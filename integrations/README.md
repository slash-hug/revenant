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

### 2. A `/revenant-review` shortcut (optional)

Both agents let you invoke a `revenant-review` shortcut instead of pasting the
full nudge sentence — you still pass the review path.

**Claude Code** — copy [`claude-code/revenant-review.md`](claude-code/revenant-review.md)
to `.claude/commands/revenant-review.md` in your project (shared via git) or
`~/.claude/commands/revenant-review.md` for all projects. Then type
`/revenant-review docs/spec.md.review.md`.

**GitHub Copilot CLI** — copy the
[`copilot-cli/skills/revenant-review/`](copilot-cli/skills/revenant-review/SKILL.md)
skill folder to `.github/skills/` (project, shared via git) or `~/.copilot/skills/`
(all projects). Invoke it in a prompt:
*"Use the `/revenant-review` skill on `docs/spec.md.review.md`."* Copilot CLI also
reads `.claude/commands/` in recent versions (≥ 0.0.399), so the Claude command
above may work directly too — but the skill is the documented, supported path.

## How the pieces fit

| Piece | Who produces it | Who consumes it |
|---|---|---|
| `<doc>.md.review.md` | Revenant (Send to agent) | your agent |
| Clipboard nudge | Revenant (Send to agent) | you → paste into agent |
| `revenant-review` command (Claude Code) / skill (Copilot CLI) | you install once | Claude Code · Copilot CLI |
| `CLAUDE.md` / `AGENTS.md` snippet | you install once | your agent (always) |

## Roadmap

- Autonomous pickup via a local MCP tool (no pasted nudge): [#97](https://github.com/slash-hug/revenant/issues/97)
- One-click auto-install of these helpers: [#98](https://github.com/slash-hug/revenant/issues/98)
