#!/usr/bin/env bash
# Verifies the app inside each given dmg is Developer ID signed, notarized and stapled.
# Usage: scripts/verify-mac-signature.sh dist-electron/*.dmg
# Exits nonzero if any check fails on any dmg (an ad-hoc/unsigned build fails spctl + stapler).
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <dmg>..." >&2
  exit 2
fi

failed=0
for dmg in "$@"; do
  [ -f "$dmg" ] || { echo "::error::not a file: $dmg"; failed=1; continue; }
  mnt=$(mktemp -d)
  if ! hdiutil attach -nobrowse -readonly -noverify -mountpoint "$mnt" "$dmg" >/dev/null; then
    echo "::error::cannot mount $dmg"; failed=1; rmdir "$mnt"; continue
  fi
  app=$(find "$mnt" -maxdepth 1 -name '*.app' | head -1)
  echo "== $dmg ($app)"
  if [ -z "$app" ]; then
    echo "::error::no .app inside $dmg"; failed=1
  else
    codesign --verify --deep --strict --verbose=2 "$app" || { echo "::error::codesign verify failed: $dmg"; failed=1; }
    # -t exec, not -t install: an app bundle assessed as "install" is rejected even when it is
    # correctly signed and notarized (install is for pkg/dmg). exec is what Gatekeeper uses to open an app.
    spctl -a -vv -t exec "$app" || { echo "::error::spctl rejected: $dmg"; failed=1; }
    xcrun stapler validate "$app" || { echo "::error::stapler validate failed: $dmg"; failed=1; }
  fi
  hdiutil detach "$mnt" -quiet || hdiutil detach "$mnt" -force -quiet
  rmdir "$mnt" 2>/dev/null || true
done
exit $failed
