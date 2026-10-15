# Releasing TipΔTask

Releases are cut from a version tag. `package.json`'s `version` is the single source of
truth for the version baked into the installers, and the tag must match it: the release
workflow fails on purpose when `vX.Y.Z` and `package.json` disagree.

## Cut a release

1. Start from an up-to-date `master` with the `Test` workflow green.
2. Set the new version (this updates `package.json` and `package-lock.json` together):

   ```bash
   nvm use
   npm version X.Y.Z --no-git-tag-version
   ```

3. Make sure `docs/releases/vX.Y.Z.md` exists and reads well (see [Release notes](#release-notes)
   below): the draft release's body is taken from that file in the tagged tree.
4. Commit the version bump and the notes, and push (through a pull request if `master` is
   protected):

   ```bash
   git commit -am "Release vX.Y.Z"
   git push origin master
   ```

5. Create an **annotated** tag on that commit and push it. `git push` alone never sends
   tags, so push the tag by name:

   ```bash
   git tag -a vX.Y.Z -m "TipΔTask vX.Y.Z"
   git push origin vX.Y.Z
   ```

6. Watch **Actions ▸ Build installers**. Three jobs run in parallel (macOS x64 + arm64,
   Windows, Linux), about 30–45 minutes. The first step of each fails fast if the tag does
   not match `package.json`. When all three pass, a `Draft release` job attaches every
   installer plus `SHA256SUMS` to a **draft** GitHub Release whose body is
   `docs/releases/vX.Y.Z.md` from the tagged tree. A tag without that file still gets a
   draft, with a one-line placeholder body and a workflow warning. Nothing is published
   automatically.
7. Open **Releases**, review the draft, and tick **Set as a pre-release** while the builds
   are unsigned. Download and smoke-test at least one installer per OS, then click
   **Publish release**. Prefer fixing the text in `docs/releases/vX.Y.Z.md` over editing the
   draft on GitHub: a re-run of the `Draft release` job rewrites the draft body from the file.

The installers in a release are `TipATask-<version>-arm64.dmg`, `TipATask-<version>-x64.dmg`,
`TipATask Setup <version>.exe`, `TipATask-<version>.AppImage`, a `.deb` and a pacman
package (`tipatask-app-<version>.pacman`).

## Release notes

`docs/releases/<tag>.md` is the body of the GitHub Release for that tag. Plain Markdown, no
H1 (the release page already shows the tag), sections such as `## Highlights`,
`## Improvements`, `## Fixes`, `## Breaking changes`, `## Upgrade notes`, `## Known issues`
as needed, written for people who use the app. The `Draft release` job reads the file from
the tagged commit, so it has to be committed before the tag is created.

In the Tipatask project the file is generated at export time: the private export script
(`export-task-app.sh` in the private checkout, see its header) resolves which private commits
are new since the previous public release, builds bounded evidence from them (commit
messages, changed-file statistics, diffs of a few user-facing files, and the resolution
reports of the tasks named in commit subjects), and asks the project's one-shot agent
provider for the notes. The model runs with no tools, no MCP servers and no credentials in
its environment, and its answer is rejected when it names task keys, commit identifiers,
private paths, email addresses or anything credential-shaped. The maintainer then reviews
and edits the file in this checkout and commits it with the sync. A fork can simply write
the file by hand.

Conventions the generator and the workflow rely on:

- A generated file ends with the HTML comment
  `<!-- tipatask-release-notes generated=… evidence=… -->`. The workflow strips it from the
  release body; the export uses it to tell a hand-edited file from an untouched one. Leave it
  in place: any edit above it keeps your version on later exports, an untouched file is only
  regenerated when the evidence behind it changed, and `--regenerate-notes` forces a rebuild.
- The closing paragraph about installers and `SHA256SUMS` is added by the generator, not by
  the model.
- The notes of a version that already has a tag are never touched again.
- If the export reports `skipped-unresolved-base`, pass `--notes-since <private commit>` (the
  message suggests one); after `failed` or `rejected`, fix the cause and re-run the export with
  `--no-version-bump --regenerate-notes`.

## Dry run without a tag

**Actions ▸ Build installers ▸ Run workflow** builds every platform from the selected
branch and keeps the installers as run artifacts for 14 days. It does not create a Release.
Use it to check a packaging change before tagging.

## Fixing a bad tag or build

- Build failed, or the tag points at the wrong commit, and **no release was published**:
  delete the draft release, delete the tag locally and on GitHub
  (`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`), fix, and tag again.
- A release was **already published**: never move or reuse its tag. Fix forward and ship
  the next patch version.

## Signing

The macOS installers are Developer ID signed and notarized when the `release` GitHub
environment holds all five secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`); the workflow then verifies each dmg with
`codesign`, `spctl` and `stapler`. With none set, macOS is ad-hoc signed and the OS warns on first
launch. Windows and Linux installers are unsigned. Setting all five is required, a partial set
fails the build. The environment must allow `v*` tags and the `master` branch. Certificate and
secret setup: [`ELECTRON_BUILD.md`](ELECTRON_BUILD.md) §2–§3; never store them in the repository.
Each release also carries a `SHA256SUMS` file covering every installer.

## Repository settings that support releases

- A tag ruleset for `v*` that blocks updates and deletions, so published tags stay put.
- Default workflow permissions set to read-only; the release job requests
  `contents: write` for itself.
