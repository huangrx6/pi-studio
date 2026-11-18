#!/usr/bin/env bash
set -euo pipefail

output_dir="${1:-.release-signing}"
identity="${PI_STUDIO_CODESIGN_IDENTITY:-Pi Studio Self Signed}"

if [[ ! "$identity" =~ ^[A-Za-z0-9._\ -]+$ ]]; then
  echo "Signing identity may only contain letters, numbers, spaces, dots, underscores, and hyphens." >&2
  exit 1
fi

for command in openssl security; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command not found: $command" >&2
    exit 1
  fi
done

p12_path="$output_dir/pi-studio-self-signed.p12"
password_path="$output_dir/pi-studio-self-signed-password.txt"

if [[ -e "$p12_path" || -e "$password_path" ]]; then
  echo "Refusing to overwrite existing signing material in $output_dir." >&2
  exit 1
fi

mkdir -p "$output_dir"
chmod 700 "$output_dir"
umask 077

work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT

key_path="$work_dir/private-key.pem"
cert_path="$work_dir/certificate.pem"
config_path="$work_dir/certificate.cnf"
staged_p12_path="$work_dir/pi-studio-self-signed.p12"
staged_password_path="$work_dir/pi-studio-self-signed-password.txt"
password=$(openssl rand -hex 32)

cat > "$config_path" <<EOF
[req]
prompt = no
distinguished_name = distinguished_name
x509_extensions = code_signing

[distinguished_name]
CN = $identity
O = Pi Studio

[code_signing]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
EOF

openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 3650 \
  -keyout "$key_path" \
  -out "$cert_path" \
  -config "$config_path"

legacy_args=()

if openssl version 2>/dev/null | grep -q '^OpenSSL 3'; then
  legacy_args+=(-legacy)
fi

pkcs12_args=("${legacy_args[@]}" -export -inkey "$key_path" -in "$cert_path" -name "$identity" -out "$staged_p12_path" -passout "file:$staged_password_path")
printf '%s\n' "$password" > "$staged_password_path"
openssl pkcs12 "${pkcs12_args[@]}"
openssl pkcs12 "${legacy_args[@]}" -in "$staged_p12_path" -noout -passin "file:$staged_password_path"
chmod 600 "$staged_p12_path" "$staged_password_path"
mv "$staged_p12_path" "$p12_path"
mv "$staged_password_path" "$password_path"

cat <<EOF
Created a stable self-signed macOS code-signing certificate:

  certificate: $p12_path
  password:    $password_path

Upload the file contents as the GitHub Actions secret CSC_LINK and the
single-line password as CSC_KEY_PASSWORD. Keep both values private and reuse
this identity for every release so Squirrel.Mac can validate future updates.

This certificate provides update identity continuity. It is not an Apple
Developer ID, does not notarize the app, and does not remove first-launch
Gatekeeper prompts.
EOF
