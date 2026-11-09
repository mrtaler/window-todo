# Changelog

## 0.4.0

- Add a Codex plugin manifest, session-aware stdio MCP tools and a companion terminal pane.
- Reuse the Claude adapter's plan, window-list and rendering reducers through generated Node modules.
- Add lifecycle hooks and optional planning enforcement for Codex.
- Add multi-process persistence and cross-adapter checks.

The existing Claude pane, observer and commands keep their behavior. The first Codex adapter
uses explicit tool updates and a terminal split; it does not include a separate observer model
or automatically mirror the built-in Codex plan.
