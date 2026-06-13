/// Library root — owned by WS-A; this stub satisfies the compiler
/// while WS-D modules are being developed.
pub mod frontmatter; // WS-B implements; WS-D consumes via crate::frontmatter
pub mod settings;    // WS-D
pub mod secrets;     // WS-D
pub mod obsidian;    // WS-D

#[cfg(test)]
pub mod tests;
