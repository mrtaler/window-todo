# window-todo

A plan and open-item list for Claude Code and OpenAI Codex. Both adapters use the same
plan and window-list reducers. Claude Code draws a native pane; Codex uses an MCP server
and a companion terminal pane.

## Claude Code

The Claude adapter has two lists in one pane:

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

### Install

Add a marketplace that lists this plugin, then install it at user scope:

```shell
claude plugin marketplace add <marketplace-source>
claude plugin install window-todo@<marketplace> --scope user
```

`<marketplace-source>` is a GitHub `owner/repo`, a git URL or a local folder. Skip the first line
if `claude plugin marketplace list` already shows the marketplace. Restart Claude Code after
installing. From a local folder marketplace the plugin loads in place, so later edits take effect
at the next session start or after `/reload-plugins`.

Two options are set with `/plugin configure window-todo@<marketplace>` in Claude Code, or
with `--config KEY=VALUE` on install:

- `enforce` (default `true`): block state-changing tools until a plan exists.
- `accentColor` (default `claude`): theme key or color for the current step, the progress bar and
  the running state, for example `magenta`, `green` or `#c084fc`.

## OpenAI Codex

Requirements: Node.js 22 or later, Codex with plugin support, and tmux for two panes in
one terminal. The Git package includes the generated shared core: installing it does not
require npm or TypeScript.

```shell
codex plugin marketplace add mrtaler/agent-plugins
codex plugin add window-todo@mrtaler
```

Review and trust the bundled hooks when Codex asks. The Codex manifest explicitly selects
its MCP configuration, skill and command hooks; it does not load the Claude hooks module.

The `plan` MCP tool supports `set`, `add`, `update`, `remove` and `show`. The `window` tool
supports `show`, `add`, `done`, `skip` and `prune`, with the same stable T/F/Q/W IDs as Claude.
When using the installed plugin directly, pass the current Codex thread ID as `sessionId`
on every tool call. The session-start hook supplies that ID. Each conversation has its own
state; background agents should report their findings to the main agent rather than change
its plan.

### Companion pane

From a checkout or an installed copy of this plugin:

```shell
node codex/launch.cjs
```

The launcher runs Codex on the left and the live plan/list on the right, inside one tmux
window. It gives both processes the same `WINDOW_TODO_SESSION` and registers the local MCP
server for that invocation. It leaves the user's Codex config file untouched. The launcher
uses an embedded app-server so its environment also reaches installed plugin hooks.

Install tmux separately if necessary (`brew install tmux` on macOS). In tmux, switch panes
with `Ctrl+B` followed by an arrow. To use an existing terminal application's split panes
instead, print the two commands and run one in each split:

```shell
node codex/launch.cjs --print
```

The launcher can register the MCP server before the plugin is installed, but lifecycle hooks
and skill discovery are available only after plugin installation. Tool updates still appear
in the companion pane. Built-in Codex plans are not mirrored automatically in this version.

The first launch prints a list session ID. To reuse that list while resuming a Codex thread:

```shell
node codex/launch.cjs --session <list-session-id> -- resume <codex-thread-id>
```

State is stored under `$XDG_STATE_HOME/window-todo` or `~/.local/state/window-todo` in files
readable only by the current user. Set `WINDOW_TODO_STATE_DIR` to choose another directory.
The MCP server rejects a call without a session ID or launcher binding; it does not silently
share one global list across conversations.

### Current differences

| Capability | Claude Code | Codex adapter |
|---|---|---|
| Plan tree and T/F/Q/W operations | Native tools | MCP tools, shared reducers |
| Pane | Inside Claude | Companion process in a terminal split |
| Persistence | Claude plugin store | Per-session local files |
| Automatic observer | Host model call using Haiku | Explicit model tool updates |
| Activity | Claude events | Bundled Codex command hooks |
| Planning gate | On by default | Opt-in with `--enforce`; requires installed, trusted hooks |

Codex enforcement pauses after three refusals per prompt to avoid trapping a session when
the plan tool is unavailable. No extra model is called and no API keys are bundled.

For a local preview with sample data, without an API call, tmux or plugin installation:

```shell
npm run demo
```

## Development

```shell
npm ci
npm run build    # regenerate codex/core from the shared hooks/*.ts reducers
npm run check    # check generated code, validate, typecheck, test both adapters
```

The tests need Claude Code 2.1.309 or later: older test engines lack `mock.session` and do not
route a mod's `session.append` to a test hook.

Commit generated `codex/core/*.js` together with changes to their TypeScript sources. The
build check detects stale generated files. Codex tests cover the actual stdio MCP protocol,
multi-process updates, restart persistence, session isolation, hooks and launcher quoting.

## Releases

Conventional Commits on `master` drive semantic-release. The release workflow runs the
checks, generates `CHANGELOG.md`, then uses `@semantic-release/exec` to run
`node scripts/update-version.js ${nextRelease.version}`. That prepare step updates both
`.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`. `@semantic-release/git`
commits those manifests and the changelog as `chore(release): <version> [skip ci]`.

Release tags use semantic-release's default `v<version>` format. Leave version numbers
and changelog entries to this workflow.

## Licence

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for the three mods this one is built from.
