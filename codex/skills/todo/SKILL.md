---
name: todo
description: Show or clean the window-todo companion plan and task list. Use for $todo commands or requests to prune completed panel items or clear the panel; does not edit code TODO comments.
---

Handle `$todo prune`, `$todo clear`, `$todo show`, and `$todo help`.
With no action, explain those commands without changing the panel.

Use the window-todo MCP tools with the current conversation's session ID supplied
by its hook. Never use another conversation's ID. For an explicit legacy
`WINDOW_TODO_SESSION` binding, the tools may omit `sessionId`.

- `prune`: call `window` with `op: prune`. This removes completed entries while
  preserving open entries and the plan.
- `clear`: read `plan show` and `window show`. Remove every top-level plan node
  with `plan remove`. Mark any open window IDs done, then call `window prune`.
  This clears the visible plan and list while preserving issued item numbers.
- `show`: read the plan and window list and briefly report their contents.
- `help`: explain the commands without mutations.

Leave the pane empty after `clear`; do not add a tracking plan or list item for
the cleanup. This operation clears panel metadata; chat history and project files
are outside its scope. Report actual tool results and any failures.

`$todo` is used in the Codex composer. `/todo` is the companion pane's local
command and is not registered as a native Codex slash command.
