<p align="center">
  <img src="docs/social-preview.jpg" alt="TipΔTask — a control plane for Claude, Codex, and every agent that comes next." width="720">
</p>

# TipΔTask App

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Test](https://github.com/Tipatask/tipatask/actions/workflows/test.yml/badge.svg)](https://github.com/Tipatask/tipatask/actions/workflows/test.yml)
[![Latest release](https://img.shields.io/github/v/release/Tipatask/tipatask?include_prereleases)](https://github.com/Tipatask/tipatask/releases)

TipΔTask is a desktop app for working with AI coding agents. Plan your tasks on a board,
hand them to Claude, Codex or Pi, and watch the work happen in one place. It also keeps a
small knowledge base about your project, so agents start each task with real context instead
of rediscovering your codebase every time.

Created by Anton Matiienko and Apppixies — <https://tipatask.com>.

## Download

Grab the installer for your system from the
[latest release](https://github.com/Tipatask/tipatask/releases).

| System | File | How to install |
|---|---|---|
| macOS (Apple Silicon) | `TipATask-<version>-arm64.dmg` | Open it and drag TipATask to Applications. |
| macOS (Intel) | `TipATask-<version>-x64.dmg` | Same as above, using the x64 file. |
| Windows | `TipATask Setup <version>.exe` | Run the installer. |
| Linux (any distro) | `TipATask-<version>.AppImage` | Make it executable and run it. |
| Debian / Ubuntu | `tipatask-app_<version>_amd64.deb` | `sudo apt install ./<file>.deb` |
| Arch / Artix | `*.pkg.tar.*` | `sudo pacman -U ./<file>.pkg.tar.*` |

Linux builds need glibc 2.35 or newer. TipΔTask uses the `claude` and `codex` command-line
tools you already have, so install and sign in to the ones you want. Pi is included.

## Getting started

To run from source you need Node.js 22.19 or newer, npm 10 or newer, and a C/C++ build
toolchain (see [`ELECTRON_BUILD.md`](ELECTRON_BUILD.md) for your platform).

```bash
git clone https://github.com/Tipatask/tipatask.git
cd tipatask
nvm use
npm ci
npm run electron
```

Once the app is open, choose **Project ▸ Open / Create Project…** and pick your project
folder. TipΔTask signs you in, lets you pick or create a project, and adds the few files your
agents need. They are yours to edit, and reopening the project keeps them up to date. Tasks
are stored on <https://web.tipatask.com> by default; to use your own server, set
`API_BASE_URL` in the project's `.tipatask/config.json`.

To update, install a newer release (or pull and rebuild) and reopen your project.

More: [`ELECTRON_BUILD.md`](ELECTRON_BUILD.md) for building installers,
[`RELEASING.md`](RELEASING.md) for releases, [`CONTRIBUTING.md`](CONTRIBUTING.md) for
development.

## Contributing and security

Contributions are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md). To report a
vulnerability, see [`SECURITY.md`](SECURITY.md).

## License

Apache License 2.0 — see [`LICENSE`](LICENSE). Copyright 2026 Anton Matiienko and Apppixies.

You're free to use, modify and fork TipΔTask, including commercially. Please keep the
[`NOTICE`](NOTICE) file and license with anything you distribute, and mark files you
changed. The TipΔTask and Tipatask names and logos aren't part of the license, so give your
fork its own name and credit the original, for example: *"Based on TipΔTask by Anton
Matiienko and Apppixies (https://github.com/Tipatask/tipatask)"*.

TipΔTask bundles the [Pi Coding Agent](https://github.com/earendil-works/pi) (MIT). Keep
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) too — it credits every third-party
package in the app, and is also under **Help ▸ Third-Party Licenses**.
