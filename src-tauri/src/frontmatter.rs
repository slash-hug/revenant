//! YAML frontmatter parse and merge helpers.
//!
//! Used by:
//! - Preview pane header rendering (WS-C via IPC)
//! - Obsidian exporter frontmatter merge (WS-D / obsidian.rs via `crate::frontmatter`)
//!
//! Format: a document optionally starts with `---\n…\n---\n` (YAML block).
//! This module parses that block into a `serde_yaml::Mapping`, provides helpers
//! to merge two mappings (overlay takes precedence), and reassembles the
//! document.

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
    /// The markdown body (everything after the closing `---` line).
    pub body: String,
}

impl fmt::Display for ParsedDoc {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(raw) = &self.raw_yaml {
            writeln!(f, "---")?;
            write!(f, "{}", raw)?;
            if !raw.ends_with('\n') {
                writeln!(f)?;
            }
            writeln!(f, "---")?;
        }
        write!(f, "{}", self.body)
    }
}

/// Split a markdown document into frontmatter + body.
///
/// Returns a `ParsedDoc` whether or not frontmatter is present.
/// The `mapping` field is `None` when the document has no `---` block or the
/// block is empty.
pub fn parse(content: &str) -> Result<ParsedDoc, FrontmatterError> {
    if let Some(rest) = content.strip_prefix("---\n") {
        // Find the closing delimiter.
        if let Some(close_pos) = find_close_delimiter(rest) {
            let raw_yaml = &rest[..close_pos];
            // +4 = length of "---\n"
            let body_start = close_pos + 4;
            let body = if body_start < rest.len() {
                rest[body_start..].to_string()
            } else {
                String::new()
            };

            let mapping: Option<serde_yaml::Mapping> = if raw_yaml.trim().is_empty() {
                None
            } else {
                let val: Value = serde_yaml::from_str(raw_yaml)?;
                match val {
                    Value::Mapping(m) => Some(m),
                    _ => None,
                }
            };

            return Ok(ParsedDoc {
                raw_yaml: Some(raw_yaml.to_string()),
                mapping,
                body,
            });
        }
    }

    // No frontmatter found.
    Ok(ParsedDoc {
        raw_yaml: None,
        mapping: None,
        body: content.to_string(),
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
/// Serializes the mapping back to YAML and wraps it in `---` delimiters.
/// If `mapping` is `None`, returns `body` unchanged.
pub fn reassemble(
    mapping: Option<&serde_yaml::Mapping>,
    body: &str,
) -> Result<String, FrontmatterError> {
    match mapping {
        None => Ok(body.to_string()),
        Some(m) => {
            let yaml = serde_yaml::to_string(&Value::Mapping(m.clone()))?;
            Ok(format!("---\n{}---\n{}", yaml, body))
        }
    }
}

/// Apply an overlay frontmatter mapping onto a full markdown document string.
///
/// Parses existing frontmatter (if any), merges with `overlay` (overlay wins on
/// conflicts), and returns the reassembled document.
pub fn merge_into_doc(
    content: &str,
    overlay: &serde_yaml::Mapping,
) -> Result<String, FrontmatterError> {
    let parsed = parse(content)?;
    let merged = match &parsed.mapping {
        Some(base) => merge_mappings(base, overlay),
        None => overlay.clone(),
    };
    reassemble(Some(&merged), &parsed.body)
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/// Find the position of the closing `---\n` (or `---` at end-of-string) within
/// the text *after* the opening `---\n` has been stripped.
///
/// Returns the byte offset of the start of `---\n` within `rest`.
fn find_close_delimiter(rest: &str) -> Option<usize> {
    let mut pos = 0;
    for line in rest.lines() {
        if line == "---" {
            return Some(pos);
        }
        pos += line.len() + 1; // +1 for '\n'
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
        let reassembled = reassemble(doc.mapping.as_ref(), &doc.body).unwrap();
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
}
