---
name: window-todo
description: Maintain the window-todo plan and open task, fix, question and wait lists when the user asks to use the companion pane or manage its items.
---

Use the window-todo MCP `plan` and `window` tools. If the session-start hook supplied a
`sessionId`, pass it on every call; when running through the companion launcher,
its `WINDOW_TODO_SESSION` identifies the list and `sessionId` may be omitted.
Never use another conversation's session ID.

For work requiring a plan, call `plan` with `op: set` and a short title and nodes.
Update each completed step immediately. Use `blocked` or `skipped` with a note when needed.
Pure questions need no plan. Follow the host's rules about parallel agents and permissions.

Use `window` with `op: add` for open tasks (`T`), fixes (`F`), unanswered questions (`Q`)
and external waits (`W`). Close answered or completed items with `done`; preserve
deferred items with `skip`; `prune` removes closed items without reusing their IDs.
Read the list with `show`. Keep the list concise and avoid duplicating plan steps.

The pane is a separate terminal process; this plugin does not insert a native Codex sidebar.
The Codex adapter uses explicit tool updates rather than the Claude Haiku observer.
