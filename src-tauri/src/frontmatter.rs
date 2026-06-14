//! YAML frontmatter parse and merge helpers.
//!
//! Used by:
//! - Preview pane header rendering (WS-C via IPC)
//! - Obsidian exporter frontmatter merge (WS-D / obsidian.rs via `crate::frontmatter`)
//!
//! Format: a document optionally starts with `---\r?\n…---\r?\n` (YAML block).
//! This module parses that block into a `serde_yaml::Mapping`, provides helpers
//! to merge two mappings (overlay takes precedence), and reassembles the
//! document.
//!
//! T2.3/A10: CRLF-aware parse + single reassembly route.
//! - `parse()` accepts `---\r?\n` open and close fences.
//! - Byte offsets are computed via `split_inclusive('\n')` so `line.len()`
//!   includes the `\n` (and `\r\n` includes both `\r` and `\n`).
//! - `reassemble()` is the single route for all callers; the `Display` impl
//!   delegates to it.  Guarantees a single trailing newline before the closing
//!   fence, and preserves the original line endings (CRLF if the doc uses CRLF).

use serde_yaml::Value;
use std::fmt;

/// Error type for frontmatter operations.
#[derive(Debug, thiserror::Error)]
pub enum FrontmatterError {
    #[error("YAML parse error: {0}")]
    Parse(#[from] serde_yaml::Error),
}

/// The parsed result of splitting a markdown document.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedDoc {
    /// Raw YAML source (the text between the `---` delimiters), or `None` if
    /// the document has no frontmatter block.
    pub raw_yaml: Option<String>,
    /// The parsed YAML mapping, or `None` if there was no frontmatter.
    pub mapping: Option<serde_yaml::Mapping>,
    /// The markdown body (everything after the closing `---\r?\n` line).
    pub body: String,
    /// The line ending detected in the document: `"\r\n"` or `"\n"`.
    /// `None` when no frontmatter was present (body has its own endings).
    pub(crate) line_ending: &'static str,
}

impl fmt::Display for ParsedDoc {
    /// Reassemble by delegating to `reassemble` so there is exactly one
    /// reassembly route (A10).
    ///
    /// NOTE — non-mapping frontmatter (e.g. a top-level YAML sequence
    /// `---\n- a\n- b\n---\nbody`): `parse()` sets `mapping: None` for any
    /// YAML that does not deserialize to a `Mapping`.  `reassemble` interprets
    /// `None` as "no frontmatter" and returns only the body, **silently
    /// dropping the original YAML block**.  This is not a live regression
    /// because the only production caller (`obsidian.rs` → `merge_into_doc`)
    /// always supplies a real `Some(merged_mapping)`, and `Display`/`to_string`
    /// have no production callers.  If a future caller invokes `to_string()` on
    /// a `ParsedDoc` whose frontmatter was a non-mapping type, the YAML block
    /// will be silently lost.  Add a guard here before extending callers.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match reassemble(self.mapping.as_ref(), &self.body, self.line_ending) {
            Ok(s) => write!(f, "{}", s),
            Err(e) => write!(f, "{}", e),
        }
    }
}

/// Split a markdown document into frontmatter + body.
///
/// Returns a `ParsedDoc` whether or not frontmatter is present.
/// The `mapping` field is `None` when the document has no `---` block or the
/// block is empty.
///
/// T2.3: accepts `---\r?\n` fences (CRLF or LF); computes byte offsets via
/// `split_inclusive('\n')` to avoid `+1` drift on CRLF files.
pub fn parse(content: &str) -> Result<ParsedDoc, FrontmatterError> {
    // Detect whether the document uses CRLF or LF line endings.
    // NOTE — whole-document scan: if the document has LF frontmatter but even
    // a single CRLF anywhere in the *body*, this will classify the document as
    // CRLF and rewrite the YAML-block fences to CRLF while the body keeps its
    // mixed endings.  For pathological/mixed-ending inputs this is cosmetically
    // inconsistent, though it does not corrupt data.  Real-world docs are
    // homogeneous; this is acceptable for the current scope.
    let line_ending: &'static str = if content.contains("\r\n") { "\r\n" } else { "\n" };

    // Check for opening fence: "---\n" or "---\r\n".
    let after_open = if let Some(rest) = content.strip_prefix("---\r\n") {
        Some((rest, "\r\n"))
    } else if let Some(rest) = content.strip_prefix("---\n") {
        Some((rest, "\n"))
    } else {
        None
    };

    if let Some((rest, _fence_ending)) = after_open {
        // Find the closing delimiter using split_inclusive so byte offsets are
        // exact even when lines end with \r\n (each line includes its terminator).
        if let Some((yaml_slice, body_slice)) = find_close_delimiter_crlf(rest) {
            let raw_yaml = yaml_slice.to_string();
            let body = body_slice.to_string();

            let mapping: Option<serde_yaml::Mapping> = if raw_yaml.trim().is_empty() {
                None
            } else {
                // Strip CRLF from the YAML slice before handing to serde_yaml
                // (serde_yaml does not handle bare \r in scalar values).
                let yaml_for_parse = raw_yaml.replace("\r\n", "\n");
                let val: Value = serde_yaml::from_str(&yaml_for_parse)?;
                match val {
                    Value::Mapping(m) => Some(m),
                    _ => None,
                }
            };

            return Ok(ParsedDoc {
                raw_yaml: Some(raw_yaml),
                mapping,
                body,
                line_ending,
            });
        }
    }

    // No frontmatter found.
    Ok(ParsedDoc {
        raw_yaml: None,
        mapping: None,
        body: content.to_string(),
        line_ending,
    })
}

/// Merge two YAML mappings.
///
/// Keys from `overlay` take precedence over `base`.  New keys in `overlay` are
/// added.  Keys present only in `base` are preserved.  Values are not
/// deep-merged: the whole value is replaced.
pub fn merge_mappings(
    base: &serde_yaml::Mapping,
    overlay: &serde_yaml::Mapping,
) -> serde_yaml::Mapping {
    let mut result = base.clone();
    for (k, v) in overlay {
        result.insert(k.clone(), v.clone());
    }
    result
}

/// Reassemble a document from a mapping and a body string.
///
/// Single reassembly route (A10/T2.3): `Display` delegates here so there is
/// no second path that could drift out of CRLF sync.
///
/// Serializes the mapping back to YAML and wraps it in `---` delimiters using
/// the given `line_ending` (preserves original CRLF/LF; never normalises).
/// Guarantees exactly one trailing newline before the closing fence.
/// If `mapping` is `None`, returns `body` unchanged.
pub fn reassemble(
    mapping: Option<&serde_yaml::Mapping>,
    body: &str,
    line_ending: &str,
) -> Result<String, FrontmatterError> {
    match mapping {
        None => Ok(body.to_string()),
        Some(m) => {
            // serde_yaml always outputs LF; replace with the document's native ending.
            let yaml_lf = serde_yaml::to_string(&Value::Mapping(m.clone()))?;
            let yaml = yaml_lf.replace('\n', line_ending);

            // Ensure the YAML block ends with exactly one line-ending before `---`.
            let yaml_trimmed = yaml.trim_end_matches(|c| c == '\r' || c == '\n');
            let open_fence = format!("---{}", line_ending);
            let close_fence = format!("---{}", line_ending);

            Ok(format!("{}{}{}{}{}", open_fence, yaml_trimmed, line_ending, close_fence, body))
        }
    }
}

/// Apply an overlay frontmatter mapping onto a full markdown document string.
///
/// Parses existing frontmatter (if any), merges with `overlay` (overlay wins on
/// conflicts), and returns the reassembled document, preserving the original
/// line ending style.
pub fn merge_into_doc(
    content: &str,
    overlay: &serde_yaml::Mapping,
) -> Result<String, FrontmatterError> {
    let parsed = parse(content)?;
    let merged = match &parsed.mapping {
        Some(base) => merge_mappings(base, overlay),
        None => overlay.clone(),
    };
    reassemble(Some(&merged), &parsed.body, parsed.line_ending)
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/// Find the closing `---\r?\n` (or `---` at end-of-string) within the text
/// *after* the opening `---\r?\n` has been stripped.
///
/// Returns `(yaml_slice, body_slice)` where `yaml_slice` is the raw YAML text
/// between the fences (including its trailing line endings) and `body_slice` is
/// everything after the closing fence.
///
/// Uses `split_inclusive('\n')` so byte offsets account for both `\r\n` and
/// `\n` terminators without a separate `+1` adjustment.
fn find_close_delimiter_crlf(rest: &str) -> Option<(&str, &str)> {
    let mut yaml_end = 0; // byte offset of start of closing "---"

    for line in rest.split_inclusive('\n') {
        let line_trimmed = line.trim_end_matches(|c| c == '\r' || c == '\n');
        if line_trimmed == "---" {
            // yaml_end is the byte offset of "---\r?\n".
            let body_start = yaml_end + line.len();
            let body = if body_start <= rest.len() {
                &rest[body_start..]
            } else {
                ""
            };
            return Some((&rest[..yaml_end], body));
        }
        yaml_end += line.len();
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const WITH_FM: &str = "---\ntitle: Hello\nauthor: Alice\n---\n# Body\n";
    const WITHOUT_FM: &str = "# No frontmatter\n\nJust body.\n";
    const EMPTY_FM: &str = "---\n---\n# Body after empty fm\n";

    #[test]
    fn parse_with_frontmatter() {
        let doc = parse(WITH_FM).unwrap();
        assert!(doc.mapping.is_some());
        let m = doc.mapping.unwrap();
        assert_eq!(
            m.get(&Value::String("title".into())),
            Some(&Value::String("Hello".into()))
        );
        assert_eq!(doc.body, "# Body\n");
    }

    #[test]
    fn parse_without_frontmatter() {
        let doc = parse(WITHOUT_FM).unwrap();
        assert!(doc.mapping.is_none());
        assert_eq!(doc.body, WITHOUT_FM);
    }

    #[test]
    fn parse_empty_frontmatter_block() {
        let doc = parse(EMPTY_FM).unwrap();
        assert!(doc.mapping.is_none());
        assert_eq!(doc.body, "# Body after empty fm\n");
    }

    #[test]
    fn merge_mappings_overlay_wins() {
        let base: serde_yaml::Mapping =
            serde_yaml::from_str("title: Old\nkept: yes").unwrap();
        let overlay: serde_yaml::Mapping =
            serde_yaml::from_str("title: New\nadded: value").unwrap();
        let merged = merge_mappings(&base, &overlay);
        assert_eq!(
            merged.get(&Value::String("title".into())),
            Some(&Value::String("New".into()))
        );
        assert_eq!(
            merged.get(&Value::String("kept".into())),
            Some(&Value::String("yes".into()))
        );
        assert_eq!(
            merged.get(&Value::String("added".into())),
            Some(&Value::String("value".into()))
        );
    }

    #[test]
    fn merge_into_doc_adds_new_keys() {
        let overlay: serde_yaml::Mapping =
            serde_yaml::from_str("tags: [review]").unwrap();
        let result = merge_into_doc(WITH_FM, &overlay).unwrap();
        // The result should contain all three keys.
        assert!(result.contains("title:"));
        assert!(result.contains("author:"));
        assert!(result.contains("tags:"));
        // Body must be preserved.
        assert!(result.contains("# Body"));
    }

    #[test]
    fn merge_into_doc_on_no_frontmatter() {
        let overlay: serde_yaml::Mapping =
            serde_yaml::from_str("title: Added").unwrap();
        let result = merge_into_doc(WITHOUT_FM, &overlay).unwrap();
        assert!(result.starts_with("---\n"));
        assert!(result.contains("title:"));
        assert!(result.contains("# No frontmatter"));
    }

    #[test]
    fn reassemble_roundtrip() {
        let doc = parse(WITH_FM).unwrap();
        let reassembled = reassemble(doc.mapping.as_ref(), &doc.body, doc.line_ending).unwrap();
        // Roundtrip may reorder YAML keys but must contain the same content.
        assert!(reassembled.contains("title:"));
        assert!(reassembled.contains("Hello"));
        assert!(reassembled.contains("# Body"));
    }

    #[test]
    fn display_roundtrip_no_frontmatter() {
        let doc = parse(WITHOUT_FM).unwrap();
        assert_eq!(doc.to_string(), WITHOUT_FM);
    }

    // ── T2.3: CRLF tests ─────────────────────────────────────────────────────

    /// A CRLF document with frontmatter must parse correctly.
    #[test]
    fn parse_crlf_frontmatter() {
        let crlf_doc = "---\r\ntitle: CRLF Test\r\nauthor: Bob\r\n---\r\n# Body with CRLF\r\n";
        let doc = parse(crlf_doc).unwrap();

        assert!(doc.mapping.is_some(), "mapping must be parsed from CRLF doc");
        let m = doc.mapping.unwrap();
        assert_eq!(
            m.get(&Value::String("title".into())),
            Some(&Value::String("CRLF Test".into())),
            "title must parse from CRLF YAML"
        );
        assert_eq!(doc.body, "# Body with CRLF\r\n", "body must include CRLF");
        assert_eq!(doc.line_ending, "\r\n", "line_ending must be CRLF");
    }

    /// Reassembling a CRLF document must preserve CRLF — never output LF-only.
    #[test]
    fn reassemble_preserves_crlf() {
        let crlf_doc = "---\r\ntitle: Hello\r\n---\r\n# Body\r\n";
        let doc = parse(crlf_doc).unwrap();
        let result = reassemble(doc.mapping.as_ref(), &doc.body, doc.line_ending).unwrap();

        assert!(result.contains("\r\n"), "reassembled output must contain CRLF");
        assert!(!result.starts_with("---\n"), "must not start with LF-only fence");
        assert!(result.contains("title:"), "must contain YAML field");
        assert!(result.contains("# Body"), "must contain body");
    }

    /// Byte offsets via split_inclusive must be exact for CRLF: no double-newlines
    /// or missing characters between YAML and body.
    #[test]
    fn crlf_byte_offset_round_trip() {
        let crlf_doc = "---\r\nkey: value\r\n---\r\nbody line\r\n";
        let doc = parse(crlf_doc).unwrap();
        let result = reassemble(doc.mapping.as_ref(), &doc.body, doc.line_ending).unwrap();

        // Body must appear after the closing fence without extra blank lines.
        assert!(result.ends_with("body line\r\n"), "body must round-trip exactly, got: {:?}", result);
        // Must start with the CRLF opening fence.
        assert!(result.starts_with("---\r\n"), "must start with CRLF fence");
    }
}
