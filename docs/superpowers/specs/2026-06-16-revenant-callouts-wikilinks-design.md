# Revenant — Obsidian-extended markdown: Callouts + Wikilinks (#38)

**Status:** Approved design — ready for `feature-research` → `feature-implement`
**Date:** 2026-06-16
**Issue:** [#38](https://github.com/slash-hug/revenant/issues/38)
**Tier:** Tier-2 (security-sensitive DOMPurify allowlist + custom render rules + shared preview/export CSS + new token)

---

## 1. Problem / Goal

The preview renders standard markdown-it output but shows two common Obsidian syntaxes as
literal text:

- **Callouts**: `> [!info] Title` renders as a plain blockquote with visible `[!info]`.
- **Wikilinks**: `[[#Heading]]`, `[[Page|Alias]]` render as literal `[[...]]`.

Add first-class rendering for both, integrated with Revenant's existing source-line/block-id
metadata (so annotations + scroll-sync keep working) and its strict DOMPurify allowlist, and
styled identically in the live preview and the PDF/HTML export.

## 2. Resolved decisions (locked via design Q&A)

| Decision | Choice |
|---|---|
| Implementation | **Custom markdown-it rules** (both) — integrate with the source-line/block-id injection and the strict allowlist; no multi-page-wiki package assumptions. |
| Callout scope | **Standard types + collapsible** (`[!type]+` / `[!type]-` via native `<details>/<summary>`). |
| Wikilink cross-file | **Styled but inert** — `[[#Heading]]` is a real in-doc anchor; cross-file `[[Page]]`/`[[Page|Alias]]` render as distinctly-styled, non-clickable text. |
| Callout border style | **Full 1px border + tinted bg + icon + colored title** (not Obsidian's thick left-stripe — matches the project's design standard). |
| `![[...]]` embeds (transclusion) | **Deferred** (own feature/issue). Render as the same **styled-but-inert reference** as a cross-file wikilink, not raw literal text. |

## 3. Callouts — custom markdown-it core rule

A core rule registered after `block` walks the token stream. When a `blockquote_open` is
followed by an inline whose first line matches `^\[!([\w-]+)\]([+-]?)\s*(.*)$`, it rewrites the
blockquote into a callout and strips the `[!type]…` marker line from the body:

- **Static** (no `+`/`-`): `<div class="callout callout-<family>" data-callout="<type>"
  data-block-id="…" data-source-line="…" data-block-type="callout">` containing a
  `.callout-title` (icon + title text) and a `.callout-body` (the remaining blockquote content,
  rendered as normal markdown).
- **Collapsible** (`-` = start collapsed, `+` = start expanded): same, but `<details>` +
  `<summary class="callout-title">` + `.callout-body`; `open` attribute present for `+`.
- **Title**: the text after the type, else the **capitalized type** (`[!info]` → "Info").
- **Metadata**: the outer element carries `data-source-line` / `data-block-id` /
  `data-block-type="callout"` — this is the reason for a custom rule over a package: a callout
  must be annotatable and scroll-sync-addressable like any other block.
- **Nesting**: the body is parsed as markdown, so nested lists/code/even nested callouts work.

### Type → family mapping (5 families)

| Family | Token | Obsidian types |
|---|---|---|
| Info | `--accent` | note, info, abstract, summary, tldr, todo |
| Success | `--success` | tip, hint, important, success, check, done |
| Warning | `--warning` (new) | question, help, faq, warning, caution, attention |
| Danger | `--danger` | failure, fail, missing, danger, error, bug |
| Neutral | muted/`--surface-2` | quote, cite, example, **and any unknown type (fallback)** |

Each family has a small inline-SVG icon in the title (uses already-allowed `svg`/`path`).

## 4. Wikilinks — custom inline rule

A rule after `link` parses `[[ … ]]` (and `![[ … ]]`):

- `[[#Heading]]` / `[[#Heading|Alias]]` → **in-doc anchor** `<a href="#<slug>"
  class="wikilink wikilink-anchor">Alias-or-Heading</a>`.
- `[[Page]]` / `[[Page|Alias]]` / `[[Page#Heading]]` → **styled-but-inert**
  `<span class="wikilink wikilink-unresolved" title="Page">Alias-or-Page</span>`.
- `![[ … ]]` → same inert reference span (transclusion deferred; see §2).
- **Escaping**: a backslash-escaped `\[[` does not parse. The rule operates on inline content,
  so `[[…]]` inside code spans/fences is untouched (markdown-it isolates code).

### Slug consistency

Extract the slugify logic currently inline in the `heading_open` rule into a shared
`slugify(text)` helper, used by both `heading_open` and the wikilink rule so `[[#Heading]]`
targets match the heading `id`s. Duplicate-heading slugs collide (anchor hits the first) — a
known, acceptable v1 limitation, noted.

## 5. Styling — `src/lib/styles/markdown.css` (shared preview + export)

All callout/wikilink CSS goes in `markdown.css`, which the preview uses and `documentExport.ts`
inlines via `?raw` — so styling is identical in preview and export from a single source.

- **Callout**: tinted background (`color-mix` of the family color), **full 1px border** in the
  family color, colored icon + title; body in normal text. `<details>` summary gets a
  disclosure affordance; respects `prefers-reduced-motion`. No left-stripe.
- **Wikilink**: `.wikilink-anchor` = accent-colored link, underline on hover.
  `.wikilink-unresolved` = distinct muted/dashed-underline style, `cursor: default`, not a link.

### New token

Add a `--warning` / `--warning-soft` / `--warning-text` amber triplet to **two** places:
1. `src/lib/styles/tokens.css` (light + dark).
2. The export's **inlined `:root` block** in `documentExport.ts` (light values) — otherwise
   export callouts of the warning family render uncolored.

## 6. Security — DOMPurify allowlist (`render/markdown.ts` PURIFY_CONFIG)

- Add tags: `details`, `summary`. Add attribute: `open`.
- Anchor `href` is **internal-only** (`#slug`, constructed by us) — no external-URL surface; the
  existing `target`/`rel` hook is unaffected.
- No `style`, no `foreignObject` (unchanged). Wikilink spans/anchors use already-allowed tags.
- Verify `details/summary/open` survive sanitization (test).

## 7. Out of scope

`![[...]]` transclusion / multi-file resolution (candidate follow-up issue) · duplicate-heading
slug disambiguation · callout custom icons beyond the family set.

## 8. Testing (pure `renderMarkdown` — runs in this repo's vitest)

- **Callouts**: type→family detection; default vs custom title; `+`/`-`/none (div vs details +
  `open`); unknown type → neutral fallback; nested body markdown; metadata attrs present.
- **Wikilinks**: `[[#H]]` anchor + slug matches heading id; `[[#H|A]]` alias; cross-file
  `[[P]]`/`[[P|A]]` inert; `![[…]]` inert; `\[[` escape; no-parse inside code span/fence.
- **Sanitization**: `details`/`summary`/`open` survive PURIFY_CONFIG; callout/wikilink output is
  not stripped; anchor href stays internal.

## 9. Rough file set (feature-research/implement splits into workstreams)

- `src/lib/render/markdown.ts` — callout core rule, wikilink inline rule, shared `slugify()`,
  DOMPurify allowlist additions.
- `src/lib/styles/markdown.css` — callout + wikilink styles (preview + export).
- `src/lib/styles/tokens.css` — `--warning` triplet (light + dark).
- `src/lib/documentExport.ts` — `--warning` in the inlined export `:root`.
- `src/tests/*` — callout/wikilink/sanitization vitest cases (e.g. `callouts_wikilinks.test.ts`).
