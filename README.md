# window-todo

A Claude Code mod with two lists in one pane:

1. **The task plan.** Claude writes it through the `plan` tool; the pane and the status line show it
   with live activity, and state-changing tools are denied until a plan exists. This layer is
   claude-mod-todo-list 0.3.1 as it is.
2. **The window list** (in progress). Open items of this window: tasks `T`, findings `F`,
   questions `Q`, waits `W`. A small observer model proposes new, closed and skipped items after
   each answered turn; `/todo skip|done|add` does the same by hand. Ids never repeat, a skipped
   item moves down with its id, and the list survives `/resume`.

A Stop reminder returns the turn once when the answer ends with a question that the window list
does not carry as a `Q` item.

## Development

```shell
npm ci
npm run check    # validate, typecheck, test
```

The tests need Claude Code 2.1.309 or later: older test engines lack `mock.session` and do not
route a mod's `session.append` to a test hook.

## Licence

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for the three mods this one is built from.
