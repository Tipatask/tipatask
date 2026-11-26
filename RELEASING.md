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
   automatically. If a build job was cancelled before it ran a step, see
   [A build job never started](#a-build-job-never-started). If only the `Draft release` job is
   red, run it again: see [The Draft release job failed](#the-draft-release-job-failed).
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

## A build job never started

A build job is red although it ran nothing: its page shows **This job was cancelled** and no
steps, and the run's annotations say `The job was not acquired by Runner of type hosted even
after multiple attempts`. GitHub could not give the job a hosted runner and cancelled it. For the
macOS job a notice about capacity for macOS arm64 runners can stand beside it. `Draft release` is
skipped, because it needs all three build jobs. The tag, the workflow and the jobs that passed
are fine, and their installers are kept.

Run the failed jobs again: **Re-run jobs ▸ Re-run failed jobs** on the run's page, or

```bash
gh run rerun <run-id> --failed -R Tipatask/tipatask
```

Only the job that did not run is built again. When the `release` environment requires a review,
approve the job once more: a re-run waits for it like the first run. `Draft release` starts by
itself when the job is green. If GitHub still has no runner, the job is cancelled the same way:
run it again later.

## The Draft release job failed

The three build jobs passed and only `Draft release` is red. The installers exist as run
artifacts, so nothing has to be rebuilt and the tag stays where it is. The job talks to
GitHub's release API, and that is what usually fails: an HTTP 5xx answer or a dropped upload
while GitHub is degraded (<https://www.githubstatus.com>). The job already retries each request
with growing pauses, for about four minutes, before it gives up, and its error names the
request, the HTTP status and GitHub's message.

1. Run the job again: open the run under **Actions ▸ Build installers** and choose
   **Re-run jobs ▸ Re-run failed jobs**, or

   ```bash
   gh run rerun <run-id> --failed -R Tipatask/tipatask
   ```

   Only `Draft release` runs; it downloads the installers the build jobs stored. Repeat until
   it is green. A re-run never starts over. It continues with the draft the tag already has,
   keeps every asset that is already uploaded with the same SHA-256, deletes and uploads again
   what is partial or different, uploads what is missing, and rewrites the draft body from the
   tagged `docs/releases/vX.Y.Z.md`. It is green only when the draft holds every file.
2. The run artifacts are kept for 14 days. After that use **Re-run all jobs**: the installers
   are built again and replace the assets the draft already holds.
3. Check that the tag has one draft and that it lists seven files (two `.dmg`, one `.exe`,
   `.AppImage`, `.deb`, `.pacman`, `SHA256SUMS`). Drafts are visible only to maintainers:

   ```bash
   gh api repos/Tipatask/tipatask/releases \
     --jq '.[] | select(.draft) | [.id, .tag_name, (.assets | length)] | @tsv'
   ```

4. Delete leftover duplicate drafts. The job never creates a second draft for a tag that has
   one, and it never deletes a release. When it finds several drafts of its tag, left by an
   earlier failure, it completes the one that holds the most uploaded assets (the oldest on a
   tie), names it in its **Draft release** notice and lists the others in a **Duplicate draft
   releases** warning. Delete each of the others by its id, on the **Releases** page or with

   ```bash
   gh api -X DELETE repos/Tipatask/tipatask/releases/<id>
   ```

   Use the id: `gh release delete vX.Y.Z` goes by tag, and the duplicates share it. Deleting a
   draft does not delete the tag.
5. A draft whose tag reads `untagged-…` in that list has lost its tag: GitHub takes it from a
   draft that is updated through the API without `tag_name`. The job names the tag in its own
   updates, and a hand-written `gh api -X PATCH` on a draft must do the same. Give the tag back;
   the body and the files stay:

   ```bash
   gh api -X PATCH repos/Tipatask/tipatask/releases/<id> -f tag_name=vX.Y.Z
   ```

The job refuses to run for a tag whose release is already published. It fills drafts only and
never changes a published release.

A re-run uses the workflow of the tagged commit, so a tag made before a workflow fix re-runs
the workflow it was tagged with. To complete such a draft, or when Actions itself is down,
run the release step from a checkout that has it. It needs Node 18 or newer and a token that
may write releases:

```bash
gh run download <run-id> -R Tipatask/tipatask -D artifacts
mkdir installers && mv artifacts/*/* installers/
(cd installers && sha256sum -- * > SHA256SUMS)        # macOS: shasum -a 256 -- * > SHA256SUMS
grep -v '^<!-- tipatask-release-notes ' docs/releases/vX.Y.Z.md > notes.md
GITHUB_TOKEN="$(gh auth token)" GITHUB_REPOSITORY=Tipatask/tipatask \
  node scripts/draft-release.js --tag vX.Y.Z --notes notes.md --dir installers --dry-run
```

`--dry-run` only reads and prints what would be kept, replaced and uploaded. Run the last
command again without it to apply.

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
