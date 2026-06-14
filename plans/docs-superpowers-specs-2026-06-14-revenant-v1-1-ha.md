# Revenant v1.1 — Hardening · Implementation Plan

- **Source spec:** `docs/superpowers/specs/2026-06-14-revenant-v1.1-hardening-design.md` (Approved brainstorm)
- **Plan status:** APPROVED (2026-06-14) — all flagged conflicts ruled on; cleared for `feature-implement`
- **Scope class:** Tier-2 (multi-file, cross-workstream, one architectural decision in WS-1)

### Ratified decisions (human rulings on §2)
- **C-LOAD-WRITE → in-memory, persist-on-next-save.** `load_annotations` re-anchors and returns positions but does NOT write the sidecar; the next normal save persists them. Eliminates the load-vs-save race; `load` stays a pure read (no `ensure_gitignore_entry`/watcher state on load). Tasks T1.3 already encode this variant.
- **R-MERMAID-SET / R-D3-TRANSITIVE → common set, validate d3 empirically.** Register `flowchart, sequenceDiagram, classDiagram, stateDiagram, erDiagram, gantt, pie, gitGraph`. Drop `katex`, `cytoscape`, `roughjs` for certain; keep `d3` only if the `vite build` chunk report shows flowchart needs it (record the achieved trim; do not break a used diagram). No silent full-bundle fallback.
- **All other recommended resolutions accepted as written:** A3 two-pass `Value` schema parse (C-PEEK-1/C-SCHEMA-NULL/C-PEEK-VALUE); A2 Rust `save_annotations` re-derives context (C-DOUBLE-KILL); C-IPC-TYPE narrow `SourceAnchor` in `ipc.ts`; A11 promote `quadBuf` to a field (C-QUAD/R-QUAD-DECISION); C-FLUSH-TABID capture `tabId` at mount; A8 save-chain reset-on-error (R-SAVECHAIN-RECOVERY); A9 CRLF regression via the `merge_into_doc` export path (C-CRLF-BLAST); R-FDLOCK-CHOICE `fd-lock` (fallback `fs2`); A1 sequenced DATA worktree; A13 mandatory `cargo tauri dev` launch smoke per worktree.
- **Deferred (not this round):** R-REANCHOR-LOADING ("Re-anchoring…" drawer state) — defer; R-LOAD-SAVE-RACE merge — moot under the in-memory variant.

---

## 1. Header — Goal, Approach, Architecture Decisions

### Goal
Make Revenant's advertised promises actually work, correctly and fast. This is **hardening only**: fix the broken fuzzy re-anchoring pipeline (the product's named moat), close data-integrity gaps (save TOCTOU, unsequenced store writes, lost keystrokes on unmount, mis-handled sidecar schema, CRLF frontmatter corruption), and bank cheap perf/stability wins (highlight.js curation, Mermaid trim, WebGL dispose leak). No net-new features.

### Approach
Three workstreams, but **WS-1 and WS-2 are sequenced into a single Rust-data worktree** because both edit `annotations.rs` and `EditorPane.svelte` (confirmed overlap — see Conflicts). WS-3 runs fully parallel in its own worktree with zero file overlap. Frontend type/store changes that belong to WS-1/WS-2 are kept inside those workstreams' file ownership; they do not bleed into WS-3.

The IPC contract stays **frozen** — no new commands, no new type fields. WS-1's "Approach A" keeps context lines as Rust-internal re-anchoring fuel, derived from the canonical doc, never crossing the IPC seam. The TypeScript `SourceAnchor` interface *loses* two now-dead fields (`context_before`/`context_after`) — this is a frontend-only type narrowing, **not** an IPC contract change (the Rust IPC `Annotation` type never had those fields).

### Architecture decisions (with the research finding that drove each)

| Decision | Driver |
|---|---|
| **A1. Single sequenced Rust-data worktree for WS-1+WS-2.** | [architecture] + [codebase] "WORKSTREAM SEQUENCING CONSTRAINT CONFIRMED": both edit `annotations.rs` and `EditorPane.svelte`. Parallel worktrees would merge-conflict on those two files. Made a **hard constraint**, not optional. |
| **A2. `save_annotations` (not just `save_file`) re-derives context from the doc on every call.** | [review-history] TRAP 4 + TRAP 13 "double-kill": the frontend `save_annotations` path runs `ann_from_ipc` which resets context to empty on every mutation. Deriving context only in `save_file` would be silently erased on the next body edit. Therefore the Rust `save_annotations` command must read the doc and derive context. This is an additive doc-read the spec only called for in `save_annotations` item 1 — we extend it to be the single source of truth so there is no second eraser. |
| **A3. Two-pass schema parse: `serde_json::Value` first, then `peek_schema_version`.** | [codebase]/[ux]/[architecture]/[review-history] all converge (TRAP 8): `peek_schema_version` returns `None` for *both* malformed JSON and valid-JSON-missing-field. Mirror `settings.rs` (`unwrap_or(0)`): if `Value` parse succeeds → treat missing version as `0` → migrate; only if `Value` parse fails → quarantine. |
| **A4. Re-anchored sidecar is persisted on load, and `load_annotations` becomes `async` + gains `State<FileWatchers>`/`AppHandle` and calls `ensure_gitignore_entry`.** | [codebase] TRAP 3/12 + [architecture]: load currently never re-anchors and is sync. Re-anchor wiring + `spawn_blocking` for large docs requires `async fn`. **BUT** see Conflict C-LOAD-WRITE below — the human must decide write-on-read vs. in-memory-only. Default recommendation encoded here is the **in-memory + persist-on-next-save** variant to avoid the new concurrency surface; an alternative is documented. |
| **A5. `±W = 50` windowed fuzzy search with verbatim short-circuit + cheap pre-filter.** | [codebase]/[architecture]/[review-history] TRAP 2: `best_fuzzy_match` scans the whole doc → O(annotations × doc × chars). Bound it. Also bound `probe_verbatim` (currently whole-doc) per [architecture] note. |
| **A6. Context derivation recomputed fresh in Rust against the 0-indexed model — do NOT port EditorPane's 1-based arithmetic.** | [architecture] "context derivation must match the matcher's existing offset model exactly": `reanchor.rs` reconstructs anchor as `window_start + context_before.lines().count()`; annotations are 0-indexed. Use doc line at index `line_start - 1` and `line_end + 1`, single-line each. |
| **A7. `fd-lock` added to `Cargo.toml`; re-hash + write through the SAME handle under the lock.** | [codebase]/[architecture]: `save_file` is classic TOCTOU. [architecture] advisory-lock caveat: flock is advisory only — the acceptance "does not write under a concurrent EXTERNAL write" is only honored if re-hash and write go through the same handle. Encode that precisely. |
| **A8. Serialized `saveChain` in `annotations.ts`, with a chain reset on error.** | [codebase]/[architecture] TRAP 5 + [ux] "Save chain error recovery": serialize, but reset `saveChain = Promise.resolve()` in the catch so one I/O error does not silently swallow all future writes. |
| **A9. CRLF fix's real regression test goes through the Obsidian export/merge round-trip, not preview.** | [architecture]: preview uses the frontend `stripFrontmatter` (already CRLF-aware); Rust `frontmatter.rs` is consumed ONLY by `obsidian.rs:164`. The acceptance "CRLF doc renders with YAML stripped" passes today via the frontend path and won't exercise the Rust fix. |
| **A10. Single reassembly route (collapse `Display` impl + `reassemble()`), CRLF-preserving.** | [codebase] FRONTMATTER DISPLAY vs REASSEMBLE: two paths exist; both must be CRLF-aware or one consolidated. Audit all callers of `to_string()` (Display) vs `reassemble()`. |
| **A11. Promote quad buffer to `private quadBuf` instance field for `dispose()`.** | [codebase]/[review-history] TRAP 10: `buf` is a constructor-local at `fluid.ts:303`, no `this.quadBuf`. Cannot delete it in `dispose()` without storing it. (Human may instead choose delete-immediately-after-VAO-setup — see C-QUAD.) |
| **A12. Mermaid trim verified via `vite build` chunk report, not by reading code.** | [review-history] RISK + [codebase] MERMAID TRIM RISK: tree-shaking of `katex/cytoscape/d3/roughjs` depends on mermaid v11's barrel imports; cannot be confirmed by reading code. Make the bundle-report check the acceptance gate. |
| **A13. Mandatory `cargo tauri dev` launch-smoke gate before any WS is "done".** | [codebase]/[architecture] LAUNCH GATE + `tasks/lessons.md` (2026-06-13, 2026-06-14): green CI does not prove the app boots. WS-1 (async load) and WS-3 (Mermaid run-once init) execute on real document open. fd-lock entering Cargo.toml requires a rebuild. |

---

## 2. Conflicts & Decisions Needed (VERBATIM — for the human to rule on before implementation)

> The following are reproduced verbatim from the research lenses. Each has my recommended resolution. **Do not start `feature-implement` until these are ruled on.**

### Spec conflicts

**[codebase] C-PEEK-1.** *Spec WS-2 item 4 says the sidecar schema policy change targets `annotations.rs:283-291` and `199-208`. Reality: line 208 (the `None` branch) currently quarantines both malformed JSON and missing-`schema_version`. The spec says to migrate the missing-version case. However, the `peek_schema_version` helper uses `serde_json::from_str::<Peek>` with `schema_version: Option<u32>` — a valid JSON object without `schema_version` will parse successfully and return `Peek { schema_version: None }`, but so will malformed JSON (it returns `Err`). The fix path the spec prescribes ('parse to `serde_json::Value` first to tell the two apart') IS the right approach and is not in conflict, but the existing helper is subtler than the spec implies: it already distinguishes parse errors (returns `None` via `.ok()`) from valid JSON with missing field (also returns `None` via `.and_then`). Implementers must check both arms of `peek.ok()` separately, not just the outer `Option`.*
> **Recommended resolution:** Adopt A3. Add a first-pass `serde_json::from_str::<serde_json::Value>(&raw)`. On `Err` → quarantine (malformed). On `Ok` → call `peek_schema_version`; `None` now means *field absent* → treat as version `0` → fall into the existing `v < CURRENT_SCHEMA_VERSION` migrate branch. Mirror `settings.rs` `unwrap_or(0)`.

**[codebase] C-CTX-DELETE.** *Spec WS-1 item 4 says 'delete the now-dead `context_before` / `context_after` computation in `handleSelectionChange`'. Reality: the computation in EditorPane.svelte lines 239-243 IS dead at the IPC seam, but it IS used — it populates the `SourceAnchor` struct dispatched to the parent via `addAnnotation` event. The parent (App.svelte or TabManager) passes it to AnnotationComposer, which forwards it to `annotationsStore.addAnnotation()`. The `addAnnotation` function in annotations.ts does NOT pass context to IPC (the Annotation IPC type has no context fields). So the data is computed, stored in the JS anchor object, but silently dropped before IPC. Deleting it from EditorPane is correct — but implementers should verify no other consumer reads `anchor.context_before` before deleting.*
> **Recommended resolution:** Before deleting, `grep -rn 'context_before\|context_after' src/` to confirm no consumer reads them off the anchor object. They are dead at the IPC seam (confirmed by all four lenses). Delete the computation AND narrow the `SourceAnchor` TS interface (see C-IPC-TYPE). Assigned to WS-1's frontend task.

**[codebase] C-QUAD.** *Spec WS-3 says the quad VAO and quad buffer should be deleted in dispose(). The quad buffer (`buf`) is created as a local variable in the constructor (fluid.ts line 303) and is NOT stored as an instance field — there is no `this.quadBuf`. Implementing the dispose fix requires adding a `private quadBuf: WebGLBuffer` instance field in addition to deleting the existing resources.*
> **Recommended resolution (A11):** Add `private quadBuf!: WebGLBuffer` and store at construction. Cross-references the [review-history] decision below — choose A11 (store + delete in dispose) for symmetry with the other resource deletions, unless the human prefers delete-immediately.

**[ux] C-IPC-TYPE.** *Spec WS-1 item 4 ... Deleting the computation from EditorPane without also updating ipc.ts will produce a TypeScript error (missing required fields on the SourceAnchor object). The spec states the IPC contract is FROZEN, but removing fields from a TypeScript type declaration is not a contract change in the IPC sense — it only affects the frontend type. The implementing dev needs to remove those two fields from the SourceAnchor interface in ipc.ts. The spec should have called this out.*
> **Recommended resolution:** Remove `context_before` and `context_after` from the `SourceAnchor` interface in `src/lib/types/ipc.ts` as part of WS-1. This is frontend-type-only; the Rust IPC `Annotation` type never carried these fields, so the frozen contract is untouched. Update `src/tests/ipc_contract.test.ts` if it asserts those fields (it does not test `SourceAnchor` per [review-history], but verify). **Note:** `ipc.ts` is a WS-A-owned file per CLAUDE.md — this is an additive frozen-surface touch and must be flagged, but it is type-narrowing only.

**[ux] C-FLUSH-TABID.** *Spec WS-2 item 3 ... The EditorPane is destroyed and remounted on every tab switch due to {#key $activeTab.id} in App.svelte (line 378). The flush-on-destroy therefore runs on every tab switch, not only on explicit tab close. ... The implementation must verify that tabId is captured by closure at the moment onDestroy is registered and not re-read from a potentially-updated prop — otherwise a rapid tab switch could flush the wrong tab's content.*
> **Recommended resolution:** In `onDestroy`, flush `view.state.doc.toString()` to `tabsStore.updateContent(tabId, …)` where `tabId` is captured at mount time (it is a prop bound to this instance; because `{#key}` remounts per tab, each instance's `tabId` is stable for its lifetime). Snapshot `const myTabId = tabId` at the top of the component/`onMount` to be explicit and immune to any prop reassignment. Mirror the existing `handleSave` flush pattern (EditorPane.svelte:175-179).

**[ux] C-SCHEMA-NULL.** *Spec WS-2 item 4 ... The current annotations.rs peek_schema_version() (line 283–291) returns None for both malformed JSON AND for valid JSON that parses but has schema_version: null. ... The fix requires distinguishing None-because-parse-failed from None-because-field-absent, which requires a two-pass approach ...*
> **Recommended resolution:** Same as C-PEEK-1 (A3). The `Value`-first pass is the discriminator.

**[ux] C-MERMAID-INIT.** *Spec WS-3 ... If initialize() is hoisted to module level, it will run once per module load, which is correct. However, Mermaid's initialize() is not idempotent across diagram-type registration: calling registerDiagramTypes after initialize() on some Mermaid versions requires re-initialization. The order (register then initialize, or initialize with config) needs to follow Mermaid's documented API for the version pinned in package.json. The spec does not specify Mermaid version or registration API shape.*
> **Recommended resolution:** Pinned version is `mermaid@^11.4.1` (confirmed in package.json). For mermaid v11, use `registerExternalDiagrams`/the v11 registration API and call `initialize({ startOnLoad:false, securityLevel:'strict' })` once at module load AFTER any registration. WS-3 implementer must check the installed version's exports map first (`node_modules/mermaid/package.json` `exports`) and confirm the registration call order against v11 docs before coding. See also C-MERMAID-SET below.

**[architecture] C-CRLF-BLAST.** *CRLF blast radius is narrower than the spec frames it. ... preview rendering does NOT use `frontmatter.rs` ... The Rust `frontmatter.rs` is consumed ONLY by `obsidian.rs:164` (the Obsidian export merge path). So the CRLF bug's real symptom is corrupted Obsidian *exports* of CRLF docs, not broken preview. The fix is still correct, but the acceptance test 'CRLF doc renders with YAML stripped' would pass TODAY via the frontend path and won't exercise the Rust fix — the real regression test must go through the export/merge_into_doc round-trip.*
> **Recommended resolution (A9):** Keep the CRLF fix as specced, but **rewrite the acceptance/regression test** to drive `frontmatter::merge_into_doc` (the `obsidian.rs` export path) with a CRLF document, asserting the merged output strips/preserves YAML correctly and round-trips CRLF. Do not rely on a preview-render assertion.

**[architecture] C-WATCHER-MISFRAME.** *The risk note (spec line 124) ... is misframed. The watcher (`watch_file`...) watches the DOC file and keys internal-vs-external on the DOC content hash via `last_written`. The load-time re-anchor writes the SIDECAR (`<doc>.md.annotations.json`), which is NOT watched at all. So there is no spurious doc-watcher event to suppress and no `save_file`-style internal-write recording is needed for the sidecar. The actual concern is different: writing the sidecar inside `load_annotations` makes a READ command mutate disk (surprising side effect) and must reuse `ensure_gitignore_entry` (currently only called in `save_annotations`...) — the load path does NOT call it today.*
> **Recommended resolution:** Drop the "record write as internal / suppress watcher" work entirely (the sidecar is not watched). IF load-time persistence is kept (see C-LOAD-WRITE), the load path must call `ensure_gitignore_entry` before writing the sidecar. This resolves the apparent need for `load_annotations` to gain `State<FileWatchers>` — it does NOT need the watcher state, only `paths::ensure_gitignore_entry`.

**[architecture] C-LOAD-WRITE.** *Spec WS-1 item 2 says load should 'persist the re-anchored sidecar (so the new hash + positions stick).' This turns `load_annotations` into a write-on-read. ... the sidecar write on load still races with concurrent `save_annotations` from the frontend store. The serialized `saveChain` (WS-2) only serializes FRONTEND writes; a Rust-side load-time sidecar write is outside that chain. Worth a human decision on whether load-time persistence is worth this added concurrency surface, or whether re-anchored positions can be returned in-memory and persisted on the next normal save instead.*
> **DECISION NEEDED — recommended: in-memory + persist-on-next-save.** Return re-anchored positions in the `load_annotations` response WITHOUT writing the sidecar on load. The frontend already saves on the next mutation, baking in the new positions then. This eliminates the load-vs-save race entirely and keeps `load_annotations` a pure read (no `ensure_gitignore_entry`, no async write). Trade-off: if the user opens and closes without mutating, the stale sidecar persists on disk (harmless — it re-anchors again next open). **Alternative (spec-literal):** write on load, call `ensure_gitignore_entry`, accept last-writer-wins. The plan's WS-1 tasks are written for the **recommended** variant with the alternative noted inline.

**[review-history] C-DOUBLE-KILL.** *Spec WS-1 change #1 says 'stop hard-coding [context] to String::new()' but does not address that save_annotations (frontend-triggered) also calls ann_from_ipc which resets context to empty. ... Resolution needed: either save_annotations must be a merge (load on-disk context, apply IPC body changes, preserve context fields) or the Rust save_annotations handler must re-derive context from the doc on every call ...*
> **Recommended resolution (A2):** The Rust `save_annotations` command re-derives `context_before`/`context_after` from the doc at `doc_path` for every annotation, every call. This is simpler and more robust than a load-merge (no risk of a stale on-disk context surviving a quoted-text edit). Cost: one doc read per save (negligible; we already hash on save). `ann_from_ipc` gains the derived context as parameters instead of `String::new()`.

**[review-history] C-PEEK-VALUE.** *Spec WS-2.4 says distinguish 'malformed JSON' from 'valid JSON missing schema_version' and default the latter to version 0. But annotations.rs peek_schema_version() returns Option<u32> where None covers both cases. The fix requires parsing to serde_json::Value first (as settings.rs already does with unwrap_or(0)), not a change to peek_schema_version's return type. The spec says 'parse to serde_json::Value first to tell the two apart' — this is correct but requires replacing the current peek-then-deserialize two-pass approach with a single Value parse, matching settings.rs exactly.*
> **Recommended resolution:** Same as C-PEEK-1/A3. Keep `peek_schema_version` (or inline the `Value` field read) — the key change is the Value-first discriminator.

**[review-history] C-LOAD-SIG.** *Spec WS-1 says re-anchor sidecar write during load_annotations 'must reuse the existing gitignore-on-first-write path'. But save_annotations (the IPC command that calls ensure_gitignore_entry) is a different code path from the proposed load_annotations re-anchor persist. The load_annotations command currently has no AppHandle/FileWatchers State parameter — adding one to update last_written after the re-anchor sidecar write requires a command signature change. Without last_written update, the sidecar write will fire a watcher event with external=true, causing a spurious ConflictModal on the frontend.*
> **Recommended resolution:** Per C-WATCHER-MISFRAME, the sidecar is NOT watched, so no `last_written`/watcher update is needed and no `FileWatchers` state is required. If the recommended C-LOAD-WRITE variant (no write on load) is chosen, `load_annotations` only needs to become `async` (for `spawn_blocking`) — no `AppHandle`/`State` additions, no `ensure_gitignore_entry` on load. This is the cleanest path and is what the WS-1 tasks below encode. (If the human picks write-on-load, add `ensure_gitignore_entry` only — still no watcher state.) **Either way, the `async fn` signature change must keep `generate_handler!` in `lib.rs` (WS-A) green — verify it compiles.**

### Open risks (VERBATIM)

**[codebase] R-LAUNCH.** *TAURI LAUNCH GATE: lessons.md documents that green cargo test + npm test + svelte-check + vite build does NOT prove the app launches (2026-06-13 lesson). The icon issue was fixed (2026-06-14 lesson). Any implementer must run `cargo tauri dev` and confirm the app opens a window before calling a workstream complete — this is an explicit mandatory step per lessons.md and cannot be inferred from CI output.*
> Encoded as A13: a mandatory launch-smoke verification task per worktree.

**[codebase] R-LOAD-BLOCK.** *RE-ANCHOR PERSISTENCE ON LOAD: ... writing the sidecar in `load_annotations` ... runs synchronously on the command handler thread; if the doc is large, the re-anchor computation + sidecar write could block the webview's IPC thread. This is why the spec mandates `spawn_blocking`. Implementer must ensure the async command signature change does not break the existing `generate_handler!` registration in lib.rs (WS-A owns lib.rs).*
> Encoded: `load_annotations` → `async fn`, re-anchor via `tauri::async_runtime::spawn_blocking`. Verify `generate_handler!` compiles unchanged.

**[codebase] R-MERMAID-EXPORTS.** *MERMAID TRIM RISK: ... Mermaid 11.x (current: `^11.4.1`) changed its internal bundle structure; the exact set of subpath imports needed to register individual renderers without pulling transitive deps must be verified against the installed version's exports map before implementation.*
> Encoded: WS-3 first task inspects `node_modules/mermaid/package.json` exports before coding; acceptance gated on the chunk report (A12).

**[codebase] R-FRONTMATTER-PATHS.** *FRONTMATTER DISPLAY IMPL vs REASSEMBLE: `frontmatter.rs` has TWO reassembly paths: `Display` impl (lines 34-46) and `reassemble()` function (lines 112-123). ... Both paths exist today and both must be made CRLF-aware, or one consolidated. Implementers must audit all callers of `ParsedDoc::to_string()` (Display) vs `reassemble()` to avoid regressions in the Obsidian exporter (`obsidian.rs` calls `frontmatter::merge_into_doc`).*
> Encoded (A10): collapse to one route; audit callers via `grep -rn 'reassemble\|to_string()' src-tauri/src/frontmatter.rs src-tauri/src/obsidian.rs`.

**[codebase] R-QUAD-FIELD.** *QUAD BUFFER DELETION REQUIRES FIELD ... Adding `private quadBuf: WebGLBuffer` ... is a required prerequisite for the dispose fix ...*
> Encoded as A11 / C-QUAD.

**[ux] R-REANCHOR-LOADING.** *Re-anchor loading state: ... The frontend has no loading indicator specific to re-anchoring. ... Decision needed: should WS-1 add a 'Re-anchoring…' transient state to the drawer, reusing the existing shimmer pattern from PreviewPane? This is a frontend-only addition and does not touch the frozen IPC contract.*
> **DECISION NEEDED — recommended: defer to issue, NOT this round.** With the recommended in-memory C-LOAD-WRITE variant, the load round-trip adds only the re-anchor compute (bounded by ±W=50, fast for typical docs). A "Re-anchoring…" state is a nice-to-have but out of the hardening scope; track as a follow-up. If load-on-write is chosen and large docs stall noticeably, reconsider. Existing precedent if added: PreviewPane `[data-mermaid-pending]` shimmer + `role='status' aria-live='polite'`.

**[ux] R-SAVECHAIN-RECOVERY.** *Save chain error recovery: if the serialized saveChain in annotations.ts rejects ... all subsequent annotation mutations in the session are silently swallowed ... Decision needed: should the chain reset to Promise.resolve() on error so future saves can proceed ... Or should the error surface a non-dismissable drawer error and block further annotation writes until the user reloads?*
> **DECISION NEEDED — recommended: reset chain to `Promise.resolve()` in the catch, keep the existing `error` surfacing.** Future saves proceed (ordering after an error is best-effort, acceptable for a single-user tool). The existing `role='alert'` drawer-error div already informs the user. Encoded as A8.

**[ux] R-SOURCEANCHOR-TESTS.** *SourceAnchor type fields context_before/context_after in ipc.ts: if the FrontendDev removes them ... any existing tests or type-check calls that construct a SourceAnchor with those fields will fail. ... Decision needed: confirm that removing context_before/context_after from SourceAnchor in ipc.ts is in scope for WS-1, assign that edit explicitly to the WS-C implementor, and ensure ipc_contract.test.ts is updated to match.*
> **Confirmed in scope for WS-1** (C-IPC-TYPE). Assigned to WS-1's frontend task. Grep `src/tests/` for `SourceAnchor` literals before removing; update any that set the two fields.

**[ux] R-MERMAID-SET.** *Mermaid diagram-type registration list: no authoritative list of supported diagram types exists ... If the FrontendDev registers too few types, existing user documents with e.g. gitGraph or erDiagram will silently fail ... Decision needed: define and document the supported set before WS-3 is implemented, or add a fallback that gracefully degrades to the full Mermaid bundle when an unregistered diagram type is encountered.*
> **DECISION NEEDED — recommended supported set:** `flowchart, sequenceDiagram, classDiagram, stateDiagram, erDiagram, gantt, pie, gitGraph` (the common-document set named by [ux]). **However**, see R-D3-TRANSITIVE: flowchart historically pulls `d3` for layout. The human must confirm whether dropping `d3` is acceptable given flowchart is in the set. Document the chosen set in `markdown.ts` as a comment. No silent full-bundle fallback (defeats the trim).

**[ux] R-LOAD-SAVE-RACE.** *Concurrency of load_annotations writing the sidecar and a simultaneous save_annotations call from the frontend ... The last writer wins, and the re-anchor write could overwrite a freshly-added annotation if the timing is tight. ... Human decision needed on whether to accept the last-writer-wins behavior or add a read-modify-write merge on the Rust side.*
> **Resolved by the recommended C-LOAD-WRITE variant (no write on load):** the race disappears because load does not write. If load-on-write is chosen instead, accept last-writer-wins (pre-existing for save-vs-save) OR add a Rust read-modify-write merge (heavier).

**[architecture] R-FDLOCK-MACOS.** *fd-lock advisory semantics on macOS: `fd-lock` uses flock(2)/fcntl advisory locks which are advisory only — an external editor (VS Code, vim) does NOT honor them ... The spec's acceptance ('does not write even under a concurrent EXTERNAL write') is only guaranteed if the re-hash and write happen atomically under the SAME file handle ... Validate this acceptance criterion carefully; it may overpromise against truly external writers.*
> Encoded as A7. Reword the acceptance to: "re-hash and write through the same locked handle, so the in-process TOCTOU window is closed; a non-cooperating external writer between our re-hash and write is detected by the re-hash (returns HASH_MISMATCH) only if it writes before our re-hash." Implement re-hash-from-the-handle precisely.

**[architecture] R-SEQUENCING.** *WS-1 and WS-2 both modify `annotations.rs` AND `EditorPane.svelte` (spec line 120 acknowledges this). For parallel `feature-implement` worktrees this is a merge-conflict hotspot. Recommend sequencing the two Rust-data workstreams (or merging into one worktree) rather than running fully parallel ... but make this a hard constraint in the plan, not optional.*
> Encoded as A1: WS-1 and WS-2 are a single sequenced worktree. Hard constraint.

**[architecture] R-LAUNCH-2.** *Launch-smoke gate (per tasks/lessons.md): none of WS-1/2/3's verification commands ... actually BOOT the Tauri app. ... add the mandatory launch smoke (cargo tauri dev or the headless Playwright harness with mocked invoke) to this round's verification, or repeat the documented failure.*
> Encoded as A13.

**[architecture] R-OFFSET-TEST.** *Re-anchor offset correctness is unverified by existing tests — the 73 unit tests pass with EMPTY context ... they never exercised the context-offset path ... ensure it asserts exact line numbers after an above-anchor insertion (not just status: anchored), since an off-by-one in the new context derivation would still report 'anchored' while mis-positioning the comment.*
> Encoded: the WS-1 integration test asserts **exact** `line_start`/`line_end` after an above-anchor insertion, not just `status`.

**[architecture] R-D3-TRANSITIVE.** *WS-3 Mermaid trim acceptance ('katex/cytoscape/d3/roughjs no longer in build output') depends on mermaid v11's diagram-registration API surface; if Revenant's real users render flowcharts/sequence/class/state/ER/gantt/pie, confirm none of those six transitively pull d3 (flowchart historically uses d3 for layout). The acceptance 'the four heavy engines are gone' may conflict with 'don't drop diagrams users need' — needs validation against the actual diagram types in use before locking the registered set.*
> **DECISION NEEDED — recommended:** Treat the acceptance as "katex, cytoscape, roughjs gone" (clearly-droppable) and validate `d3` empirically: register the recommended set, run `vite build`, read the chunk report. If `d3` remains because flowchart needs it, **keep flowchart and accept d3 in the bundle** (don't drop a diagram users need). Update the acceptance to the actually-achievable trim. Human ratifies the final set after the report.

**[review-history] R-QUAD-DECISION.** *The quad buffer deletion problem (Trap 10) requires a decision: promote buf to a member field vs. delete it immediately after VAO setup. Deleting it immediately is valid in WebGL2 (the VAO retains the binding reference) but is a subtle correctness point that needs a human call before the dispose() fix is written.*
> **DECISION NEEDED — recommended: promote to `private quadBuf` (A11)** for explicit symmetry with the other `deleteBuffer`/`deleteTexture`/`deleteFramebuffer` calls in `dispose()`. (Delete-immediately is valid but less obvious to future readers.)

**[review-history] R-LOAD-ASYNC-REVIEW.** *load_annotations gaining async + AppHandle/FileWatchers state to support re-anchor sidecar write and watcher update is a command signature change. ... it needs review to confirm the watcher hash-update logic from watch_file() can be safely called from load_annotations without a full watcher spawn ...*
> Resolved by C-WATCHER-MISFRAME + recommended C-LOAD-WRITE: no watcher state needed; only `async fn`.

**[review-history] R-MERMAID-TREESHAKE.** *The Mermaid trim (WS-3.2) acceptance criterion ... depends on Mermaid's dynamic import tree-shaking behavior with the bundler. If Mermaid's package.json barrel file imports all diagram types unconditionally, tree-shaking will not remove the transitive deps regardless of which diagram types are registered. This needs a vite build --report verification pass; it cannot be confirmed by reading code alone.*
> Encoded as A12: acceptance is the `vite build` chunk report, not code reading.

**[review-history] R-SMOKE.** *Smoke test requirement: the app must actually launch and render after changes ... WS-1 adds async logic to load_annotations and a doc-read in save_annotations. WS-2 adds fd-lock (new crate). A Cargo.toml change (fd-lock) requires a rebuild ...*
> Encoded as A13 + each Cargo.toml change runs `cargo build` (not just `cargo test`).

**[review-history] R-FDLOCK-CHOICE.** *fd-lock vs fs2 choice. The spec says fd-lock preferred, fs2 acceptable fallback. fd-lock is not currently in Cargo.toml. This is a new dependency addition ... The macOS advisory lock behavior under WKWebView's sandboxed file access should be verified; Tauri's tauri-plugin-fs grants file access but fd-lock uses raw OS file descriptors outside of that plugin layer.*
> **DECISION NEEDED — recommended: `fd-lock` (per spec decision 2), fallback to `fs2` if it doesn't build/lock under the macOS target.** New dependency — flag per global rule §9; note in PR. Verify it locks under the real `cargo tauri dev` run (A13), since `save_file` uses raw fds outside tauri-plugin-fs.

---

## 3. File Map

### Create
- `plans/docs-superpowers-specs-2026-06-14-revenant-v1-1-ha.md` — this plan (done).
- `src-tauri/src/tests/reanchor_integration_tests.rs` — WS-1 end-to-end save→edit→load round-trip (new module; add `mod` line in the tests aggregator).
- `src/tests/annotations_store.test.ts` — WS-2 store serialization + chain-reset tests (if a suitable file doesn't already exist; otherwise extend).
- `src/tests/editor_pane_flush.test.ts` — WS-2 unmount-flush test (or extend existing EditorPane test file).

### Modify — WS-1+WS-2 worktree (Rust data + frontend store/editor)
- `src-tauri/src/ipc.rs` — WS-1: derive context in `save_annotations`; re-anchor in `load_annotations` (`async fn`); `ann_from_ipc` takes derived context. (WS-A-owned surface; additive, frozen contract preserved.)
- `src-tauri/src/reanchor.rs` — WS-1: `REANCHOR_WINDOW=50` constant, ±W windowed `best_fuzzy_match`, bounded `probe_verbatim`, verbatim short-circuit, pre-filter.
- `src-tauri/src/annotations.rs` — WS-1 (none if context derived in ipc.rs) + WS-2: two-pass schema parse (A3). **Shared file → sequence WS-1 before WS-2 within the worktree.**
- `src-tauri/src/frontmatter.rs` — WS-2: CRLF-aware parse + byte offsets; collapse `Display`/`reassemble` into one route; preserve endings.
- `src-tauri/src/file_io.rs` — WS-2: `save_file` advisory lock, re-hash + write through the same handle.
- `src-tauri/Cargo.toml` — WS-2: add `fd-lock` dependency. (WS-A-owned; additive — flag.)
- `src-tauri/src/lib.rs` — **verify only**, do not edit beyond confirming `generate_handler!` compiles with the `async` `load_annotations`. (WS-A-owned. If a signature change forces an edit here, it must be done by/with WS-A sign-off.)
- `src/lib/EditorPane.svelte` — WS-1: delete dead context computation; WS-2: `onDestroy` flush. **Shared file → sequence WS-1 before WS-2.**
- `src/lib/stores/annotations.ts` — WS-2: serialized `saveChain` + reset-on-error.
- `src/lib/types/ipc.ts` — WS-1: remove `context_before`/`context_after` from `SourceAnchor` (C-IPC-TYPE). (WS-A-owned; type-narrowing only — flag.)
- `src/tests/ipc_contract.test.ts` — WS-1: update only if it references the removed `SourceAnchor` fields (verify first).
- `src-tauri/src/tests/*` aggregator — register `reanchor_integration_tests` and any new annotations/frontmatter/file_io test modules.

### Modify — WS-3 worktree (perf/stability, zero overlap with above)
- `src/lib/render/markdown.ts` — WS-3: highlight.js core + curated grammars; Mermaid trim + module-level run-once `initialize()`.
- `src/lib/fx/fluid.ts` — WS-3: complete `dispose()` (delete all FBOs/textures/programs/VAO/quadBuf), add `private quadBuf` field.
- `vite.config.ts` — WS-3: optional `build.rollupOptions.output.manualChunks` for hljs/mermaid to make the bundle report legible. (WS-A-owned; additive — flag.)

---

## 4. Workstreams (zero file overlap between worktrees)

> **Two worktrees, sequenced internally where files are shared.**

### Worktree DATA (WS-1 then WS-2 — sequenced, hard constraint A1/R-SEQUENCING)
Owns: `ipc.rs`, `reanchor.rs`, `annotations.rs`, `frontmatter.rs`, `file_io.rs`, `Cargo.toml`, `EditorPane.svelte`, `stores/annotations.ts`, `types/ipc.ts`, `ipc_contract.test.ts`, all new Rust test modules, new frontend store/flush tests.
Reason for merge: WS-1 and WS-2 both edit `annotations.rs` and `EditorPane.svelte`. Run WS-1 tasks fully, then WS-2 tasks, in the same worktree.

### Worktree PERF (WS-3 — fully parallel, no overlap)
Owns: `render/markdown.ts`, `fx/fluid.ts`, `vite.config.ts`.
No file is shared with Worktree DATA. Safe to run concurrently.

(`lib.rs` is touched by neither beyond a verify; if an edit is genuinely required, it is a WS-A coordination point — flag to the human, do not let a worktree silently own it.)

---

## 5. Tasks

> Each task is one sitting. Run the launch-smoke (A13) once per worktree at the end, not per task. The frozen-surface files (`ipc.ts`, `Cargo.toml`, `lib.rs`, `vite.config.ts`) are WS-A-owned — edits to them are additive/flagged per the conflicts above.

### Worktree DATA — Phase WS-1 (re-anchoring made real)

**T1.1 — Bound the re-anchor algorithm (`reanchor.rs`).**
Add `const REANCHOR_WINDOW: usize = 50;`. In `best_fuzzy_match`, restrict the slide range to `stored_anchor_line.saturating_sub(W) ..= (stored_anchor_line + W).min(lines.len().saturating_sub(window_size))`. Keep the content-hash short-circuit and exact verbatim probe first; skip fuzzy on a verbatim hit (already early-returns at ~67-76 — verify). Bound `probe_verbatim` to the same ±W window. Add a cheap pre-filter (line-length/token-ratio) before the char-level `TextDiff`. Below 0.75 → `detached`.
*Verify:* `cargo test reanchor --manifest-path src-tauri/Cargo.toml` → existing reanchor tests pass; add 2 unit tests (windowed hit inside ±W; miss outside ±W marks detached).

**T1.2 — Derive context in Rust at save (`ipc.rs`, `annotations.rs` read-only of struct).**
Change `ann_from_ipc` to accept `context_before: String, context_after: String` instead of hard-coding `String::new()` (ipc.rs:163-164). In the `save_annotations` command: read the doc at `doc_path`, split into lines (0-indexed), and for each annotation set `context_before` = line at index `line_start - 1` (single line, empty if `line_start == 0`) and `context_after` = line at index `line_end + 1` (empty if past EOF), per A6 — do NOT port EditorPane's 1-based math. Call `ensure_gitignore_entry` as today.
*Verify:* `cargo build --manifest-path src-tauri/Cargo.toml` → compiles; `cargo test --manifest-path src-tauri/Cargo.toml` → green.

**T1.3 — Wire re-anchor on load + make `load_annotations` async (`ipc.rs`).**
Change `load_annotations` to `async fn`. After loading the sidecar, compare `sidecar.doc_content_hash` to the freshly-read `doc_hash` (already computed). On mismatch, run `reanchor::reanchor_all(&anns, &content, &doc_hash, &stored_hash)` inside `tauri::async_runtime::spawn_blocking`; apply each result's line range + `status` to the returned sidecar. **Recommended (C-LOAD-WRITE): do NOT write the sidecar on load** — return re-anchored positions in-memory; the next frontend save persists them. (Alternative: write on load + `ensure_gitignore_entry`; no watcher state needed per C-WATCHER-MISFRAME.) Read the full doc content here (currently only bytes-for-hash) so `reanchor_all` has `new_content`.
*Verify:* `cargo build --manifest-path src-tauri/Cargo.toml` → compiles AND `generate_handler!` in `lib.rs` still builds with the async command (R-LOAD-BLOCK). `cargo test --manifest-path src-tauri/Cargo.toml` → green.

**T1.4 — Integration test: save→edit→load→re-anchor (`src-tauri/src/tests/reanchor_integration_tests.rs`).**
New test module (register it in the tests aggregator `mod` list). Write a doc, save an annotation (exercising T1.2 context derivation), insert N lines ABOVE the anchor, reload via the same code path as `load_annotations`, assert **exact** `line_start`/`line_end` moved by +N and `status == anchored` (R-OFFSET-TEST). Second case: delete the anchored text, reload, assert `status == detached`.
*Verify:* `cargo test reanchor_integration --manifest-path src-tauri/Cargo.toml` → both cases pass.

**T1.5 — Delete dead frontend context + narrow `SourceAnchor` (`EditorPane.svelte`, `types/ipc.ts`, tests).**
`grep -rn 'context_before\|context_after' src/` to confirm no live consumer (C-CTX-DELETE). Delete the `context_before`/`context_after` computation in `handleSelectionChange` (EditorPane.svelte:239-243) and remove them from the dispatched `SourceAnchor` object. Remove the two fields from the `SourceAnchor` interface in `src/lib/types/ipc.ts` (C-IPC-TYPE). Update any test/literal that constructs `SourceAnchor` with those fields (R-SOURCEANCHOR-TESTS).
*Verify:* `npx tsc --noEmit` → no errors; `npm test` → green.

### Worktree DATA — Phase WS-2 (data integrity — run AFTER WS-1 in same worktree)

**T2.1 — `save_file` advisory lock (`file_io.rs`, `Cargo.toml`).**
Add `fd-lock = "<latest>"` to `[dependencies]` in `src-tauri/Cargo.toml` (fallback `fs2` per R-FDLOCK-CHOICE). Rewrite `save_file` (file_io.rs:101-124): open the target once, take an exclusive advisory lock, re-hash from THAT handle, compare to `expected_hash`, write through the SAME handle, all under the lock (A7/R-FDLOCK-MACOS). On mismatch return `HASH_MISMATCH` without writing.
*Verify:* `cargo build --manifest-path src-tauri/Cargo.toml` → compiles with the new crate (REBUILD, not just test). `cargo test --manifest-path src-tauri/Cargo.toml` → add a concurrent-write / mismatch test; green.

**T2.2 — Two-pass sidecar schema parse (`annotations.rs`).**
In `load_annotations` (the lib fn, ~199-249): before `peek_schema_version`, run `serde_json::from_str::<serde_json::Value>(&raw)`. On `Err` → quarantine (malformed). On `Ok` → read `schema_version`; if absent/null → treat as `0` and fall into the existing `v < CURRENT_SCHEMA_VERSION` migrate branch (A3/C-PEEK-1). Keep the unknown-future-version quarantine.
*Verify:* `cargo test --manifest-path src-tauri/Cargo.toml` → add tests: (a) valid JSON missing `schema_version` migrates (NOT renamed to `.bak`); (b) malformed JSON still quarantines. Both pass.

**T2.3 — CRLF-aware frontmatter, single reassembly route (`frontmatter.rs`).**
Audit callers: `grep -rn 'reassemble\|to_string()' src-tauri/src/frontmatter.rs src-tauri/src/obsidian.rs` (R-FRONTMATTER-PATHS). Make `parse()` match `---\r?\n` (open + close fences). Compute byte offsets via `split_inclusive('\n')` so `line.len()` includes the terminator (no `+1` drift on CRLF). Collapse `Display` impl + `reassemble()` into one route guaranteeing a single trailing newline before the closing fence (A10). Preserve original line endings — never normalize.
*Verify:* `cargo test frontmatter --manifest-path src-tauri/Cargo.toml` → add CRLF parse + byte-offset + reassemble round-trip tests (assert CRLF preserved).

**T2.4 — CRLF regression via the export/merge path (`src-tauri/src/tests/`).**
Per A9/C-CRLF-BLAST: add a test driving `frontmatter::merge_into_doc` (the `obsidian.rs:164` path) with a CRLF document + a frontmatter merge, asserting YAML handled correctly and CRLF round-trips. Do NOT assert via preview render.
*Verify:* `cargo test --manifest-path src-tauri/Cargo.toml` → new merge_into_doc CRLF test passes.

**T2.5 — Serialized save chain with reset-on-error (`stores/annotations.ts`).**
Add a module-level `let saveChain: Promise<void> = Promise.resolve();`. Replace each bare `await save()` in the six mutators with enqueue onto the chain: `saveChain = saveChain.then(runSave)`. Each `runSave` snapshots the latest store state via `get()` at write time. In the catch, surface `error` (existing) AND reset `saveChain = Promise.resolve()` so future saves proceed (A8/R-SAVECHAIN-RECOVERY).
*Verify:* `npx tsc --noEmit` clean; `npm test` → add a test in `src/tests/annotations_store.test.ts`: interleaved mutations both persist; an injected rejecting save does not block a subsequent save.

**T2.6 — Debounce flush on unmount (`EditorPane.svelte`).**
In `onDestroy`: snapshot `myTabId` at mount (C-FLUSH-TABID). If a debounce timer is pending, synchronously call `tabsStore.updateContent(myTabId, view.state.doc.toString())` BEFORE `clearTimeout` / `view.destroy()`. Mirror the `handleSave` flush pattern (EditorPane.svelte:175-179). Account for `{#key $activeTab.id}` remount firing on every tab switch.
*Verify:* `npm test` → add `src/tests/editor_pane_flush.test.ts`: simulate pending edit + unmount, assert `tabsStore` got the last content under the correct tab id.

**T2.D — Worktree DATA launch smoke (A13/R-LAUNCH/R-SMOKE).**
After all DATA tasks: `cargo tauri dev`, confirm a window opens and a document renders, open a doc with an existing mismatched sidecar to exercise the async re-anchor load path, and save a file to exercise the fd-lock path. (Or the headless Playwright harness with mocked `invoke` per lessons.md if the native window can't run.)
*Verify:* App boots, window renders, no panic; a re-anchored annotation appears at the moved position.

### Worktree PERF (WS-3 — parallel)

**T3.1 — Inspect Mermaid v11 exports + decide registered set (`node_modules`, no code change yet).**
Read `node_modules/mermaid/package.json` `exports` map (R-MERMAID-EXPORTS) and confirm the v11 registration API shape (C-MERMAID-INIT). Confirm the human-ratified diagram set (R-MERMAID-SET default: flowchart, sequence, class, state, er, gantt, pie, gitGraph), noting d3 may stay if flowchart needs it (R-D3-TRANSITIVE).
*Verify:* Documented decision (comment in markdown.ts in the next task). No build change.

**T3.2 — Curate highlight.js + trim Mermaid + run-once init (`render/markdown.ts`).**
Replace `import('highlight.js')` with `import('highlight.js/lib/core')` + explicit `registerLanguage` for the curated set (javascript, typescript, rust, python, go, json, yaml, toml, bash, sql, xml, css, markdown, diff, dockerfile, c, cpp, java). Register only the ratified Mermaid diagram types; hoist `mermaid.initialize({startOnLoad:false, securityLevel:'strict'})` to a module-level run-once after the dynamic import, in the correct register→initialize order for v11. Keep DOMPurify sanitization on both `renderCodeBlock` and `renderMermaid` outputs (no regression to the sanitize lesson).
*Verify:* `npx tsc --noEmit` clean; `npm test` → green (existing markdown render tests still pass).

**T3.3 — Optional manualChunks for bundle legibility (`vite.config.ts`).**
Add `build.rollupOptions.output.manualChunks` splitting hljs and mermaid into named chunks so the report is readable. (WS-A-owned, additive — flag.)
*Verify:* `npm run build` → succeeds; chunk report shows distinct hljs/mermaid chunks.

**T3.4 — Bundle-report acceptance (A12/R-MERMAID-TREESHAKE/R-D3-TRANSITIVE).**
`npm run build` and read the chunk report. Acceptance: `katex`, `cytoscape`, `roughjs` absent; hljs chunk a fraction of prior size. For `d3`: if present only because flowchart needs it, keep flowchart and record the achievable trim (human ratifies). If absent, all four gone.
*Verify:* `npm run build` report inspected; the agreed packages are gone; record before/after chunk sizes.

**T3.5 — Complete WebGL dispose (`fx/fluid.ts`).**
Add `private quadBuf!: WebGLBuffer` and store the quad buffer at construction (A11/C-QUAD; line ~303). In `dispose()`: `deleteTexture`/`deleteFramebuffer` every FBO (velocity, dye, divergence, curl, pressure, coverage read+write), `docTex`, `docBlur` read+write; `deleteProgram` every program (splat, advection, divergence, curl, vorticity, pressure, gradient, clear, display, blur, cover); `deleteVertexArray(quadVao)`; `deleteBuffer(quadBuf)`; THEN `loseContext()` (may be null on WebView2/ANGLE — deletion must not depend on it).
*Verify:* `npx tsc --noEmit` clean; `npm test` → green.

**T3.P — Worktree PERF launch smoke (A13).**
`cargo tauri dev` (or headless harness): confirm the suminagashi open transition still draws and tears down cleanly, code blocks highlight, and a Mermaid diagram of each registered type renders. Open/close several docs to confirm no WebGL context accumulation warnings.
*Verify:* Transition renders + disposes; diagrams render; no "too many contexts" warnings.

### Whole-round verification (after both worktrees merge)
```sh
cargo test --manifest-path src-tauri/Cargo.toml   # WS-1 integration + WS-2 schema/CRLF/lock tests
npm test                                           # store serialization + unmount flush
npx tsc --noEmit                                   # SourceAnchor narrowing clean (svelte-check equivalent)
npm run build                                      # chunk report: katex/cytoscape/roughjs gone, hljs shrunk
cargo build --manifest-path src-tauri/Cargo.toml   # fd-lock + async load_annotations compile
```
Plus the mandatory `cargo tauri dev` launch smoke (A13) — the app boots, renders a doc, re-anchors on open, saves under the lock, and the transition disposes cleanly.

---

## 6. Out of Scope (explicitly)

- All deferred GitHub issues #1–#14 from the spec: tab-switch persistence (#1), preview render-guard `afterUpdate`→`$effect` (#2), scroll-sync (#3), obsidian async (#4), watcher debounce (#5), PDF/HTML export (#6), KaTeX (#7), Linux (#8), ⌘K palette (#9), keyboard add-comment (#10), undoable delete + status-bar dirty (#11), confinement fail-open + DOMPurify allowlist (#12), settings path + schema-policy unification + P3 cleanups (#13), positioning & pricing (#14).
- A "Re-anchoring…" drawer loading state (R-REANCHOR-LOADING) — deferred unless load-on-write is chosen and stalls.
- A detached-annotation "position unknown" display affordance ([ux] note) — not in hardening scope.
- A Rust-side read-modify-write merge for load-vs-save (R-LOAD-SAVE-RACE) — avoided by the recommended in-memory load variant.
- Responsive/mobile behavior — desktop tool, intentionally none ([ux] confirmed).
- New ARIA/keyboard-nav work beyond reusing existing patterns.
- Any IPC contract change (new command or new IPC type field). The only type edit is narrowing the frontend-only `SourceAnchor` interface.
- Bounding/optimizing re-anchor beyond ±W=50 + verbatim short-circuit + pre-filter (no algorithmic rewrite).
- Editing `lib.rs` beyond verifying `generate_handler!` compiles with the async command.
