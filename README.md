# window-todo

A Claude Code mod with two lists in one pane:

1. **The task plan.** Claude writes it through the `plan` tool; the pane and the status line show it
   with live activity, and state-changing tools are denied until a plan exists. This layer is
   claude-mod-todo-list 0.3.1 as it is.
2. **The window list.** Open items of this window, under the plan: tasks `T`, fixes `F`,
   questions to the user `Q`, waits on something outside `W`. Ids are numbered per kind and never
   reused; a closed item stays, struck through, until a prune removes the closed ones; a skipped
   item moves to the bottom of the open
   items with its id.
   The list is kept per session, so `/resume` brings it back. The status line counts the open
   items, for example `T2 F1 Q1`.

Three ways fill the window list:

- **The observer.** After each answered main-loop turn a small model (`haiku`) reads the turn and
  the list, then closes, skips and adds items. «F1 can wait» in your message moves F1 down.
- **The `window` tool.** Claude adds, closes, skips and prunes items itself; every call answers the list
  as it is now.
- **The command.** `/todo add <T|F|Q|W> <title>`, `/todo done <ids>`, `/todo skip <ids>`, `/todo prune` (removes the closed items).

**The Stop reminder.** When an answer ends on a question and the list has no open `Q` item, the
turn is sent back once with a request to add it.

## Install

The plugin ships in the local folder marketplace `<marketplace>`, whose source is the
`claude-plugins` folder that holds this one:

```shell
claude plugin marketplace add <path-to-marketplace>
claude plugin install window-todo@<marketplace> --scope user
```

Skip the first line if `claude plugin marketplace list` already shows `<marketplace>`.
Restart Claude Code after installing. The plugin loads in place from this folder, so later edits
take effect at the next session start or after `/reload-plugins`.

Two options are set with `/plugin configure window-todo@<marketplace>` in Claude Code, or
with `--config KEY=VALUE` on install:

- `enforce` (default `true`): block state-changing tools until a plan exists.
- `accentColor` (default `claude`): theme key or color for the current step, the progress bar and
  the running state, for example `magenta`, `green` or `#c084fc`.

## Development

```shell
npm ci
npm run check    # validate, typecheck, test
```

The tests need Claude Code 2.1.309 or later: older test engines lack `mock.session` and do not
route a mod's `session.append` to a test hook.

## Licence

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for the three mods this one is built from.
