# Contributing to TipΔTask

Thanks for helping. Bug reports, fixes and improvements are welcome.

## Set up

Follow **Requirements** and **Build and run from source** in [`README.md`](README.md).
In short: Node ≥ 22.19 (`nvm use`), `npm ci`, `npm test`, `npm run build`.

Run the tests before you open a pull request:

```bash
npm test
```

The suite needs no network, database or real terminal. Try your change in the desktop app
(`npm run electron`) — that is the product. Browser mode (`node todo-server.js`) is for
debugging the web layer only.

## Pull requests

- Keep a pull request to one change, and describe what it does and why.
- Add or update tests next to the code you change (`*.test.js`).
- Match the surrounding code: naming, comment density, module style.
- Never commit secrets or local state: `.env`, `.tipatask/`, API tokens, signing
  certificates. They are git-ignored; keep it that way.
- If you change a file, the Apache License §4(b) expects it to stay marked as changed. Git
  history satisfies that for contributions to this repository.

## License of contributions

This project is licensed under the [Apache License 2.0](LICENSE). Under §5, anything you
intentionally submit for inclusion is licensed under the same terms, with no additional
terms or conditions.

## Forks

Keep the [`NOTICE`](NOTICE) attribution and rename your fork. See **Attribution and forks**
in the [`README.md`](README.md#attribution-and-forks).

## Security issues

Do not open a public issue for a vulnerability. See [`SECURITY.md`](SECURITY.md).
