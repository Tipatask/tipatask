# TipATask — Electron Build, Signing & Distribution

> **Paths.** Every path below is relative to the root of this repository.

This guide covers everything needed to produce a signed, notarized, and auto-updating **Electron desktop app** installer for TipATask — the desktop app is the product; everything else in this repo exists to build and support it. It covers macOS (signed + notarized DMG), Windows (unsigned now, signing path documented), and Linux (AppImage, no signing required).

**Shipped state today (differs from the target this guide walks toward):** macOS builds are ad-hoc signed and not notarized locally, and signed + notarized in CI when the `release` environment holds the five Apple secrets; the Windows installer is **unsigned** (SmartScreen warns); Linux has no signing; there is **no auto-update** on any platform; Windows and Linux ship **x64 only**; and the release job only creates a **draft** GitHub Release that a maintainer publishes.

**CI does this for you now**: `.github/workflows/build.yml` builds all three platforms in parallel on a `v*` tag push or manual dispatch and drafts a GitHub Release with every installer attached. The manual steps below remain the reference for what the workflow's `electron:ci:*` scripts actually run, for local iteration, and for the signing/notarization setup CI does not do (no certs are configured there yet).

This is **not** about the Tipatask API server or web frontend, or about the browser/debug mode (`node todo-server.js`). For those, see [`README.md`](README.md).

---

## Quick Reference

| Platform | Output | Signing | Status |
|---|---|---|---|
| macOS | `dist-electron/TipATask-<version>-x64.dmg` (Intel) + `dist-electron/TipATask-<version>-arm64.dmg` (Apple Silicon) | Apple Developer ID + notarize | Wired after cert setup below |
| Windows | `dist-electron/TipATask Setup <version>.exe` (NSIS one-click) | OV / EV cert | Deferred — SmartScreen warns until signed |
| Linux | `dist-electron/*.AppImage` + `*.deb` + `*.pkg.tar.*` (pacman) | None required | Works as-is; x64 only, glibc 2.35 or newer |

Filenames and paths use `TipATask` (electron-builder `productName`). **In-app** strings —
window titles, menu items, splash screen — deliberately keep `TipΔTask` (U+0394).

### Build commands

Each platform must be built on its **native OS** (macOS → DMG, Windows → NSIS, Linux → AppImage+deb+pacman) — `.github/workflows/build.yml`'s matrix does exactly this across three runners.

```bash
cd tipatask
nvm use 22          # Node v22 required

npm install                    # also runs electron-rebuild for node-pty
npm run build                  # bundle client JS/CSS → dist/ (required before electron:dist)
npm run electron               # dev — opens Electron window (no installer)
npm run electron:pack          # unpacked app bundle (fast, no installer)
npm run electron:dist:mac      # macOS DMG only
npm run electron:dist:win      # Windows NSIS installer only
npm run electron:dist:linux    # Linux AppImage + deb only
npm run electron:dist          # all three (cross-platform; must be on matching OS)
```

There is no `electron:publish` script yet; §6 describes how to add one.

Output lands in `dist-electron/`. First run: copies bundled `.env.example` → `~/Library/Application Support/TipATask/.env` (macOS) on first launch.

### Minimum env vars per platform

| Platform | Required in `.env` |
|---|---|
| macOS (signed) | `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Windows (signed) | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` |
| Linux | — |
| Publish to GitHub | `GH_TOKEN` |

Unsigned builds skip all of the above. Linux and unsigned Windows always work without any env vars.

---

## 1. Prerequisites

- **Node v22** — the `postinstall` script uses `electron-rebuild` which requires v22.
  ```bash
  nvm install 22 && nvm use 22
  ```
- **macOS** machine to build macOS DMGs (Apple's toolchain required for signing).
- **Windows** machine (or VM) to build NSIS installers.
- Any OS for Linux AppImage.
- No Docker required.

---

## 2. macOS — Sign + Notarize

### 2a. Enroll in Apple Developer Program

**Cost**: $99 USD / year  
**URL**: https://developer.apple.com/programs/enroll/

Choose **Individual** (faster, no business verification needed) unless you want a company/LLC name to appear in the Gatekeeper prompt. Organization enrollment requires a D-U-N-S number and takes 1-2 weeks.

After activation (usually <24h for Individual), find your **Team ID** at:  
https://developer.apple.com/account → **Membership** → Team ID (10 characters, e.g. `ABCD123456`)

### 2b. Generate a Developer ID Application certificate

This is the certificate that signs the app bundle. It is different from a Mac App Store certificate.

1. On the build Mac: open **Keychain Access** → menu **Certificate Assistant → Request a Certificate From a Certificate Authority**.
2. Fill in: Email = your Apple ID email, Common Name = `TipATask Developer ID`, check **Saved to disk**. This creates `CertificateSigningRequest.certSigningRequest`.
3. Go to https://developer.apple.com/account/resources/certificates → click **+**.
4. Choose **Developer ID Application** (NOT "Mac App Distribution" — that is for the Mac App Store only).
5. Upload the `.certSigningRequest` file. Download the resulting `.cer` file.
6. Double-click the `.cer` to install it into your login keychain.
7. In Keychain Access, find **Developer ID Application: Your Name (TEAM_ID)** → right-click → **Export** → save as `DeveloperID.p12` with a strong password.

Store the `.p12` file and its password in 1Password or similar. The `.p12` is the signing key — losing it means generating a new cert.

### 2c. App-specific password for notarization

Notarization requires authenticating to Apple's servers during the build. App-specific passwords are safer than using your Apple ID password directly.

1. Go to https://account.apple.com → **Sign-In and Security** → **App-Specific Passwords** → **+**.
2. Name it `tipatask-notarize` (label only, no functional effect).
3. Copy the generated password (`xxxx-xxxx-xxxx-xxxx`) and store it in 1Password.

### 2d. Set environment variables

Add to `.env` (**this file is not committed**):

```
# macOS code signing
CSC_LINK=/absolute/path/to/DeveloperID.p12
CSC_KEY_PASSWORD=<your-p12-export-password>

# Notarization
APPLE_ID=<your-apple-id-email>
APPLE_APP_SPECIFIC_PASSWORD=<xxxx-xxxx-xxxx-xxxx>
APPLE_TEAM_ID=<10-char-team-id>
```

`CSC_LINK` can also be a base64-encoded string (useful for CI):
```bash
base64 -i DeveloperID.p12 | pbcopy   # paste result as CSC_LINK value
```

Shell export alternative (one-shot, no .env edit):
```bash
export CSC_LINK=/path/to/DeveloperID.p12
export CSC_KEY_PASSWORD=...
export APPLE_ID=...
export APPLE_APP_SPECIFIC_PASSWORD=...
export APPLE_TEAM_ID=...
npm run electron:dist
```

### 2e. Wire signing in package.json and create entitlements file

These two changes are **required in your checkout** before `npm run electron:dist` will produce a signed build. They are not yet in the repo.

**Replace the `build.mac` block in `package.json`:**

```json
"mac": {
  "target": {
    "target": "dmg",
    "arch": ["x64", "arm64"]
  },
  "icon": "assets/icon.icns",
  "category": "public.app-category.productivity",
  "hardenedRuntime": true,
  "gatekeeperAssess": false,
  "entitlements": "build/entitlements.mac.plist",
  "entitlementsInherit": "build/entitlements.mac.plist",
  "notarize": {
    "teamId": "${env.APPLE_TEAM_ID}"
  }
}
```

electron-builder v25+ has notarization built in. It reads `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` from the environment automatically — no extra `afterSign` hook or `@electron/notarize` dependency needed.

**Create `build/entitlements.mac.plist`:**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
  <key>com.apple.security.cs.allow-executable-page-protection-changes</key><true/>
  <key>com.apple.security.inherit</key><true/>
</dict>
</plist>
```

`disable-library-validation` is required because `node-pty` ships an unsigned native binary (`pty.node`) that is unpacked outside the ASAR bundle. Without this entitlement, Gatekeeper rejects the app at launch.

### 2f. Build

```bash
cd tipatask
nvm use 22
npm install
npm run electron:dist
```

Output: two dmgs — `dist-electron/TipATask-<version>-x64.dmg` (Intel, from `dist-electron/mac/TipATask.app`) and `dist-electron/TipATask-<version>-arm64.dmg` (Apple Silicon, from `dist-electron/mac-arm64/TipATask.app`). `build.mac.artifactName` forces the `-x64` suffix — electron-builder otherwise strips the arch suffix for the default arch (x64), which made the Intel dmg indistinguishable from a universal/default build.

The arm64 dmg runs natively on Apple Silicon Macs — it no longer triggers the **"Support Ending for Intel-Based Apps"** Rosetta warning that an Intel build shows on Apple Silicon. Apple Silicon users must install the `-arm64.dmg`; Intel users install the `-x64.dmg`. Neither filename is a default — always check the suffix before installing.

The first notarize submission blocks until Apple responds — typically 2-15 minutes. Both arch targets are notarized separately in the same `electron-builder` invocation.

### 2g. Verify the build

Run all three checks. All three should print `accepted` or `valid`:

```bash
# 1. Code signature is intact
codesign --verify --deep --strict --verbose=2 "dist-electron/mac-arm64/TipATask.app"

# 2. Gatekeeper accepts the app
spctl --assess --type execute --verbose "dist-electron/mac-arm64/TipATask.app"

# 3. Notarization ticket is stapled to the DMG (repeat for both artifacts)
xcrun stapler validate "dist-electron/TipATask-<version>-x64.dmg"
xcrun stapler validate "dist-electron/TipATask-<version>-arm64.dmg"
```

### 2h. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `errSecInternalComponent` | Keychain locked (CI environment) | Run `security unlock-keychain -p "$KEYCHAIN_PASS" ~/Library/Keychains/login.keychain-db` before build |
| `node-gyp` fails with `ModuleNotFoundError: No module named 'distutils'` while rebuilding `node-pty` for the **x64** target on an Apple Silicon build machine | Building the `x64` dmg on `arm64` hardware cross-rebuilds `node-pty` natively; node-gyp's vendored `gyp` imports stdlib `distutils`, which Python 3.12+ removed | Point `npm_config_python` (or `PYTHON` env var) at a Python ≤3.11 before building (e.g. `pyenv install 3.11 && npm_config_python=$(pyenv which python3.11) npm run electron:dist:mac`), or build the x64 dmg on actual Intel hardware/CI. The `arm64` leg is unaffected — it never needs a cross rebuild on Apple Silicon. |
| Notarize hangs or times out | Network or Apple server issue | Check status: `xcrun notarytool history --apple-id $APPLE_ID --team-id $APPLE_TEAM_ID --password $APPLE_APP_SPECIFIC_PASSWORD` |
| Stapler "no ticket" | Bundle was not actually notarized | Verify notarize env vars are set; check `notarytool history` for rejection details |
| `disable-library-validation` warning in build log | Not an error — expected for node-pty | Ignore |
| App crashes at launch with `NODE_MODULE_VERSION mismatch` | `node-pty` not rebuilt for Electron | Re-run `npm install` (triggers `electron-rebuild`) |

---

## 3. Windows — Signing (Deferred)

Signing is not yet wired. Windows builds work but show a **SmartScreen warning** on install:

> "Windows protected your PC"

Users click **More info → Run anyway** to proceed. Acceptable for early adopters.

### Certificate options (when ready to buy)

| Type | Vendor | Price | SmartScreen |
|---|---|---|---|
| OV code signing | SSL.com | ~$130/yr | Warns until ~3000 installs build reputation (weeks/months) |
| EV code signing | DigiCert, Sectigo | ~$400/yr | Instant trust, no warning ever |

**EV note**: EV certs ship on a USB HSM token (YubiKey HSM 2 or vendor token). Signing requires the token physically attached to the build machine. For CI: use a self-hosted runner with the token, or AzureSignTool + Azure Key Vault HSM.

### Wiring (do this when cert arrives)

1. Add to `.env`:
   ```
   WIN_CSC_LINK=/path/to/codesign.pfx
   WIN_CSC_KEY_PASSWORD=<pfx-password>
   ```

2. Update the `build.win` block in `package.json`:
   ```json
   "win": {
     "target": "nsis",
     "icon": "assets/icon.ico",
     "signingHashAlgorithms": ["sha256"],
     "rfc3161TimeStampServer": "http://timestamp.digicert.com"
   }
   ```

   electron-builder picks up `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` automatically — no `certificateFile` key needed.

3. **EV / HSM path only**: drop `WIN_CSC_LINK`, set `win.certificateSubjectName` to the cert's CN and ensure the token is loaded into the Windows cert store. electron-builder will locate it automatically.

---

## 4. Linux — AppImage

No signing required. AppImage does not use platform code signing. Integrity is provided by the SHA512 hash in `latest-linux.yml` (used by the auto-updater) plus HTTPS download.

Optional: GPG-sign the AppImage for users who download outside the auto-updater:

```bash
gpg --detach-sign --armor "dist-electron/TipATask-<version>.AppImage"
# Publish both .AppImage and .AppImage.asc alongside the GitHub Release
```

---

## 5. First-run behavior (packaged app)

When the packaged Electron app launches for the first time on a new machine:

- If `userData/.env` does not exist, `main.js` copies the bundled `.env.example` to `userData/.env`.
- **Onboarding wizard**: if `userData/.tipatask/config.json` does not exist, `main.js` sends a `first-run` event to the window. The renderer (`src/client/first-run.js`) shows a 4-step blocking overlay: (1) Claude/Codex detection + install links, (2) pick default agent, (3) API URL + token, (4) project name. On Finish it writes `userData/.tipatask/config.json` so the wizard never re-appears. No manual `.env` editing is required for normal use.

userData locations:

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/TipATask/` |
| Windows | `%APPDATA%\TipATask\` |
| Linux | `~/.config/TipATask/` |

---

## 6. Auto-update via GitHub Releases

Auto-update lets installed apps download and apply updates silently in the background. This requires `electron-updater` to be wired in `main.js` and a GitHub Release to publish artifacts to.

**Repo**: `git@github.com:Tipatask/tipatask.git` → owner `Tipatask`, repo `tipatask` (the public Task App repository).

### 6a. Install runtime dependencies

```bash
cd tipatask
npm install --save electron-updater electron-log
```

These are runtime deps (used in the main process), not devDependencies.

### 6b. Add publish config to package.json

Inside `build` (sibling of `mac`, `win`, `linux`):

```json
"publish": [{
  "provider": "github",
  "owner": "Tipatask",
  "repo": "tipatask",
  "releaseType": "release"
}]
```

The repository is **public**, so installed clients can read releases without a token. (A private repository would need a `GH_TOKEN` baked into the app or a `generic` provider such as S3/R2.)

### 6c. Add electron:publish script to package.json

```json
"electron:publish": "electron-builder --publish always"
```

### 6d. Wire autoUpdater in main.js

After the `app.whenReady().then(startServer).then(createWindow)` chain in `main.js`, extend with:

```js
.then(() => {
  if (!app.isPackaged) return;
  const { autoUpdater } = require('electron-updater');
  const log = require('electron-log');
  log.transports.file.level = 'info';
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.checkForUpdatesAndNotify().catch(err => log.error('[updater]', err));
});
```

The `app.isPackaged` guard ensures dev sessions (`npm run electron`) never check for updates.

### 6e. GitHub Personal Access Token

Create a PAT at https://github.com/settings/tokens with `repo` scope (classic PAT) or Contents: write (fine-grained). Save as:

```
GH_TOKEN=<your-token>
```

in `.env` or export in shell before publishing.

### 6f. Publish flow

1. **Bump version** in `package.json` (e.g. `1.1.0` → `1.1.1`).
   Never reuse version tags. Never delete-and-reupload an existing tag — clients cache `latest-*.yml`.
2. Build and publish:
   ```bash
   cd tipatask
   nvm use 22
   GH_TOKEN=<pat> npm run electron:publish
   ```
3. electron-builder builds DMG (macOS) + NSIS (Windows) + AppImage+deb (Linux), creates GitHub Release `v1.1.1`, uploads:
   - `TipATask-1.1.1-x64.dmg` (Intel) / `TipATask-1.1.1-arm64.dmg` (Apple Silicon)
   - `TipATask Setup 1.1.1.exe` (Windows NSIS one-click)
   - `TipATask-1.1.1.AppImage` + `tipatask_1.1.1_amd64.deb`
   - `latest-mac.yml`, `latest-linux.yml`, `latest.yml` (version metadata read by installed clients)

### 6g. End-to-end verification

1. Install `v1.1.0` DMG on a test machine.
2. Publish `v1.1.1` via `electron:publish`.
3. Launch the installed `v1.1.0` app.
4. Watch the updater log:
   ```bash
   tail -f ~/Library/Logs/TipATask/main.log
   ```
   You should see `Update downloaded`.
5. Quit and relaunch. The app version should now be `1.1.1`.

---

## 7. End-user install instructions

### Download

Installers are attached to each [GitHub Release](https://github.com/Tipatask/tipatask/releases). The release workflow only creates a **draft**, so a maintainer publishes it by hand; see [`RELEASING.md`](RELEASING.md). Until the signing certificates from §2/§3 are in place, macOS and Windows builds are unsigned or ad-hoc signed, as described below.

### macOS (ad-hoc signed, not notarized)

1. Download `TipATask-<version>-arm64.dmg` on Apple Silicon Macs (M1/M2/M3/M4), or `TipATask-<version>-x64.dmg` on Intel Macs. Apple Silicon users on the `-arm64.dmg` no longer see the "Support Ending for Intel-Based Apps" warning — check the filename suffix before installing; neither dmg is a default/universal build.
2. Double-click the DMG, drag **TipATask** to **Applications**.
3. Launch from Applications. The build is not notarized, so macOS blocks the first launch: open **System Settings ▸ Privacy & Security** and choose **Open Anyway**.

### Windows (currently unsigned, x64 only)

1. Download `TipATask Setup <version>.exe`.
2. If SmartScreen appears: click **More info → Run anyway**.
3. Follow the installer.

### Linux (x64 only, glibc 2.35 or newer)

The build is compiled on Ubuntu 22.04, so older distributions will not run it. Formats: `.AppImage` (any distribution), `.deb` (Debian/Ubuntu), and a pacman package (`*.pkg.tar.*`, Arch/Artix).

1. Download `TipATask-<version>.AppImage`.
2. Make it executable:
   ```bash
   chmod +x TipATask-<version>.AppImage
   ```
3. Double-click or run:
   ```bash
   ./TipATask-<version>.AppImage
   ```

### After install

- The app opens a window and starts the local task server on port 4455.
- On first launch, choose **Project ▸ Open / Create Project…** and follow the setup wizard: it signs you in through your browser and writes `.tipatask/config.json` (your project credentials) into the project folder. API credentials no longer live in a per-user `.env`.
- There is no auto-update: install a newer version by downloading and installing it by hand.
- The embedded server also answers on http://127.0.0.1:4455/todo.html (launch code required); a browser tab is a debug view of the web layer, not the supported UI.

---

## 8. Reference

| Resource | URL |
|---|---|
| electron-builder docs | https://www.electron.build |
| electron-builder code signing | https://www.electron.build/code-signing |
| electron-builder auto-update | https://www.electron.build/auto-update |
| Apple Developer enrollment | https://developer.apple.com/programs/enroll/ |
| Apple Developer certificates | https://developer.apple.com/account/resources/certificates |
| notarytool man page | `man xcrun notarytool` |
| electron-updater | https://github.com/electron-userland/electron-builder/tree/master/packages/electron-updater |

### Related project docs

- [`README.md`](README.md) — build from source, install, CLI setup, MCP tools
- [`RELEASING.md`](RELEASING.md) — versioning, tagging and the draft-release flow
