//! Integration-level tests for reanchor.rs.
//!
//! Unit tests are also colocated in `reanchor.rs`.  This file adds tests
//! that span the full reanchor_all → annotations store pipeline and verifies
//! the 5-case suite from spec §7 + review-history TRAP 9.

#[cfg(test)]
mod integration {
    use crate::annotations::{Annotation, AnchorStatus};
    use crate::file_io::sha256_hex;
    use crate::reanchor::{reanchor, reanchor_all, SIMILARITY_THRESHOLD};

    fn ann(
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
            quoted_text: quoted.to_string(),
            context_before: before.to_string(),
            context_after: after.to_string(),
            body: String::new(),
            status: AnchorStatus::Anchored,
        }
    }

    // ── Spec §7 case 1: exact match (hash short-circuit) ─────────────────────

    #[test]
    fn spec_case1_exact_match_no_reanchor_needed() {
        let doc = "## Section\nThe key insight is here.\nFurther details.\n";
        let hash = sha256_hex(doc.as_bytes());
        let a = ann("c1", 2, 2, "The key insight is here.", "## Section", "Further details.");

        let r = reanchor(&a, doc, &hash, &hash);
        assert_eq!(r.annotation.status, AnchorStatus::Anchored);
        assert_eq!(r.annotation.line_start, 2);
    }

    // ── Spec §7 case 2: fuzzy match after light edit ──────────────────────────

    #[test]
    fn spec_case2_fuzzy_match_light_edit() {
        let original =
            "## Overview\nThis feature improves performance.\nBenchmark results below.\n";
        let old_hash = sha256_hex(original.as_bytes());

        // Light edit: "improves" → "greatly improves"
        let edited =
            "## Overview\nThis feature greatly improves performance.\nBenchmark results below.\n";
        let new_hash = sha256_hex(edited.as_bytes());

        let a = ann(
            "c2",
            2,
            2,
            "This feature improves performance.",
            "## Overview",
            "Benchmark results below.",
        );

        let r = reanchor(&a, edited, &new_hash, &old_hash);
        assert_eq!(r.annotation.status, AnchorStatus::Anchored);
        assert_eq!(r.annotation.line_start, 2);
    }

    // ── Spec §7 case 3: detached after heavy edit ─────────────────────────────

    #[test]
    fn spec_case3_detached_heavy_edit() {
        let original = "The algorithm runs in O(n log n) time.\n";
        let old_hash = sha256_hex(original.as_bytes());

        // Complete rewrite.
        let edited = "All previous content removed. New approach: O(1).\n";
        let new_hash = sha256_hex(edited.as_bytes());

        let a = ann("c3", 1, 1, "The algorithm runs in O(n log n) time.", "", "");

        let r = reanchor(&a, edited, &new_hash, &old_hash);
        assert_eq!(r.annotation.status, AnchorStatus::Detached);
    }

    // ── Spec §7 case 4: empty document ───────────────────────────────────────

    #[test]
    fn spec_case4_empty_document_detaches_all() {
        let original = "Line 1\nLine 2\nLine 3\n";
        let old_hash = sha256_hex(original.as_bytes());
        let new_hash = sha256_hex(b"");

        let annotations = vec![
            ann("e1", 1, 1, "Line 1", "", "Line 2"),
            ann("e2", 2, 2, "Line 2", "Line 1", "Line 3"),
            ann("e3", 3, 3, "Line 3", "Line 2", ""),
        ];

        let results = reanchor_all(&annotations, "", &new_hash, &old_hash);
        assert_eq!(results.len(), 3);
        for r in &results {
            assert_eq!(
                r.annotation.status,
                AnchorStatus::Detached,
                "annotation {} should be detached in empty doc",
                r.annotation.id
            );
        }
    }

    // ── Spec §7 case 5: multi-annotation (one anchors, one detaches) ──────────
    //
    // The stable annotation has context that is mostly unchanged across the edit,
    // so its 3-line needle (Preamble + "Stable text..." + Epilogue) remains
    // ≥0.75 similar to a window in the edited document.
    // The volatile annotation ("Volatile section…") has no similar text in the
    // edited doc and must detach.
    //
    // Design note: context_before/after for the stable annotation use lines that
    // do NOT change across the edit, so the needle similarity stays high.

    #[test]
    fn spec_case5_multi_annotation_mixed() {
        // 6-line document: only lines 2 and 5 change.
        let original =
            "Preamble\nStable text that stays.\nMiddle constant\nVolatile section to be replaced.\nEpilogue\n";
        let old_hash = sha256_hex(original.as_bytes());

        // Line 4 ("Volatile…") rewritten; rest unchanged.
        let edited =
            "Preamble\nStable text that stays.\nMiddle constant\nCompletely new content here.\nEpilogue\n";
        let new_hash = sha256_hex(edited.as_bytes());

        // Stable annotation at line 2 — context uses "Preamble" and "Middle constant"
        // (both stable), so needle stays ≥0.75 similar.
        let stable_ann = ann(
            "stable",
            2,
            2,
            "Stable text that stays.",
            "Preamble",
            "Middle constant",
        );
        // Volatile annotation at line 4 — context "Volatile section to be replaced."
        // has no similar text in the edited doc → detach.
        let volatile_ann = ann(
            "volatile",
            4,
            4,
            "Volatile section to be replaced.",
            "Middle constant",
            "Epilogue",
        );

        let results =
            reanchor_all(&[stable_ann, volatile_ann], &edited, &new_hash, &old_hash);

        assert_eq!(results[0].annotation.status, AnchorStatus::Anchored);
        assert_eq!(results[0].annotation.line_start, 2);
        assert_eq!(results[1].annotation.status, AnchorStatus::Detached);
    }

    // ── TRAP 9: re-anchor tie-break regression ────────────────────────────────

    #[test]
    fn trap9_tie_break_prefers_closest_line() {
        // "target" appears at lines 3, 7, and 11. Stored anchor was line 7.
        // Re-anchor should pick line 7 (distance 0).
        let doc = vec![
            "other",
            "other",
            "target line content",
            "other",
            "other",
            "other",
            "target line content", // line 7
            "other",
            "other",
            "other",
            "target line content", // line 11
        ];
        let content = doc.join("\n") + "\n";
        let old_hash = sha256_hex(b"old_different");
        let new_hash = sha256_hex(content.as_bytes());

        let a = ann("t9", 7, 7, "target line content", "other", "other");
        let r = reanchor(&a, &content, &new_hash, &old_hash);
        assert_eq!(r.annotation.status, AnchorStatus::Anchored);
        assert_eq!(r.annotation.line_start, 7, "should prefer closest line (7)");
    }

    // ── TRAP 9: earliest position when same distance ──────────────────────────

    #[test]
    fn trap9_tie_break_same_distance_picks_earliest() {
        // Two occurrences equidistant from stored anchor line 4.
        // Lines: 2 (dist=2), 6 (dist=2). Earliest (2) should win.
        let doc = vec![
            "x",
            "match me here",  // line 2 — dist 2
            "x",
            "x",              // stored anchor line 4
            "x",
            "match me here",  // line 6 — dist 2
            "x",
        ];
        let content = doc.join("\n") + "\n";
        let old_hash = sha256_hex(b"old");
        let new_hash = sha256_hex(content.as_bytes());

        let a = ann("eq", 4, 4, "match me here", "x", "x");
        let r = reanchor(&a, &content, &new_hash, &old_hash);
        assert_eq!(r.annotation.status, AnchorStatus::Anchored);
        assert_eq!(r.annotation.line_start, 2, "earliest at equal distance should win");
    }

    // ── Threshold boundary test ───────────────────────────────────────────────

    #[test]
    fn similarity_threshold_is_0_75() {
        assert_eq!(SIMILARITY_THRESHOLD, 0.75);
    }
}
