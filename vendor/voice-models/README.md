# vendor/voice-models/

Downloaded local voice-transcription models, managed by
`src/server/voice-model-manager.js`. This is the **dev-mode** location only — see below.

Everything in this directory except this README is gitignored (`.gitignore`:
`/vendor/voice-models/*` with `!/vendor/voice-models/README.md`). Models are fetched at
runtime, never committed and never packaged — they range from ~153 MB (`whisper-base`) to
~670 MB (`parakeet-v3`), and packaged builds must never write inside the signed app bundle.

## Supported models

| ID | Size | Languages |
|---|---|---|
| `parakeet-v2` | ~661 MB | English |
| `parakeet-v3` | ~670 MB | multilingual |
| `whisper-base` | ~161 MB | multilingual |

Full registry (repo, revision, per-file size + sha256): `VOICE_MODEL_REGISTRY` in
`src/server/voice-model-manager.js`.

## Where models actually live

`downloadVoiceModel()` always resolves its destination via `voiceModelsRoot()`
(`config.USER_DATA_ROOT/vendor/voice-models`), which is **shared by every project** on the
machine — one download serves all of them:

- **Dev** (`USER_DATA_ROOT === SERVER_ROOT`): literally this directory,
  `<checkout>/vendor/voice-models/<modelId>/`.
- **Packaged**: Electron's userData dir instead — e.g. macOS
  `~/Library/Application Support/TipATask/vendor/voice-models/<modelId>/`. This directory
  inside the app bundle plays no role there; the app never reads or writes it.

## Usage

```bash
npm run probe:voice-model                            # dry-run: verify all pinned URLs resolve
npm run probe:voice-model -- --model whisper-base     # real download (smallest model, ~161MB)
```

This README (and `mkdir -p`, done unconditionally by the manager) is what keeps the directory
present in a fresh clone — a `.gitkeep` would work too, but this doubles as documentation.
