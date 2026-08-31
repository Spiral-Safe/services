#!/bin/sh
set -eu

manifest_path="${SPIRAL_NODE_MANIFEST_PATH:-/run/spiral-safe/node-manifest.json}"
wait_seconds="${SPIRAL_MANIFEST_WAIT_SECONDS:-0}"
case "${wait_seconds}" in
  ''|*[!0-9]*)
    echo "SPIRAL_MANIFEST_WAIT_SECONDS must be a non-negative integer." >&2
    exit 1
    ;;
esac

elapsed=0
while [ ! -f "${manifest_path}" ]; do
  if [ "${wait_seconds}" -ne 0 ] && [ "${elapsed}" -ge "${wait_seconds}" ]; then
    echo "Timed out waiting for the post-attestation node manifest." >&2
    exit 1
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

if [ -L "${manifest_path}" ]; then
  echo "The node manifest must not be a symbolic link." >&2
  exit 1
fi

runtime_dir=/tmp/spiral-safe
vault_config="${runtime_dir}/vault.hcl"
plugin_environment="${runtime_dir}/plugin.env"
mkdir -p "${runtime_dir}"
chmod 0700 "${runtime_dir}"

/usr/local/bin/spiral-node-config \
  -input "${manifest_path}" \
  -output "${vault_config}" \
  -env-output "${plugin_environment}" \
  -check-files=true
chown vault:vault "${vault_config}"
chmod 0600 "${vault_config}"
chmod 0600 "${plugin_environment}"

# This file is emitted by spiral-node-config from strictly validated fields;
# the untrusted manifest itself is never sourced as shell code.
set -a
# shellcheck disable=SC1090 # spiral-node-config generated this validated file.
. "${plugin_environment}"
set +a

export VAULT_ADDR=http://127.0.0.1:8200
exec su-exec vault vault server -config="${vault_config}"
