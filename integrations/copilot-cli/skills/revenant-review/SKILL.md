---
name: revenant-review
description: Apply a Revenant review to the markdown document it reviews. Use this when the user asks to apply a Revenant review, references a .md.review.md file, or pastes an "apply the review comments" instruction from Revenant.
---

# Apply a Revenant review

Revenant writes a review of a markdown document to a sibling
`<doc>.md.review.md` file (for example, `docs/spec.md` → `docs/spec.md.review.md`).
When this skill is invoked, apply that review to the document:

1. **Find the review file.** If the prompt names a path (e.g. the pasted
   Revenant nudge includes `docs/spec.md.review.md`), use it. Otherwise look for
   the most recently modified `*.md.review.md` near the document under discussion.
2. **Read it.** The heading `# Review — <filename>` names the document being
   reviewed. The body has numbered comments — each with a line range, a quoted
   snippet, and the reviewer's note — followed by a `## General notes` section.
   Detached comments (their anchor was lost after edits) are listed separately.
3. **Apply each comment** to the document it reviews. For detached comments,
   locate the relevant text by its quoted snippet and apply the note manually.
4. **Summarize** what you changed, comment by comment.

If no `*.md.review.md` file exists, there is nothing to apply — say so and
proceed normally. Not every document gets annotated.
