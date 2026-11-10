# window-todo

A plan and open-item list for Claude Code and OpenAI Codex. Both adapters use the same
plan and window-list reducers. Claude Code draws a native pane; Codex uses an MCP server
and a companion terminal pane.

## Structure

```text
shared/   client-independent types, plan/window logic, rendering and observer parsing
claude/   Claude hooks, panes, store, model configuration and SDK declarations
codex/    Codex MCP server, hooks, file store and companion terminal
scripts/  build, package checks and release version updates
dist/     generated runtime (not committed): the shared ESM core and the Codex adapter
```

Both adapters run the same `shared/` modules: Claude Code loads them from the TypeScript
sources, Codex from the built `dist/shared/`. There is no second hand-maintained
implementation or Codex-specific copy of the core. Shared tests use Node's test runner;
only Claude adapter tests require the Claude testing SDK. The Claude state contract,
`claude/state.d.ts`, is generated from the canonical shared types and
`claude/state-schema.ts` because that SDK requires a self-contained file with inline state
schemas. It is committed so that a tag installs without a build step.

`master` holds sources only. `npm run build` produces `dist/` locally; it is ignored by Git
and the MR gate fails if anything under `dist/` is tracked. Build a local checkout before
running `node dist/codex/launch.cjs` or installing it in Codex. MR builds are tested and
uploaded as artifacts.

Each release is one tag, `v<version>`. Claude Code installs that tag from its sources. Codex
installs the release asset `window-todo-<version>.tgz`, an npm-format package with the Codex
manifest, `dist/codex/`, `dist/shared/`, `README.md`, `LICENSE` and `NOTICE`, which the
catalog resolves through its static registry `registry/window-todo`. Install release tags,
not arbitrary commits or `master`.

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

### Terminal pane (tmux)

For Claude Code in its normal terminal mode the plan can live in a tmux pane of its own: Claude
on the left with its own scrollback, the plan and window list on the right, scrolling on its own.
From a checkout or the installed plugin folder (Node.js 22.12 or later and tmux):

```shell
node claude/launch.cjs            # or: npm run claude -- [claude options]
```

Claude options are forwarded (`--model`, `--resume <id>`, `--continue`, ...). The launcher picks
the session id (`--session-id`) unless one is resumed, sets `WINDOW_TODO_PANE=1` for the mod and
builds `dist/` when it is missing. Only with that variable set does the mod write the session's
plan, list and activity to the state file the Codex pane reads (see the Codex state directory
below), and the pane inside Claude does not open unasked. A `/clear` or `/resume` moves the pane
to the new session. `--print-commands` prints the two commands for terminal splits of your own;
`-p`, `--help` and Claude's subcommands run Claude directly. A shell function makes it the usual
`claude`:

```shell
claude() { node "<plugin-folder>/claude/launch.cjs" "$@"; }
```

The tmux prefix is `Ctrl+A`; `Ctrl+A` then an arrow switches panes. Mouse mode is on: the wheel
scrolls Claude's history and a click focuses a pane (hold Shift, or Option in iTerm2, to select
text). Keys in the pane:

| Key | Does |
|---|---|
| `↑` `↓` (`k` `j`) | select a window item; scroll on the Plan page |
| `Space` (`x`) | mark the selected item done |
| `s` | move it down («can wait») |
| `Tab`, `0` `1` `2` `3` | pages: all, plan, window list, activity |
| `/` | a command: `/todo done <ids>`, `/todo skip <ids>`, `/todo prune`, `/todo show` |

A change made in the pane waits in `<state>.inbox.json` until the mod applies it (within two
seconds, or at the next prompt) and shows at once, marked as waiting. The plan is view-only.

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

Requirements: Node.js 22.12 or later, Codex with plugin support, and tmux for two panes in
one terminal. The release package includes the generated shared core: installing a release
does not require TypeScript or a build.
The Codex entrypoints check the Node version before loading ESM and report a clear error;
unsupported hook runtimes return an empty response instead of blocking the session.

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
node dist/codex/launch.cjs
```

The launcher creates the tmux panes from the calling shell, before Codex starts. Codex runs
on the left and the plan/list on the right. A local `SessionStart` hook gives the waiting
companion the native thread ID through a private file; it does not open terminal windows.
The companion follows thread changes, restores a resumed thread's list, and exits when its
Codex process exits. The launcher registers its MCP server and local binding hook for that
invocation, leaving the user's Codex config file untouched. It uses an embedded app-server
so its environment reaches the hooks.

To use the usual `codex` command, put a function in your shell configuration. Replace the
checkout path below with your built checkout or installed plugin path:

```shell
codex() { node "$HOME/Projects/github/mrtaler/window-todo/dist/codex/launch.cjs" "$@"; }
```

Reload the shell configuration, then use `codex`, `codex resume --last`, or
`codex -c 'model_reasoning_effort="high"'`. All caller options are forwarded. Help,
administrative commands and non-interactive commands run Codex directly, without tmux.
The companion is a terminal process; this adapter does not add a pane inside Codex's UI.
The terminal pane preserves the shared colors, bold and dim text, and strikethrough for
closed items. Set `NO_COLOR` to disable styling. Output redirected to a file stays plain.

The companion takes the same keys as the Claude pane (see the table above). Focus it with
`Ctrl+A`, then the right arrow, press `/` and enter `/todo prune` to remove completed list
entries or `/todo clear` to empty the plan and the entire list. `/todo show` reports counts
and `/todo help` lists the commands.
These local operations update only the bound conversation and do not call a model.
Item numbers remain issued after cleanup, so removed IDs are never reused.

The bundled `todo` skill provides the same cleanup requests through Codex's MCP tools:
invoke `$todo prune` or `$todo clear` in the Codex composer. For a user installation,
copy `dist/codex/skills/todo/SKILL.md` to `~/.codex/skills/todo/SKILL.md` (or the equivalent
location under your configured Codex home). `/todo` belongs to the companion prompt;
this plugin does not register it as a native Codex slash command.

Install tmux separately if necessary (`brew install tmux` on macOS). The launcher's tmux
prefix is `Ctrl+A`, so `Ctrl+B` reaches Codex. Switch panes with `Ctrl+A`, release it, then
press an arrow or the Latin `o` key. The status line identifies the active pane as Codex
or Window Todo. With `resume <thread-id>` or `resume --last`, the companion reads the
saved list before the first hook runs. For `--last`, the launcher reads the most recent
eligible thread from Codex's local database and passes that same explicit ID to Codex.
If that lookup is unavailable, the session-start hook remains the fallback.
To use an existing terminal application's split panes
instead, print the two commands and run one in each split:

```shell
node dist/codex/launch.cjs --print
```

The launcher supplies the binding hook and MCP server before plugin installation; the
installed plugin adds skill discovery and the remaining activity hooks. Built-in Codex
plans are not mirrored automatically in this version.

Normal launches use the native Codex thread ID, so resuming needs no separate list ID:

```shell
node dist/codex/launch.cjs resume --last
```

For a list created by the older launcher with a separate list-session ID, explicit legacy
binding remains available:

```shell
node dist/codex/launch.cjs --session <list-session-id> -- resume <codex-thread-id>
```

State is stored under `$XDG_STATE_HOME/window-todo` or `~/.local/state/window-todo` in files
readable only by the current user. Set `WINDOW_TODO_STATE_DIR` to choose another directory.
The MCP server rejects a call without a session ID or launcher binding; it does not silently
share one global list across conversations.

### Current differences

| Capability | Claude Code | Codex adapter |
|---|---|---|
| Plan tree and T/F/Q/W operations | Native tools | MCP tools, shared reducers |
| Pane | Inside Claude, or a tmux pane (`claude/launch.cjs`) | Companion process in a terminal split |
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
npm run check    # typecheck, build, validate, test the core/adapters/installable package
npm run demo     # preview the built Codex pane without model calls
npm run pack     # create artifacts/window-todo-<version>.tgz, the Codex package
```

Development uses Node.js 24 or later. Claude tests need Claude Code 2.1.309 or later: older
test engines lack `mock.session` and do not route a mod's `session.append` to a test hook.
Run `npm run build` before installing a local development checkout in Codex; Claude Code
loads the sources directly.

Commit source changes only; the release workflow builds and publishes `dist/`. When the
shared types or `claude/state-schema.ts` change, run `npm run build` and commit the regenerated
`claude/state.d.ts`; the MR gate fails when it is stale. Codex tests cover the
actual stdio MCP protocol, multi-process updates, restart persistence, session isolation,
hooks and launcher quoting. The Claude plugin is validated and tested on the source tree.
Package tests assemble the Codex package in a temporary folder, check its npm layout and
manifest paths and exercise Codex MCP without the source tree or development dependencies.
`npm test` always builds first, so it cannot silently test a stale runtime. Node declarations
are enabled only for shared test specs, not for the Claude adapter or the shared production code.

## Releases

Each MR runs the build, tests and package validation and uploads an installable archive.
These jobs do not change versions, create tags or publish releases. Configure the `check`
status as a required branch-protection check when merge must depend on it.

After merge into `master`, the release workflow reruns the checks and semantic-release
calculates the next version from Conventional Commits. Its prepare step updates both
plugin manifests, builds the runtime with that version, tests the Codex package and
creates the archive. `@semantic-release/git` commits the manifests and `CHANGELOG.md` as
`chore(release): <version> [skip ci]`; `dist/` stays out of `master`. GitHub receives the
release tag and the package archive only after preparation succeeds.

The release-bot job then opens an agent-plugins PR that points the Claude entry at the new
tag, adds the version with the asset's URL and integrity to `registry/window-todo` and points
the Codex entry at it. Until that catalog PR is merged, users keep the previous released
version. Docs/chore-only changes do not create a release unless the configured commit rules
warrant one.

Tags use semantic-release's default `v<version>` format. Leave version numbers, changelog
entries and tags to this workflow.

If GitHub rejects Git notes after a release tag has already been pushed, the workflow retries
the note and completes publication from that immutable tagged tree. It does not recalculate a
version, move a tag or overwrite an existing release asset. Unrelated release failures remain
failures. An existing draft release requires operator review.

To finish a previously interrupted publication, run the `release` workflow manually with
`recover_tag` set to the existing stable tag. The recovery job verifies both tagged manifests
and the tag's ancestry on `master`, builds the tagged sources to restore the archive and runs
the existing catalog update job. It never builds newer source code. Both the automatic
recovery and the manual one end with the package published.

## Licence

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for the three mods this one is built from.
