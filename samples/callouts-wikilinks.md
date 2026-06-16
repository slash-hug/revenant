# Callouts & Wikilinks

Quick reference doc to exercise #38.

## Callouts — families

> [!note] Note
> An informational callout (accent family). Body supports **bold**, `code`, and lists:
> - item one
> - item two

> [!tip] Success / tip
> The green family.

> [!warning] Heads up
> The amber/warning family.

> [!danger] Danger
> The red family.

> [!quote]
> Neutral family — no custom title, so the title defaults to "Quote".

> [!unknowntype] Unknown type
> Falls back to the neutral family.

## Callouts — collapsible

> [!tip]- Collapsed by default
> This body is hidden until you click the title (`[!tip]-`).

> [!info]+ Expanded but foldable
> This starts open and can be collapsed (`[!info]+`).

## Wikilinks

- In-document anchor: [[#Callouts — families]] — should scroll to that heading.
- Aliased anchor: [[#Wikilinks|jump to wikilinks]]
- Cross-file (inert, styled): [[Some Other Note]] and [[Some Note|with an alias]]
- Embed (inert reference, transclusion deferred): ![[Embedded Note]]

## Nested callout

> [!warning] Outer
> Outer body.
> > [!note] Inner
> > Nested callout — annotate me; I carry my own block id.
