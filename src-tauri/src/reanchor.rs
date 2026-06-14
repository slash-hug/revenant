//! Fuzzy re-anchoring module.
//!
//! Architecture decisions implemented here:
//! - A4/C3: Content-hash short-circuit → line-range probe → context fuzzy match
//!   with `similar` crate (Patience diff algorithm).
//! - Threshold: normalized similarity ≥ 0.75 → anchored; below → detached.
//! - 3-line context window: `context_before + quoted_text + context_after`.
//! - Tie-break: smallest line-distance from stored anchor, then earliest position.
//! - C8 / A10: Preview-side block-level degradation noted — `block_level_fallback`
//!   flag in `ReanchorResult` signals when transformed-block degradation occurred.
//!
//! # Algorithm
//! ```text
//! 1. If doc hash == stored hash → positions unchanged, return Anchored.
//! 2. Probe stored [line_start..line_end] in new doc — if quoted_text found
//!    verbatim → update lines, return Anchored.
//! 3. Build needle = context_before + "\n" + quoted_text + "\n" + context_after.
//!    Slide a window of needle.lines().count() lines over the document and
//!    compute normalized similarity (via `similar::TextDiff`).
//!    Collect candidates with similarity ≥ 0.75.
//!    Tie-break: closest line to stored anchor, then earliest.
//! 4. No candidate ≥ 0.75 → Detached.
//! ```

use similar::{ChangeTag, TextDiff};
use std::collections::BTreeMap;

use crate::annotations::{Annotation, AnchorStatus};

/// Similarity threshold for re-anchoring (C3).
pub const SIMILARITY_THRESHOLD: f64 = 0.75;

/// Half-width of the search window around the stored anchor line (T1.1/A5).
///
/// The fuzzy search and verbatim probe are restricted to lines
/// `[stored_line - W, stored_line + W]` to bound worst-case O(doc) → O(W)
/// per annotation, keeping re-anchor latency constant for large documents.
pub const REANCHOR_WINDOW: usize = 50;

/// The outcome of re-anchoring a single annotation.
#[derive(Debug, Clone, PartialEq)]
pub struct ReanchorResult {
    /// The annotation with updated `line_start`, `line_end`, and `status`.
    pub annotation: Annotation,
    /// Whether the match degraded to block-level (C8/A10: Mermaid/table/footnote
    /// transformed blocks in the preview).  Always `false` in this Rust module
    /// (block-level detection happens on the JS side using a source-map); the
    /// field is included for interface completeness.
    pub block_level_fallback: bool,
}

/// Re-anchor a single annotation against `new_content`.
///
/// `doc_hash` is the sha256 hex of `new_content` (pre-computed by the caller
/// to avoid re-hashing in loops).  `stored_hash` is the hash stored in the
/// sidecar at the time annotations were saved.
pub fn reanchor(
    ann: &Annotation,
    new_content: &str,
    doc_hash: &str,
    stored_hash: &str,
) -> ReanchorResult {
    // ── Step 1: Content-hash short-circuit ────────────────────────────────────
    if doc_hash == stored_hash {
        return ReanchorResult {
            annotation: ann.clone(),
            block_level_fallback: false,
        };
    }

    let lines: Vec<&str> = new_content.lines().collect();

    // ── Step 2: Verbatim probe in stored line range ───────────────────────────
    if let Some((new_start, new_end)) = probe_verbatim(ann, &lines) {
        let mut updated = ann.clone();
        updated.line_start = new_start;
        updated.line_end = new_end;
        updated.status = AnchorStatus::Anchored;
        return ReanchorResult {
            annotation: updated,
            block_level_fallback: false,
        };
    }

    // ── Step 3: Fuzzy context window search ───────────────────────────────────
    let needle = build_needle(ann);
    let needle_line_count = needle.lines().count().max(1);

    // Count the context_before lines so we can offset from the window start
    // to the line where quoted_text begins inside that window.
    let before_line_count = if ann.context_before.is_empty() {
        0
    } else {
        ann.context_before.lines().count()
    };
    let quoted_line_count = if ann.quoted_text.is_empty() {
        1
    } else {
        ann.quoted_text.lines().count()
    };

    if let Some(window_start) =
        best_fuzzy_match(&needle, &lines, needle_line_count, ann.line_start)
    {
        // Offset into the window to get the anchor on the quoted_text lines.
        let anchor_start = window_start + before_line_count as u32;
        let anchor_end = anchor_start + quoted_line_count as u32 - 1;

        let mut updated = ann.clone();
        updated.line_start = anchor_start;
        updated.line_end = anchor_end;
        updated.status = AnchorStatus::Anchored;
        return ReanchorResult {
            annotation: updated,
            block_level_fallback: false,
        };
    }

    // ── Step 4: Detach ────────────────────────────────────────────────────────
    let mut detached = ann.clone();
    detached.status = AnchorStatus::Detached;
    ReanchorResult {
        annotation: detached,
        block_level_fallback: false,
    }
}

/// Re-anchor all annotations in a sidecar against updated document content.
///
/// Returns a `Vec<ReanchorResult>` in the same order as `annotations`.
pub fn reanchor_all(
    annotations: &[Annotation],
    new_content: &str,
    doc_hash: &str,
    stored_hash: &str,
) -> Vec<ReanchorResult> {
    annotations
        .iter()
        .map(|ann| reanchor(ann, new_content, doc_hash, stored_hash))
        .collect()
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/// Build the needle string from annotation context (3-line window).
fn build_needle(ann: &Annotation) -> String {
    let parts: Vec<&str> = [
        ann.context_before.as_str(),
        ann.quoted_text.as_str(),
        ann.context_after.as_str(),
    ]
    .iter()
    .copied()
    .filter(|s| !s.is_empty())
    .collect();
    parts.join("\n")
}

/// Probe the document for a verbatim match of `ann.quoted_text` within ±W lines
/// of the stored anchor position (T1.1/A5 windowed search).
///
/// Returns `(new_start, new_end)` **(0-indexed)** if found, else `None`.
/// Prefers the match closest to the stored 0-indexed anchor line.
fn probe_verbatim(ann: &Annotation, lines: &[&str]) -> Option<(u32, u32)> {
    let quoted = ann.quoted_text.as_str();
    if quoted.is_empty() {
        return None;
    }
    let quoted_lines: Vec<&str> = quoted.lines().collect();
    let span = quoted_lines.len();

    // Search within ±W of the stored anchor; prefer closest match.
    let stored_start = ann.line_start as usize; // 0-indexed
    let window_lo = stored_start.saturating_sub(REANCHOR_WINDOW);
    let window_hi = (stored_start + REANCHOR_WINDOW).min(lines.len());
    let mut best: Option<(u32, u32, usize)> = None; // (start, end, distance)

    if span <= 1 {
        // Single-line selection — almost always a SUBSTRING of a line (a word or
        // phrase, e.g. "Randy"), not a whole line. Match by containment, preferring
        // the line closest to the stored anchor. Whole-line equality would detach
        // every sub-line selection — which is the common case.
        for (i, line) in lines.iter().enumerate().take(window_hi).skip(window_lo) {
            if line.contains(quoted) {
                let dist = i.abs_diff(stored_start);
                if best.map_or(true, |(_, _, d)| dist < d) {
                    best = Some((i as u32, i as u32, dist));
                }
            }
        }
    } else {
        // Multi-line selection: match the consecutive run of lines verbatim.
        for i in window_lo..window_hi {
            if i + span > lines.len() {
                break;
            }
            if lines[i..i + span] == quoted_lines[..] {
                let dist = i.abs_diff(stored_start);
                if best.map_or(true, |(_, _, d)| dist < d) {
                    best = Some((i as u32, (i + span - 1) as u32, dist));
                }
            }
        }
    }

    best.map(|(s, e, _)| (s, e))
}

/// Slide a window of `needle_line_count` lines over `lines` and compute
/// normalized similarity between `needle` and each window using `similar`.
///
/// Returns the **0-indexed** line number of the **start of the best window**
/// (i.e., the first line of the context window, before any context_before
/// offset) with similarity ≥ `SIMILARITY_THRESHOLD`, or `None` if no window
/// qualifies.
///
/// The caller is responsible for offsetting by `context_before` line count to
/// arrive at the actual anchor line for the `quoted_text`.
///
/// Tie-break: smallest line-distance from `stored_anchor_line` (0-indexed),
/// then earliest position.
fn best_fuzzy_match(
    needle: &str,
    lines: &[&str],
    window_size: usize,
    stored_anchor_line: u32,
) -> Option<u32> {
    if lines.is_empty() || window_size == 0 {
        return None;
    }

    // Restrict the slide range to ±W lines around the stored anchor (T1.1/A5).
    let anchor = stored_anchor_line as usize;
    let slide_lo = anchor.saturating_sub(REANCHOR_WINDOW);
    let slide_hi = (anchor + REANCHOR_WINDOW).min(lines.len().saturating_sub(window_size));

    if slide_lo > slide_hi {
        return None;
    }

    // Pre-compute needle character count for pre-filter.
    let needle_char_count = needle.chars().count();

    // We'll collect candidates keyed by (distance, start_idx) → similarity.
    // BTreeMap gives us deterministic ordering: smallest key first.
    let mut candidates: BTreeMap<(usize, usize), f64> = BTreeMap::new();

    for i in slide_lo..=slide_hi {
        let window = lines[i..i + window_size].join("\n");

        // Cheap pre-filter: skip if character count ratio is too far off.
        // A similarity of ≥0.75 requires the lengths to not differ too much.
        // We allow a 4× ratio (0.25 of the longer → similarity < 0.25, well below
        // threshold) as the filter is conservative and avoids redundant char-diff.
        let w_chars = window.chars().count();
        let max_c = needle_char_count.max(w_chars);
        let min_c = needle_char_count.min(w_chars);
        if max_c > 0 && (min_c as f64) / (max_c as f64) < 0.25 {
            continue;
        }

        let sim = normalized_similarity(needle, &window);
        if sim >= SIMILARITY_THRESHOLD {
            // Distance is measured from stored 0-indexed anchor to the window-start.
            let dist = i.abs_diff(anchor);
            candidates
                .entry((dist, i))
                .and_modify(|s| {
                    if sim > *s {
                        *s = sim;
                    }
                })
                .or_insert(sim);
        }
    }

    // First entry has the smallest (distance, start_idx).
    candidates
        .into_iter()
        .next()
        .map(|((_, start_idx), _)| start_idx as u32)
}

/// Compute a normalized similarity score in [0.0, 1.0] between `a` and `b`
/// using `similar`'s Patience diff.
///
/// The score is 1 - (edit_distance / max_len), where edit_distance is the
/// number of changed characters.
fn normalized_similarity(a: &str, b: &str) -> f64 {
    if a == b {
        return 1.0;
    }
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }

    let diff = TextDiff::from_chars(a, b);
    let mut unchanged = 0usize;
    let mut total = 0usize;

    for change in diff.iter_all_changes() {
        let len = change.value().len();
        total += len;
        if change.tag() == ChangeTag::Equal {
            unchanged += len;
        }
    }

    if total == 0 {
        return 1.0;
    }

    // Score = ratio of unchanged characters to the union of both strings.
    // This is equivalent to: 2 * |LCS| / (|a| + |b|) — the Dice coefficient
    // on character level, which maps to [0, 1].
    unchanged as f64 / total as f64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_io::sha256_hex;

    fn make_ann(
        id: &str,
        line_start: u32,
        line_end: u32,
        quoted: &str,
        before: &str,
        after: &str,
    ) -> Annotation {
        Annotation {
            id: id.to_string(),
            line_start,
            line_end,
            char_start: 0,
            char_end: 0,
            quoted_text: quoted.to_string(),
            context_before: before.to_string(),
            context_after: after.to_string(),
            body: "comment".to_string(),
            status: AnchorStatus::Anchored,
            created_at: "2025-01-01T00:00:00Z".to_string(),
            updated_at: "2025-01-01T00:00:00Z".to_string(),
        }
    }

    // ── 1. Exact match (hash short-circuit) ───────────────────────────────────
    // All line numbers are 0-indexed per the frozen IPC contract.

    #[test]
    fn exact_match_hash_short_circuit() {
        let content = "line 1\nline 2\nline 3\n";
        let hash = sha256_hex(content.as_bytes());
        // "line 2" is at index 1 (0-indexed).
        let ann = make_ann("a1", 1, 1, "line 2", "line 1", "line 3");

        let result = reanchor(&ann, content, &hash, &hash);
        assert_eq!(result.annotation.status, AnchorStatus::Anchored);
        assert_eq!(result.annotation.line_start, 1);
        assert_eq!(result.annotation.line_end, 1);
    }

    // ── 2. Fuzzy match after a light edit ─────────────────────────────────────

    #[test]
    fn fuzzy_match_after_light_edit() {
        // Original document.
        let original = "Introduction\nThis is the key finding.\nConclusion\n";
        let old_hash = sha256_hex(original.as_bytes());

        // After edit: a line is inserted before.
        let edited =
            "Preamble\nIntroduction\nThis is the key finding!\nConclusion\n";
        let new_hash = sha256_hex(edited.as_bytes());

        let ann = make_ann(
            "a2",
            1, // "This is the key finding." was at index 1 (0-indexed)
            1,
            "This is the key finding.",
            "Introduction",
            "Conclusion",
        );

        let result = reanchor(&ann, edited, &new_hash, &old_hash);
        // Should have found "This is the key finding!" (≥0.75 similar) at index 2 (0-indexed).
        assert_eq!(result.annotation.status, AnchorStatus::Anchored);
        assert_eq!(result.annotation.line_start, 2);
    }

    // ── 3. Detached after heavy edit ──────────────────────────────────────────

    #[test]
    fn detached_after_heavy_edit() {
        let original = "Alpha beta gamma delta epsilon.\n";
        let old_hash = sha256_hex(original.as_bytes());

        // Completely different document.
        let edited = "Lorem ipsum dolor sit amet.\nConsectetur adipiscing elit.\n";
        let new_hash = sha256_hex(edited.as_bytes());

        let ann = make_ann(
            "a3",
            0, // first line, 0-indexed
            0,
            "Alpha beta gamma delta epsilon.",
            "",
            "",
        );

        let result = reanchor(&ann, edited, &new_hash, &old_hash);
        assert_eq!(result.annotation.status, AnchorStatus::Detached);
    }

    // ── 4. Empty document ─────────────────────────────────────────────────────

    #[test]
    fn empty_document_detaches() {
        let original = "Some content here.\n";
        let old_hash = sha256_hex(original.as_bytes());
        let new_hash = sha256_hex(b"");

        let ann = make_ann("a4", 0, 0, "Some content here.", "", "");

        let result = reanchor(&ann, "", &new_hash, &old_hash);
        assert_eq!(result.annotation.status, AnchorStatus::Detached);
    }

    // ── 5. Multi-annotation: one anchors, one detaches ────────────────────────
    //
    // "Important note here." → "Important notes here." (single word change,
    // stable immediate context) — should re-anchor.
    // "Volatile section xyz." → completely rewritten — should detach.

    #[test]
    fn multi_annotation_one_anchors_one_detaches() {
        // Original: 5 lines (indices 0-4)
        let original = "Header\nImportant note here.\nSeparator line\nVolatile section xyz.\nFooter\n";
        let old_hash = sha256_hex(original.as_bytes());

        // Edit: single word in index 1 ("note" → "notes"); index 3 completely rewritten.
        let edited = "Header\nImportant notes here.\nSeparator line\nQwerty uiop asdf.\nFooter\n";
        let new_hash = sha256_hex(edited.as_bytes());

        // Stable annotation at index 1 (0-indexed).
        let ann_anchored = make_ann(
            "keep", 1, 1,
            "Important note here.",
            "Header",
            "Separator line",
        );

        // Volatile annotation at index 3 (0-indexed).
        let ann_detached = make_ann(
            "lose", 3, 3,
            "Volatile section xyz.",
            "Separator line",
            "Footer",
        );

        let results =
            reanchor_all(&[ann_anchored, ann_detached], edited, &new_hash, &old_hash);

        assert_eq!(results.len(), 2);
        assert_eq!(results[0].annotation.status, AnchorStatus::Anchored,
            "stable annotation should re-anchor");
        assert_eq!(results[1].annotation.status, AnchorStatus::Detached,
            "volatile annotation should detach");
    }

    // ── 6. Regression: tie-break by closest line then earliest ────────────────

    #[test]
    fn tie_break_by_line_distance_then_earliest() {
        // Document where "match text" appears at indices 1 and 7 (0-indexed).
        // Stored anchor was index 1, so index 1 should win.
        let content = "ctx\nmatch text\nother\nother\nother\nother\nctx\nmatch text\nfin\n";
        let old_hash = sha256_hex(b"old");
        let new_hash = sha256_hex(content.as_bytes());

        let ann = make_ann("tie", 1, 1, "match text", "ctx", "other");

        let result = reanchor(&ann, content, &new_hash, &old_hash);
        assert_eq!(result.annotation.status, AnchorStatus::Anchored);
        // Should pick index 1 (distance 0) over index 7 (distance 6).
        assert_eq!(result.annotation.line_start, 1);
    }

    // ── 7. Regression: transformed-block fallback field ───────────────────────
    //
    // C8 ruling: preview-side block-level degradation is signalled via the
    // `block_level_fallback` field.  In this Rust module it is always false
    // (block detection lives in the JS source-map layer); verify the contract.

    #[test]
    fn block_level_fallback_is_always_false_in_rust_module() {
        let content = "# Heading\nSome text.\n";
        let hash = sha256_hex(content.as_bytes());
        // "Some text." is at index 1 (0-indexed).
        let ann = make_ann("blk", 1, 1, "Some text.", "# Heading", "");

        let result = reanchor(&ann, content, &hash, &hash);
        assert!(!result.block_level_fallback);

        // Also check on detached path.
        let diff_hash = sha256_hex(b"different");
        let result2 = reanchor(&ann, "", &sha256_hex(b""), &diff_hash);
        assert!(!result2.block_level_fallback);
    }

    // ── 8. Normalized similarity sanity checks ────────────────────────────────

    #[test]
    fn similarity_identical_strings() {
        assert!((normalized_similarity("hello", "hello") - 1.0).abs() < 1e-9);
    }

    #[test]
    fn similarity_empty_strings() {
        assert!((normalized_similarity("", "") - 1.0).abs() < 1e-9);
    }

    #[test]
    fn similarity_completely_different() {
        let s = normalized_similarity("abcde", "vwxyz");
        assert!(s < SIMILARITY_THRESHOLD);
    }

    #[test]
    fn similarity_light_edit_above_threshold() {
        // One character changed out of many should stay above 0.75.
        let s = normalized_similarity(
            "Important note here.",
            "Important notes here.",
        );
        assert!(s >= SIMILARITY_THRESHOLD, "got {}", s);
    }

    // ── 9. Window bound: hit inside ±W re-anchors ─────────────────────────────
    //
    // T1.1: verify that a text moved within REANCHOR_WINDOW lines of the stored
    // anchor is found by the windowed search.

    #[test]
    fn windowed_hit_inside_bound_reanchors() {
        // Build a document where the annotated line is initially at position W-1
        // (just inside the window), then simulate a doc where it has moved to
        // position W (still inside the ±W window).
        let w = REANCHOR_WINDOW;

        // Original: target text at line 0.
        let mut original_lines = vec!["padding line"; w + 10];
        original_lines[0] = "the anchored sentence here";
        let original = original_lines.join("\n");
        let old_hash = sha256_hex(original.as_bytes());

        // Edited: target text moved forward by W lines (still inside ±W from stored 0).
        let mut edited_lines = vec!["padding line"; w + 10];
        edited_lines[w] = "the anchored sentence here"; // moved to exactly +W
        let edited = edited_lines.join("\n");
        let new_hash = sha256_hex(edited.as_bytes());

        let ann = make_ann("win-hit", 0, 0, "the anchored sentence here", "", "padding line");

        let result = reanchor(&ann, &edited, &new_hash, &old_hash);
        // Should still be found within the ±W window.
        assert_eq!(result.annotation.status, AnchorStatus::Anchored,
            "target within ±W should re-anchor");
        assert_eq!(result.annotation.line_start, w as u32,
            "should find at offset +W");
    }

    // ── 10. Window bound: miss outside ±W marks detached ─────────────────────
    //
    // T1.1: verify that text moved MORE than REANCHOR_WINDOW lines away is NOT
    // found and returns Detached (the window bound is enforced).

    #[test]
    fn miss_outside_window_marks_detached() {
        let w = REANCHOR_WINDOW;

        // Original: unique target at line 0.
        let mut original_lines: Vec<String> = (0..=w * 3 + 5).map(|i| format!("filler {i}")).collect();
        original_lines[0] = "unique target text outside window".to_string();
        let original = original_lines.join("\n");
        let old_hash = sha256_hex(original.as_bytes());

        // Edited: move target to line W+10 (outside the ±W window from stored line 0).
        let outside_pos = w + 10;
        let mut edited_lines: Vec<String> = (0..=w * 3 + 5).map(|i| format!("filler {i}")).collect();
        edited_lines[outside_pos] = "unique target text outside window".to_string();
        let edited = edited_lines.join("\n");
        let new_hash = sha256_hex(edited.as_bytes());

        let ann = make_ann("win-miss", 0, 0, "unique target text outside window", "", "filler 1");

        let result = reanchor(&ann, &edited, &new_hash, &old_hash);
        // Must be Detached because the target is outside the ±W window.
        assert_eq!(result.annotation.status, AnchorStatus::Detached,
            "target outside ±W should detach");
    }

    // ── 11. Sub-line selection (a word inside a longer line) re-anchors ───────
    //
    // The common real case: the quoted_text is a WORD selected within a longer
    // line ("Randy" inside "**Author:** Randy ..."), not a whole line. Whole-line
    // equality would detach it; substring containment must re-anchor it.

    #[test]
    fn sub_line_word_selection_reanchors_after_insertion() {
        let original = "# Title\n\n**Author:** Randy (clogic@gmail.com)\nbody\n";
        let old_hash = sha256_hex(original.as_bytes());

        // "Randy" is a sub-line selection on line 2 (0-indexed).
        let ann = make_ann("randy", 2, 2, "Randy", "", "body");

        // Insert 3 lines above; the Author line moves from index 2 → 5.
        let edited = "new 1\nnew 2\nnew 3\n# Title\n\n**Author:** Randy (clogic@gmail.com)\nbody\n";
        let new_hash = sha256_hex(edited.as_bytes());

        let result = reanchor(&ann, edited, &new_hash, &old_hash);
        assert_eq!(result.annotation.status, AnchorStatus::Anchored,
            "a word selected inside a line must re-anchor, not detach");
        assert_eq!(result.annotation.line_start, 5,
            "should follow the line to its new position (+3)");

        // And if the word itself is extended (Randy → Randy Williams), the
        // substring still anchors to that line rather than detaching.
        let renamed = "# Title\n\n**Author:** Randy Williams (clogic@gmail.com)\nbody\n";
        let renamed_hash = sha256_hex(renamed.as_bytes());
        let r2 = reanchor(&ann, renamed, &renamed_hash, &old_hash);
        assert_eq!(r2.annotation.status, AnchorStatus::Anchored,
            "substring still present → still anchored");
    }
}
