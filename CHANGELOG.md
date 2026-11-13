## [0.11.2](https://github.com/mrtaler/window-todo/compare/v0.11.1...v0.11.2) (2026-11-13)

### Bug Fixes

* keep the observer from restating items and from logging the agent's own next steps ([717810e](https://github.com/mrtaler/window-todo/commit/717810eb2471cfe7117ed2e020d231fb7174b748))

## [0.11.1](https://github.com/mrtaler/window-todo/compare/v0.11.0...v0.11.1) (2026-11-12)

### Bug Fixes

* resume a session in its own folder and open the sessions page from the pane's command line ([5c00660](https://github.com/mrtaler/window-todo/commit/5c006600303e54f46fd98ffc47e4e2cbbfd73107))

## [0.11.0](https://github.com/mrtaler/window-todo/compare/v0.10.0...v0.11.0) (2026-11-12)

### Features

* **claude:** carry the open window items into the session a /clear starts ([a11fa40](https://github.com/mrtaler/window-todo/commit/a11fa40a1f367f5a1869479aff46222f939e36fe))
* list the sessions to come back to and give window items a come-back day ([c1503df](https://github.com/mrtaler/window-todo/commit/c1503df097f3e1901e7328036e2d0ab61b1628fe))

## [0.10.0](https://github.com/mrtaler/window-todo/compare/v0.9.0...v0.10.0) (2026-11-10)

### Features

* **claude:** show the window-todo pane in tmux beside Claude Code ([c33f1dd](https://github.com/mrtaler/window-todo/commit/c33f1dd72d495f5b25fa64dd1830bcb2fc299843))

## [0.9.0](https://github.com/mrtaler/window-todo/compare/v0.8.0...v0.9.0) (2026-11-10)

### Features

* **codex:** bind resume --last to the latest thread and pre-approve the window-todo tools ([b5bc249](https://github.com/mrtaler/window-todo/commit/b5bc249c843616010488408ba6943b03b501561d))

## [0.8.0](https://github.com/mrtaler/window-todo/compare/v0.7.0...v0.8.0) (2026-11-10)

### Features

* **release:** ship one release tag, Claude from sources and Codex from an npm-format asset ([045facf](https://github.com/mrtaler/window-todo/commit/045facf59436b06c3afa64ea9c5acd598caecfcd))

## [0.7.0](https://github.com/mrtaler/window-todo/compare/v0.6.0...v0.7.0) (2026-11-10)

### Features

* **release:** publish the built package to a release branch instead of master ([9ec6586](https://github.com/mrtaler/window-todo/commit/9ec658632dbc4cfcb5564e541d753b9a3c264573))

## [0.6.0](https://github.com/mrtaler/window-todo/compare/v0.5.0...v0.6.0) (2026-11-10)

### Features

* **codex:** improve companion launch and cleanup commands ([0ce4ea2](https://github.com/mrtaler/window-todo/commit/0ce4ea2be03aa1d70dad0710e654506416ff24cf))

## [0.5.0](https://github.com/mrtaler/window-todo/compare/v0.4.0...v0.5.0) (2026-11-10)

### Features

* **build:** share one core and assemble tested release packages ([c6bdfb0](https://github.com/mrtaler/window-todo/commit/c6bdfb07d1488b7016c17cee5c6260e3ac8b5f15))

### Bug Fixes

* **ci:** guard generated runtime and harden package checks ([a44c538](https://github.com/mrtaler/window-todo/commit/a44c5382fbb95304dfc2fdf1fc3249cdf12d40a1))

## [0.4.0](https://github.com/mrtaler/window-todo/compare/v0.3.0...v0.4.0) (2026-11-10)

### Features

* **codex:** add shared-core MCP tools and companion pane ([0bc1008](https://github.com/mrtaler/window-todo/commit/0bc100852908e99a1e4f4f9c7188134856e98a08))

### Bug Fixes

* **codex:** gate shell commands reported as Bash ([c2f628e](https://github.com/mrtaler/window-todo/commit/c2f628e213f78cd7054df8a8e71f78a34f555c0e))
* **codex:** start the plugin MCP server from the plugin root ([5630cc1](https://github.com/mrtaler/window-todo/commit/5630cc1cf79ea8b503dcb0d0aed9058991539edc))
* **codex:** take the state lock in one step and reclaim stale ones safely ([6b5774b](https://github.com/mrtaler/window-todo/commit/6b5774b0974b6b185bb7dd2d8f8d9b47bdda7694))
* **release:** let semantic-release update plugin manifests ([0ab2af0](https://github.com/mrtaler/window-todo/commit/0ab2af09db02014a4412a817fe43929ffde77b09))
