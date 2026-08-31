#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 3 ]]; then
  echo "Usage: $0 IMAGE_EIF VEIL_PROXY NODE_MANIFEST" >&2
  exit 1
fi

image_eif="$1"
veil_proxy="$2"
node_manifest="$3"
tools_dir="$(cd -- "$(dirname -- "${veil_proxy}")" && pwd -P)"
node_config="${tools_dir}/spiral-node-config"

if [[ ! -f "${image_eif}" || -L "${image_eif}" || ! -x "${veil_proxy}" || ! -x "${node_config}" ]]; then
  echo "The EIF, veil-proxy, or spiral-node-config binary is missing. Run 'make eif tools' first." >&2
  exit 1
fi
if [[ ! -f "${node_manifest}" || -L "${node_manifest}" ]]; then
  echo "The node manifest must be a regular non-symlink file." >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required to launch a manifest-named enclave." >&2
  exit 1
fi

"${node_config}" \
  -input "${node_manifest}" \
  -validate-only \
  -check-files=false

node_id="$(jq -er '.node.id' "${node_manifest}")"
expected_eif_sha384="$(jq -er '.image.eifSha384' "${node_manifest}")"
if command -v sha384sum >/dev/null 2>&1; then
  actual_eif_sha384="$(sha384sum "${image_eif}" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual_eif_sha384="$(shasum -a 384 "${image_eif}" | awk '{print $1}')"
else
  echo "sha384sum or shasum is required." >&2
  exit 1
fi
if [[ "${actual_eif_sha384}" != "${expected_eif_sha384}" ]]; then
  echo "The EIF SHA-384 does not match the node manifest." >&2
  exit 1
fi

enclave_name="spiral-safe-${node_id//./-}"
veil_address="$(jq -er '.node.veilAddress' "${node_manifest}")"
api_address="$(jq -er '.node.apiAddress' "${node_manifest}")"
cluster_address="$(jq -er '.node.clusterAddress' "${node_manifest}")"

sudo "${veil_proxy}" -dns-forwarder &
proxy_pid="$!"

cleanup() {
  sudo kill -INT "${proxy_pid}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

nitro-cli run-enclave \
  --enclave-name "${enclave_name}" \
  --eif-path "${image_eif}" \
  --cpu-count 2 \
  --memory 4096

echo "Veil attestation address: ${veil_address} (parent-local tunnel endpoint is https://10.0.0.2:8443)."
echo "Vault mTLS API address: ${api_address} (enclave tunnel bind is 10.0.0.2:18200)."
echo "Vault Raft cluster address: ${cluster_address} (enclave tunnel bind is 10.0.0.2:18201)."
echo "Cross-host L4 routes and the post-attestation manifest/identity delivery hook are external requirements."
echo "The enclave remains running after this script exits; manage it explicitly by name."
wait "${proxy_pid}"
