#!/usr/bin/env bash
set -euo pipefail

identity="${PI_STUDIO_CODESIGN_IDENTITY:-Pi Studio Self Signed}"
certificate="${PI_STUDIO_SIGNING_CERTIFICATE:-.release-signing/pi-studio-self-signed.p12}"
password_file="${PI_STUDIO_SIGNING_PASSWORD_FILE:-.release-signing/pi-studio-self-signed-password.txt}"

if [[ ! -f "$certificate" ]]; then
  echo "Signing certificate not found: $certificate" >&2
  echo "Run 'pnpm release:cert' once, then keep the resulting certificate stable." >&2
  exit 1
fi

if [[ ! -f "$password_file" ]]; then
  echo "Signing password file not found: $password_file" >&2
  exit 1
fi

certificate_password=$(tr -d '\r\n' < "$password_file")
if [[ -z "$certificate_password" ]]; then
  echo "Signing password file is empty." >&2
  exit 1
fi

keychain_dir=$(mktemp -d)
keychain="$keychain_dir/pi-studio-signing.keychain-db"
keychain_password=$(openssl rand -hex 32)
previous_keychains=()

while IFS= read -r keychain_entry; do
  previous_keychains+=("$keychain_entry")
done < <(security list-keychains -d user | sed -E 's/^[[:space:]]*"(.*)"$/\1/')

cleanup() {
  security list-keychains -d user -s "${previous_keychains[@]}" >/dev/null 2>&1 || true
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$keychain_dir"
}
trap cleanup EXIT

security create-keychain -p "$keychain_password" "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security import "$certificate" \
  -k "$keychain" \
  -P "$certificate_password" \
  -T /usr/bin/codesign \
  -T /usr/bin/security \
  -T /usr/bin/productbuild
security set-key-partition-list \
  -S apple-tool:,apple: \
  -s \
  -k "$keychain_password" \
  "$keychain" >/dev/null
security list-keychains -d user -s "$keychain" "${previous_keychains[@]}"

if ! security find-certificate -c "$identity" "$keychain" >/dev/null; then
  echo "Expected self-signed certificate was not imported: $identity" >&2
  exit 1
fi

pnpm run build
env \
  -u CSC_LINK \
  -u CSC_KEY_PASSWORD \
  PI_STUDIO_CODESIGN_IDENTITY="$identity" \
  PI_STUDIO_SIGNING_KEYCHAIN="$keychain" \
  CSC_IDENTITY_AUTO_DISCOVERY=false \
  pnpm exec electron-builder --mac --arm64 --x64 --publish never

version=$(node -p "require('./package.json').version")

for app in "release/mac/Pi Studio.app" "release/mac-arm64/Pi Studio.app"; do
  if [[ ! -d "$app" ]]; then
    echo "Expected packaged app was not found: $app" >&2
    exit 1
  fi
  codesign --verify --deep --strict --verbose=2 "$app"
  signature=$(codesign --display --verbose=4 "$app" 2>&1)
  if ! grep -Fq "Authority=$identity" <<<"$signature"; then
    echo "$signature" >&2
    echo "Unexpected signing identity in $app" >&2
    exit 1
  fi
done

for arch in x64 arm64; do
  archive="release/Pi-Studio-${version}-${arch}.zip"
  extracted=$(mktemp -d)
  ditto -x -k "$archive" "$extracted"
  codesign --verify --deep --strict --verbose=2 "$extracted/Pi Studio.app"
  rm -rf "$extracted"
done

echo "Verified signed macOS apps and updater archives for v$version."
