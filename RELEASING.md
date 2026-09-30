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

3. Commit and push it (through a pull request if `master` is protected):

   ```bash
   git commit -am "Release vX.Y.Z"
   git push origin master
   ```

4. Create an **annotated** tag on that commit and push it. `git push` alone never sends
   tags, so push the tag by name:

   ```bash
   git tag -a vX.Y.Z -m "TipΔTask vX.Y.Z"
   git push origin vX.Y.Z
   ```

5. Watch **Actions ▸ Build installers**. Three jobs run in parallel (macOS x64 + arm64,
   Windows, Linux), about 30–45 minutes. The first step of each fails fast if the tag does
   not match `package.json`. When all three pass, a `Draft release` job attaches every
   installer to a **draft** GitHub Release. Nothing is published automatically.
6. Open **Releases**, edit the draft, click **Generate release notes**, and tick **Set as a
   pre-release** while the builds are unsigned. Download and smoke-test at least one
   installer per OS, then click **Publish release**.

The installers in a release are `TipATask-<version>-arm64.dmg`, `TipATask-<version>-x64.dmg`,
`TipATask Setup <version>.exe`, `TipATask-<version>.AppImage`, a `.deb` and a pacman
package (`*.pkg.tar.*`).

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
