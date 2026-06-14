# Revenant — In-Document Annotation Markers & Drawer↔Document Navigation

**Status:** Design approved (visual + scope validated via brainstorming companion, 2026-06-14)
**Issue:** [#15](https://github.com/slash-hug/revenant/issues/15)
**Scope tier:** Tier-2 (cross-file UX, brand-defining surface) — route to `feature-research` → `feature-implement` after plan approval.
**Surface ownership:** Frontend (WS-C) + one design token (`tokens.css`). **No IPC / Rust changes.**

---

## 1. Problem

Annotations are invisible inside the document. Once added, a comment lives only in the right-hand `AnnotationDrawer`; there is no in-document indication that a span is annotated, and clicking a drawer card does nothing — it does not scroll to or highlight the anchored text. This breaks the core review loop: you cannot scan a document and see where feedback is, and you cannot jump from a comment to its target.

Two gaps, one feature:

1. **In-document marker** — a persistent, brand-distinct indicator on every anchored annotation, visible while scrolling the preview *and* the editor.
2. **Drawer ↔ document navigation** — clicking a drawer card scrolls its anchor into view, washes the span, and opens its comment; clicking an in-document seal scrolls/highlights the matching drawer card.

This is also a deliberate brand surface: every other review tool ships the same yellow highlighter + speech bubble. Revenant's identity is the suminagashi (ink-in-water) transition; the marker extends that ink language rather than copying convention.

## 2. Goals / Non-goals

**Goals**
- A muted ink "seal" marker in the gutter of both the rendered preview and the source editor for every *anchored* and *block-level* annotation.
- Hover-preview / click-commit interaction with an in-context comment popover anchored under the annotated span.
- Bidirectional, click-driven navigation between drawer and document.
- Light (Paper) and dark (Graphite) parity, AA contrast, reduced-motion safety.

**Non-goals (deferred)**
- Inline editing of an annotation body from the popover. Nothing in the app edits bodies today (the drawer only deletes); the popover matches that (read + delete). Editing is a separate follow-up for both surfaces.
- Cross-surface *hover* sync (hovering a drawer card previewing the doc, and vice versa). We ship click-driven navigation; hover stays within a single surface.
- Showing detached annotations in the document (see §6).
- Threaded replies, multiple comments per anchor, reactions.

## 3. The marker — visual language (validated)

**Form:** a muted sumi-ink **droplet-in-a-ring** seal sitting in the gutter beside the annotated block. The droplet shape ties to the suminagashi open transition (which literally seeds drops of ink into water); the ring gives the "stamp / mark" read and a clear hit target. Culturally neutral — derived from Revenant's own ink/water motif, not borrowed iconography. **No kanji/glyph.**

**States:**
- **Resting** — soft seal: ring at ~60% opacity, droplet filled at ~22% opacity. Prose untouched.
- **Hover** — seal darkens (ring/drop to full ink) and a *faint* ink-wash hint (~13%) appears on the span. Reversible; previews scope without committing.
- **Active (clicked)** — seal fills solid ink with a 3px soft halo; droplet inverts to the surface color; the span gets the full ink **wash** (~24%); the comment popover opens under the span.

**Color — one variable drives everything.** A new `--seal-ink` token is defined per theme; ring, droplet, halo, and wash all derive from it via `color-mix()`.

| Token | Paper (light) | Graphite (dark) |
|---|---|---|
| `--seal-ink` | `#4A453B` (muted charcoal) | `#C2BBAA` (warm bone) |
| active droplet (`--seal-on`) | `#FFFFFF` | `#232427` (dark surface) |

"Ink" inverts between themes: charcoal on paper, warm bone on dark paper. Bone `#C2BBAA` on the `#232427` surface clears AA for a UI glyph and is distinct from dark-mode text (`#D6D7DA`), accent (blue), and detached (violet) — no collision. In light, `#4A453B` is distinct from accent, detached, and the danger red (`#B4453A`) it deliberately avoids.

The wash is `linear-gradient(transparent 56%, color-mix(in srgb, var(--seal-ink) 24%, transparent) 56%)` — an underline-weighted ink wash, not a flat highlighter block.

## 4. The popover

A single shared `AnnotationPopover.svelte`, used by both preview and editor.

- **Placement:** drops directly under the annotated span (caret pointing up at the words). For multi-line spans, anchors under the end of the span. **Flips above** when the span is near the viewport bottom.
- **Content:** line chip (`L5` / `L5–L7`) · status badge (`Anchored` / `Block`) · quoted snippet (italic Literata, ink-left-border) · comment body · delete (two-step inline confirm, matching the drawer's pattern — no native `confirm()`).
- **Dismissal:** outside-click or `Esc`. Opening another annotation's popover closes the current one (single active annotation at a time).
- **Block-level anchors** (mermaid/table): no inline text span exists, so the "wash" becomes a soft full-block tint and the popover opens under the block.

## 5. Surfaces & rendering

### 5.1 Preview (`PreviewPane.svelte` + new `AnnotationSeals.svelte`)
- **Seal layer:** an absolutely-positioned overlay inside the preview scroll container. Each seal's vertical position is computed from its target block's `offsetTop`. The target block is found by mapping the annotation's source line to a rendered block via the existing `data-source-line` / block-map mechanism (nearest-line, same approach as scroll-sync).
- **Wash:** painted with the **CSS Custom Highlight API** (`CSS.highlights` registry + `::highlight(annotation-wash)` / `::highlight(annotation-wash-active)`). This paints a `Range` **without mutating the DOM**, so it never fights DOMPurify or the markdown re-render, and it recomputes cleanly when content changes. The `Range` is built by `annotationHighlight.ts`: locate the block element (via block-map), then find `quoted_text` within the block's text content and construct a `Range` across the matching text nodes.
- **Recompute triggers:** after each preview render and on container resize, recompute seal positions and wash ranges from the store (migrate `afterUpdate` → `$effect`, coordinating with issue #2's re-render guard — not dependent on it).

### 5.2 Editor (`EditorPane.svelte`, CodeMirror 6)
- A **custom gutter** (`gutter()` + `GutterMarker`) renders the ink-drop seal on each line carrying an annotation (`line_start`).
- The wash is a `Decoration.mark` over the annotation's line/char range, held in a `StateField` keyed off the active annotation.
- Same hover-preview / click-commit behavior; clicking the gutter marker opens the shared popover anchored at the line.
- In split view, both preview and editor show seals for the same annotations.

### 5.3 Drawer (`AnnotationDrawer.svelte`)
- Cards become navigation triggers: clicking a card sets the focus state (§7) and the active pane scrolls to + opens that annotation.
- The card matching the current `activeId` gets a subtle active treatment (so seal-click highlights it).
- Detached section unchanged.

## 6. Detached annotations (decided: drawer-only)

A detached annotation has no valid anchor, so it has **no document seal**. It surfaces only in the drawer's existing Detached section. We never point ink at text that no longer matches. (Rejected alternative: a "ghost" marker at the stale last-known line — on-theme but misleading once content has moved.)

## 7. State & coordination

A new minimal store `stores/annotationFocus.ts`:

```ts
// writable<{ activeId: string | null; hoverId: string | null; scrollNonce: number }>
```

- `activeId` — the annotation whose popover is open / span is washed. Single value (one active at a time).
- `hoverId` — the annotation being hover-previewed within a surface.
- `scrollNonce` — bumped when a navigation requests a scroll, so the target pane re-runs `scrollIntoView` even if `activeId` is unchanged (re-clicking the same card re-centers it).

Subscribed by `PreviewPane`, `EditorPane`, and `AnnotationDrawer`. Flows:

- **Drawer card click →** set `activeId` + bump `scrollNonce`. Active pane: `scrollIntoView({ block: 'center' })` on the seal/block → wash span → open popover → **ink-bloom pulse** on the seal.
- **Seal click →** set `activeId`. Drawer: scroll the matching card into view + apply active treatment.
- **Esc / outside-click →** clear `activeId` (popover closes, wash clears).

This store is the single source of truth for "what's focused," keeping the three components decoupled — each only reads focus and renders, none reaches into another.

## 8. Motion

- **Hover:** 150 ms ease-out wash-in + seal darken.
- **Click:** seal fill + halo; wash 180 ms ease-out.
- **Arrival (drawer → doc):** brief ink-bloom pulse on the seal (~400 ms: scale 1 → 1.15 → 1 with halo fade) so the eye lands after the scroll.
- **Reduced motion** (`prefers-reduced-motion: reduce`): no bloom, no transitions; instant scroll (`block: 'center'`, no smooth) and static emphasis. Required, per repo motion rules.

## 9. Error handling & edge cases

- **`quoted_text` not found** in a drifted-but-still-anchored block → seal still renders at the block; wash falls back to a soft full-block tint (or omitted); popover still opens. No crash.
- **Target block not found** for a source line (rare) → skip the seal; annotation remains in the drawer; dev-warn.
- **Multiple annotations on one block / adjacent lines** → stack seals vertically with a small offset (seal height + ~2px); clicking one opens only its popover.
- **`CSS.highlights` unsupported** (very old webview) → feature-detect; seal + popover still function; wash silently skipped.
- **Popover near viewport bottom** → flip above the span.

## 10. Files

**New**
- `src/lib/AnnotationSeals.svelte` — preview-side gutter overlay layer.
- `src/lib/AnnotationPopover.svelte` — shared comment popover (preview + editor).
- `src/lib/annotationHighlight.ts` — build `Range`(s) from a block + `quoted_text`; register/refresh `CSS.highlights`.
- `src/lib/stores/annotationFocus.ts` — `{ activeId, hoverId, scrollNonce }`.

**Edited**
- `src/lib/PreviewPane.svelte` — mount seals layer, paint washes, wire focus store, recompute on render/resize.
- `src/lib/EditorPane.svelte` — CM6 gutter marker + range decoration + popover wiring.
- `src/lib/AnnotationDrawer.svelte` — card click → focus/scroll; reflect `activeId`.
- `src/lib/styles/tokens.css` — add `--seal-ink` / `--seal-on` for both themes.

**No changes:** `ipc.rs`, `ipc.ts`, any Rust module. Stored annotations already carry `line/char`, `quoted_text`, and `status`.

## 11. Testing

**Vitest unit**
- `annotationHighlight`: range-building — quoted text found; not found (graceful null); multiple occurrences (first at/after block start); block-level (no inline range).
- `annotationFocus`: state transitions (set active, clear on Esc, `scrollNonce` bump on re-click).
- Seal-position mapping: nearest-block resolution from source line.
- Popover placement: below-span default, flip-above near viewport bottom.

**Component**
- Drawer card click sets `activeId` + scroll intent.
- Seal click sets `activeId`; matching drawer card gets active treatment.
- Detached annotation renders **no** document seal.

**Launch smoke (real doc — mandatory per repo lessons)**
- Preview + editor, light + dark.
- Scroll a long doc: seals track their blocks.
- Edit so an anchor moves (re-anchor): seal follows to the new position.
- Near-bottom annotation: popover flips above.
- `prefers-reduced-motion`: no bloom; instant scroll.

## 12. Open risks

- **Custom Highlight API fidelity in WKWebView vs WebView2** — verify the wash renders identically on both targets (per repo lesson: WKWebView-specific rendering can't be reproduced in the Chromium harness; smoke on the real macOS build).
- **Block-map coarseness** — source-line → rendered-block mapping is nearest-line; for annotations mid-large-block the seal sits at the block top. Acceptable for v1; precise sub-block placement is a possible refinement.
- **Re-render churn** — recomputing ranges every preview render must stay cheap; coordinate with issue #2's re-render guard.
