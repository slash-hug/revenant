/// Frontmatter module stub — implemented by WS-B (frontmatter.rs).
/// WS-D consumes this module; do not edit the real implementation here.
///
/// This stub satisfies the compiler for WS-D development.
/// WS-B will replace the bodies while keeping the same public signatures.
use serde_json::Value;
use std::collections::HashMap;

/// Parsed frontmatter: key → JSON value.
pub type Frontmatter = HashMap<String, Value>;

/// Parse YAML frontmatter from markdown text.
/// Returns (frontmatter, body_without_fence) or (empty map, original text).
pub fn parse(markdown: &str) -> (Frontmatter, String) {
    let stripped = markdown.strip_prefix("---\n").unwrap_or(markdown);
    if let Some(end) = stripped.find("\n---\n") {
        let yaml_block = &stripped[..end];
        let body = &stripped[end + 5..];
        let fm: Frontmatter = serde_yaml::from_str(yaml_block).unwrap_or_default();
        return (fm, body.to_string());
    }
    (HashMap::new(), markdown.to_string())
}

/// Merge `incoming` frontmatter into `base`, returning the combined map.
/// Incoming values overwrite base values for the same key.
pub fn merge(base: &Frontmatter, incoming: &Frontmatter) -> Frontmatter {
    let mut result = base.clone();
    for (k, v) in incoming {
        result.insert(k.clone(), v.clone());
    }
    result
}

/// Render a frontmatter map + markdown body back into a complete document string.
pub fn render(fm: &Frontmatter, body: &str) -> String {
    if fm.is_empty() {
        return body.to_string();
    }
    let yaml = serde_yaml::to_string(fm).unwrap_or_default();
    format!("---\n{yaml}---\n{body}")
}
