# Agent Review Handback — "Send to agent" (Approach A)

**Date:** 2026-06-20
**Status:** Design — awaiting review
**Backlog follow-up:** [#97](https://github.com/slash-hug/revenant/issues/97) (Approach B — local MCP pull tool)

## Problem

Agents are instructed to open every markdown file they generate in Revenant. The
user annotates it. Today there is no seamless way to get those annotations **back
into the same running CLI agent session** (Claude Code or GitHub Copilot CLI).

The user wants this to feel native *when used*, but never to force annotations into
the workflow — plenty of runs need no review at all.

## Decisions (from brainstorm)

- **Pull, not push.** The agent consumes the review; Revenant does not babysit a
  terminal. (Verified: a truly idle CLI REPL cannot be woken by MCP/hooks; only a
  keystroke can. Claude Code "Channels" can push but is research-preview +
  Anthropic-auth-only and non-cross-agent — deferred to a future issue.)
- **Clipboard nudge for the idle case.** On "Send", Revenant copies a one-line
  instruction to the clipboard. If the agent is mid-turn it can pick the review up
  on its own; if it has gone idle, the user pastes the copied line — one action.
- **Transport: the file artifact Revenant already writes.** No new binary, no MCP
  server in v1. The agent reads `<doc>.md.review.md` (already produced by
  `generate_review`).
- **One-way consume in v1, format kept round-trip-ready.** Stable comment
  numbering + line ranges are preserved as the future resolution key (issue #97).
- **Both the nudge template and the path style are user-configurable.**

## Architecture

Wraps the existing `generate_review` flow with a clipboard step. Nothing about
review generation changes; this adds a transport/trigger layer on top.

```
[Toolbar: "Send to agent"]
        │ click
        ▼
generate_review(doc_path, markdown)   ── existing ──▶ writes <doc>.md.review.md
        │ returns repo-relative paths (new return fields)
        ▼
build nudge  ←─ settings: agent_nudge_template + agent_nudge_path_style
        │
        ▼
clipboard.writeText(nudge)            ── new ──▶ user pastes into agent session
        │
        ▼
toast: "Review written · paste copied"
```

### Components & ownership

| Unit | File(s) | WS |
|---|---|---|
| "Send to agent" button + nudge build + clipboard + toast | `Toolbar.svelte` | C |
| Nudge builder (template substitution, path-style selection) | new `src/lib/agentNudge.ts` | C |
| Settings fields: template + path style | `settings.rs`, settings UI panel | D |
| Repo-relative path helper | `paths.rs` (reuse repo-root walk) | B |
| `generate_review` returns relative paths | `ipc.rs`, `ipc.ts` | A |
| Clipboard plugin + capability | `Cargo.toml`, `lib.rs`, `capabilities/default.json` | A |
| Agent-side convention docs + slash-command template | `README.md`, `docs/` | A |

## Detailed design

### 1. Settings (additive, `schema_version` stays 1)

Two new fields, both with serde defaults so older settings files load unchanged:

- `agent_nudge_template: String`
  Default: `` Apply the review comments in `{review_path}` to `{doc_path}`, then summarize what you changed. ``
  Supported placeholders: `{review_path}`, `{doc_path}`. Unknown placeholders are
  left literal.
- `agent_nudge_path_style: "relative" | "absolute"` (enum), default `relative`.

Surfaced in the settings panel: a multiline text field for the template and a
two-option toggle for path style. A "Reset to default" affordance for the template.

### 2. `generate_review` return (IPC contract change — both files updated)

The command is FROZEN but its **return shape** is extended (no new command, no new
args). It already returns `GenerateReviewResult { review_path: String }` — the
canonical absolute path of the written `<doc>.md.review.md`. We add the canonical
absolute doc path plus both repo-relative forms:

```rust
struct GenerateReviewResult {
    review_path: String,             // existing: canonical absolute .md.review.md path
    doc_path: String,                // new: canonical absolute doc path
    review_path_rel: Option<String>, // new: relative to nearest git root; None if not in a repo
    doc_path_rel: Option<String>,    // new: relative to nearest git root; None if not in a repo
}
```

The command already canonicalizes the doc and derives the review path, so these are
all computed Rust-side from the canonical paths (authoritative — the frontend's held
doc path may be non-canonical). For `path_style = absolute`, or when `*_rel` is
`None` (doc not inside a repo), the nudge uses the canonical absolute paths. `ipc.ts`
mirror updated to match.

### 3. Repo-relative helper (`paths.rs`)

`fn repo_relative(path: &Path) -> Option<String>` — walk parents for a `.git`
entry (reusing the existing nearest-repo logic that the annotation-sidecar
gitignore helper already uses), return `path` relative to that root with forward
slashes; `None` if no repo ancestor. Pure, unit-testable.

### 4. Nudge builder (`src/lib/agentNudge.ts`)

```
buildNudge(template, style, { reviewAbs, reviewRel, docAbs, docRel }) -> string
```

Picks rel vs abs per `style` (falling back to abs when rel is null), substitutes
`{review_path}` / `{doc_path}`. No assistant names anywhere (agent-agnostic rule).

### 5. Toolbar action

"Send to agent" button. On click: `generate_review` → read settings → `buildNudge`
→ `clipboard.writeText` → toast. **Disabled** when there are zero annotations *and*
empty general notes (nothing to send), keeping no-review runs frictionless.

### 6. Clipboard

`tauri-plugin-clipboard-manager`; register in `lib.rs`; grant only
`clipboard-manager:allow-write-text` in `capabilities/default.json` (no read, no
broad grant — consistent with the scoped-ACL convention).

### 7. Agent-side convention (docs only)

- **Universal path:** user pastes the copied nudge; agent reads the review file and
  applies it. Works in Claude Code, Copilot CLI, anything with a Read tool.
- **Optional Claude Code helper:** a copy-paste `.claude/commands/revenant-review.md`
  template taking the review path as `$ARGUMENTS`, instructing the agent to read it
  and apply. Documented; not required.
- **Convention snippet** for `CLAUDE.md` / `AGENTS.md`: "A doc opened in Revenant may
  gain a `<doc>.md.review.md`; when asked to apply a review, read that file, apply
  the numbered comments to the reviewed document, and summarize changes."

## Round-trip readiness (no v1 code)

The existing `ReviewExporter` output already keys comments by number + line range.
Lock that as the stable resolution key so issue #97 can add an agent→Revenant
resolutions block additively, with no format rewrite.

## Testing

- **Rust:** `repo_relative` (in-repo, nested, not-in-repo); `generate_review`
  returns expected relative paths and `None` outside a repo.
- **Frontend (Vitest):** `buildNudge` — both placeholders substituted, both path
  styles, abs fallback when rel is null, no assistant names in output; Toolbar
  disabled-state when no annotations + no notes; clipboard called with built nudge.

## Out of scope

- MCP pull tool / autonomous checkpoint pickup → issue #97.
- Claude Code Channels push → future issue.
- Round-trip resolution ingestion → future (format kept compatible).

## Agent-agnostic compliance

Button label ("Send to agent"), default template, slash-command name
("revenant-review"), and all output contain no assistant names. ✓
