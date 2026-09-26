<p align="center">
  <img src="docs/social-preview.jpg" alt="TipΔTask — a control plane for Claude, Codex, and every agent that comes next." width="720">
</p>

# TipΔTask App

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Test](https://github.com/Tipatask/tipatask/actions/workflows/test.yml/badge.svg)](https://github.com/Tipatask/tipatask/actions/workflows/test.yml)
[![Latest release](https://img.shields.io/github/v/release/Tipatask/tipatask?include_prereleases)](https://github.com/Tipatask/tipatask/releases)

**TipΔTask is an Electron desktop app**: a local task board, architecture knowledge base,
and AI coding-agent orchestrator. It runs Claude, Codex, or Pi Coding Agent sessions against
your project in built-in terminals, tracks tasks against the Tipatask API, and keeps a
per-project knowledge base in sync so agents have real context instead of re-discovering the
codebase every session.

Originally created by **Anton Matiienko and Apppixies** — <https://tipatask.com>.

What you get:

- **The desktop app** (`TipΔTask`, macOS / Windows / Linux) — project picker, Kanban board,
  xterm-based agent terminals, native menus and notifications, and a **Project ▸ Open /
  Create Project…** wizard that provisions the agent harness (Claude/Codex instructions, MCP
  registration, skills, hooks, architecture scaffolding) into any project you open.
- **A CLI installer** (`tipatask-setup`) that provisions the same harness from a terminal,
  for headless or scripted setups. It runs from wherever you cloned this repo.
- **A browser/debug mode** — the app's embedded HTTP + WebSocket server can also be started
  on its own (`node todo-server.js`) and viewed in a browser tab. This is a secondary mode
  for debugging the web layer; it is not the supported way to use TipΔTask.

The task store is a **Tipatask API** project. The hosted service at
<https://web.tipatask.com> is the default: the setup wizard signs you in through your
browser and writes `.tipatask/config.json` into your project. To use a different Tipatask
API server, set `API_BASE_URL` in that file.

This repository is standalone. Clone it anywhere; nothing in it assumes a particular
location on disk or a parent repository.

## Download

Prebuilt installers are attached to every [GitHub Release](https://github.com/Tipatask/tipatask/releases).
Releases are built by CI from a version tag (see [`RELEASING.md`](RELEASING.md)).

> **Unsigned builds.** Until code-signing certificates are in place, the macOS build is
> ad-hoc signed and not notarized, and the Windows installer is unsigned, so both OSes
> warn on first launch. The Windows and Linux builds come from CI and have had less
> real-world testing than macOS; please [report problems](https://github.com/Tipatask/tipatask/issues).

| OS | File | Install |
|---|---|---|
| macOS (Apple Silicon) | `TipATask-<version>-arm64.dmg` | Open the dmg, drag **TipATask** to **Applications**. First launch: **System Settings ▸ Privacy & Security ▸ Open Anyway**. |
| macOS (Intel) | `TipATask-<version>-x64.dmg` | Same as above. Check the suffix: neither dmg is universal. |
| Windows (x64) | `TipATask Setup <version>.exe` | Run it. SmartScreen: **More info ▸ Run anyway**. Per-user install, no admin rights needed. |
| Linux (x64), any distro | `TipATask-<version>.AppImage` | `chmod +x TipATask-<version>.AppImage && ./TipATask-<version>.AppImage` (needs `libfuse2`). |
| Debian / Ubuntu | `tipatask-app_<version>_amd64.deb` | `sudo apt install ./tipatask-app_<version>_amd64.deb` |
| Arch / Artix | `*.pkg.tar.*` | `sudo pacman -U ./<file>.pkg.tar.*` |

Linux builds are compiled on Ubuntu 22.04, so they need **glibc 2.35 or newer**.
There is no auto-updater: install a newer version by downloading it.

The app runs agent sessions with the CLIs you already have installed (`claude`, `codex`);
the Pi Coding Agent is bundled. Install and sign in to whichever agent you want to use.

## Requirements (build from source)

- **Node.js ≥ 22.19.0** (`.nvmrc` pins major 22; `engine-strict=true` in `.npmrc` hard-fails
  `npm install` on an older ambient Node — run `nvm use` first) and **npm ≥ 10**.
- A native toolchain, because `node-pty` is a native module:
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`).
  - **Windows:** Python 3 and Visual Studio Build Tools with the "Desktop development with C++"
    workload, if `npm ci` reports `node-gyp` errors.
  - **Linux:** `python3`, `make`, `g++` (Debian/Ubuntu: `sudo apt install build-essential python3`;
    Arch/Artix: `sudo pacman -S --needed base-devel python`).
  - **Linux, building the pacman package:** `bsdtar` and `zstd` (Debian/Ubuntu:
    `sudo apt install libarchive-tools zstd`; already part of a normal Arch/Artix install).

## Build and run from source

```bash
git clone https://github.com/Tipatask/tipatask.git
cd tipatask                # any location works
nvm install && nvm use     # Node 22.x, must be >= 22.19.0
npm ci
npm test                   # unit tests, no network or database needed
npm run electron           # build the client bundle and open the desktop app (dev run)
npm run electron:pack      # unsigned, unpacked local app bundle (dist-electron/)
```

`npm run electron` bundles the client (`npm run build` → `dist/`), then starts Electron,
which forks the embedded server on port 4455 and opens the project picker.

### Browser mode (debugging only)

The embedded server can run without Electron. Use this to debug the web layer with browser
devtools; it has no project picker, native menus, notifications, or the merge panel, and the
startup banner marks it as debug mode.

```bash
npm run build
node todo-server.js        # HTTP + WebSocket server on :4455
# Open http://127.0.0.1:4455/todo.html and enter the one-time launch code printed by the server
```

In this mode the server needs to know which project it manages. It uses
`TIPATASK_PROJECT_ROOT` when set; otherwise the nearest directory at or above the current
working directory that contains `.tipatask/config.json`; otherwise the current directory.
Run it from inside the project, or set the variable:

```bash
TIPATASK_PROJECT_ROOT=/path/to/your/project node todo-server.js
```

### Build installers

Each OS builds its own installer on that OS (this is what CI does on three runners):

```bash
npm run electron:ci:mac     # macOS   -> dist-electron/TipATask-<version>-arm64.dmg and -x64.dmg
npm run electron:ci:win     # Windows -> dist-electron/TipATask Setup <version>.exe
npm run electron:ci:linux   # Linux   -> dist-electron/*.AppImage, *.deb, *.pkg.tar.*
```

`electron:dist:<os>` does the same but first bumps the patch version in `package.json`; use
`electron:ci:<os>` when you want the version left alone. Pass extra `electron-builder` flags
after `--`. The first build downloads Electron and packaging tools and needs network access.
Signing and notarization setup, and build troubleshooting (for example the Python 3.12
`distutils` error when building the macOS x64 target on Apple Silicon), are in
[`ELECTRON_BUILD.md`](ELECTRON_BUILD.md).

### Releases

Pushing a `v*` tag runs `.github/workflows/build.yml`, which builds all three platforms and
attaches the installers to a draft GitHub Release. The tag must equal the `version` in
`package.json`. Full procedure: [`RELEASING.md`](RELEASING.md).

## Use it with your project

**Desktop app (recommended):** launch TipΔTask, choose **Project ▸ Open / Create
Project…**, and pick your project folder. The wizard signs you in, lets you pick or create a
Tipatask API project, registers this machine as a device, writes `.tipatask/config.json`
into the project, and installs the agent harness files listed below. Re-opening a project
refreshes the harness.

**CLI (headless / scripted):** run the same installer from your clone of this repository,
pointing it at the project. The clone can live anywhere; the installer writes absolute paths
to itself into the project's MCP and hook configuration.

```bash
cd /path/to/tipatask && npm ci                      # once
node src/cli/setup.js --project-root /path/to/your/project
# or, from inside the project:
cd /path/to/your/project && node /path/to/tipatask/src/cli/setup.js
```

`tipatask-setup` is also exposed as an npm `bin` (`npx tipatask-setup` from the clone). The
guided setup:

1. Authenticates you against the Tipatask API (Google OAuth or email+password).
2. Lets you pick or create a project.
3. Registers this machine as a device.
4. Writes `.tipatask/config.json` (project root) with your credentials + backend mode.
5. **Installs the harness templates** into the project (see below).
6. Registers the Tipatask MCP servers in the project's `.mcp.json`, Claude's
   `.claude/settings.local.json` and Codex's `.codex/config.toml`.
7. Offers to install the Caveman Claude Code plugin statusline config.
8. Offers to scan the project and seed an architecture knowledge base
   (`ai/architecture/`).

Source-of-truth rules after setup:

1. The Tipatask API project selected by `API_PROJECT_ID` (`.tipatask/config.json`) is the
   only live task store.
2. Agents should mutate task status through the current project's `tipatask` MCP server
   with `update_task`, then immediately confirm with `get_task`.
3. If MCP task reads/writes do not match `.tipatask/config.json`, refresh project MCP
   registration before trusting status changes.

## What lands in your project

| Path | Purpose | Install mode |
|---|---|---|
| `CLAUDE.md` | Claude agent workflow, task rules, tag conventions | write (protected) |
| `AGENTS.md` | Codex / generic agent guide with inline caveman-ultra rules | write (protected) |
| `.mcp.json` | Registers the `tipatask` (remote HTTP) and `tipatask-local` (stdio, absolute path into this checkout) MCP servers | merge |
| `.claude/settings.json` | Hooks: plan capture, file-access tracking, KB auto-push (absolute path into this checkout). Tipatask-owned entries tagged `_tipatask: true` | merge |
| `.claude/skills/tipatask-expert/SKILL.md` | Tag + architecture skill | write |
| `ai/architecture/GENERAL.md` | Project architecture (populated by discovery) | seed (no overwrite) |
| `.tipatask/install-manifest.json` | Per-file SHA-256 hashes — tracks user edits | write |

## Updating

Install a newer desktop release and re-open the project; the harness refreshes on open. For
a source clone:

```bash
cd /path/to/tipatask && git pull && npm ci && npm run build
node src/cli/setup.js --templates-only --project-root /path/to/your/project
```

Re-install behavior:

- **Unchanged files** (hash matches manifest) → overwritten with new template content.
- **User-edited files** (hash differs from manifest) → skipped with warning. Pass
  `--force` to overwrite.
- **Merge-install targets** (`.mcp.json`, `.claude/settings.json`) → Tipatask-owned
  entries refreshed, user-added entries preserved.

## Customizing installed files

`CLAUDE.md`, `AGENTS.md`, and skill files are yours to edit. The manifest records the
original hash, so the installer knows to stop touching files you've changed.

To reset a file back to the shipped template, delete it and re-run
`tipatask-setup --templates-only`.

To force-refresh every file to the current template, run
`tipatask-setup --templates-only --force` (overwrites any local edits).

## CLI flags

```
tipatask-setup [flags]

  --templates-only      Skip auth/project flow; only install templates + MCP config
  --skip-install        Run auth/project flow but don't install templates
  --skip-discover       Don't offer architecture discovery after install
  --force               Overwrite user-modified files + refresh caveman statusline path
  --dry-run             Print planned actions, don't write
  --project-root <path> Override auto-detected project root
```

## MCP tools exposed

The bundled Tipatask MCP server (`src/mcp/server.js`) gives any MCP-speaking agent these
tools, scoped to the project selected via `.tipatask/config.json`:

| Tool | Purpose |
|---|---|
| `list_tasks`, `get_task`, `create_task`, `update_task`, `delete_task` | Task CRUD |
| `list_system_tags` | List all `tt-*` architecture tags with descriptions |
| `get_tag_architecture` | Read one tag's full `ai/architecture/{tag}.md` content |
| `get_tag_architectures` | Batch-read multiple tags in one call |
| `batch_grep_tags` | Codebase scan across several `tt-*` tags in one pass |
| `create_system_tag` | Write a `tt-*` stub doc + register the tag in the DB |
| `ensure_project_tag` | Register/update a plain (non-`tt-*`) tag's description |
| `get_project_tags` | List project-level task tags from the database |
| `create_task_comment` | Post a comment on a task (defaults to a completion resolution) |
| `list_task_resolutions` | Browse past task comment history by tag |
| `push_knowledge` / `pull_knowledge` | Sync local `ai/architecture/*.md` with the API |
| `list_knowledge_conflicts` / `get_knowledge_conflict` | Recover content another writer's sync overwrote |
| `purge_stale_reservations` | Delete stale, never-finalized task-key reservations |
| `git_worktree_status` | Read-only git worktree/status report (git projects only) |

API-mode status rule:

- `update_task` writes the status.
- `get_task` verifies the saved status from the active project.
- If verification resolves a different project than `.tipatask/config.json` names,
  rerun setup or fix MCP config before continuing.

## Merging task branches (git projects)

When a project's Version Control settings enable git worktrees + commits, every CODING
task leaves a `task/<KEY>` branch (usually in `.worktrees/<KEY>`, in the root repo and in
each nested git repo / submodule). Integrate them from the Task App instead of by
hand: **Project ▸ Merge task branches…** (Electron menu) or the button in **Settings ▸
Version Control**. The panel lists every task branch per repo with its task status,
commits ahead/behind the target, dirty-worktree state and predicted conflicts (`git
merge-tree`), blocks on uncommitted changes that would collide, merges nested repos first
(then records their merged HEAD in the root before merging root branches, so the nested
pointer never conflicts), runs `npm test` / `npm run build` with a pre-merge baseline so
only new failures block, stops on the first real conflict with a "Resolve with agent"
hand-off, and can optionally push + open pull requests and clean up worktrees/branches.
Git runs inside the Task App server process — agents never merge.

## Directory layout

```
tipatask/                        (repo root — clone it anywhere)
├── main.js                      Electron main process entry
├── main/                        Electron main-process helpers (windows, menus, IPC, About)
├── preload.js                   Electron preload bridge
├── todo-server.js               Embedded HTTP + WebSocket server entry (browser/debug mode)
├── src/
│   ├── server/                  Server: task backend, agent sessions, KB sync, git merge
│   ├── client/                  Browser UI (bundled by esbuild into dist/)
│   ├── mcp/
│   │   └── server.js            Tipatask MCP server (stdio, `tipatask-local`)
│   ├── cli/
│   │   ├── setup.js             Installer orchestrator (`tipatask-setup`)
│   │   ├── install-templates.js Template copy + merge + manifest
│   │   ├── manifest.js          Install manifest (.tipatask/install-manifest.json)
│   │   ├── placeholders.js      {{KEY}} substitution
│   │   ├── mcp-client.js        Spawn MCP server as subprocess (for discovery)
│   │   ├── discover.js          Stack detection + tag proposal + GENERAL.md seed
│   │   ├── plugin-install.js    Caveman plugin detect + statusline config
│   │   ├── auth.js              Google OAuth flow for CLI
│   │   ├── http.js              JSON HTTP client
│   │   ├── prompts.js           Interactive prompts (readline-based)
│   │   ├── migrate-tasks.js     file → api / api → file migration
│   │   └── export-tasks.js      Task export
│   └── codex-mcp-config.js      Codex config.toml writer
├── templates/                   Everything that gets copied into your projects
│   ├── CLAUDE.md
│   ├── AGENTS.md
│   ├── .mcp.json
│   ├── .claude/settings.json
│   ├── .claude/skills/tipatask-expert/SKILL.md
│   └── ai/architecture/GENERAL.md.tpl
├── bin/                         mcp-node (Node resolver used by hooks/MCP), bundled pi launcher
├── assets/                      App icons, splash, About/Notices pages
├── build/                       electron-builder resources (macOS entitlements)
├── scripts/                     Build, packaging, probe and dev-hook scripts
├── vendor/                      Staged Pi bundle (gitignored) and voice models (gitignored)
├── fixtures/                    Recorded terminal streams used by tests and probes
├── docs/                        README assets (share image)
└── .env                         Dev-mode server settings (not committed)
```

## Limitations

- `.mcp.json`, `.claude/settings.json` hooks and `.codex/config.toml` in your project carry
  the absolute path of this checkout (or of the installed desktop app). Moving or deleting
  it breaks them — re-open the project in the app or re-run `tipatask-setup` to heal.
- If you have multiple repos with Tipatask installed, make sure the active `tipatask`
  entry in `~/.codex/config.toml` points at the right project before trusting
  `update_task` / `get_task`.
- The caveman statusline absolute path contains the plugin version hash. When the plugin
  auto-updates, re-run with `--force` to refresh the path.
- Discovery scans depth 1 only. Deeper module structure requires manual
  `create_system_tag` calls as you work.

## Contributing and security

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to build, test and submit changes, and
[`SECURITY.md`](SECURITY.md) for how to report a vulnerability.

## License

Apache License 2.0 — see [`LICENSE`](LICENSE). Copyright 2026 Anton Matiienko and Apppixies.

### Attribution and forks

You are free to use, modify, fork and redistribute TipΔTask, including commercially. In
return, Apache-2.0 requires that you:

- keep the copyright and attribution notices, and **include a copy of [`NOTICE`](NOTICE)**
  (or its contents) with any source or binary distribution, in a `NOTICE` file, in your
  documentation, or in a display your product generates (§4(a), §4(c), §4(d));
- mark files you changed as changed (§4(b)).

The license grants no right to use the **TipΔTask** or **Tipatask** names, logos or the
share image other than to describe where the code came from (§6). If you publish a fork,
give it its own name and say what it is based on, for example: *"Based on TipΔTask by Anton
Matiienko and Apppixies (https://github.com/Tipatask/tipatask)"*.

TipΔTask bundles the [Pi Coding Agent](https://github.com/earendil-works/pi) CLI (MIT
license) and its full npm dependency closure. Every third-party package shipped in the
packaged app — TipΔTask's own dependencies and Pi's — is attributed in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md), also reachable from the running app
via **Help ▸ Third-Party Licenses** (macOS: the app menu).
