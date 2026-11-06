#!/usr/bin/env bash
set -euo pipefail

package_mode='release'
node_arch="$(node -p 'process.arch')"
arches=('--arm64' '--x64')

while [[ $# -gt 0 ]]; do
  case "$1" in
    --current)
      case "$node_arch" in
        arm64|x64) arches=("--$node_arch") ;;
        *) echo "Unsupported Node architecture for macOS packaging: $node_arch" >&2; exit 1 ;;
      esac
      ;;
    --dir)
      package_mode='dir'
      ;;
    --help|-h)
      echo "Usage: $0 [--current] [--dir]"
      echo "  --current  build only the host architecture"
      echo "  --dir      create an unpacked .app without DMG or ZIP archives"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
  shift
done

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
build_id="${PI_STUDIO_BUILD_ID:-$(node tools/release/build-identity.cjs)}"
build_number="${PI_STUDIO_BUILD_NUMBER:-$(date -u +%Y%m%d%H%M%S)}"
export PI_STUDIO_BUILD_ID="$build_id"
export PI_STUDIO_BUILD_NUMBER="$build_number"
export BUILD_NUMBER="$build_number"

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
  -f pkcs12 \
  -k "$keychain" \
  -P "$certificate_password" \
  -T /usr/bin/codesign
security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s \
  -k "$keychain_password" \
  "$keychain" >/dev/null
security list-keychains -d user -s "$keychain" "${previous_keychains[@]}"

if ! security find-certificate -c "$identity" "$keychain" >/dev/null; then
  echo "Expected self-signed certificate was not imported: $identity" >&2
  exit 1
fi

pnpm run build
builder_args=(exec electron-builder --mac)
builder_args+=("${arches[@]}")
builder_args+=(--publish never)
if [[ "$package_mode" == 'dir' ]]; then
  builder_args+=(--dir)
fi
env \
  -u CSC_LINK \
  -u CSC_KEY_PASSWORD \
  PI_STUDIO_BUILD_ID="$build_id" \
  PI_STUDIO_BUILD_NUMBER="$build_number" \
  BUILD_NUMBER="$build_number" \
  PI_STUDIO_CODESIGN_IDENTITY="$identity" \
  PI_STUDIO_SIGNING_KEYCHAIN="$keychain" \
  CSC_IDENTITY_AUTO_DISCOVERY=false \
  pnpm "${builder_args[@]}"

version=$(node -p "require('./package.json').version")

apps=()
if [[ " ${arches[*]} " == *' --arm64 '* ]]; then apps+=("release/mac-arm64/Pi Studio.app"); fi
if [[ " ${arches[*]} " == *' --x64 '* ]]; then apps+=("release/mac/Pi Studio.app"); fi

for app in "${apps[@]}"; do
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

if [[ "$package_mode" == 'dir' ]]; then
  echo "Verified unpacked macOS app for v$version: ${apps[*]}"
  exit 0
fi

for arch in arm64 x64; do
  if [[ " ${arches[*]} " != *" --$arch "* ]]; then continue; fi
  archive="release/Pi-Studio-${version}-${arch}.zip"
  extracted=$(mktemp -d)
  ditto -x -k "$archive" "$extracted"
  codesign --verify --deep --strict --verbose=2 "$extracted/Pi Studio.app"
  rm -rf "$extracted"
done

node tools/release/stamp-update-metadata.cjs

echo "Verified signed macOS apps and updater archives for v$version."
