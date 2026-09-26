# Security policy

## Supported versions

Only the latest [release](https://github.com/Tipatask/tipatask/releases) receives security fixes.

## Reporting a vulnerability

Please do not report security problems in public issues or pull requests.

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and
choose **Report a vulnerability**. Include what you found, the version, and steps to
reproduce.

You can expect an acknowledgement, and a fix or a mitigation plan for confirmed issues. We
will credit you in the release notes unless you prefer otherwise.

## Scope notes

The desktop app starts a local HTTP and WebSocket server on `127.0.0.1:4455` (loopback
only, gated by a per-launch code) that launches agent sessions on your machine, and it
stores project credentials in `.tipatask/config.json` inside your project folder. Running
that server on its own (`node todo-server.js`) is a debug mode with the same surface.
Reports about any of these are in scope.
