#!/usr/bin/env bash
set -euo pipefail

known_hosts_file="${1:?known_hosts file is required}"
configured_host="${2:?configured host is required}"
expected_fingerprint="${3:?expected SHA256 fingerprint is required}"

if [[ ! -f "$known_hosts_file" ]]; then
  echo "known_hosts file is missing" >&2
  exit 1
fi
if [[ ! "$expected_fingerprint" =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]]; then
  echo "expected host fingerprint must use the OpenSSH SHA256 format" >&2
  exit 1
fi

matched_keys="$(mktemp)"
trap 'rm -f "$matched_keys"' EXIT

ssh-keygen -F "$configured_host" -f "$known_hosts_file" \
  | awk '!/^#/ && NF' > "$matched_keys"
if [[ ! -s "$matched_keys" ]]; then
  echo "known_hosts has no key for the configured production host" >&2
  exit 1
fi

if ! ssh-keygen -lf "$matched_keys" -E sha256 \
  | awk '{print $2}' \
  | grep -Fxq -- "$expected_fingerprint"; then
  echo "fingerprint does not match the configured host" >&2
  exit 1
fi

echo "[deploy] configured SSH host identity verified"
