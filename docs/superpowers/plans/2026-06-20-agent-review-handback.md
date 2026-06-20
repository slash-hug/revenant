# Agent Review Handback — "Send to agent" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Send to agent" flow that, on click, writes the review file (existing `generate_review`) and copies a configurable one-line nudge to the clipboard so the user can paste it into a running Claude Code / Copilot CLI session and the agent reads `<doc>.md.review.md`.

**Architecture:** Wrap the existing `generate_review` IPC with a clipboard step. Rust extends `ReviewResult` with canonical + repo-relative paths (computed via a new `paths::repo_relative` helper). The frontend builds the nudge from two new settings (`agent_nudge_template`, `agent_nudge_path_style`) via a pure `agentNudge.ts` module and writes it with the official Tauri clipboard plugin. One-way consume in v1; format kept round-trip-ready. Approach B (local MCP pull tool) is parked in issue #97.

**Tech Stack:** Rust (Tauri 2, serde, thiserror), Svelte 5 + TypeScript, Vitest (jsdom), `@tauri-apps/plugin-clipboard-manager` (new), `cargo test`.

**Spec:** `docs/superpowers/specs/2026-06-20-agent-review-handback-design.md`

## Global Constraints

- **Schema stays version 1.** New settings fields are additive with serde defaults so older `settings.json` loads unchanged. Do NOT bump `schema_version`.
- **Agent-agnostic (TRAP 2).** No "Claude", "Copilot", or any assistant name in button labels, the default nudge template, the slash-command name, or any output. The word "agent" is fine.
- **IPC freeze.** Changing the `ReviewResult` return shape requires updating BOTH `src-tauri/src/ipc.rs` and `src/lib/types/ipc.ts`. No new commands, no new args.
- **`set_settings_preserving_ref` rebuilds `Settings` field-by-field** (`settings.rs:257-268`). Every new field MUST be added there too, or it is silently dropped on every settings save.
- **Scoped ACL.** Grant only `clipboard-manager:allow-write-text` in `capabilities/default.json` — no clipboard read, no blanket grant.
- **New dependency.** `@tauri-apps/plugin-clipboard-manager` (npm) + `tauri-plugin-clipboard-manager` (Cargo) — the official Tauri plugin; note it in the final summary.
- **Gates.** Frontend: `npm run verify` (check + test + build). Rust: `cargo test --manifest-path src-tauri/Cargo.toml`. Both must pass before a task is done.
- **DEFAULT_NUDGE_TEMPLATE** is duplicated in Rust (`default_agent_nudge_template`) and TS (`agentNudge.ts`). Keep the two strings byte-identical; each references the other in a comment.

---

### Task 1: `paths::repo_relative` helper

**Files:**
- Modify: `src-tauri/src/paths.rs` (add public fn + tests near the existing `find_git_dir`)

**Interfaces:**
- Consumes: existing private `find_git_dir(start: &Path) -> Option<PathBuf>` (`paths.rs:147`).
- Produces: `pub fn repo_relative(path: &Path) -> Option<String>` — path relative to the nearest git root (the directory containing `.git`) with forward slashes; `None` if no `.git` ancestor exists. Used by Task 2.

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block in `src-tauri/src/paths.rs`:

```rust
    #[test]
    fn repo_relative_returns_path_from_git_root() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        let docs = dir.path().join("docs");
        fs::create_dir(&docs).unwrap();
        let doc = docs.join("spec.md");
        fs::write(&doc, "# hi").unwrap();

        assert_eq!(repo_relative(&doc).as_deref(), Some("docs/spec.md"));
    }

    #[test]
    fn repo_relative_returns_none_outside_repo() {
        let dir = TempDir::new().unwrap();
        let doc = dir.path().join("spec.md");
        fs::write(&doc, "# hi").unwrap();
        // No .git anywhere above a fresh TempDir.
        assert_eq!(repo_relative(&doc), None);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml repo_relative`
Expected: FAIL — `cannot find function repo_relative in this scope`.

- [ ] **Step 3: Implement `repo_relative`**

Add after `find_git_dir` (around `paths.rs:158`):

```rust
/// Return `path` expressed relative to the nearest git repository root (the
/// directory that contains `.git`), using forward slashes. `None` if `path`
/// has no `.git` ancestor.
///
/// `path` should be absolute/canonical (callers pass canonicalized paths); the
/// relative form is what goes into the agent nudge so a pasted prompt stays
/// repo-portable and doesn't leak the user's home directory.
pub fn repo_relative(path: &Path) -> Option<String> {
    // Walk up from the path's own directory looking for `.git`.
    let start = if path.is_dir() { path } else { path.parent()? };
    let git_dir = find_git_dir(start)?;
    let root = git_dir.parent()?; // directory containing `.git`
    let rel = path.strip_prefix(root).ok()?;
    Some(rel.to_string_lossy().replace('\\', "/"))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml repo_relative`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/paths.rs
git commit -m "feat(paths): repo_relative helper for nudge paths (#97 follow-up)"
```

---

### Task 2: Extend `ReviewResult` with canonical + relative paths

**Files:**
- Modify: `src-tauri/src/ipc.rs:121-125` (struct), `:737-775` (command — extract `resolve_review_paths`)
- Modify: `src/lib/types/ipc.ts:111-114` (TS mirror)

**Interfaces:**
- Consumes: `paths::repo_relative` (Task 1).
- Produces: `ReviewResult { review_path, doc_path, review_path_rel: Option<String>, doc_path_rel: Option<String> }`; sync helper `fn resolve_review_paths(doc_path: &str) -> IpcResult<(PathBuf, ReviewResult)>`. Used by Task 6.

- [ ] **Step 1: Write the failing test**

Add a test module at the bottom of `src-tauri/src/ipc.rs` (or extend an existing `#[cfg(test)] mod` if present):

```rust
#[cfg(test)]
mod review_path_tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn resolve_review_paths_includes_relative_forms() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        let docs = dir.path().join("docs");
        std::fs::create_dir(&docs).unwrap();
        let doc = docs.join("spec.md");
        std::fs::write(&doc, "# hi").unwrap();

        let (review_path, result) =
            resolve_review_paths(&doc.to_string_lossy()).unwrap();

        assert!(review_path.to_string_lossy().ends_with("spec.md.review.md"));
        assert_eq!(result.doc_path_rel.as_deref(), Some("docs/spec.md"));
        assert_eq!(
            result.review_path_rel.as_deref(),
            Some("docs/spec.md.review.md")
        );
        assert!(result.doc_path.ends_with("spec.md"));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml resolve_review_paths`
Expected: FAIL — `cannot find function resolve_review_paths` and missing struct fields.

- [ ] **Step 3: Extend the struct**

Replace `ipc.rs:121-125`:

```rust
/// Result of generate_review — paths used to build the agent nudge.
#[derive(Debug, Serialize, Deserialize)]
pub struct ReviewResult {
    /// Canonical absolute path of the written `<doc>.md.review.md`.
    pub review_path: String,
    /// Canonical absolute path of the reviewed document.
    pub doc_path: String,
    /// Review path relative to the nearest git root; None if not in a repo.
    pub review_path_rel: Option<String>,
    /// Doc path relative to the nearest git root; None if not in a repo.
    pub doc_path_rel: Option<String>,
}
```

- [ ] **Step 4: Extract `resolve_review_paths` and call it from `generate_review`**

Replace the body of `generate_review` (`ipc.rs:737-775`) with:

```rust
/// Canonicalize the doc, derive the `<doc>.review.md` target, confine it, and
/// build the ReviewResult. Pure of the file write so it is unit-testable
/// without an async runtime.
fn resolve_review_paths(doc_path: &str) -> IpcResult<(std::path::PathBuf, ReviewResult)> {
    let doc_p = std::path::Path::new(doc_path);
    crate::paths::assert_markdown(doc_p)
        .map_err(|e| IpcError { code: "NOT_MARKDOWN".into(), message: e.to_string() })?;
    let canon_doc = std::fs::canonicalize(doc_p)
        .map_err(|e| IpcError { code: "IO_ERROR".into(), message: e.to_string() })?;

    let mut review_os = canon_doc.as_os_str().to_owned();
    review_os.push(".review.md");
    let review_path = std::path::PathBuf::from(review_os);

    let doc_dir = canon_doc.parent().ok_or_else(|| IpcError {
        code: "PATH_CONFINED".into(),
        message: "document has no parent directory".into(),
    })?;
    crate::paths::assert_confined(&review_path, &[doc_dir.to_path_buf()])
        .map_err(|e| IpcError { code: "PATH_CONFINED".into(), message: e.to_string() })?;

    let result = ReviewResult {
        review_path: review_path.to_string_lossy().into_owned(),
        doc_path: canon_doc.to_string_lossy().into_owned(),
        review_path_rel: crate::paths::repo_relative(&review_path),
        doc_path_rel: crate::paths::repo_relative(&canon_doc),
    };
    Ok((review_path, result))
}

/// Write a pre-formatted review markdown file beside the document.
/// Frontend (ReviewExporter.ts) builds the markdown payload.
#[tauri::command]
pub async fn generate_review(payload: ReviewPayload) -> IpcResult<ReviewResult> {
    // Canonicalize + write the .review.md — blocking fs, offloaded (perf #28).
    tauri::async_runtime::spawn_blocking(move || -> IpcResult<ReviewResult> {
        let (review_path, result) = resolve_review_paths(&payload.doc_path)?;
        std::fs::write(&review_path, payload.markdown.as_bytes())
            .map_err(|e| IpcError { code: "IO_ERROR".into(), message: e.to_string() })?;
        Ok(result)
    })
    .await
    .map_err(task_err)?
}
```

- [ ] **Step 5: Update the TS mirror**

Replace `src/lib/types/ipc.ts:111-114`:

```ts
/** Result of generate_review — paths used to build the agent nudge. */
export interface ReviewResult {
  /** Canonical absolute path of the written <doc>.md.review.md. */
  review_path: string;
  /** Canonical absolute path of the reviewed document. */
  doc_path: string;
  /** Review path relative to the nearest git root; null if not in a repo. */
  review_path_rel: string | null;
  /** Doc path relative to the nearest git root; null if not in a repo. */
  doc_path_rel: string | null;
}
```

- [ ] **Step 6: Run the Rust test + typecheck**

Run: `cargo test --manifest-path src-tauri/Cargo.toml resolve_review_paths`
Expected: PASS.
Run: `npm run check`
Expected: PASS (no type errors).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/ipc.rs src/lib/types/ipc.ts
git commit -m "feat(ipc): ReviewResult carries canonical + repo-relative paths"
```

---

### Task 3: Two new settings fields (`agent_nudge_template`, `agent_nudge_path_style`)

**Files:**
- Modify: `src-tauri/src/settings.rs` (struct, defaults, `Default`, `set_settings_preserving_ref`)
- Modify: `src-tauri/src/tests/settings_tests.rs` (tests)
- Modify: `src/lib/types/ipc.ts:62-80` (Settings interface)

**Interfaces:**
- Produces: `Settings.agent_nudge_template: String` (default = the nudge template), `Settings.agent_nudge_path_style: String` (`"relative"` | `"absolute"`, default `"relative"`). Consumed by Tasks 5 & 6.

- [ ] **Step 1: Write the failing tests**

Add to `src-tauri/src/tests/settings_tests.rs`:

```rust
#[test]
fn defaults_include_agent_nudge_fields() {
    let s = crate::settings::Settings::default();
    assert_eq!(s.agent_nudge_path_style, "relative");
    assert!(s.agent_nudge_template.contains("{review_path}"));
    assert!(s.agent_nudge_template.contains("{doc_path}"));
}

#[test]
fn old_settings_json_without_agent_fields_loads_with_defaults() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("settings.json");
    // A v1 file written before these fields existed.
    std::fs::write(
        &path,
        r#"{"schema_version":1,"vaults":[],"default_export_subfolder":"",
            "theme":"system","export_on_save":false,"rest_key_ref":null,
            "preview_zoom":100}"#,
    )
    .unwrap();

    let loaded = crate::settings::get_settings(&path).unwrap();
    assert_eq!(loaded.agent_nudge_path_style, "relative");
    assert!(loaded.agent_nudge_template.contains("{review_path}"));
}

#[test]
fn preserving_ref_keeps_agent_fields() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("settings.json");
    let mut s = crate::settings::Settings::default();
    s.agent_nudge_template = "custom {doc_path}".to_string();
    s.agent_nudge_path_style = "absolute".to_string();
    crate::settings::set_settings_preserving_ref(&path, s).unwrap();

    let loaded = crate::settings::get_settings(&path).unwrap();
    assert_eq!(loaded.agent_nudge_template, "custom {doc_path}");
    assert_eq!(loaded.agent_nudge_path_style, "absolute");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml agent_nudge`
Expected: FAIL — missing fields `agent_nudge_template` / `agent_nudge_path_style`.

- [ ] **Step 3: Add the fields, defaults, and `Default` impl**

In `src-tauri/src/settings.rs`, after `default_preview_zoom` (`:24-26`) add:

```rust
/// Default one-line nudge copied to the clipboard on "Send to agent".
/// MUST stay byte-identical to DEFAULT_NUDGE_TEMPLATE in src/lib/agentNudge.ts.
fn default_agent_nudge_template() -> String {
    "Apply the review comments in `{review_path}` to `{doc_path}`, then summarize what you changed.".to_string()
}

/// Default path form used in the nudge: "relative" (to git root) or "absolute".
fn default_agent_nudge_path_style() -> String {
    "relative".to_string()
}
```

Add to the `Settings` struct after `preview_zoom` (`:57`):

```rust
    /// Template for the clipboard nudge built on "Send to agent".
    /// Placeholders: `{review_path}`, `{doc_path}`.
    #[serde(default = "default_agent_nudge_template")]
    pub agent_nudge_template: String,

    /// Path form used in the nudge: "relative" (to git root) or "absolute".
    #[serde(default = "default_agent_nudge_path_style")]
    pub agent_nudge_path_style: String,
```

Add to the `Default` impl after `preview_zoom: 100,` (`:69`):

```rust
            agent_nudge_template: default_agent_nudge_template(),
            agent_nudge_path_style: default_agent_nudge_path_style(),
```

- [ ] **Step 4: Add the fields to `set_settings_preserving_ref`**

In the `merged` struct literal (`settings.rs:257-268`), after `preview_zoom: incoming.preview_zoom,` add:

```rust
        agent_nudge_template: incoming.agent_nudge_template,
        agent_nudge_path_style: incoming.agent_nudge_path_style,
```

- [ ] **Step 5: Update the TS Settings mirror**

In `src/lib/types/ipc.ts`, inside `interface Settings` after `preview_zoom: number;` (`:79`):

```ts
  /** Clipboard nudge template. Placeholders: {review_path}, {doc_path}. */
  agent_nudge_template: string;
  /** Path form used in the nudge. */
  agent_nudge_path_style: "relative" | "absolute";
```

- [ ] **Step 6: Run tests + typecheck**

Run: `cargo test --manifest-path src-tauri/Cargo.toml settings`
Expected: PASS (including the 3 new tests).
Run: `npm run check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/settings.rs src-tauri/src/tests/settings_tests.rs src/lib/types/ipc.ts
git commit -m "feat(settings): add agent_nudge_template + agent_nudge_path_style"
```

---

### Task 4: `agentNudge.ts` pure builder

**Files:**
- Create: `src/lib/agentNudge.ts`
- Create: `src/tests/agent_nudge.test.ts`

**Interfaces:**
- Produces: `DEFAULT_NUDGE_TEMPLATE: string`; `buildNudge(template, style, paths): string`; types `NudgePathStyle`, `NudgePaths`. Used by Task 6.

- [ ] **Step 1: Write the failing test**

Create `src/tests/agent_nudge.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildNudge, DEFAULT_NUDGE_TEMPLATE } from '../lib/agentNudge';

const paths = {
  reviewAbs: '/home/u/repo/docs/spec.md.review.md',
  reviewRel: 'docs/spec.md.review.md',
  docAbs: '/home/u/repo/docs/spec.md',
  docRel: 'docs/spec.md',
};

describe('buildNudge', () => {
  it('substitutes both placeholders with relative paths', () => {
    const out = buildNudge(DEFAULT_NUDGE_TEMPLATE, 'relative', paths);
    expect(out).toContain('docs/spec.md.review.md');
    expect(out).toContain('docs/spec.md');
    expect(out).not.toContain('/home/u/repo');
  });

  it('uses absolute paths when style is absolute', () => {
    const out = buildNudge(DEFAULT_NUDGE_TEMPLATE, 'absolute', paths);
    expect(out).toContain('/home/u/repo/docs/spec.md.review.md');
  });

  it('falls back to absolute when the relative form is null', () => {
    const out = buildNudge(DEFAULT_NUDGE_TEMPLATE, 'relative', {
      ...paths,
      reviewRel: null,
      docRel: null,
    });
    expect(out).toContain('/home/u/repo/docs/spec.md');
  });

  it('replaces every occurrence of a placeholder', () => {
    const out = buildNudge('{doc_path} and again {doc_path}', 'relative', paths);
    expect(out).toBe('docs/spec.md and again docs/spec.md');
  });

  it('default template names no AI assistant (agent-agnostic)', () => {
    expect(DEFAULT_NUDGE_TEMPLATE.toLowerCase()).not.toMatch(/claude|copilot|gpt|gemini/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- agent_nudge`
Expected: FAIL — cannot resolve `../lib/agentNudge`.

- [ ] **Step 3: Implement the module**

Create `src/lib/agentNudge.ts`:

```ts
/**
 * agentNudge.ts — builds the one-line clipboard "nudge" copied on "Send to
 * agent". The user pastes it into a running CLI agent session; the agent reads
 * the referenced <doc>.md.review.md and applies the comments.
 *
 * Agent-agnostic (TRAP 2): no assistant name appears here or in the default
 * template. Approach B (autonomous MCP pull) is tracked in issue #97.
 */

export type NudgePathStyle = 'relative' | 'absolute';

export interface NudgePaths {
  reviewAbs: string;
  reviewRel: string | null;
  docAbs: string;
  docRel: string | null;
}

/**
 * Default nudge template. MUST stay byte-identical to
 * `default_agent_nudge_template` in src-tauri/src/settings.rs.
 */
export const DEFAULT_NUDGE_TEMPLATE =
  'Apply the review comments in `{review_path}` to `{doc_path}`, then summarize what you changed.';

/**
 * Fill `{review_path}` / `{doc_path}` in `template`, choosing the path form per
 * `style`. Falls back to the absolute path when the relative form is null
 * (document not inside a git repo).
 */
export function buildNudge(
  template: string,
  style: NudgePathStyle,
  paths: NudgePaths,
): string {
  const review = style === 'relative' ? paths.reviewRel ?? paths.reviewAbs : paths.reviewAbs;
  const doc = style === 'relative' ? paths.docRel ?? paths.docAbs : paths.docAbs;
  return template.replaceAll('{review_path}', review).replaceAll('{doc_path}', doc);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- agent_nudge`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/agentNudge.ts src/tests/agent_nudge.test.ts
git commit -m "feat: agentNudge.ts pure clipboard-nudge builder"
```

---

### Task 5: Settings UI — "Agent" section

**Files:**
- Create: `src/lib/settings/AgentSection.svelte`
- Modify: `src/lib/SettingsPage.svelte` (add category) + `:27` deep-link union
- Modify: `src/App.svelte` (the `openSettings` category type, if it narrows the union — verify)

**Interfaces:**
- Consumes: `settings` store + `patchSettings` (`src/lib/stores/settings.ts`), `DEFAULT_NUDGE_TEMPLATE` (Task 4), `SettingGroup`/`SettingRow`.
- Produces: a new settings category `'agent'`.

- [ ] **Step 1: Create the section component**

Create `src/lib/settings/AgentSection.svelte` (mirrors `AppearanceSection.svelte` idioms):

```svelte
<script lang="ts">
  /**
   * AgentSection.svelte — "Send to agent" handback settings.
   * Lets the user edit the clipboard nudge template and choose whether paths
   * are repo-relative or absolute. Agent-agnostic (TRAP 2). See issue #97.
   */
  import SettingGroup from './SettingGroup.svelte';
  import SettingRow from './SettingRow.svelte';
  import { settings, patchSettings } from '../stores/settings';
  import { DEFAULT_NUDGE_TEMPLATE } from '../agentNudge';

  function onTemplateChange(e: Event) {
    const value = (e.target as HTMLTextAreaElement).value;
    patchSettings({ agent_nudge_template: value });
  }

  function onStyleChange(style: 'relative' | 'absolute') {
    patchSettings({ agent_nudge_path_style: style });
  }

  function resetTemplate() {
    patchSettings({ agent_nudge_template: DEFAULT_NUDGE_TEMPLATE });
  }
</script>

<SettingGroup label="Agent handback">
  <SettingRow
    label="Clipboard nudge"
    helper="Copied to your clipboard when you Send to agent. Placeholders: {'{review_path}'} and {'{doc_path}'}."
  >
    <div class="nudge-field">
      <textarea
        class="nudge-template"
        rows="3"
        value={$settings?.agent_nudge_template ?? DEFAULT_NUDGE_TEMPLATE}
        on:change={onTemplateChange}
        aria-label="Clipboard nudge template"
      ></textarea>
      <button type="button" class="reset-btn" on:click={resetTemplate}>
        Reset to default
      </button>
    </div>
  </SettingRow>

  <SettingRow
    label="Path style"
    helper="How file paths appear in the nudge. Relative keeps them repo-portable."
  >
    <div class="seg" role="group" aria-label="Nudge path style">
      <button
        type="button"
        class:active={($settings?.agent_nudge_path_style ?? 'relative') === 'relative'}
        aria-pressed={($settings?.agent_nudge_path_style ?? 'relative') === 'relative'}
        on:click={() => onStyleChange('relative')}
      >Relative</button>
      <button
        type="button"
        class:active={$settings?.agent_nudge_path_style === 'absolute'}
        aria-pressed={$settings?.agent_nudge_path_style === 'absolute'}
        on:click={() => onStyleChange('absolute')}
      >Absolute</button>
    </div>
  </SettingRow>
</SettingGroup>

<style>
  .nudge-field { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
  .nudge-template {
    width: 360px; max-width: 100%;
    font: inherit; font-size: var(--fs-sm); font-family: var(--font-mono);
    padding: 8px 10px; border-radius: var(--r-md);
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text);
    resize: vertical;
  }
  .reset-btn {
    font: inherit; font-size: var(--fs-sm); cursor: pointer;
    background: transparent; border: none; color: var(--accent-text); padding: 0;
  }
  .reset-btn:hover { text-decoration: underline; }
  .seg {
    display: inline-flex; gap: 2px; padding: 3px;
    border-radius: var(--r-md); background: var(--surface-2); border: 1px solid var(--border);
  }
  .seg button {
    font: inherit; font-size: var(--fs-sm); font-weight: var(--fw-medium);
    cursor: pointer; padding: 5px 13px; border-radius: var(--r-sm);
    border: none; background: transparent; color: var(--text-muted);
  }
  .seg button:hover { color: var(--text); }
  .seg button.active { background: var(--surface); color: var(--text); box-shadow: var(--shadow-sm); }
</style>
```

- [ ] **Step 2: Register the category in SettingsPage**

In `src/lib/SettingsPage.svelte`: add the import beside the others (`:23-25`):

```ts
  import AgentSection from './settings/AgentSection.svelte';
```

Widen the deep-link union (`:27`) and the `cats` array (`:34-37`):

```ts
  export let category: 'general' | 'integrations' | 'agent' | 'about' = 'general';
```
```ts
    { id: 'general', label: 'General', component: AppearanceSection },
    { id: 'integrations', label: 'Integrations', component: ObsidianSection },
    { id: 'agent', label: 'Agent', component: AgentSection },
    { id: 'about', label: 'About', component: AboutSection },
```

- [ ] **Step 3: Widen the `openSettings` category type if needed**

Run: `grep -n "openSettings\|'general' | 'integrations'" src/App.svelte`
If `App.svelte` declares the category union (e.g. `function openSettings(category: 'general' | 'integrations' | 'about')`), add `'agent'` to that union too so `npm run check` passes. If it passes a plain string, no change needed.

- [ ] **Step 4: Verify typecheck + build**

Run: `npm run check`
Expected: PASS — no type errors; the `'agent'` category is accepted everywhere the union is used.

- [ ] **Step 5: Commit**

```bash
git add src/lib/settings/AgentSection.svelte src/lib/SettingsPage.svelte src/App.svelte
git commit -m "feat(settings): Agent handback settings section (nudge template + path style)"
```

---

### Task 6: Wire "Send to agent" — clipboard plugin + handler + button

**Files:**
- Modify: `src-tauri/Cargo.toml` (dependency), `src-tauri/src/lib.rs:197` (plugin init)
- Modify: `src-tauri/capabilities/default.json:6-9` (permission)
- Modify: `package.json` (npm dependency — via `npm install`)
- Modify: `src/lib/ReviewExporter.ts:172-177` (return the IPC `ReviewResult`)
- Modify: `src/App.svelte:336-359` (build + copy nudge)
- Modify: `src/lib/Toolbar.svelte:202` + `:191` (relabel button + tooltip)

**Interfaces:**
- Consumes: `ReviewResult` (Task 2), `buildNudge` + `DEFAULT_NUDGE_TEMPLATE` (Task 4), `settings` store (Task 3), clipboard plugin `writeText`.

- [ ] **Step 1: Add the clipboard plugin (Rust + npm)**

Add to `src-tauri/Cargo.toml` under `[dependencies]` (match the existing `tauri-plugin-*` version line style, e.g. `2`):

```toml
tauri-plugin-clipboard-manager = "2"
```

Register it in `src-tauri/src/lib.rs` right after `tauri_plugin_opener` (`:197`):

```rust
        .plugin(tauri_plugin_clipboard_manager::init())
```

Install the JS binding:

```bash
npm install @tauri-apps/plugin-clipboard-manager
```

- [ ] **Step 2: Grant the scoped clipboard permission**

In `src-tauri/capabilities/default.json`, add to the `"permissions"` array (after `"dialog:allow-save"`, `:9`):

```json
    "clipboard-manager:allow-write-text",
```

- [ ] **Step 3: Make `ReviewExporter.generateReview` return the IPC result**

Replace `src/lib/ReviewExporter.ts:172-177`:

```ts
export async function generateReview(
  sidecar: Sidecar,
  docPath: string,
): Promise<ReviewResult> {
  const payload = formatReview(sidecar, docPath);
  // Use the typed IPC wrapper which sends { payload: { doc_path, markdown } }.
  return ipcGenerateReview({ doc_path: docPath, markdown: payload.markdown });
}
```

Add `ReviewResult` to the import on `ReviewExporter.ts:15-16`:

```ts
import type { Annotation, Sidecar, ReviewResult } from './types/ipc';
```

(Grep first: `grep -rn "generateReview(" src/tests` — if a test asserts on the old `ReviewPayload` return of this wrapper, update it to assert on `formatReview` instead. The `review_exporter.test.ts` suite targets `formatReview`, which is unchanged.)

- [ ] **Step 4: Build + copy the nudge in the handler**

Add imports to `src/App.svelte` (beside the ReviewExporter import, `:48`):

```ts
  import { writeText } from '@tauri-apps/plugin-clipboard-manager';
  import { buildNudge, DEFAULT_NUDGE_TEMPLATE } from './lib/agentNudge';
```

Replace the `try` block inside `handleGenerateReview` (`App.svelte:351-358`):

```ts
    busyAction = 'review';
    try {
      const result = await generateReview(sidecar, tab.path);
      const cfg = $settings;
      const template = cfg?.agent_nudge_template || DEFAULT_NUDGE_TEMPLATE;
      const style = cfg?.agent_nudge_path_style ?? 'relative';
      const nudge = buildNudge(template, style, {
        reviewAbs: result.review_path,
        reviewRel: result.review_path_rel,
        docAbs: result.doc_path,
        docRel: result.doc_path_rel,
      });
      try {
        await writeText(nudge);
        showToast(`Review written · nudge copied — paste into your agent`);
      } catch {
        // Clipboard failed (rare): the file is still written, so don't block.
        showToast(`Review written: ${basename(tab.path)}.review.md (clipboard unavailable)`);
      }
    } catch (err) {
      showToast(`Send to agent failed: ${errMessage(err)}`);
    } finally {
      busyAction = null;
    }
```

- [ ] **Step 5: Relabel the Toolbar button**

In `src/lib/Toolbar.svelte`, change the button label (`:202`) from `Generate review` to:

```
        Send to agent
```

And the tooltip (`:191`):

```
      title="Write a .review.md and copy a paste-ready nudge for your agent (⌘⇧R)"
```

(Leave the `generateReview` event name and `handleGenerateReview` as-is — internal names; only the user-facing strings change. The disabled-when-empty guard in `handleGenerateReview:340-343` already covers the no-annotation case.)

- [ ] **Step 6: Verify the full frontend + Rust gates**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: builds with the new plugin.
Run: `npm run verify`
Expected: check + test + build all PASS.

- [ ] **Step 7: Manual smoke (record result in the commit body)**

Run `cargo tauri dev`, open a `.md` inside a git repo, add one annotation, click **Send to agent**. Confirm: (a) `<doc>.md.review.md` is written, (b) the clipboard holds the nudge with a repo-relative path, (c) toast reads "nudge copied". Toggle path style to Absolute in Settings → Agent and repeat; confirm an absolute path.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/lib.rs src-tauri/capabilities/default.json \
        package.json package-lock.json src/lib/ReviewExporter.ts src/App.svelte src/lib/Toolbar.svelte
git commit -m "feat: Send to agent — write review + copy clipboard nudge"
```

---

### Task 7: Ship the agent-integration assets + setup guide

Ship the optional helpers as **real, copy-pasteable files** in the repo (decision:
"ship templates now, auto-install later" — auto-install is tracked in
[#98](https://github.com/slash-hug/revenant/issues/98)). Each artifact is its own
file, so there are no nested-code-fence escaping problems.

**Files:**
- Create: `integrations/claude-code/revenant-review.md` (the slash command)
- Create: `integrations/agent-instructions.md` (CLAUDE.md / AGENTS.md snippet)
- Create: `integrations/README.md` (setup + how-it-fits guide)
- Modify: `README.md` (short section linking to `integrations/`)

**Interfaces:** none (shipped assets + docs).

- [ ] **Step 1: Create the slash-command file**

Create `integrations/claude-code/revenant-review.md` — a ready-to-use Claude Code
command (the user copies it into `.claude/commands/`). It does NOT rely on
`@`-path interpolation of an argument (uncertain); it tells the agent to Read the
path in `$ARGUMENTS`:

```markdown
---
description: Apply a Revenant review file to the document it reviews
argument-hint: <path-to-.md.review.md>
---
Read the file at $ARGUMENTS — a review of a markdown document produced by
Revenant. Apply each numbered comment to the document the review refers to (its
heading names the file), then summarize what you changed.
```

- [ ] **Step 2: Create the agent-instructions snippet**

Create `integrations/agent-instructions.md`:

```markdown
# Revenant agent-integration snippet

Paste the block below into your project's `CLAUDE.md` (Claude Code) or `AGENTS.md`
(GitHub Copilot CLI) so your agent understands Revenant's review files. This is
what makes the handback feel native — the agent already knows what a
`.md.review.md` file is before you ask.

---

## Reviewing docs in Revenant

When you generate a markdown document, open it in Revenant for review. The user
may annotate it and click **Send to agent**, which writes a `<doc>.md.review.md`
beside the document and copies a one-line instruction to their clipboard.

When the user pastes that instruction (or runs `/revenant-review <path>`), read
the referenced `.md.review.md` file, apply each numbered comment to the document
it reviews, and summarize what you changed. If no review file exists, proceed
normally — not every document gets annotated.
```

- [ ] **Step 3: Create the integration setup guide**

Create `integrations/README.md`:

```markdown
# Revenant agent integration

How Revenant hands your review annotations back to a running CLI coding agent
(Claude Code or GitHub Copilot CLI), and how to scaffold the optional helpers.

## The loop

1. Your agent generates a markdown file and opens it in Revenant.
2. You annotate it — or not; a clean pass needs no annotations.
3. Click **Send to agent**. Revenant writes `<doc>.md.review.md` beside the
   document and copies a paste-ready nudge to your clipboard, e.g.:
   > Apply the review comments in `docs/spec.md.review.md` to `docs/spec.md`, then summarize what you changed.
4. Paste it into the agent session that opened the doc. The agent reads the
   review file and applies your comments.

Customize the nudge wording and repo-relative vs absolute paths in
**Settings → Agent**.

## Optional helpers (copy these into your project)

These are templates — Revenant does not install them for you yet
([#98](https://github.com/slash-hug/revenant/issues/98)).

### 1. Teach your agent the convention

Copy the snippet from [`agent-instructions.md`](agent-instructions.md) into your
project's `CLAUDE.md` (Claude Code) or `AGENTS.md` (Copilot CLI).

### 2. Claude Code slash command (optional)

Copy [`claude-code/revenant-review.md`](claude-code/revenant-review.md) to
`.claude/commands/revenant-review.md` in your project (shared via git) or
`~/.claude/commands/revenant-review.md` for all projects. Then paste
`/revenant-review docs/spec.md.review.md` instead of the full nudge sentence.

GitHub Copilot CLI has no user-defined slash commands — use the pasted nudge; its
`AGENTS.md` support still gives you step 1.

## How the pieces fit

| Piece | Who produces it | Who consumes it |
|---|---|---|
| `<doc>.md.review.md` | Revenant (Send to agent) | your agent |
| Clipboard nudge | Revenant (Send to agent) | you → paste into agent |
| `revenant-review` slash command | you install once | Claude Code |
| `CLAUDE.md` / `AGENTS.md` snippet | you install once | your agent (always) |

## Roadmap

- Autonomous pickup via a local MCP tool (no pasted nudge): [#97](https://github.com/slash-hug/revenant/issues/97)
- One-click auto-install of these helpers: [#98](https://github.com/slash-hug/revenant/issues/98)
```

- [ ] **Step 4: Link from the root README**

Add a short subsection to `README.md` under the features/usage area:

```markdown
### Sending reviews back to your agent

Click **Send to agent** to write a `.review.md` and copy a paste-ready nudge to
your clipboard for a running Claude Code / Copilot CLI session. Optional
slash-command and agent-instruction templates live in
[`integrations/`](integrations/README.md).
```

- [ ] **Step 5: Verify the slash command is a valid command file**

Run: `head -5 integrations/claude-code/revenant-review.md`
Expected: YAML frontmatter with `description:` and `argument-hint:` — confirms it
drops straight into `.claude/commands/` without edits.
Run: `ls integrations integrations/claude-code`
Expected: all three files present.

- [ ] **Step 6: Commit**

```bash
git add integrations/ README.md
git commit -m "feat(integrations): ship revenant-review command + agent-instruction templates"
```

---

## Self-Review

**Spec coverage:**
- Settings (template + path style, schema 1, serde defaults) → Task 3 ✓
- `generate_review` returns relative paths → Task 2 ✓
- `repo_relative` helper → Task 1 ✓
- Nudge builder → Task 4 ✓
- Toolbar "Send to agent" + disabled-when-empty → Task 6 (guard pre-exists) ✓
- Clipboard (scoped `allow-write-text`) → Task 6 ✓
- Settings UI (template field + path toggle + reset) → Task 5 ✓
- Shipped integration assets (slash command + convention snippet) + setup guide → Task 7 ✓ (auto-install deferred to #98)
- Round-trip readiness (stable comment numbering, no v1 code) → no task needed; `ReviewExporter` format unchanged ✓
- Tests (Rust `repo_relative` + `resolve_review_paths` + settings; Vitest `buildNudge`) → Tasks 1–4 ✓

**Placeholder scan:** none — every step has concrete code/commands. Task 7 now
ships each asset as its own file, so there are no nested-code-fence escapes to
clean up.

**Type consistency:** `ReviewResult` fields (`review_path`, `doc_path`,
`review_path_rel`, `doc_path_rel`) are identical across Rust (Task 2 Step 3) and
TS (Task 2 Step 5) and consumed with those exact names in Task 6 Step 4.
`buildNudge(template, style, NudgePaths)` signature matches between Task 4 and
its Task 6 call site. Settings field names (`agent_nudge_template`,
`agent_nudge_path_style`) are identical across Rust, TS, the UI (Task 5), and the
handler (Task 6).

**Open verification (handled in-task, not assumptions):**
- Task 6 Step 1: `tauri-plugin-clipboard-manager` version — match the repo's
  existing `tauri-plugin-*` major (`2`). Confirm against `Cargo.toml` when editing.
- Task 5 Step 3: whether `App.svelte` narrows the settings-category union —
  grep-gated, widen only if present.
- Task 6 Step 3: whether any test asserts on `ReviewExporter.generateReview`'s
  old return — grep-gated.
