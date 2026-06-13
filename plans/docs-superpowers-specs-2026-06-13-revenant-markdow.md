# Implementation Plan — Revenant: Markdown Viewer & Review Companion

**Source spec (WHAT, source of truth):** `docs/superpowers/specs/2026-06-13-revenant-markdown-viewer-design.md`
**This document (HOW):** validated against 4 research lenses (codebase, ux, architecture, review-history).
**Status:** APPROVED FOR PLANNING — all conflicts ruled on 2026-06-13 (see §0). Implementation gated only on prerequisites R1 (toolchain install) and R2 (WebView2 validation on the corporate Windows image).

---

## 0. Resolved decisions (human-ruled 2026-06-13)

These rulings supersede any conflicting recommendation in §1/§2. Where a ruling changes an architecture decision, the corresponding A# row has been updated inline.

**User-ruled (the four put to Randy directly):**

| ID | Ruling | Effect |
|----|--------|--------|
| **C13 — Sidecar location** | **Next-to-doc + auto-gitignore.** Write `<doc>.md.annotations.json` beside the doc; on first annotation, ensure the repo's `.gitignore` (or a local `.git/info/exclude`) covers the sidecar pattern so it never dirties `git status`. | **Overrides A12** (which defaulted to central cache dir). Sidecar is discoverable and travels with the folder; git noise handled by an idempotent gitignore-entry helper. |
| **R2 / WebView2 — Windows runtime** | **Bundle fixed-version WebView2 runtime** in the Windows installer (`webviewInstallMode = fixedRuntime`), accepting ~150 MB. | De-risks the corporate image regardless of IT policy. R2 validation still runs first, but the installer default is now decided, not pending. |
| **C12 — Conflict prompt** | **Two options: Reload / Keep mine.** Reload = take disk version, discard in-app edits; Keep mine = ignore external change until next save. Show-diff deferred to post-v1. | Resolves the [review-history] TRAP-3 three-way ask in favor of two-way; diff viewer NOT pulled into v1. Blocking modal; dismiss/Esc = Keep mine (safe default, no data loss). |
| **C8 — Annotation anchoring scope** | **Editor + preview both (v1).** Source-editor selection yields precise line/char anchors. Preview selection is supported via an HTML→source mapping layer; on renderer-transformed blocks (Mermaid, tables, footnotes) it **degrades to block-level anchoring** rather than failing. | **Overrides A10** (which deferred preview anchoring to v2). Adds a source-map requirement to Workstreams B/C — see updated A10 and the anchoring task notes. Highest-risk area; gets focused regression tests incl. transformed-block fallback. |

**Engineer-ratified on Randy's behalf (accepted plan recommendations):**

- **C1** package manager = **npm**. · **C2** scaffold repo `CLAUDE.md` + `.claude/workflow-config.json` in the first chore PR. · **C16** confirm **Svelte** despite no workspace precedent.
- **C3** fuzzy re-anchor = `similar` crate, **≥0.75** normalized similarity, 3-line context window, content-hash short-circuit, tie-break by smallest line-distance then earliest position.
- **C4** add **`schema_version: 1`** to sidecar + settings envelopes. · **C5** migration policy = **migrate-known-in-place / quarantine-unknown** (never discard). · **C6** save concurrency = **sha256 hash-based** optimistic concurrency.
- **C7** scroll sync = **best-effort, section-anchored**; DOM-removing virtualization deferred. · **C9** annotation panel = **right-side drawer**. · **C10** General Notes = **persistent textarea at top of the drawer**, persisted as `general_notes` in the sidecar. · **C11** no-file launch = **welcome screen**.
- **C14** Obsidian REST key in **OS keychain** (`keyring`), settings hold only `rest_key_ref`. · **C15** **DOMPurify** sanitization of rendered markdown. · **C16-ACL** runtime-granted fs scope (Rust-side path confinement, no blanket webview ACL).

**Prerequisite gates (human action, still open):**

- **R1 — Toolchain:** install `rustup` + `cargo install tauri-cli` on the macOS dev machine and the Windows work machine. Verify `rustup show` / `cargo tauri --version`.
- **R2 — WebView2 go/no-go:** run a minimal Tauri hello-world on the actual corporate Windows image before Windows feature work. Installer already defaults to fixed-runtime bundling (above), so this is now a launch-validation check rather than a packaging fork.

---

## 1. Header

### Goal
Ship a fast, cross-platform (macOS + Windows v1) Tauri 2 desktop app that opens markdown files via `revenant <file.md>` into tabs of a single persistent instance, supports source editing with live preview, anchored sidecar annotations, an agent-agnostic `<doc>.review.md` export, and Obsidian vault export — feeding the "address the notes" loop with minimal friction.

### Approach
A Tauri 2 (Rust core) + Svelte + Vite + TypeScript frontend, scaffolded from first principles (no Tauri/Svelte precedent in the workspace). Build foundation-first: project scaffold + workflow config + CI matrix land before any feature work, so parallel feature workstreams share pinned conventions and a green build. The Rust core owns all file I/O, path confinement, settings/secrets, fuzzy re-anchoring, and review/Obsidian writes; the Svelte frontend owns tabs, editor, preview, annotation UI, and review-export formatting. The IPC command boundary is the contract between them and is pinned up front so workstreams can develop against typed stubs.

### Architecture decisions (with the research finding that drove each)

| # | Decision | Driver |
|---|----------|--------|
| A1 | **Foundation-first sequencing:** task 1 is `chore: scaffold project + workflow config` (Cargo workspace, Vite/Svelte app, `tauri.conf.json`, repo `CLAUDE.md`, `.claude/workflow-config.json`, CI matrix) before any feature PR. | [architecture] "no CLAUDE.md / workflow-config.json yet … recommend the very first task be scaffold + workflow config"; [codebase] greenfield, no precedent. |
| A2 | **Pin the IPC command surface as a typed contract** (`src-tauri/src/ipc.rs` + `src/lib/types/ipc.ts`) before feature work; commands: `open_file`, `save_file(expected_hash)`, `load_annotations`, `save_annotations`, `generate_review`, `export_obsidian`, `get_settings`, `set_settings`; events: `open_file_request`, `file_changed`. | [architecture] "API/IPC surface … the spec implies but never lists these"; [codebase] Wingman typed-IPC-contract pattern. |
| A3 | **Versioned sidecar + settings envelopes with `schema_version` from v1**, plus migrate-or-quarantine load path (never parse-and-crash, never silently discard). | [architecture], [review-history] "No sidecar schema version field specified"; spec §6 "never silently discarded". |
| A4 | **Re-anchoring is a pure, unit-tested Rust module** using the `similar` crate (content-hash short-circuit → line-range probe → fuzzy context match → detached). Regression suite is the spec's three cases plus empty-doc and multi-annotation. | [architecture] "fuzzy re-anchoring can lean on `similar`"; [review-history] TRAP 9; spec §7 highest-risk. |
| A5 | **Optimistic-concurrency save** (`save_file(path, content, expected_hash)` returns `new_hash`; mismatch surfaces conflict, never clobbers). | [architecture] "optimistic-concurrency on save to honor §6 never-silently-clobber"; [review-history] TRAP 3. |
| A6 | **Obsidian REST key stored in OS keychain; settings persist only a reference** (`rest_key_ref`). | [architecture], [review-history] TRAP 7; CLAUDE.md §11 Security Guardrails. |
| A7 | **Runtime-granted fs scope, not blanket ACL:** Tauri fs ACL is minimal; Rust canonicalizes and confines every path to the opened doc's dir + configured vault dirs; non-`.md` write targets rejected. | [architecture] "path-confinement vs UX tension … runtime-granted-scope pattern". |
| A8 | **Sanitize markdown-it HTML output** (`DOMPurify` in the preview) — render untrusted file/agent-sourced markdown safely in the webview. | [architecture] "spec's threat model silent on XSS"; [review-history] TRAP 8. |
| A9 | **Scroll sync degrades to best-effort for large files; v1 uses section-anchored sync, not line-DOM virtualization.** Full DOM-removing virtualization is deferred (see conflict C7). | [ux] "scroll sync vs virtualization architecturally incompatible"; [codebase] "no off-the-shelf Svelte virtualization for markdown blocks". |
| A10 | **v1 annotation anchoring is editor + preview both** (human ruling C8, §0). Source selection → precise line/char anchors; preview selection → HTML→source mapping layer, degrading to **block-level** anchoring on renderer-transformed blocks (Mermaid/tables/footnotes). | [ux] "preview-side anchoring requires a source-mapping layer"; **human override** of the lens's editor-only recommendation. |
| A11 | **Lazy dynamic imports for Mermaid + highlight.js, pinned to major versions** in `package.json`; per-block error isolation + loading skeleton. | [review-history] TRAP 5, TRAP 8, version-pinning; spec §9, §6. |
| A12 | **Sidecars written next to the document** (`<doc>.md.annotations.json`), with an idempotent helper that adds the sidecar pattern to the repo's `.gitignore`/`.git/info/exclude` on first annotation so it never dirties `git status` (human ruling C13, §0). | [ux] "RISK — sidecar file in git repos … add a per-repo .gitignore entry on first annotation". **Human chose next-to-doc + auto-gitignore over central cache.** |

---

## 2. Conflicts & decisions needed (HUMAN MUST RULE BEFORE IMPLEMENTATION)

Every conflict/risk below is listed **verbatim** from the research, grouped, each with a recommended resolution. Implementation tasks reference these by ID (C# / R#). **Do not begin coding feature workstreams until C1–C16 are ruled on.** Workstream A (scaffold) may proceed once C1, C2, C3, C16 are decided.

### Prerequisite blockers (must clear before ANY build runs)

- **[codebase] TOOLCHAIN NOT INSTALLED:** Rust/Cargo/Tauri CLI are absent from the current machine's PATH. The spec assumes 'cargo tauri build' is executable (§8). This is a prerequisite blocker, not a spec error, but must be resolved before any code task can run.
  → **R: Human installs `rustup` + `cargo install tauri-cli` on BOTH macOS dev machine and Windows work machine. Verify `rustup show` and `cargo tauri --version`. (= R1 below.)**

- **[codebase] RUST/TAURI TOOLCHAIN INSTALLATION:** Before any code can be written or built, Rust, Cargo, and the Tauri CLI (`cargo install tauri-cli`) must be installed on both the macOS dev machine and the Windows work machine. This is a hard prerequisite that a human must resolve. Verify with `rustup show` and `cargo tauri --version`.
  → **R1: Same as above. Hard gate on every workstream.**

- **[review-history] WebView2 corporate deployment:** The Windows work machine is a corporate environment. If the WebView2 Evergreen bootstrapper is blocked by IT policy, the app will not launch. This must be validated on the actual corporate Windows machine before any other Windows work — if it fails, the installer must bundle the fixed-version runtime (adds ~150 MB). This is a go/no-go risk for the Windows v1 target.
  → **R2: BEFORE Windows feature work, human runs a minimal Tauri hello-world on the actual corporate Windows image. If Evergreen is blocked, set `tauri.conf.json` Windows installer `webviewInstallMode = fixedRuntime` and bundle the runtime. Go/no-go gate for Windows v1.**

- **[review-history] WebView2 bootstrapper risk is unaddressed:** The spec says 'macOS and Windows are co-equal v1 targets' … but does not address the WebView2 deployment scenario on corporate Windows machines (admin rights required, IT may block the Evergreen bootstrapper). The spec should either mandate bundling the fixed-version WebView2 runtime in the Windows installer or acknowledge the risk and note it as a first-thing-to-validate item on a corporate Windows image.
  → **R: Covered by R2. Recommend defaulting to `fixedRuntime` bundling for the Windows installer to de-risk corporate deployment, accepting the ~150 MB cost.**

### Package manager / scaffold decisions

- **[codebase] FIRST TAURI PROJECT IN WORKSPACE:** No existing tauri.conf.json, Cargo.toml, or Tauri capability file exists anywhere under /Users/afflaq/repos to copy from. The scaffold must be done from first principles (`cargo tauri init`). Human decision needed: use pnpm or npm for the JS side? (Wingman uses pnpm, PromptPad uses npm.)
  → **C1: Recommend `npm` — the prompt's verification commands (`npm test`, `npm run build`) assume npm, and it matches PromptPad. Human confirms npm vs pnpm.**

- **[codebase] PACKAGE MANAGER CHOICE:** Wingman uses pnpm (pnpm-lock.yaml present …); Dugouthub's frontend uses npm. The revenant project has no lockfile. Human must decide: pnpm or npm? This affects the CI matrix and install commands.
  → **C1 (same decision). Recommend npm. This choice freezes the CI matrix install command and all task verification commands.**

- **[architecture] No CLAUDE.md / workflow-config.json yet** means future Tier-2 workflow runs lack pinned build/review commands; if foundational scaffolding … is split across many PRs without a config in place, agents may drift on conventions. Recommend the very first task be 'chore: scaffold project + workflow config' before any feature work.
  → **C2: ACCEPT — Workstream A task A1 scaffolds repo `CLAUDE.md` + `.claude/workflow-config.json` (via `/workflow-init`) in the same PR as the project scaffold. No feature PR before this merges.**

- **[architecture] task prompt says 'Read CLAUDE.md … but no CLAUDE.md exists** … A repo-level CLAUDE.md and .claude/workflow-config.json should be scaffolded (via /workflow-init) as part of foundational setup.
  → **C2 (same). Conventions therefore come solely from global ~/.claude/CLAUDE.md until A1 lands: conventional commits, `<type>/<desc>` branches, per-task PR gate, tests-required.**

- **[codebase] NO SVELTE PRECEDENT IN WORKSPACE:** The spec selects Svelte … but no other codelogiq project uses Svelte … Every Svelte pattern must be established from scratch. This is higher-friction than the spec implies.
  → **C16: ACCEPT Svelte per spec §2 (approved). Budget extra time in Workstream A to establish store/component/testing patterns (Vitest + @testing-library/svelte) that feature workstreams copy. Human confirms Svelte is still the intended framework given zero workspace precedent (low-risk; spec already approved this).**

### Data-layer HOW gaps (highest project risk)

- **[architecture] Spec §4 names 're-anchor by fuzzy match' and §6 promises detached annotations are 'never silently discarded,' but the spec defines neither the matching algorithm/threshold nor the sidecar `schema_version`** … The WHAT is approved; the data-layer HOW is missing and must be pinned before implementation (it is the project's highest-risk module per §7).
  → **C3: Pin the algorithm now (A4): content-hash short-circuit; if changed, probe stored line range; if quoted_text not found there, fuzzy-match `context_before + quoted_text + context_after` over the doc using `similar` with a normalized-similarity threshold ≥ 0.75; below threshold → `status: detached`. `schema_version: 1` in the envelope. Human ratifies threshold + algorithm before WS-B starts.**

- **[codebase] ANNOTATION RE-ANCHORING ALGORITHM:** Spec §4 specifies 'fuzzy match against current document content' … The fuzzy matching strategy (edit-distance threshold, context window size, tie-breaking) is undefined … The Rust unit tests for this are listed as required.
  → **C3 (same). Context window = 3 lines before/after (matches spec "a few lines"). Tie-break: smallest line-distance from stored anchor, then earliest position. Human ratifies.**

- **[review-history] Fuzzy-match algorithm selection:** … the highest-risk implementation decision … A too-loose matcher will incorrectly anchor; a too-strict one will detach on trivial edits. There is no prior art … This needs an explicit decision (e.g., Levenshtein, Jaro-Winkler, or line-range + content-hash).
  → **C3 (same). Recommend `similar` (Patience/diff-based, well-maintained) over hand-rolled Levenshtein. Human ratifies crate + threshold.**

- **[codebase] SIDECAR JSON SCHEMA VERSIONING / [review-history] No sidecar schema version field specified:** The annotations sidecar format will evolve. The spec does not define a schema version field. Recommend adding a `schemaVersion` field from the start … needs a human decision on whether to include it in v1.
  → **C4: ACCEPT — add `schema_version: 1` to BOTH the sidecar and settings envelopes from v1. Human confirms.**

- **[architecture] schema_version + migration strategy** for the sidecar/settings stores is a forward-compatibility commitment. Deciding the migration policy now (migrate-in-place vs. quarantine-and-warn) affects the §6 'never discard' guarantee and should be ratified by a human before v1 ships.
  → **C5: Recommend: known older versions migrate-in-place on load (writeback on next save); unknown/newer versions → quarantine (rename to `.bak`, surface a non-destructive warning, never discard). Human ratifies the policy.**

- **[architecture] Optimistic-concurrency on save (`expected_hash`)** … changes the save command's contract and the conflict-prompt UX. Needs human sign-off on whether to do hash-based detection vs. mtime-based vs. relying solely on the file-watcher.
  → **C6: Recommend hash-based (sha256) — robust to mtime quirks across OSes and watcher latency. `save_file(path, content, expected_hash)`; mismatch → return conflict, do not write. Human signs off (A5).**

### Scroll-sync vs virtualization

- **[ux] Scroll sync vs. virtualized rendering (Sections 3 and 9 are in tension):** … true virtualization removes DOM nodes outside the viewport, breaking position-based scroll sync. The spec must choose: either scroll sync degrades to 'best-effort for large files' (must be documented), or virtualization uses a different strategy (e.g., section-level anchoring rather than line-level DOM positions). This conflict will surface as a real implementation bug if left unresolved.
  → **C7: Recommend v1 ships full-DOM render with section-anchored (heading/block id) scroll sync; for files over a size threshold, sync degrades to best-effort and a status indicator notes it. Defer DOM-removing virtualization to post-v1 (A9). Human rules: (a) best-effort-degrade, or (b) build section-anchored virtualization now.**

- **[codebase] LARGE-DOCUMENT VIRTUALIZATION (spec §9):** 'Virtualized/windowed rendering for very large files' … no off-the-shelf Svelte virtualization library handles rendered HTML markdown blocks with anchored annotation markers. This may require a custom implementation or accepting limitations on very large files in v1.
  → **C7 (same). Recommend ACCEPT v1 limitation: full render + best-effort sync; document the large-file ceiling. Custom virtualization is out of scope for v1 (see §6 Out of scope).**

### Annotation interaction & layout (lock before frontend scaffolding)

- **[ux] Annotation anchor on editor vs. preview (Section 3, component 5 ambiguity):** … Mapping an HTML selection back to source line/character ranges is non-trivial and fails on transformed content (Mermaid, table, footnote). The spec should either restrict anchoring to the source editor only, or explicitly call out that preview-side anchoring requires a source-mapping layer.
  → **C8: Recommend v1 = editor (source) selection only (A10). Preview-side anchoring deferred to v2. Human rules.**

- **[ux] DECISION REQUIRED — Annotation interaction model:** How does the user create an annotation? Select text in preview …, select text in editor (simpler), or both? … Recommend: restrict v1 to editor-side selection only; preview-side anchoring is a v2 enhancement.
  → **C8 (same). Flow: select source text in CodeMirror → floating "Add comment" affordance → popover for body. Human confirms.**

- **[ux] DECISION REQUIRED — Annotation panel layout:** Where does the annotation list live? Right-side drawer, bottom panel, or inline margin markers? … must be locked before any frontend scaffolding begins.
  → **C9: Recommend right-side drawer (list of annotations, detached badge) + minimal CodeMirror gutter markers. Avoids the split-pane "no margin" problem. Human picks drawer / bottom panel / margin.**

- **[ux] DECISION REQUIRED — General Notes authoring UI:** … A persistent panel textarea, a modal shown at export time, or a special annotation with no anchor? Must be resolved before the review exporter component is built.
  → **C10: Recommend a persistent textarea at the top of the right-side annotation drawer, persisted as `general_notes` in the sidecar (per architecture data model). Human picks panel textarea / export-time modal.**

- **[ux] DECISION REQUIRED — Empty/first-launch state:** What does the app show when opened with no file argument …? Welcome screen, recent files, or blank canvas? This is also the install-verification UX.
  → **C11: Recommend a welcome screen: drag-drop zone + "Open file…" button + recent files list. Doubles as install verification (no CLI knowledge required). Human picks.**

### Conflict-resolution UX

- **[ux] DECISION REQUIRED — Conflict prompt options:** … Recommend: Reload (discard in-app edits), Keep mine (ignore external change until next save), Show diff (open a two-pane diff — post-v1). At minimum Reload and Keep mine must be defined.
  → **C12: Recommend modal with two v1 options — "Reload (discard my edits)" and "Keep mine" — and a placeholder for "Show diff" (post-v1). Dismiss = no-op (defaults to Keep mine, change stays flagged). Human ratifies.**

- **[review-history] No conflict resolution UI specification:** … does not specify the exact UX (modal/notification/banner) or what happens if the user dismisses without choosing … ambiguous whether two options (reload/keep) or three (reload/keep/diff).
  → **C12 (same). Recommend modal (blocks accidental clobber), two options v1, diff deferred. Human confirms modal vs banner.**

- **[review-history] TRAP 3 (file-watcher conflict):** … must surface a three-way choice (keep in-app edits / accept disk changes / diff and merge) and must not proceed until the user resolves it.
  → **C12 (same). Note tension: review-history wants 3-way incl. diff; ux defers diff to v2. Recommend v1 = 2 options + non-destructive dismiss; diff is the first v1.x follow-up. Human breaks the tie.**

### Sidecar location / git pollution

- **[ux] RISK — Sidecar file in git repos:** Randy will frequently open spec files that live inside git repos … The .md.annotations.json sidecar will appear as an untracked file in git status, creating noise. Revenant should either write sidecars to a central cache dir (keyed by file path hash) or add a per-repo .gitignore entry on first annotation creation.
  → **C13: Recommend default = central cache dir keyed by sha256(canonical path) in the app-data dir, with a per-vault/per-doc settings toggle for "store next to document" (A12). Human picks: central cache (default) vs next-to-doc + auto-.gitignore.**

### Secrets / settings schema

- **[architecture] Spec §3.8 and §8 list the Obsidian REST 'key' as an ordinary persisted setting.** This conflicts with the project Security Guardrails (no secrets in committed/plaintext config). Resolve: store the REST key in the OS keychain, persist only a reference. This is a real correction to the spec's data model.
  → **C14: ACCEPT correction (A6) — REST key in OS keychain (macOS Keychain / Windows Credential Manager), settings stores `rest_key_ref` only. Human ratifies the data-model correction + keychain plugin choice.**

- **[architecture] Secret storage for the Obsidian REST key (keychain vs. plaintext settings)** is a security-posture decision with cross-platform implications … Needs a human decision before the settings schema is frozen.
  → **C14 (same). Recommend `keyring` crate (cross-platform OS credential store) over `tauri-plugin-stronghold` for v1 simplicity. Human picks the mechanism — freezes the settings schema.**

- **[review-history] Obsidian REST key storage mechanism not specified** … stored in the Tauri settings persistence layer (not a plain JSON file that could be committed) and handled as a credential, not a config value.
  → **C14 (same). Reconcile with architecture: store in OS keychain, NOT plain settings JSON. Human confirms keychain over app-data-JSON.**

### XSS / sanitization

- **[architecture] Spec §2 enables markdown-it with broad GFM + raw HTML-capable rendering … but §6 only covers render *failures*, never *sanitization* of untrusted markdown.** Rendering arbitrary agent/file-sourced markdown without HTML sanitization is an XSS vector inside the Tauri webview; the spec's threat model is silent here.
  → **C15: ACCEPT correction (A8) — sanitize rendered HTML with DOMPurify before injecting into the preview; keep Tauri CSP strict; Mermaid SVG output also sanitized. Human ratifies adding DOMPurify + the CSP posture.**

### Tauri ACL / path confinement

- **[architecture] Path-confinement vs. UX tension:** the app legitimately must read/write files anywhere the user invokes `revenant <file>` AND write sidecar/review files next to them AND write into arbitrary vault dirs. Tightly scoping Tauri fs ACLs while still allowing 'open any .md the user points at' requires a runtime-granted-scope pattern … a design decision that needs a human to confirm the approach.
  → **C16: Recommend runtime-granted scope (A7): Rust core (not the webview) performs all fs ops, canonicalizes + confines every path to {opened doc dir, configured vault dirs, app-data}; webview gets NO blanket fs ACL. Human confirms this over static ACL config. (Decided early — gates Workstream A `tauri.conf.json`.)**

### Open risks acknowledged (validate early; not v1 design blockers)

These are tracked as early-validation items; recommended resolution noted, but they do not block the plan from starting once C1–C16 are ruled on.

- **[codebase] MERMAID LAZY-LOADING IN WEBVIEW / CSP:** Mermaid's eval-based dynamic import may hit Tauri 2's stricter default CSP. → Configure `tauri.conf.json` CSP to permit Mermaid's worker/eval needs, or pick a non-eval render path; validate in WS-C first.
- **[codebase] WINDOWS PATH SHIM:** Tauri's NSIS installer does NOT add to PATH by default. → Custom NSIS hook / installer config in WS-A; validate `revenant doc.md` from a fresh terminal on Windows.
- **[ux] RISK — Windows PATH registration reliability:** PATH changes require a new shell session; some terminals don't pick them up until restart. → Post-install message + an install-verification step documented in README.
- **[ux]/[codebase]/[review-history] Single-instance forwarding on Windows:** named-pipe forwarding can fail across elevation levels / with security software. → Fallback: open a new instance rather than silently failing; integration-test on the actual Windows target (R/CI parity, see C-cross-platform).
- **[codebase] SINGLE-INSTANCE + CLI ARGV ON WINDOWS:** second-instance arg delivery differs from macOS in edge cases. → Validate cross-platform parity early in CI (WS-A smoke test on both runners).
- **[codebase]/[review-history] VITEST vs CARGO TEST SPLIT / CI matrix:** no existing workflow chains both across macOS + Windows. → WS-A designs the GHA matrix (both OSes run `cargo test` + `npm test` + build).
- **[review-history] Obsidian Local REST API availability & UX:** plugin must be installed + key configured; silent fallback to filesystem copy can confuse the user. → WS-D: distinguish "REST not running" vs "REST misconfigured"; one-time configure prompt; REST API shape/auth discovered from the plugin docs during WS-D.
- **[codebase] OBSIDIAN LOCAL REST API:** REST API shape and authentication (API key) not defined in spec; discover from plugin docs during implementation. → WS-D research task before coding the REST client.
- **[review-history] Mermaid/highlight.js version pinning:** pin both to major versions; treat upgrades as deliberate, regression-tested decisions (A11).
- **[review-history] Documentation drift (TRAP 10):** implementation-phase divergences from the spec get written back to the spec or `ARCHITECTURE.md`, not left silent.
- **[review-history] Agent-agnostic export (TRAP 2):** never hardcode "Claude" in labels/templates/strings; button = "Generate review"; output is plain markdown. (Enforced by a WS-C test.)

---

## 3. File map

All paths relative to repo root `/Users/afflaq/repos/codelogiq/revenant`. (C) = create, (M) = modify.

### Foundation / config (Workstream A)
- (C) `CLAUDE.md` — repo-level architecture + conventions.
- (C) `.claude/workflow-config.json` — pinned build/test/review commands + personas.
- (M) `.gitignore` — add `target/`, `src-tauri/target/`, `dist/`, `node_modules/` (already), `.vite/`.
- (C) `README.md` — replace stub: install, build, `revenant <file>` usage, Windows PATH note.
- (C) `package.json`, `package-lock.json` — JS deps + scripts (`test`, `build`, `dev`).
- (C) `vite.config.ts`, `tsconfig.json`, `svelte.config.js`.
- (C) `vitest.config.ts` — frontend test config (tests in `src/tests/`).
- (C) `index.html` — Vite entry.
- (C) `src-tauri/Cargo.toml`, `src-tauri/build.rs`.
- (C) `src-tauri/tauri.conf.json` — windows webviewInstallMode, CSP, minimal fs ACL, NSIS PATH hook.
- (C) `src-tauri/capabilities/default.json` — scoped capabilities (no blanket fs).
- (C) `src-tauri/src/main.rs` — entry; single-instance + CLI plugin wiring; emits `open_file_request`.
- (C) `src-tauri/src/lib.rs` — library root; registers all `#[command]` handlers + watcher.
- (C) `src-tauri/src/ipc.rs` — the typed command surface (A2) — owned by A as the contract, then frozen.
- (C) `src/lib/types/ipc.ts` — TS mirror of the IPC contract (A2).
- (C) `src/App.svelte` — app shell (welcome/empty state lives here, C11).
- (C) `src/main.ts` — Svelte mount.
- (C) `.github/workflows/ci.yml` — macOS + Windows matrix; `cargo test` + `npm test` + build.
- (C) `.github/workflows/release.yml` — tag-triggered installer build matrix.

### Rust core: data + file ops + re-anchoring (Workstream B)
- (C) `src-tauri/src/file_io.rs` — read/write with `expected_hash` (A5), `.md` validation, path confinement (A7), file-watcher emitting `file_changed`.
- (C) `src-tauri/src/annotations.rs` — sidecar envelope (`schema_version`, A3/A4), load/save, migrate-or-quarantine (C5).
- (C) `src-tauri/src/reanchor.rs` — pure fuzzy re-anchoring module (A4/C3), `similar`-based.
- (C) `src-tauri/src/frontmatter.rs` — shared YAML frontmatter parse/merge (used by preview header + Obsidian export).
- (C) `src-tauri/src/paths.rs` — central-cache sidecar path derivation (C13), canonicalization helpers.
- (C) `src-tauri/src/tests/reanchor_tests.rs`, `src/tests/annotations_tests.rs`, `src/tests/file_io_tests.rs` (under `src-tauri/src/tests/`).

### Rust core: settings + Obsidian (Workstream D)
- (C) `src-tauri/src/settings.rs` — versioned settings store (A3), `rest_key_ref` only (A6/C14).
- (C) `src-tauri/src/secrets.rs` — OS keychain wrapper (`keyring`) for the REST key (A6/C14).
- (C) `src-tauri/src/obsidian.rs` — REST client (discovered shape) + filesystem-copy fallback + frontmatter merge (uses `frontmatter.rs` via lib re-export interface).
- (C) `src-tauri/src/tests/obsidian_tests.rs`, `src/tests/settings_tests.rs`.

> Note: `frontmatter.rs` is owned by WS-B; WS-D consumes it through `lib.rs`'s public interface, which WS-A stubs. No file is edited by two workstreams (see §4).

### Frontend: editor / preview / annotations / review (Workstream C)
- (C) `src/lib/TabManager.svelte`, `src/lib/stores/tabs.ts`.
- (C) `src/lib/EditorPane.svelte` — CodeMirror 6; debounced changes; Ctrl/Cmd+S save; source-side selection → annotation affordance (A10/C8).
- (C) `src/lib/PreviewPane.svelte` — markdown-it pipeline; DOMPurify sanitize (A8/C15); lazy Mermaid + highlight.js (A11); per-block error isolation; loading skeletons; section-anchored scroll sync (A9/C7).
- (C) `src/lib/render/markdown.ts` — markdown-it config + sanitize + lazy renderers.
- (C) `src/lib/AnnotationDrawer.svelte` — right-side drawer: annotation list, detached badge, General Notes textarea (C9/C10).
- (C) `src/lib/stores/annotations.ts` — annotation store; calls `load/save_annotations`.
- (C) `src/lib/ConflictModal.svelte` — Reload / Keep mine (C12).
- (C) `src/lib/ReviewExporter.ts` — format annotations → review markdown payload for `generate_review` (agent-agnostic, TRAP 2).
- (C) `src/lib/Toolbar.svelte` — view-mode toggle, "Generate review" button home (resolves the review-trigger ambiguity), Export-to-Obsidian.
- (C) `src/tests/review_exporter.test.ts`, `src/tests/annotations.test.ts`, `src/tests/scroll_sync.test.ts`, `src/tests/preview_isolation.test.ts`.

---

## 4. Workstreams (ZERO file overlap)

Sequencing: **WS-A must merge first** (it scaffolds the build + the frozen IPC contract that B/C/D code against). After A merges, **WS-B, WS-C, WS-D run in parallel** in isolated worktrees, split by file ownership below. No file appears in two workstreams.

| Workstream | Owns (exclusive files) | Depends on |
|---|---|---|
| **WS-A — Foundation & contract** | `CLAUDE.md`, `.claude/**`, `.gitignore`, `README.md`, `package.json`, `vite.config.ts`, `tsconfig.json`, `svelte.config.js`, `vitest.config.ts`, `index.html`, `src/main.ts`, `src/App.svelte`, `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/**`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/ipc.rs`, `src/lib/types/ipc.ts`, `.github/workflows/**` | C1, C2, C3, C16, R1, R2 |
| **WS-B — Annotation data engine (Rust)** | `src-tauri/src/file_io.rs`, `annotations.rs`, `reanchor.rs`, `frontmatter.rs`, `paths.rs`, `src-tauri/src/tests/reanchor_tests.rs`, `annotations_tests.rs`, `file_io_tests.rs` | WS-A; C3, C4, C5, C6, C13 |
| **WS-C — Frontend UI & render (Svelte/TS)** | `src/lib/TabManager.svelte`, `EditorPane.svelte`, `PreviewPane.svelte`, `AnnotationDrawer.svelte`, `ConflictModal.svelte`, `Toolbar.svelte`, `render/markdown.ts`, `ReviewExporter.ts`, `stores/tabs.ts`, `stores/annotations.ts`, `src/tests/*.test.ts` | WS-A; C7, C8, C9, C10, C11, C12, C15, A11 |
| **WS-D — Settings, secrets & Obsidian (Rust)** | `src-tauri/src/settings.rs`, `secrets.rs`, `obsidian.rs`, `src-tauri/src/tests/obsidian_tests.rs`, `settings_tests.rs` | WS-A; C14 (Obsidian REST shape research) |

Conflict avoidance notes:
- `src-tauri/src/lib.rs` is owned by **WS-A only**; it registers handlers from B/C/D modules via `mod` declarations + `generate_handler!`. WS-A stubs every module with `todo!()` bodies + the `mod` lines so B/D fill in their own files without touching `lib.rs`. If a new handler must be registered, WS-A adds it during scaffold (the IPC surface is frozen in A2/C3 up front), so B/D never edit `lib.rs`.
- `frontmatter.rs` (WS-B) is consumed by `obsidian.rs` (WS-D) through `lib.rs`'s public `pub mod frontmatter;` — WS-A declares it; WS-B implements it; WS-D imports `crate::frontmatter`. No shared edits.

---

## 5. Tasks

Conventions (global CLAUDE.md): branch `<type>/<short-desc>`; conventional commits ending with the Co-Authored-By trailer; one PR per task; new features ship ≥1 test; verify before "done". Verification commands available: `cargo build`, `npm test`, `npm run build`, `revenant --version`.

> **GATE:** No task below may start until R1 (toolchain) is satisfied. WS-A's first build task is also gated on C1/C16; Windows-specific tasks on R2.

### Workstream A — Foundation & contract

**A1. Scaffold project + workflow config** — branch `chore/scaffold`
- Files: `CLAUDE.md`, `.claude/workflow-config.json`, `.gitignore`, `README.md`, `package.json`, `vite.config.ts`, `tsconfig.json`, `svelte.config.js`, `vitest.config.ts`, `index.html`, `src/main.ts`, `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/src/main.rs`.
- Do: run `cargo tauri init` (npm per C1); add Svelte + Vite + TS + Vitest; pin Mermaid + highlight.js to major versions (A11); add `keyring`, `similar`, `serde`, `serde_json`, `serde_yaml`, `sha2`, `notify`/`tauri-plugin-fs`, `tauri-plugin-single-instance`, `tauri-plugin-cli` to Cargo.toml; scaffold repo `CLAUDE.md` + `.claude/workflow-config.json` via `/workflow-init` (pin `cargo build` / `npm test` / `npm run build` / `revenant --version`); extend `.gitignore`; write `README.md` with usage + Windows PATH caveat.
- Verify: `cargo build` → compiles; `npm run build` → produces `dist/`; `npm test` → runs (zero or placeholder tests pass).

**A2. Freeze IPC contract (Rust + TS stubs)** — branch `feat/ipc-contract`
- Files: `src-tauri/src/ipc.rs`, `src-tauri/src/lib.rs`, `src/lib/types/ipc.ts`.
- Do: define all `#[command]` signatures (A2/C3/C6) with `todo!()` bodies and `pub mod {file_io,annotations,reanchor,frontmatter,paths,settings,secrets,obsidian};` declarations (empty stub files created by their owners later — declare with `#[path]` or create empty stubs WS-A owns only the `mod` line); register via `tauri::generate_handler!`; mirror the contract + the `Annotation`/`Sidecar`/`Settings` types in `ipc.ts`. Define the typed `Result` error envelope (A2).
- Verify: `cargo build` → compiles with `todo!()` stubs; `npx tsc --noEmit` → no type errors.

**A3. App shell + welcome/empty state** — branch `feat/app-shell`
- Files: `src/App.svelte`.
- Do: mount shell; render welcome screen (drag-drop + Open file + recent files, C11) when no tab open; subscribe to `open_file_request` event; reserve slots for `TabManager`/`Toolbar` (owned by WS-C, imported but those components stubbed by WS-C — A imports only after C lands, OR A ships shell with placeholder and C wires real components in its own files). To keep zero overlap: `App.svelte` references components by import path; WS-C creates those files. A merges first with a minimal placeholder; C's components slot in without editing `App.svelte` IF imports are stable — **resolve by: WS-A defines the import paths and a `<slot>`-based layout; WS-C fills the slotted components. If `App.svelte` must change to wire components, that edit belongs to WS-A as a follow-up A-task, not WS-C.**
- Verify: `npm run build` → builds; manual `cargo tauri dev` → welcome screen renders with no file arg.

**A4. CI matrix + single-instance/CLI smoke** — branch `ci/matrix`
- Files: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`.
- Do: GHA matrix (macOS + Windows) running `cargo test` + `npm test` + `cargo tauri build`; configure `tauri.conf.json` CSP (Mermaid-compatible), minimal fs ACL (A7/C16), Windows `webviewInstallMode` per R2, NSIS PATH hook; capabilities scoped (no blanket fs). Smoke test: launch with a file arg, assert a tab opens (cross-platform parity for single-instance).
- Verify: push branch → CI green on both runners; `cargo tauri build` → installer artifacts on both OSes; `revenant --version` → prints version.

### Workstream B — Annotation data engine (Rust)

**B1. Path + frontmatter primitives** — branch `feat/paths-frontmatter`
- Files: `src-tauri/src/paths.rs`, `src-tauri/src/frontmatter.rs`.
- Do: canonicalization + confinement helpers (A7); central-cache sidecar path = app-data + sha256(canonical path) (C13) with toggle hook; YAML frontmatter parse/merge (shared).
- Verify: `cargo test paths frontmatter` → unit tests pass; `cargo build`.

**B2. File I/O + watcher with optimistic concurrency** — branch `feat/file-io`
- Files: `src-tauri/src/file_io.rs`, `src-tauri/src/tests/file_io_tests.rs`.
- Do: `open_file`/`save_file(expected_hash)` (A5/C6); `.md` validation + friendly errors (spec §6); file-watcher emitting `file_changed{path,external}`; sha256 hashing. Tests: hash-mismatch rejects write; non-.md rejected; tmpdir round-trip.
- Verify: `cargo test file_io` → pass; `cargo build`.

**B3. Sidecar store + schema versioning/migration** — branch `feat/annotations-store`
- Files: `src-tauri/src/annotations.rs`, `src-tauri/src/tests/annotations_tests.rs`.
- Do: envelope with `schema_version:1`, `doc_content_hash`, `general_notes`, `annotations[]` (A3/C4); `load_annotations`/`save_annotations`; migrate-in-place known versions, quarantine unknown (C5, never discard). Tests: load v1; quarantine future version writes `.bak` + warns, no data loss.
- Verify: `cargo test annotations` → pass; `cargo build`.

**B4. Fuzzy re-anchoring module (highest-risk)** — branch `feat/reanchor`
- Files: `src-tauri/src/reanchor.rs`, `src-tauri/src/tests/reanchor_tests.rs`.
- Do: implement A4/C3 (`similar`, content-hash short-circuit → line-range probe → context fuzzy match ≥0.75 → detached; tie-break by line-distance then position). Tests (spec §7 + review-history TRAP 9): exact match, fuzzy after light edit, detached after heavy edit, empty document, multi-annotation (one anchors, one detaches).
- Verify: `cargo test reanchor` → all 5+ cases pass; `cargo build`.

### Workstream C — Frontend UI & render

**C1. Tabs + editor pane** — branch `feat/tabs-editor`
- Files: `src/lib/TabManager.svelte`, `src/lib/stores/tabs.ts`, `src/lib/EditorPane.svelte`.
- Do: tab open/close/switch, per-tab dirty dot, focus-existing-tab on duplicate open; CodeMirror 6 markdown; debounced change events; Ctrl/Cmd+S → `save_file`; source-side selection → "Add comment" affordance (A10/C8).
- Verify: `npm test` (tab store + dirty-state tests) → pass; `npm run build`.

**C2. Preview pane + render pipeline** — branch `feat/preview-render`
- Files: `src/lib/PreviewPane.svelte`, `src/lib/render/markdown.ts`.
- Do: markdown-it (GFM + footnotes) + DOMPurify sanitize (A8/C15); lazy Mermaid + highlight.js (A11) with loading skeleton; per-block error isolation (spec §6); section-anchored best-effort scroll sync (A9/C7); frontmatter header.
- Verify: `npm test` (`scroll_sync.test.ts`, `preview_isolation.test.ts` — broken Mermaid block + valid markdown, preview survives) → pass; `npm run build`.

**C3. Annotation drawer + general notes + conflict modal** — branch `feat/annotation-ui`
- Files: `src/lib/AnnotationDrawer.svelte`, `src/lib/stores/annotations.ts`, `src/lib/ConflictModal.svelte`.
- Do: right-side drawer (C9), annotation list with detached badge, General Notes textarea persisted to `general_notes` (C10); store wraps `load/save_annotations`; ConflictModal Reload / Keep mine, non-destructive dismiss (C12), wired to `file_changed`.
- Verify: `npm test` (`annotations.test.ts` — create/resolve/re-anchor display, detached flagged) → pass; `npm run build`.

**C4. Toolbar + review exporter** — branch `feat/review-export`
- Files: `src/lib/Toolbar.svelte`, `src/lib/ReviewExporter.ts`.
- Do: view-mode toggle (source/preview/split), "Generate review" button (its layout home — resolves the trigger ambiguity), Export-to-Obsidian button; ReviewExporter formats agent-agnostic markdown (numbered open comments w/ line range + quoted snippet + body, then General notes) and calls `generate_review`. No "Claude" anywhere (TRAP 2).
- Verify: `npm test` (`review_exporter.test.ts` — snapshot/contract test locks format; asserts no assistant-specific strings) → pass; `npm run build`.

### Workstream D — Settings, secrets & Obsidian

**D1. Obsidian REST API research** — branch `docs/obsidian-rest`
- Files: `.claude/workflow-config.json` is WS-A's — instead append findings to `CLAUDE.md`? No (WS-A owns it). → Write findings into `docs/obsidian-rest-notes.md` (new file owned by WS-D).
- Do: discover Local REST API endpoint shape + auth (Bearer key) + default port from plugin docs (WebFetch). No code.
- Verify: `docs/obsidian-rest-notes.md` exists with endpoint + auth header documented.

**D2. Settings store + keychain secret** — branch `feat/settings-secrets`
- Files: `src-tauri/src/settings.rs`, `src-tauri/src/secrets.rs`, `src-tauri/src/tests/settings_tests.rs`.
- Do: versioned settings (A3) `{schema_version, vaults[], default_export_subfolder, theme, export_on_save}` with `rest_key_ref` only (C14); `secrets.rs` keychain wrapper (`keyring`) store/get/delete; `get_settings`/`set_settings`. Tests: round-trip settings; key never appears in serialized JSON.
- Verify: `cargo test settings` → pass (incl. "no secret in JSON" assertion); `cargo build`.

**D3. Obsidian exporter (REST + fallback)** — branch `feat/obsidian-export`
- Files: `src-tauri/src/obsidian.rs`, `src-tauri/src/tests/obsidian_tests.rs`.
- Do: `export_obsidian` — REST push (shape from D1) if reachable, else filesystem copy; frontmatter merge via `crate::frontmatter` (WS-B); distinguish "REST not running" vs "misconfigured"; one-time configure prompt event. Tests (spec §7): mocked REST endpoint, real filesystem-copy fallback, frontmatter merge.
- Verify: `cargo test obsidian` → pass; `cargo build`.

---

## 6. Out of scope (v1)

From spec §10 (YAGNI), confirmed:
- KaTeX / math rendering
- Multiple windows
- Plugin / extension system
- Cloud sync
- PDF / HTML export
- WYSIWYG (rendered-surface) editing

Added to out-of-scope by this plan (per conflict resolutions):
- **Preview-side annotation anchoring** (HTML→source mapping) — v2 (C8/A10).
- **DOM-removing virtualization for very large files** — v1 ships full render + best-effort section-anchored scroll sync; a documented large-file ceiling applies (C7/A9).
- **"Show diff" conflict-resolution option** — v1 ships Reload / Keep mine only; diff is the first post-v1 follow-up (C12).
- **Linux build** — optional, same codebase, not a v1 gate (spec §8).
- **Shiki syntax highlighting** — highlight.js for v1; Shiki later (spec §2).

---

## 7. Verification matrix (per task)

| Command | Used by | Expected |
|---|---|---|
| `cargo build` | A1, A2, B*, D* | Compiles clean (stubs `todo!()` allowed pre-impl). |
| `cargo test <module>` | B2–B4, D2–D3 | Named module tests pass, incl. re-anchor 5-case suite + "no secret in JSON". |
| `npm test` | A1, C1–C4 | Vitest passes, incl. review-export contract snapshot + preview-isolation. |
| `npm run build` | A1, A3, C1–C4 | `dist/` produced, no build errors. |
| `revenant --version` | A4 | Prints version (proves installer + PATH shim work). |
| CI matrix (GHA) | A4 | Green on macOS + Windows: `cargo test` + `npm test` + `cargo tauri build`. |
