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

When the user pastes that instruction (or invokes the `/revenant-review` command
or skill), read the referenced `.md.review.md` file, apply each numbered comment
to the document it reviews, and summarize what you changed. If no review file
exists, proceed normally — not every document gets annotated.
