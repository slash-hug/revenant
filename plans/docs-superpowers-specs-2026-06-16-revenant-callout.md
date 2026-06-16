# Implementation Plan — Callouts + Wikilinks (#38)

**Source spec:** `docs/superpowers/specs/2026-06-16-revenant-callouts-wikilinks-design.md` (approved 2026-06-16)
**Plan status:** DRAFT — awaiting human ruling on the conflicts in §B before implementation
**Tier:** Tier-2 (security-sensitive DOMPurify allowlist + custom render rules + shared preview/export CSS)

---

## A. Header — goal, approach, architecture decisions

### Goal
Render two Obsidian-extended markdown syntaxes that currently show as literal text in the preview and export:

- **Callouts** — `> [!info] Title` → a bordered, tinted, icon-titled callout card; collapsible variants (`[!type]+` / `[!type]-`) render via native `<details>/<summary>`.
- **Wikilinks** — `[[#Heading]]` → real in-doc anchor; cross-file `[[Page]]` / `[[Page|Alias]]` / `![[…]]` → distinctly styled but inert spans.

Both must keep working with Revenant's source-line / block-id metadata (annotations + scroll-sync) and pass the strict DOMPurify allowlist, and must look identical in the live preview and the PDF/HTML export.

### Approach
Pure **frontend WS-C** feature. No IPC, Rust, settings, or `.svelte` files are touched by the primary work. Greenfield: grep confirms zero callout/wikilink code exists today. Three production files plus one test file:

- `src/lib/render/markdown.ts` — callout **core rule** (token-stream rewrite), wikilink **inline rule**, extracted shared `slugify()`, DOMPurify allowlist additions.
- `src/lib/styles/markdown.css` — callout + wikilink styles (used by preview AND inlined into export via `?raw`, so one source = identical styling everywhere).
- `src/tests/callouts_wikilinks.test.ts` — render + sanitization vitest cases.
- `src/tests/markdown_sanitize.test.ts` — augment with a `details/summary/open` survival case (existing WS-C test file).

### Architecture decisions (with the research finding that drove each)

| Decision | Choice | Driving finding |
|---|---|---|
| **Token color for the Warning callout family** | **Reuse the existing `--warn` / `--warn-soft` / `--warn-text` triplet. Do NOT add a new `--warning*` triplet. No change to `tokens.css` or `documentExport.ts`.** | [codebase], [architecture], [review-history] all independently confirm `tokens.css` already has `--warn*` (light 107–109, dark 178–180), mirrored in `documentExport.ts` LIGHT_ROOT_CSS (157–159). It is identical amber, same semantic role. A `--warning*` duplicate is dead weight and reintroduces the exact LIGHT_ROOT_CSS drift class that caused the 2026-06-14 stale-export-token bug. (Human ruling required — see §B-1.) |
| **Callout transform mechanism** | **markdown-it core rule that rewrites the `blockquote_open` token's `.type`/`.tag`/`.attrs` in place (token-stream rewrite), NOT a renderer override and NOT string post-processing.** | [codebase], [architecture], [review-history] TRAP 10: the existing `blockquote_open` renderer override (markdown.ts 231–235) emits `<blockquote …>`. A string/renderer approach would double-emit metadata or produce a `<blockquote>` and a `<div class="callout">`. The core rule must replace the token so `blockquote_open` never reaches that renderer for callout blocks. |
| **Wikilink inline rule insertion point** | **`md.inline.ruler.after('link', 'wikilink', fn)`. Verify `![[…]]` and `*[[…]]*` (emphasis) cases with tests; fall back to `before('image', …)` only if a test shows the image rule greedily consumes `![`.** | Codebase grep of `node_modules/markdown-it/lib/parser_inline.mjs` line 36 confirms `'link'` IS a real inline rule name in markdown-it 14.x (and `'image'` at line 37). The [review-history] claim that 'link' does not exist (only 'linkify') is **incorrect** — verified against the installed source. |
| **Callout annotation routing** | **Callouts use the SOURCE-anchor path, not a block anchor. Do NOT add `'callout'` to the `BlockAnchor.block_type` union.** The outer callout element MUST carry all three: `data-block-id`, `data-source-line`, `data-block-type="callout"`. | [architecture], [review-history], [ux]: `BlockAnchor.block_type` in `ipc.ts:181` is `"mermaid" \| "table" \| "footnote"` (verified) and is FROZEN. `PreviewPane.handlePreviewMouseUp` (lines 511–538, verified) only block-anchors `mermaid`/`table`; `callout` correctly falls through to the `data-source-line` branch. Adding `'callout'` would require an atomic `ipc.rs` + `ipc.ts` change (out of scope) and break the freeze. |
| **DOMPurify allowlist** | Add `details`, `summary` to `ALLOWED_TAGS`; add `open` to `ALLOWED_ATTR`. `div`, `span`, `svg`, `path`, `data-block-*`, `class`, `id`, `title`, `href` are already allowed (verified 73–116). | [codebase], [review-history] TRAP 1. Highest-risk silent failure: without this, every collapsible callout is stripped to inner text. Mandatory round-trip test. |
| **Slug consistency** | Extract the inlined slug regex (markdown.ts 278–282) into an exported `slugify(text)` and have BOTH `heading_open` and the wikilink rule call it. | [review-history] TRAP 2, [codebase]: the slug is an anonymous regex chain today; an independent reimplementation in the wikilink rule would drift (same class as the 2026-06-14 FROZEN-list bug). |

---

## B. Conflicts & decisions needed (VERBATIM from research — HUMAN MUST RULE BEFORE IMPLEMENTATION)

Each item below is reproduced verbatim from the research lenses, followed by my recommended resolution. The first is the single highest-impact decision and changes the file map.

### Spec conflicts

> - [codebase] Spec §5 and §94 specify adding a `--warning` / `--warning-soft` / `--warning-text` amber triplet to tokens.css and documentExport.ts's inlined :root. Reality: tokens.css already has `--warn` / `--warn-soft` / `--warn-text` (amber, identical semantic role) at lines 107–109 (light) and 178–180 (dark), and documentExport.ts already mirrors them at lines 157–159. Creating a `--warning` duplicate would be dead weight. The callout CSS should use `--warn` / `--warn-soft` / `--warn-text` rather than introducing new names, and no token additions are required.

> - [codebase] Spec §3 says the callout core rule 'walks the token stream' and 'rewrites the blockquote into a callout'. In practice the existing `blockquote_open` renderer rule in markdown.ts (lines 231–235) will fire on any surviving `blockquote_open` token. The core rule must splice replacement html_block or custom tokens before the renderer sees them — or the renderer rule must be made callout-aware. The token-stream-rewrite approach (as spec describes) is correct but means the renderer's blockquote_open override and the core rule must not conflict: the core rule should replace token.type so blockquote_open never reaches the renderer for callout blocks.

> - [codebase] Spec §4 says 'a rule after `link`' for wikilinks. The actual markdown-it inline ruler chain name for links is 'link' (confirmed in /node_modules/markdown-it/lib/rules_inline/link.mjs). `md.inline.ruler.after('link', 'wikilink', fn)` is the correct call. The `![[ ]]` syntax uses `!` as a prefix which markdown-it's image rule ('image') may consume first — the wikilink rule may need to be positioned after 'image' as well, or test that `![[` is not greedily consumed by the image rule.

> - [ux] TOKEN NAME vs. EXISTING TOKEN: The spec introduces '--warning' but tokens.css already has '--warn'. Both are amber. The spec does not acknowledge --warn's existence or explain the distinction. Implementers should know: --warn is for UI chrome (the info banner); --warning is for callout semantic color. These must remain separate tokens. The spec should name the pre-existing --warn explicitly to prevent accidental reuse.

> - [ux] EXPORT LIGHT_ROOT_CSS IS MANUALLY MAINTAINED: The spec says to add --warning to 'the export's inlined :root block in documentExport.ts' (§5). But it does not mention that LIGHT_ROOT_CSS in documentExport.ts (lines 92-168) is a manual copy of tokens.css — there is no build-time sync mechanism. The spec implies this is a simple addition but the developer needs to know why it exists separately (to avoid system dark-mode affecting exported documents). This architectural explanation is missing from the spec's §5.

> - [ux] COLLAPSIBLE CALLOUT DEGRADED ANNOTATION WASH: The spec §3 supports '[!type]-' (start collapsed) syntax. The spec §1 states the feature 'integrated with Revenant's existing source-line/block-id metadata (so annotations + scroll-sync keep working)'. This claim is partially true for scroll-sync (the outer callout div is indexed) and partially false for the ink wash (wash does not render inside a closed details element). This is a conflict between the spec's stated goal and implementation reality.

> - [architecture] The new warning token duplicates the existing warn triplet; reuse warn.

> - [review-history] The spec (§5) introduces `--warning` / `--warning-soft` / `--warning-text` as NEW tokens. However, tokens.css already defines `--warn` / `--warn-soft` / `--warn-text` (light: lines 107–109; dark: lines 178–180) which serve an overlapping semantic role (amber, used by hljs type highlighting). The spec uses a different name prefix to avoid collision, which is correct, but the LIGHT_ROOT_CSS in documentExport.ts (lines 157–159) already has `--warn*`. Implementers must add `--warning*` as entirely new entries and must NOT rename `--warn*` since those are consumed by `.hljs-number` in markdown.css line 110.

> - [review-history] The spec (§4) states the wikilink rule is registered 'after `link`' in the inline ruler. markdown-it's inline ruler has no built-in rule named 'link' — the link-parsing rule is named `'linkify'` and the bracket/image rules are `'newline'`, `'escape'`, `'backticks'`, `'emphasis'`, etc. The correct insertion point is `md.inline.ruler.before('link', ...)` or `md.inline.ruler.push(...)` — 'after link' is ambiguous. Implementers must verify the correct rule name in markdown-it 14.x to avoid a runtime error on rule insertion.

> - [review-history] The spec states callout `data-block-type='callout'` is carried on the outer element (§3) so annotations work. But `BlockAnchor.block_type` in ipc.ts is `'mermaid' | 'table' | 'footnote'` — `'callout'` is NOT in the union. The spec's intent is that callouts use the SOURCE anchor path (walk-up hits the callout div's `data-source-line`), not the block anchor path. This is correct but is not stated explicitly in §3 of the spec. An implementer reading PreviewPane.svelte line 513 may add `blockType === 'callout'` to the block-anchor branch without updating ipc.rs, creating a TypeScript type error caught only by svelte-check.

> - [review-history] The spec (§9 rough file set) does not list PreviewPane.svelte as a file to touch. However, if a user selects text that spans from inside a `.callout-body` up through the callout title/summary, the `commonAncestorContainer` may be the `<details>` or `<div class='callout'>` itself — which does carry `data-block-id` and `data-block-type='callout'` per the spec. Since `'callout'` is not in the `mermaid | table` guard, it falls through to the source anchor branch correctly. But if `data-source-line` is missing from the outer element (an implementation error), the loop exits with `anchor = null` and the annotation is silently dropped. This boundary case needs an explicit test.

### Open risks

> - [codebase] Token-stream rewrite approach for callouts: splicing tokens in a core rule requires careful index management (tokens shift as you splice). A simpler alternative is to keep the renderer approach — make `blockquote_open` renderer callout-aware by checking if the next inline token matches `^\[!(\w[\w-]*)\]`. Either approach works but the core-rule path is harder to test. Human decision: confirm core-rule walk-and-replace vs. renderer-side detection.

> - [codebase] The `![[ ]]` embed syntax: markdown-it's image rule fires on `![`. If a user writes `![[Page]]`, the image rule may attempt to parse `[[Page]]` as an image URL (failing gracefully), or it may consume the `!` and leave `[[Page]]` for the wikilink rule. The behavior must be tested; if the image rule consumes `![[`, the wikilink rule needs to be registered before 'image' rather than after 'link'.

> - [codebase] Collapsible callouts use `<details>`/`<summary>`/`open` attribute. jsdom (Vitest environment) supports `<details>` parsing but `<details open>` toggle behavior is not interactive in jsdom — tests can only verify the `open` attribute is present in the rendered HTML, not that the browser expands/collapses it. This is acceptable for unit tests but the launch-gate check (`cargo tauri dev`) must manually verify collapsible behavior.

> - [codebase] The `blockquote_open` renderer rule override (lines 231–235) will conflict with any callout that reaches the renderer as a still-typed `blockquote_open`. If the core rule does not cover every callout path (e.g. a blockquote that markdown-it considers 'lazy continuation'), the renderer rule will emit a `<blockquote>` for a callout body. This edge case needs a test with multi-line callout bodies.

> - [codebase] DOMPurify version pinned at ^3.4.0 in package.json. `details` and `summary` support in DOMPurify 3.x is confirmed as standard HTML5 elements, but the `open` attribute (a boolean attribute) must be in ADD_ATTR or ALLOWED_ATTR to survive — DOMPurify strips unknown boolean attributes by default. The spec correctly identifies this; implementation must add 'open' explicitly to PURIFY_CONFIG ALLOWED_ATTR.

> - [codebase] The slug consistency contract (spec §4): `[[#Heading]]` → `href="#<slug>"` must match the `id` produced by `heading_open`. The extracted `slugify()` helper makes this mechanical, but the current inline slug at line 279 strips `[^\w\s-]` — Unicode heading text (CJK, accented chars) produces empty or truncated slugs. This is a pre-existing limitation but wikilink anchors to Unicode headings will silently miss. Worth noting in the implementation plan as a known v1 limitation to document alongside the duplicate-heading note.

> - [ux] RISK — ANNOTATABLE UNIT INSIDE NESTED CALLOUTS: The spec allows nested callouts ('nested lists/code/even nested callouts work', §3). If a user annotates text inside a nested callout, the DOM walk in handlePreviewMouseUp (PreviewPane.svelte:505) walks up from the selection and will stop at the INNER callout's data-block-id, not the outer one. This is the correct UX behavior (annotate the innermost container), but it must be validated that the inner callout element carries its own data-block-id — the spec does not confirm this explicitly. Human decision needed: should the callout rule emit data-block-id on the inner callout div when nesting, or only on the outermost?

> - [ux] RISK — `data-block-type` VALUE FOR CALLOUT: The existing annotationResolve.ts block_level path (line 54) does not special-case 'callout' — it falls through to the text-search. The handlePreviewMouseUp anchor builder (PreviewPane.svelte line 511) already has a guard: blockType === 'mermaid' || blockType === 'table' triggers a block anchor (no quoted text walk). A callout with blockType='callout' will NOT hit this guard and will fall through to the source-anchor path. This is correct behavior — callouts should be source-anchored, not block-anchored. But the spec does not confirm this intent, leaving the implementer to infer it.

> - [ux] RISK — WIKILINK ANCHORS AND DUPLICATE HEADINGS: The spec acknowledges duplicate heading slug collisions as a known v1 limitation (§4). The risk is that a user clicking [[#Introduction]] in a document with two '## Introduction' headings will silently land on the first one with no indication of ambiguity. There is no user-visible error or tooltip. This is accepted in the spec, but it should be noted in the implementation that this is intentional, not a bug, so a reviewer does not file it as a defect.

> - [ux] RISK — DOMPurify `open` ATTRIBUTE SURVIVAL: The spec says to add 'open' to ALLOWED_ATTR (§6). The `open` attribute is a boolean attribute on <details>. DOMPurify's ALLOWED_ATTR list controls attribute names on ALL tags, not per-tag. Adding 'open' globally is safe (no known attack surface for the 'open' attribute name on arbitrary elements in this allowlist) but should be confirmed against the specific DOMPurify version in package.json before implementation, as attribute allow behavior has shifted between major versions.

> - [ux] RISK — COLLAPSIBLE DETAILS DISCLOSURE TRIANGLE STYLING: The spec says 'summary gets a disclosure affordance' (§5) and respects prefers-reduced-motion. The native <details>/<summary> disclosure triangle (the browser's built-in arrow) can be styled via list-style or the ::-webkit-details-marker pseudo-element, but cross-browser behavior differs (Firefox, Chrome, Safari all render differently). The spec does not specify whether to use the native triangle or a custom SVG indicator. Using a custom SVG icon (the family icon already defined for the callout title) as the toggle indicator would be more consistent but requires CSS or JS to rotate on open/close. Human decision needed on whether to style the native triangle or replace it.

> - [architecture] In-doc hash anchor nav is unproven; verify with cargo tauri dev.

> - [review-history] TRAP 1 — DOMPurify allowlist omission (precedent: security #12 / Mermaid foreignObject): `details`, `summary`, and `open` are absent from PURIFY_CONFIG. If the implementer adds the callout rule but forgets to update PURIFY_CONFIG, every `<details><summary>` collapsible callout is silently stripped to its inner text. The spec mandates the fix (§6) and requires a sanitization test, but this is the highest-risk silent failure because the rule produces valid HTML that DOMPurify then quietly removes. Verification: the test suite MUST assert `<details open>` round-trips through `renderMarkdown`.

> - [review-history] TRAP 2 — slugify drift between heading_open and wikilink rule (no shared helper yet): The slug logic in heading_open is inlined, not exported. If the wikilink inline rule implements its own slug function with any character-set difference (e.g., keeping hyphens vs. stripping them, or handling Unicode differently), `[[#My Heading]]` will produce an `href` that does not match the heading's `id`. This is the same class of drift that caused the stale FROZEN list bug (2026-06-14). The fix is to extract `slugify()` first, before writing the wikilink rule, and have BOTH rules import it.

> - [review-history] TRAP 3 — LIGHT_ROOT_CSS drift in documentExport.ts (precedent: stale export token, 2026-06-14): tokens.css and LIGHT_ROOT_CSS are manually kept in sync. Every prior round that added a new semantic token has risked drift here. The `--warning*` triplet must be added to LIGHT_ROOT_CSS (lines 92–168 of documentExport.ts) or warning-family callouts export as unstyled. This is exactly the pattern the spec warns about in §5 but is the most commonly missed step in parallel-workstream implementations.

> - [review-history] TRAP 4 — callout body annotation anchoring (outer div must carry data-source-line): The walk-up in PreviewPane.svelte line 506 terminates when it finds the first `data-block-id` ancestor. If the callout core rule emits the outer `<div class='callout'>` with `data-block-id` but WITHOUT `data-source-line` (e.g., implementation forgets to include it), the loop hits the `if (blockId)` branch but `sourceLine` is 0, failing the `sourceLine > 0` guard and exiting with `anchor = null`. Annotations on callout text silently fail. Tests must verify the outer callout div has all three: `data-block-id`, `data-source-line`, and `data-block-type='callout'`.

> - [review-history] TRAP 5 — `--warn` vs `--warning` naming collision risk: tokens.css already uses `--warn` for the amber syntax-highlight color. If an implementer uses `--warn` for callout warning-family styling (rather than `--warn-text` for the family color) they will visually match but semantically alias the hljs type-highlight token, which could break if the token is ever re-tuned. The spec's proposed `--warning` / `--warning-soft` / `--warning-text` names avoid this — but the implementation must not accidentally reference `var(--warn)` in the callout CSS.

> - [review-history] TRAP 6 — test fixtures must include multi-line callout bodies and code inside callouts (precedent: multi-line selection matching, 2026-06-14 lesson): Prior test suites used single-line, clean fixtures and missed real-world failures. Callout bodies can contain `**bold**`, inline code, and list items whose rendered text differs from the quoted_text string (soft-break → space, inline delimiters). The tests in §8 must include at least one multi-line callout body and one inline-formatted line to match the lesson.

> - [review-history] TRAP 7 — svelte-check gate (precedent: 2026-06-14 lesson): Although this feature touches no .svelte files in the primary workstream, if any wiring lands in PreviewPane.svelte (e.g., click handler for collapsible callout toggle) the svelte-check gate (`npm run check`) must run before declaring done. tsc and vite build will not catch arity or prop-type mismatches in Svelte script blocks.

> - [review-history] TRAP 8 — markdown-it inline ruler insertion point is 'link', not a real rule name: md.inline.ruler.before() and .after() require an exact rule name that exists in the chain. markdown-it 14.x's inline ruler chain names are: newline, escape, backticks, strikethrough, emphasis, link, image, newline, html_inline, entity. The name 'link' DOES exist and is correct for inserting before/after it, but the wikilink rule must also handle the case where `[[…]]` appears inside an emphasis run — the inline tokenizer will have already tokenized delimiters at that point. Safer to use `md.inline.ruler.push()` which runs last and sees the final token stream, or verify with a test that `*[[Page]]*` renders the wikilink inside emphasis.

> - [review-history] TRAP 9 — `![[…]]` transclusion must NOT be left as raw `[[…]]` literal text: The spec (§2, §4) requires `![[…]]` to render as the same inert `.wikilink-unresolved` span as a cross-file wikilink — NOT as literal text. This is a deferred feature but the render must handle the `![[` prefix. If the inline rule only matches `[[` (not `![[`), the `!` prefixed syntax silently renders as literal `![[Page]]` text, which is worse than the inert styled span.

> - [review-history] TRAP 10 — blockquote_open renderer override conflict: The existing `md.renderer.rules.blockquote_open` override at markdown.ts lines 231–236 emits `<blockquote data-block-id=… data-block-type='blockquote'>`. The callout core rule must transform the token stream BEFORE rendering, replacing the `blockquote_open` token with a synthetic token sequence, so the renderer never fires `blockquote_open` for callout blocks. If the core rule instead post-processes rendered HTML as a string (string replacement approach), it will conflict with the existing blockquote_open override and produce double metadata or malformed nesting. Use token-stream rewriting only.

### Human rulings — RESOLVED 2026-06-16 (all recommendations accepted)

- **B-1 ACCEPTED:** reuse the existing `--warn` / `--warn-soft` / `--warn-text` triplet for the Warning callout family. **No `--warning*` token; `tokens.css` and `documentExport.ts` are NOT touched. WS-3 is dropped → 2 workstreams.** (This supersedes the design spec §5/§6, which called for a new `--warning` token.)
- **B-2 ACCEPTED:** core-rule rewrites `blockquote_open`→`callout_open` / `blockquote_close`→`callout_close` token `.type` in place (no array splicing); dedicated `callout_open`/`callout_close` renderers.
- **B-3 ACCEPTED:** `md.inline.ruler.after('link', 'wikilink', fn)`, matching both `[[…]]` and `![[…]]`; if the `![[Page]]` test shows the image rule eats `![`, switch to `before('image', …)` (test decides).
- **B-4 ACCEPTED:** callouts route through the existing source-anchor walk; do NOT add `'callout'` to `BlockAnchor.block_type` (FROZEN); no `PreviewPane.svelte`/`ipc` change. Outer element carries all three data-attrs (test asserts).
- **B-5 ACCEPTED:** `data-block-id` + `data-source-line` + `data-block-type="callout"` on EVERY callout div (inner + outer).
- **B-6 ACCEPTED:** collapsed-callout ink-wash degradation is a documented known limitation (annotation still resolves; wash paints on expand).
- **B-7 ACCEPTED:** native `<details>` disclosure marker, minimally restyled. No custom SVG rotator in v1.
- **B-8 ACCEPTED:** Unicode/accented + duplicate-heading slug behaviors are documented v1 limitations (no slugify change — would alter existing heading ids).
- **B-9 ACCEPTED:** Mermaid inside a collapsed callout still hydrates (just not visible until expanded) — noted, no code change.
- **Export collapse behavior (resolved):** the export **preserves the authored collapse state** (a `[!type]-` callout stays collapsed in the export, consistent with "looks like the app"; HTML export remains interactive). No export-specific force-expand in v1 — a possible future enhancement; documented as v1 behavior.

### Recommended resolutions (research lens detail — all accepted above)

- **B-1 (token name — HIGHEST IMPACT, changes the file map):** **Reuse `--warn` / `--warn-soft` / `--warn-text` for the Warning callout family. Do NOT add a `--warning*` triplet.** Four independent lenses agree the existing triplet is identical amber with the same semantic role; a duplicate reintroduces the 2026-06-14 LIGHT_ROOT_CSS drift bug class for no benefit. The [ux] lens's argument for keeping them separate ("--warn is UI chrome, --warning is callout color") is a distinction without a difference here — both are "amber status," and `--syn-type`/`.hljs-number` already share `--warn`. **If the human accepts B-1:** `tokens.css` and `documentExport.ts` are NOT touched, the plan is 2 workstreams, and TRAP 3 / TRAP 5 are eliminated. **If the human rejects B-1** (wants a dedicated `--warning*` token): a third workstream (WS-Token) owns `tokens.css` + `documentExport.ts` LIGHT_ROOT_CSS, and the callout CSS uses `var(--warning*)`. The plan below is written for **B-1 accepted** with the rejection variant noted inline.

- **B-2 (core rule vs renderer detection):** **Core-rule token-stream rewrite**, per spec §3 and TRAP 10. Replace the `blockquote_open` token's `.type`→`callout_open` (and the matching `blockquote_close`→`callout_close`), and register dedicated `callout_open`/`callout_close` renderer rules. This guarantees the existing `blockquote_open` override never fires for callouts. Rewriting `.type` in place (not splicing) avoids the index-shift problem the risk flags.

- **B-3 (wikilink insertion point):** **`md.inline.ruler.after('link', 'wikilink', fn)`** — `'link'` is a verified real rule (parser_inline.mjs line 36). The [review-history] "no rule named link" claim is wrong. The rule must match BOTH `[[…]]` and `![[…]]` (consume a leading `!`). Add tests for `![[Page]]`, `*[[Page]]*` (emphasis), `\[[Page]]` (escape), and `[[…]]` inside a code span. If `![[Page]]` test fails because the `image` rule consumes `![`, move to `before('image', 'wikilink', fn)` — the test decides, no guesswork.

- **B-4 (callout annotation routing):** **Source-anchor path; do NOT add `'callout'` to `BlockAnchor.block_type`.** Verified: the union is `"mermaid" | "table" | "footnote"` and is FROZEN; `PreviewPane` only block-anchors `mermaid`/`table`. The outer callout element MUST carry `data-block-id` + `data-source-line` + `data-block-type="callout"` (TRAP 4). No `PreviewPane.svelte` change is needed — but a test must assert all three attrs are present on the outer element so the existing source-anchor walk succeeds.

- **B-5 (nested callout data-block-id):** **Emit `data-block-id` + `data-source-line` on EVERY callout div, inner and outer.** The DOM walk stops at the innermost `data-block-id` ancestor, which is the correct "annotate the innermost container" UX. Since the core rule rewrites each `blockquote_open` token independently, nested callouts get their own metadata for free — just confirm with a nested-callout test.

- **B-6 (collapsible wash degradation):** **Accept as a documented known limitation.** When a callout is collapsed (`[!type]-`), the ink-wash highlight does not paint inside the closed `<details>` (Range geometry is zero). Annotation still RESOLVES (textContent walk includes hidden text) and the wash paints once expanded. Document this in the test file header and in a one-line note; do not block the feature on it. (No code fix; matches spec intent.)

- **B-7 (disclosure triangle styling):** **Use the native `<details>` marker, restyled minimally** (`summary { cursor: pointer }`, suppress default marker only if it clashes with the family icon, respect `prefers-reduced-motion`). A custom SVG rotator is more polish than v1 needs and adds JS. **Human may override** to request a custom rotating icon — flagged because it changes the CSS task scope.

- **B-8 (Unicode / duplicate-heading slugs):** **Accept both as documented v1 limitations**, per spec §4/§7. Add one xfail-style note test (`[[#Héading]]` slug strips the accent — asserts current behavior, not desired) so a reviewer doesn't file it as a regression. No slugify change in v1 (would alter existing heading `id`s and risk scroll-sync).

- **B-9 (Mermaid inside collapsed callout):** **Out of scope for code change; note as known limitation.** `hydrateDynamicBlocks` queries `[data-mermaid-pending]` regardless of visibility, so hydration still runs; the shimmer is just not visible while collapsed. Acceptable. Flag in the launch-gate manual check.

---

## C. File map

| File | Action | Owner |
|---|---|---|
| `src/lib/render/markdown.ts` | **Modify** — extract `slugify()`; add callout core rule + `callout_open`/`callout_close` renderer rules; add wikilink inline rule; add `details`/`summary` to `ALLOWED_TAGS` and `open` to `ALLOWED_ATTR` | WS-1 |
| `src/tests/callouts_wikilinks.test.ts` | **Create** — callout + wikilink + sanitization render tests | WS-1 |
| `src/tests/markdown_sanitize.test.ts` | **Modify** — add `details/summary/open` survival case | WS-1 |
| `src/lib/styles/markdown.css` | **Modify** — append callout family styles (5 families using `--accent`/`--success`/`--warn`/`--danger`/`--surface-2`) + `<details>` summary affordance + `.wikilink-anchor` / `.wikilink-unresolved` styles | WS-2 |
| `src/lib/styles/tokens.css` | **NOT TOUCHED** (B-1 accepted). *Only if B-1 rejected:* add `--warning*` light+dark → WS-3 | — / WS-3 |
| `src/lib/documentExport.ts` | **NOT TOUCHED** (markdown.css is auto-inlined via `?raw`, line 26; LIGHT_ROOT_CSS unchanged because callouts reuse `--warn`). *Only if B-1 rejected:* add `--warning*` to LIGHT_ROOT_CSS → WS-3 | — / WS-3 |
| `src/lib/PreviewPane.svelte` | **NOT TOUCHED** — callouts route through the existing source-anchor walk (B-4). No new value in the `mermaid`/`table` guard. | — |
| `src/lib/types/ipc.ts` / `src-tauri/src/ipc.rs` | **NOT TOUCHED** — FROZEN; no `'callout'` block_type (B-4). | — |

**Verified no-change rationale for `documentExport.ts`:** line 26 is `import markdownCssRaw from './styles/markdown.css?raw'`, so any callout/wikilink CSS appended to `markdown.css` flows into the export automatically. With B-1 accepted, no token line is added, so LIGHT_ROOT_CSS stays correct.

---

## D. Workstreams (ZERO file overlap)

> **WS-1 and WS-2 share NO files.** WS-1 owns `markdown.ts` + the two test files; WS-2 owns `markdown.css`. They can run fully in parallel. WS-1 produces the HTML class contract (`.callout`, `.callout-callout-<family>`→ actually `.callout-<family>`, `.callout-title`, `.callout-body`, `.wikilink-anchor`, `.wikilink-unresolved`, `data-callout`) that WS-2 styles; agree the class names up front from §A so neither blocks the other. WS-3 exists ONLY if the human rejects B-1.

### WS-1 — Render rules + sanitization + tests (`markdown.ts`, test files)

### WS-2 — Callout + wikilink CSS (`markdown.css`)

### WS-3 — Dedicated `--warning` token (ONLY if B-1 rejected) (`tokens.css`, `documentExport.ts`)

---

## E. Tasks

### WS-1 — Render rules + sanitization + tests

**T1.1 — Extract `slugify()` and rewire `heading_open`.**
- File: `src/lib/render/markdown.ts`.
- Add `export function slugify(text: string): string` containing exactly the current inline chain: `text.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-')`.
- Replace the inline slug block at lines 278–282 inside `heading_open` with `const slug = slugify(headingText);`. No behavior change.
- Verify: `npx tsc --noEmit` (no errors) and `npm test -- markdown_blockmap scroll_sync` → existing heading-id tests still pass (proves no slug regression).

**T1.2 — DOMPurify allowlist additions.**
- File: `src/lib/render/markdown.ts`, `PURIFY_CONFIG` (73–116).
- Add `'details', 'summary'` to `ALLOWED_TAGS`; add `'open'` to `ALLOWED_ATTR`. (`data-callout` is covered — confirm; if the callout rule emits `data-callout`, add it to `ALLOWED_ATTR` too, OR reuse `data-block-type`/`class` only. Decide in T1.3 and keep the allowlist in sync.)
- Verify: `npx tsc --noEmit`. Full sanitization verified in T1.6.

**T1.3 — Callout core rule (token-stream rewrite) + renderer rules.**
- File: `src/lib/render/markdown.ts`.
- Register `md.core.ruler.push('callout', fn)`. Walk `state.tokens`; for each `blockquote_open` whose following `inline` token's content first line matches `/^\[!([\w-]+)\]([+-]?)\s*(.*)$/`:
  - Map type→family per spec §3 table (Info→`accent`, Success→`success`, Warning→`warn`, Danger→`danger`, Neutral/unknown→`neutral`). Note: **family CSS uses `--warn*`, not `--warning*`** (B-1 / TRAP 5 — never `var(--warn)` bare; use `--warn-soft`/`--warn-text` semantically in WS-2).
  - Rewrite the `blockquote_open` token: set `.type = 'callout_open'`, carry `data-callout`, family class, `data-block-id`, `data-source-line`, `data-block-type="callout"`, collapsible flag (`+`/`-`/none), and the title (text after type, else capitalized type). Rewrite the matching `blockquote_close` → `callout_close`. Strip the `[!type]…` marker from the body inline (slice the first line).
  - **Do NOT splice array indices** — rewrite token `.type` in place so `blockquote_open`'s existing renderer never fires for callouts (TRAP 10 / B-2).
- Add `md.renderer.rules.callout_open` / `callout_close`:
  - Static → `<div class="callout callout-<family>" data-callout="<type>" data-block-id data-source-line data-block-type="callout">` + `<div class="callout-title"><svg…/>Title</div>` + `<div class="callout-body">`.
  - Collapsible → `<details …same data-attrs…[ open]><summary class="callout-title">…</summary><div class="callout-body">`; `callout_close` closes `</div></details>` vs `</div></div>` accordingly.
  - Every callout div (inner + outer) carries all three data-attrs (B-5/TRAP 4).
- Reset note: `renderMarkdown` resets `_blockCounter` before `md.render()` (line 299, verified), and core rules run inside `md.render()`, so `nextBlockId()` is valid inside the core rule.
- Verify: `npm test -- callouts_wikilinks` (after T1.5).

**T1.4 — Wikilink inline rule.**
- File: `src/lib/render/markdown.ts`.
- `md.inline.ruler.after('link', 'wikilink', fn)` (B-3; `'link'` verified at parser_inline.mjs:36).
- Rule consumes optional leading `!`, then `[[ … ]]`. Parse `target`, optional `#heading`, optional `|alias`:
  - `[[#H]]` / `[[#H|A]]` → `<a href="#${slugify(H)}" class="wikilink wikilink-anchor">${alias ?? H}</a>` (reuse `slugify` from T1.1 — TRAP 2).
  - `[[P]]` / `[[P|A]]` / `[[P#H]]` / `![[…]]` → `<span class="wikilink wikilink-unresolved" title="${P}">${alias ?? P}</span>` (TRAP 9 — `![[…]]` MUST render as the inert span, never literal text).
  - Respect escaping: `\[[` does not parse (markdown-it `escape` rule runs before `link`).
- Verify: `npm test -- callouts_wikilinks`.

**T1.5 — Test file: callouts + wikilinks.**
- File: `src/tests/callouts_wikilinks.test.ts` (create; follow `markdown_blockmap.test.ts` / `markdown_sanitize.test.ts` patterns — `renderMarkdown(src)` → regex/DOM assertions).
- Callout cases: each family detected; default title (capitalized type) vs custom title; static→`<div class="callout">`, `+`→`<details open>`, `-`→`<details>` (no `open`); unknown type→neutral; **multi-line body** with `**bold**` + inline code + a list item (TRAP 6); nested callout (inner div has its own `data-block-id`+`data-source-line`+`data-block-type="callout"` — B-5); **outer element carries all three data-attrs** (TRAP 4 / B-4); callout blockquote is NOT emitted as `<blockquote>` (TRAP 10 coverage gap).
- Wikilink cases: `[[#H]]` href === `#${slugify(H)}` AND matches the `id` from a real `## H` heading rendered in the same doc (slug-match cross-check — spec §8 / TRAP 2); `[[#H|A]]` alias text; `[[P]]`/`[[P|A]]` inert span with `title`; `![[…]]` inert span (TRAP 9); `\[[P]]` literal; `[[…]]` inside a code span/fence untouched; `*[[Page]]*` wikilink inside emphasis (TRAP 8); `![[Page]]` not eaten by image rule (B-3 — if this fails, switch to `before('image',…)`).
- Add header comment documenting known v1 limits: collapsed-callout wash (B-6), Unicode slug strip (B-8), duplicate-heading collision (B-8).
- Verify: `npm test -- callouts_wikilinks` → all green.

**T1.6 — Sanitization survival case.**
- File: `src/tests/markdown_sanitize.test.ts` (existing WS-C file).
- Add a case: `renderMarkdown('> [!warning]- Heads up\n> body')` output contains `<details>` (or `<details open>` for `+`) AND `<summary` survives — i.e. NOT stripped to inner text (TRAP 1). String-level assertion, matching existing tests in this file.
- Add a case: an explicit `<details open>` round-trips through `DOMPurify.sanitize` with `open` preserved (boolean attr, B / ux open-attr risk).
- Verify: `npm test -- markdown_sanitize` → green.

**WS-1 final gate:** `npm test` (full) + `npx tsc --noEmit` → all green. (No `.svelte` touched, so `npm run check` is not strictly required for WS-1, but run it once if any wiring leaks into a `.svelte` file — TRAP 7.)

### WS-2 — Callout + wikilink CSS

**T2.1 — Callout family card styles.**
- File: `src/lib/styles/markdown.css` (append; follow the existing `.mermaid-error` pattern at the tail — `border: 1px solid color-mix(...); background: var(--…-soft); border-radius: var(--r-lg);` — verified present).
- `.callout` base: full 1px border + tinted bg + radius + padding; `.callout-title` (bold, colored, icon-aligned); `.callout-body` (normal text). Per family:
  - `.callout-info` → `--accent` / `--accent-soft` / `--accent-text`.
  - `.callout-success` → `--success` / `--success-soft` / `--success-text`.
  - `.callout-warning` → **`--warn` / `--warn-soft` / `--warn-text`** (B-1 / TRAP 5 — use the `-soft`/`-text` variants; never bare `var(--warn)` for body color).
  - `.callout-danger` → `--danger` / `--danger-soft` / `--danger-text`.
  - `.callout-neutral` → `--surface-2` / `--border` / `--text-muted`.
  - Tokens only, no raw hex (repo convention — verified the file uses only `var(--…)`).
- *If B-1 rejected:* swap the warning family to `--warning*` (provided by WS-3).
- Verify: `npm run build` (CSS compiles into the bundle) and visual check in T-Gate.

**T2.2 — Collapsible `<details>` affordance.**
- File: `src/lib/styles/markdown.css`.
- `summary.callout-title { cursor: pointer; list-style: none; }`, suppress default marker if it clashes with the family icon (`summary::-webkit-details-marker { display: none }`), and wrap any open/close transition in `@media (prefers-reduced-motion: reduce)` (B-7). Native marker by default unless human picks the custom-icon override.
- Verify: `npm run build`; manual toggle in T-Gate.

**T2.3 — Wikilink styles.**
- File: `src/lib/styles/markdown.css`.
- `.wikilink-anchor` → accent-colored (`var(--accent-text)`), underline on hover (mirror existing `.preview-content a` at line 65).
- `.wikilink-unresolved` → muted, dashed underline, `cursor: default` (not a link). Per the [ux] accessibility note: the inline rule already emits `title="Page"` (T1.4) — that is the v1 affordance; a richer `aria-description` is out of scope for v1 but noted.
- Verify: `npm run build`; visual check in T-Gate.

### WS-3 — Dedicated `--warning` token (ONLY if human rejects B-1)

**T3.1 — Add `--warning*` to tokens.css.**
- File: `src/lib/styles/tokens.css`. Add `--warning`/`--warning-soft`/`--warning-text` to the light `:root` (near 107–109) and the `[data-theme="dark"]` block (near 178–180). Use distinct amber values (precedent: existing `--warn` light `#9A6B1F`/`#F4E9D6`/`#875E1B`, dark `#D2A45C`/`#2A2113`/`#D2A45C`). Do NOT rename `--warn*` (consumed by `--syn-type` line 119 and `.hljs-number` markdown.css:110 — verified).
- Verify: `npm run build`.

**T3.2 — Mirror in LIGHT_ROOT_CSS.**
- File: `src/lib/documentExport.ts`, LIGHT_ROOT_CSS (92–168, light values only). Add the three light `--warning*` lines next to the existing `--warn*` (157–159) — TRAP 3.
- Verify: `npm test -- document_export` → green; export retains warning callout color.

---

## F. Combined verification gate (run after all workstreams merge)

1. `npx tsc --noEmit` → no errors.
2. `npm test` → all suites green (incl. `callouts_wikilinks`, `markdown_sanitize`, `markdown_blockmap`, `scroll_sync`).
3. `npm run check` (svelte-check) → clean (TRAP 7 safety net).
4. `npm run build` → succeeds; CSS bundled.
5. **T-Gate (launch gate, manual — `cargo tauri dev`):** open a doc containing static + collapsible (`+`/`-`) callouts of all 5 families, an `[[#Heading]]` anchor (click → scrolls to heading — architecture "unproven hash-nav" risk), a `[[Page|Alias]]` inert span, an `![[Page]]` inert span, a Mermaid block inside a collapsed callout (B-9), and an annotation on callout-body text (B-4/TRAP 4 — must save). Confirm collapse/expand works (jsdom can't — codebase risk), wash degradation while collapsed is acceptable (B-6), and export (PDF/HTML) shows identical callout colors.

---

## G. Out of scope

- `![[…]]` transclusion / multi-file content embedding (renders as inert span only).
- Multi-file wikilink resolution / cross-document navigation.
- Duplicate-heading slug disambiguation (anchor hits the first — documented v1 limit, B-8).
- Unicode/CJK/accented heading slugs (stripped by existing `slugify` — documented v1 limit, B-8; no change to avoid altering existing heading `id`s).
- Adding `'callout'` to `BlockAnchor.block_type` / any `ipc.rs`/`ipc.ts` change (FROZEN; callouts use source anchors, B-4).
- Custom callout icons beyond the 5-family set.
- Ink-wash rendering inside a collapsed `<details>` (degradation accepted, B-6).
- Custom rotating SVG disclosure indicator (native marker in v1 unless human overrides B-7).
- `aria-description` / richer screen-reader affordance on `.wikilink-unresolved` beyond the `title` attribute.
- Any `PreviewPane.svelte` change (no callout-specific click handling needed — native `<details>` and existing anchor walk suffice).
