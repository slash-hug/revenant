//! Path canonicalization, confinement, and sidecar path helpers.
//!
//! Architecture decisions implemented here:
//! - A7: Runtime-granted fs scope — Rust core canonicalizes and confines every path.
//! - C13: Sidecar location = next-to-doc, pattern auto-added to .gitignore/.git/info/exclude
//!   on first annotation write.
//! - A12: Idempotent gitignore-entry helper so sidecars never dirty `git status`.

use std::path::{Path, PathBuf};
use std::io::{self, BufRead, Write};
use std::fs;

/// Error type for path operations.
#[derive(Debug, thiserror::Error)]
pub enum PathError {
    #[error("Path is not a valid .md file: {0}")]
    NotMarkdown(PathBuf),

    #[error("Path escapes the allowed directories: {0}")]
    Confined(PathBuf),

    #[error("I/O error: {0}")]
    Io(#[from] io::Error),

    #[error("Path could not be canonicalized: {0}")]
    Canonicalize(PathBuf),
}

/// Canonicalize `path` to an absolute, symlink-resolved form.
/// Returns `PathError::Canonicalize` if the path does not exist.
pub fn canonicalize(path: &Path) -> Result<PathBuf, PathError> {
    fs::canonicalize(path).map_err(|_| PathError::Canonicalize(path.to_path_buf()))
}

/// Return the sidecar annotation path for `doc_path`.
///
/// Per C13: the sidecar lives **next to the document** as
/// `<doc>.md.annotations.json`.
///
/// Example: `/home/user/notes/spec.md` → `/home/user/notes/spec.md.annotations.json`
pub fn sidecar_path(doc_path: &Path) -> PathBuf {
    let mut s = doc_path.as_os_str().to_owned();
    s.push(".annotations.json");
    PathBuf::from(s)
}

/// Validate that `path` is within one of the `allowed_dirs`.
///
/// A7: non-`.md` write targets and paths that escape the allowed set are
/// rejected.  This is called by `file_io` before any read/write.
///
/// `allowed_dirs` should contain **canonicalized** directory paths.
///
/// Safe-by-default against `..` traversal: any `path` containing a parent-dir
/// (`..`) component is rejected up front. The directory match is a lexical
/// `starts_with`, so without this guard a path like `<allowed>/../escape` would
/// satisfy it (the allowed dir is a prefix) while escaping on disk. Folding the
/// check in here closes that lexical gap for any caller reaching this function,
/// instead of relying on each one to pre-check `has_parent_traversal` (#46).
/// Callers passing canonicalized/normalized paths are unaffected (no `..`).
///
/// Scope — this is a *lexical* guard only. It does NOT defend against symlink
/// escapes (callers must `canonicalize` first, which resolves symlinks) nor
/// against code paths that touch the filesystem WITHOUT calling `assert_confined`
/// at all (the `file_io` layer itself is unconfined — confinement is enforced by
/// its `ipc` callers).
pub fn assert_confined(path: &Path, allowed_dirs: &[PathBuf]) -> Result<(), PathError> {
    // Reject parent-directory traversal before the lexical prefix check.
    if has_parent_traversal(path) {
        return Err(PathError::Confined(path.to_path_buf()));
    }
    // Path must already be absolute/canonical for this check to be reliable.
    for dir in allowed_dirs {
        if path.starts_with(dir) {
            return Ok(());
        }
    }
    Err(PathError::Confined(path.to_path_buf()))
}

/// True if `rel` contains a parent-directory (`..`) component.
///
/// Used to reject path-traversal in a user-supplied export subfolder *before* it
/// is joined onto a vault directory: `assert_confined` is a lexical
/// `starts_with` check, so `vault/../escape` would otherwise satisfy it (the
/// vault's own components are a prefix) while escaping the vault on disk.
pub fn has_parent_traversal(rel: &Path) -> bool {
    rel.components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
}

/// Check that `path` has a `.md` extension.
pub fn assert_markdown(path: &Path) -> Result<(), PathError> {
    match path.extension().and_then(|e| e.to_str()) {
        Some("md") => Ok(()),
        _ => Err(PathError::NotMarkdown(path.to_path_buf())),
    }
}

/// Idempotently add the sidecar glob pattern `*.annotations.json` to the
/// nearest `.gitignore` or `.git/info/exclude` so sidecars never appear in
/// `git status`.
///
/// Walk up from `doc_dir` looking for a `.git` directory; if found, append to
/// `.git/info/exclude`.  Failing that, append to the nearest `.gitignore`
/// found while walking up.  If neither exists, create a `.gitignore` in
/// `doc_dir`.
///
/// The function is idempotent: it checks that the pattern is not already
/// present before writing.
pub fn ensure_gitignore_entry(doc_dir: &Path) -> Result<(), PathError> {
    const PATTERN: &str = "*.annotations.json";

    // Walk up to find .git/
    if let Some(git_dir) = find_git_dir(doc_dir) {
        let exclude = git_dir.join("info").join("exclude");
        if let Some(parent) = exclude.parent() {
            fs::create_dir_all(parent)?;
        }
        append_if_missing(&exclude, PATTERN)?;
        return Ok(());
    }

    // No .git found: look for nearest .gitignore or create one.
    if let Some(gitignore) = find_file_walking_up(doc_dir, ".gitignore") {
        append_if_missing(&gitignore, PATTERN)?;
    } else {
        let new_gitignore = doc_dir.join(".gitignore");
        append_if_missing(&new_gitignore, PATTERN)?;
    }

    Ok(())
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/// Walk up from `start` looking for a directory named `.git`.
fn find_git_dir(start: &Path) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    loop {
        let candidate = current.join(".git");
        if candidate.is_dir() {
            return Some(candidate);
        }
        if !current.pop() {
            return None;
        }
    }
}

/// Walk up from `start` looking for a file with the given name.
fn find_file_walking_up(start: &Path, name: &str) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    loop {
        let candidate = current.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
        if !current.pop() {
            return None;
        }
    }
}

/// Append `line` to `file` only if that exact line is not already present.
fn append_if_missing(file: &Path, line: &str) -> Result<(), PathError> {
    // If the file exists, scan it.
    if file.exists() {
        let f = fs::File::open(file)?;
        let reader = io::BufReader::new(f);
        for existing in reader.lines() {
            if existing?.trim() == line {
                return Ok(()); // already present
            }
        }
    }
    // Append (or create).
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)?;
    writeln!(f, "{}", line)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn sidecar_path_appends_suffix() {
        let doc = PathBuf::from("/home/user/notes/spec.md");
        let sidecar = sidecar_path(&doc);
        assert_eq!(sidecar, PathBuf::from("/home/user/notes/spec.md.annotations.json"));
    }

    #[test]
    fn assert_markdown_accepts_md() {
        assert!(assert_markdown(Path::new("foo.md")).is_ok());
    }

    #[test]
    fn assert_markdown_rejects_txt() {
        assert!(assert_markdown(Path::new("foo.txt")).is_err());
    }

    #[test]
    fn assert_markdown_rejects_no_extension() {
        assert!(assert_markdown(Path::new("Makefile")).is_err());
    }

    #[test]
    fn assert_confined_accepts_child() {
        let allowed = vec![PathBuf::from("/home/user/docs")];
        let path = PathBuf::from("/home/user/docs/sub/file.md");
        assert!(assert_confined(&path, &allowed).is_ok());
    }

    #[test]
    fn assert_confined_rejects_escape() {
        let allowed = vec![PathBuf::from("/home/user/docs")];
        let path = PathBuf::from("/home/other/file.md");
        assert!(assert_confined(&path, &allowed).is_err());
    }

    #[test]
    fn has_parent_traversal_detects_dotdot() {
        assert!(has_parent_traversal(Path::new("../escape/file.md")));
        assert!(has_parent_traversal(Path::new("sub/../../escape.md")));
        assert!(!has_parent_traversal(Path::new("sub/folder/file.md")));
        assert!(!has_parent_traversal(Path::new("file.md")));
    }

    #[test]
    fn assert_confined_rejects_dotdot_even_when_prefix_matches() {
        // A `..` escape lexically shares the vault's leading components, so the
        // bare starts_with check would pass it. assert_confined now rejects any
        // path containing `..` up front, so safety no longer depends on every
        // caller pre-checking has_parent_traversal (#46).
        let vault = PathBuf::from("/home/user/vault");
        let escaping = vault.join("../secret/file.md");
        assert!(
            assert_confined(&escaping, &[vault]).is_err(),
            "a `..` traversal must be rejected even though it prefix-matches the vault"
        );
    }

    #[test]
    fn assert_confined_rejects_bare_dotdot_relative_path() {
        // Even with no matching allowed dir, a `..` path is rejected as Confined
        // (not silently falling through to the prefix loop).
        let allowed = vec![PathBuf::from("/home/user/docs")];
        assert!(assert_confined(Path::new("../escape.md"), &allowed).is_err());
        assert!(assert_confined(Path::new("/home/user/docs/sub/../../etc/x.md"), &allowed).is_err());
    }

    #[test]
    fn ensure_gitignore_entry_creates_gitignore() {
        let dir = TempDir::new().unwrap();
        ensure_gitignore_entry(dir.path()).unwrap();
        let gitignore = dir.path().join(".gitignore");
        assert!(gitignore.exists());
        let contents = fs::read_to_string(&gitignore).unwrap();
        assert!(contents.contains("*.annotations.json"));
    }

    #[test]
    fn ensure_gitignore_entry_is_idempotent() {
        let dir = TempDir::new().unwrap();
        ensure_gitignore_entry(dir.path()).unwrap();
        ensure_gitignore_entry(dir.path()).unwrap(); // second call
        let gitignore = dir.path().join(".gitignore");
        let contents = fs::read_to_string(&gitignore).unwrap();
        let count = contents.matches("*.annotations.json").count();
        assert_eq!(count, 1, "pattern must appear exactly once");
    }

    #[test]
    fn ensure_gitignore_entry_uses_git_info_exclude_when_git_present() {
        let dir = TempDir::new().unwrap();
        let git_dir = dir.path().join(".git");
        let info_dir = git_dir.join("info");
        fs::create_dir_all(&info_dir).unwrap();
        // Create a minimal exclude file
        fs::write(info_dir.join("exclude"), "").unwrap();

        ensure_gitignore_entry(dir.path()).unwrap();
        let exclude = info_dir.join("exclude");
        let contents = fs::read_to_string(&exclude).unwrap();
        assert!(contents.contains("*.annotations.json"));
        // .gitignore should NOT have been created
        assert!(!dir.path().join(".gitignore").exists());
    }
}
