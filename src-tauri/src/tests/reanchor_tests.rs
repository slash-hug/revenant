//! Integration-level tests for reanchor.rs.
//!
//! Unit tests are also colocated in `reanchor.rs`.  This file adds tests
//! that span the full reanchor_all → annotations store pipeline and verifies
//! the 5-case suite from spec §7 + review-history TRAP 9.

#[cfg(test)]
mod integration {
    use crate::annotations::{Annotation, AnchorStatus};
    use crate::file_io::sha256_hex;
    use crate::reanchor::{normalized_similarity, reanchor, reanchor_all, SIMILARITY_THRESHOLD};

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
            char_start: 0,
            char_end: 0,
            quoted_text: quoted.to_string(),
            context_before: before.to_string(),
            context_after: after.to_string(),
            body: String::new(),
            status: AnchorStatus::Anchored,
            created_at: "2025-01-01T00:00:00Z".to_string(),
            updated_at: "2025-01-01T00:00:00Z".to_string(),
        }
    }

    // ── Spec §7 case 1: exact match (hash short-circuit) ─────────────────────
    // All line_start/line_end values are 0-indexed per the frozen IPC contract.

    #[test]
    fn spec_case1_exact_match_no_reanchor_needed() {
        let doc = "## Section\nThe key insight is here.\nFurther details.\n";
        let hash = sha256_hex(doc.as_bytes());
        // "The key insight is here." is at index 1 (0-indexed).
        let a = ann("c1", 1, 1, "The key insight is here.", "## Section", "Further details.");

        let r = reanchor(&a, doc, &hash, &hash);
        assert_eq!(r.annotation.status, AnchorStatus::Anchored);
        assert_eq!(r.annotation.line_start, 1);
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

        // "This feature improves performance." is at index 1 (0-indexed).
        let a = ann(
            "c2",
            1,
            1,
            "This feature improves performance.",
            "## Overview",
            "Benchmark results below.",
        );

        let r = reanchor(&a, edited, &new_hash, &old_hash);
        assert_eq!(r.annotation.status, AnchorStatus::Anchored);
        // After edit, still at index 1 (same line position).
        assert_eq!(r.annotation.line_start, 1);
    }

    // ── Spec §7 case 3: detached after heavy edit ─────────────────────────────

    #[test]
    fn spec_case3_detached_heavy_edit() {
        let original = "The algorithm runs in O(n log n) time.\n";
        let old_hash = sha256_hex(original.as_bytes());

        // Complete rewrite.
        let edited = "All previous content removed. New approach: O(1).\n";
        let new_hash = sha256_hex(edited.as_bytes());

        // Only line, 0-indexed = 0.
        let a = ann("c3", 0, 0, "The algorithm runs in O(n log n) time.", "", "");

        let r = reanchor(&a, edited, &new_hash, &old_hash);
        assert_eq!(r.annotation.status, AnchorStatus::Detached);
    }

    // ── Spec §7 case 4: empty document ───────────────────────────────────────

    #[test]
    fn spec_case4_empty_document_detaches_all() {
        let original = "Line 1\nLine 2\nLine 3\n";
        let old_hash = sha256_hex(original.as_bytes());
        let new_hash = sha256_hex(b"");

        // 0-indexed: Line 1=0, Line 2=1, Line 3=2.
        let annotations = vec![
            ann("e1", 0, 0, "Line 1", "", "Line 2"),
            ann("e2", 1, 1, "Line 2", "Line 1", "Line 3"),
            ann("e3", 2, 2, "Line 3", "Line 2", ""),
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

    #[test]
    fn spec_case5_multi_annotation_mixed() {
        // 5-line document (indices 0-4).
        let original =
            "Preamble\nStable text that stays.\nMiddle constant\nVolatile section to be replaced.\nEpilogue\n";
        let old_hash = sha256_hex(original.as_bytes());

        // Index 3 ("Volatile…") rewritten; rest unchanged.
        let edited =
            "Preamble\nStable text that stays.\nMiddle constant\nCompletely new content here.\nEpilogue\n";
        let new_hash = sha256_hex(edited.as_bytes());

        // Stable annotation at index 1 (0-indexed).
        let stable_ann = ann(
            "stable",
            1,
            1,
            "Stable text that stays.",
            "Preamble",
            "Middle constant",
        );
        // Volatile annotation at index 3 (0-indexed).
        let volatile_ann = ann(
            "volatile",
            3,
            3,
            "Volatile section to be replaced.",
            "Middle constant",
            "Epilogue",
        );

        let results =
            reanchor_all(&[stable_ann, volatile_ann], &edited, &new_hash, &old_hash);

        assert_eq!(results[0].annotation.status, AnchorStatus::Anchored);
        assert_eq!(results[0].annotation.line_start, 1);
        assert_eq!(results[1].annotation.status, AnchorStatus::Detached);
    }

    // ── TRAP 9: re-anchor tie-break regression ────────────────────────────────

    #[test]
    fn trap9_tie_break_prefers_closest_line() {
        // "target line content" appears at indices 2, 6, 10 (0-indexed).
        // Stored anchor was index 6. Re-anchor should pick index 6 (distance 0).
        let doc = vec![
            "other",
            "other",
            "target line content", // index 2
            "other",
            "other",
            "other",
            "target line content", // index 6
            "other",
            "other",
            "other",
            "target line content", // index 10
        ];
        let content = doc.join("\n") + "\n";
        let old_hash = sha256_hex(b"old_different");
        let new_hash = sha256_hex(content.as_bytes());

        let a = ann("t9", 6, 6, "target line content", "other", "other");
        let r = reanchor(&a, &content, &new_hash, &old_hash);
        assert_eq!(r.annotation.status, AnchorStatus::Anchored);
        assert_eq!(r.annotation.line_start, 6, "should prefer closest line (index 6)");
    }

    // ── TRAP 9: earliest position when same distance ──────────────────────────

    #[test]
    fn trap9_tie_break_same_distance_picks_earliest() {
        // Two occurrences equidistant from stored anchor index 3 (0-indexed).
        // Indices: 1 (dist=2), 5 (dist=2). Earliest (1) should win.
        let doc = vec![
            "x",
            "match me here",  // index 1 — dist 2 from stored anchor (3)
            "x",
            "x",              // stored anchor index 3
            "x",
            "match me here",  // index 5 — dist 2 from stored anchor (3)
            "x",
        ];
        let content = doc.join("\n") + "\n";
        let old_hash = sha256_hex(b"old");
        let new_hash = sha256_hex(content.as_bytes());

        let a = ann("eq", 3, 3, "match me here", "x", "x");
        let r = reanchor(&a, &content, &new_hash, &old_hash);
        assert_eq!(r.annotation.status, AnchorStatus::Anchored);
        assert_eq!(r.annotation.line_start, 1, "earliest at equal distance should win");
    }

    // ── Threshold boundary test ───────────────────────────────────────────────

    #[test]
    fn similarity_threshold_is_0_75() {
        assert_eq!(SIMILARITY_THRESHOLD, 0.75);
    }

    // ── Regression #49: similarity counts characters, not bytes ───────────────

    #[test]
    fn similarity_counts_chars_not_bytes_accented() {
        // "café" vs "cafe" differ only in the final char (é vs e). "é" is a
        // 2-byte UTF-8 sequence, so byte- and char-weighting diverge.
        //
        // Char-level diff: equal "caf" (3) + delete "é" (1) + insert "e" (1)
        //   → unchanged = 3, total = 5 → 0.6
        // If bytes were (incorrectly) counted, "é" would weigh 2:
        //   → unchanged = 3, total = 6 → 0.5
        let s = normalized_similarity("café", "cafe");
        assert!(
            (s - 0.6).abs() < 1e-9,
            "expected char-ratio 0.6, got {s} (byte-counting would give 0.5)"
        );
    }

    #[test]
    fn similarity_counts_chars_not_bytes_cjk() {
        // "日本語" vs "日本X" differ only in the final char. Each CJK char is a
        // 3-byte UTF-8 sequence; the substituted ASCII "X" is 1 byte.
        //
        // Char-level diff: equal "日本" (2) + delete "語" (1) + insert "X" (1)
        //   → unchanged = 2, total = 4 → 0.5
        // Byte-counting would weight the CJK chars as 3 each, skewing the ratio.
        let s = normalized_similarity("日本語", "日本X");
        assert!(
            (s - 0.5).abs() < 1e-9,
            "expected char-ratio 0.5, got {s} (byte-counting would skew this)"
        );
    }
}
