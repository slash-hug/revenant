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
