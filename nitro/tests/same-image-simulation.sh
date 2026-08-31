#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
nitro_dir="$(cd -- "${script_dir}/.." && pwd -P)"
work_dir="$(mktemp -d)"

cleanup() {
  rm -rf -- "${work_dir}"
}
trap cleanup EXIT

renderer="${SPIRAL_NODE_CONFIG_BIN:-}"
if [[ -z "${renderer}" && -x "${nitro_dir}/.tools/spiral-node-config" ]]; then
  renderer="${nitro_dir}/.tools/spiral-node-config"
fi
if [[ -z "${renderer}" ]]; then
  if ! command -v go >/dev/null 2>&1; then
    echo "Set SPIRAL_NODE_CONFIG_BIN or install the pinned Go toolchain." >&2
    exit 1
  fi
  renderer="${work_dir}/spiral-node-config"
  go -C "${nitro_dir}/config-renderer" build -trimpath -o "${renderer}" .
fi
[[ -x "${renderer}" ]] || {
  echo "spiral-node-config is not executable: ${renderer}" >&2
  exit 1
}

rfc3339_from_epoch() {
  local epoch="$1"
  if date -u -r "${epoch}" '+%Y-%m-%dT%H:%M:%SZ' >/dev/null 2>&1; then
    date -u -r "${epoch}" '+%Y-%m-%dT%H:%M:%SZ'
  else
    date -u -d "@${epoch}" '+%Y-%m-%dT%H:%M:%SZ'
  fi
}

issued_at="$(rfc3339_from_epoch "$(date +%s)")"
expires_at="$(rfc3339_from_epoch "$(( $(date +%s) + 600 ))")"
image_digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
eif_sha384="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
source_revision="cccccccccccccccccccccccccccccccccccccccc"
veil_revision="2b8c06ca651e09b21832f6fc4ae2605371386f76"
kms_key_id="arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000000"

mkdir -p \
  "${work_dir}/node-a/raft" \
  "${work_dir}/node-b/raft" \
  "${work_dir}/plugins" \
  "${work_dir}/tls"
chmod 0700 "${work_dir}/node-a/raft" "${work_dir}/node-b/raft" "${work_dir}/plugins" "${work_dir}/tls"
for tls_file in node.crt node.key operator-ca.crt join-ca.crt join-client.crt join-client.key; do
  : >"${work_dir}/tls/${tls_file}"
done
chmod 0644 "${work_dir}/tls/"*.crt
chmod 0600 "${work_dir}/tls/node.key" "${work_dir}/tls/join-client.key"

make_manifest() {
  local output_file="$1"
  local mode="$2"
  local node_id="$3"
  local raft_path="$4"
  local api_address="$5"
  local cluster_address="$6"
  local leaders_json="$7"
  local join_ca=""
  local join_cert=""
  local join_key=""
  local leader_name=""
  if [[ "${mode}" == "join" ]]; then
    join_ca="${work_dir}/tls/join-ca.crt"
    join_cert="${work_dir}/tls/join-client.crt"
    join_key="${work_dir}/tls/join-client.key"
    leader_name="vault.internal"
  fi

  jq -n \
    --argjson schemaVersion 1 \
    --arg digest "${image_digest}" \
    --arg eifSha384 "${eif_sha384}" \
    --arg sourceRevision "${source_revision}" \
    --arg veilRevision "${veil_revision}" \
    --arg mode "${mode}" \
    --arg id "${node_id}" \
    --arg raftPath "${raft_path}" \
    --arg pluginDirectory "${work_dir}/plugins" \
    --arg veilAddress "https://${node_id}.example:8443" \
    --arg apiAddress "${api_address}" \
    --arg clusterAddress "${cluster_address}" \
    --arg certificateFile "${work_dir}/tls/node.crt" \
    --arg privateKeyFile "${work_dir}/tls/node.key" \
    --arg clientCAFile "${work_dir}/tls/operator-ca.crt" \
    --arg joinCAFile "${join_ca}" \
    --arg joinClientCertFile "${join_cert}" \
    --arg joinClientKeyFile "${join_key}" \
    --arg leaderServerName "${leader_name}" \
    --argjson leaders "${leaders_json}" \
    --arg region "us-east-1" \
    --arg keyId "${kms_key_id}" \
    --arg issuedAt "${issued_at}" \
    --arg expiresAt "${expires_at}" '
      {
        schemaVersion: $schemaVersion,
        image: {
          digest: $digest,
          eifSha384: $eifSha384,
          sourceRevision: $sourceRevision,
          veilRevision: $veilRevision
        },
        node: {
          mode: $mode,
          id: $id,
          raftPath: $raftPath,
          pluginDirectory: $pluginDirectory,
          veilAddress: $veilAddress,
          apiAddress: $apiAddress,
          clusterAddress: $clusterAddress,
          loopbackApiBind: "127.0.0.1:8200",
          tunnelApiBind: "10.0.0.2:18200",
          tunnelClusterBind: "10.0.0.2:18201",
          durableStorageBridge: "simulation-only-host-directory",
          externalL4Route: "simulation-only-private-route"
        },
        application: {
          webAuthnRpId: "wallet.example.com",
          webAuthnRpOrigins: ["https://wallet.example.com"]
        },
        tls: {
          certificateFile: $certificateFile,
          privateKeyFile: $privateKeyFile,
          clientCAFile: $clientCAFile,
          joinCAFile: $joinCAFile,
          joinClientCertFile: $joinClientCertFile,
          joinClientKeyFile: $joinClientKeyFile,
          leaderServerName: $leaderServerName
        },
        leaders: {apiAddresses: $leaders},
        seal: {type: "awskms", region: $region, keyId: $keyId},
        admission: {
          issuedAt: $issuedAt,
          expiresAt: $expiresAt,
          minimumVoters: 3,
          requireVeilVerification: true,
          requireMTLS: true,
          requireSharedAutoUnseal: true
        }
      }
    ' >"${output_file}"
  chmod 0600 "${output_file}"
}

bootstrap_manifest="${work_dir}/bootstrap.json"
join_manifest="${work_dir}/join.json"
make_manifest \
  "${bootstrap_manifest}" \
  bootstrap \
  vault-nitro-a \
  "${work_dir}/node-a/raft" \
  https://vault-a.internal:18200 \
  https://vault-a.internal:18201 \
  '[]'
make_manifest \
  "${join_manifest}" \
  join \
  vault-nitro-b \
  "${work_dir}/node-b/raft" \
  https://vault-b.internal:18200 \
  https://vault-b.internal:18201 \
  '["https://vault-a.internal:18200"]'

"${renderer}" \
  -input "${bootstrap_manifest}" \
  -output "${work_dir}/bootstrap.hcl" \
  -env-output "${work_dir}/bootstrap.env" \
  -check-files=true
"${renderer}" \
  -input "${join_manifest}" \
  -output "${work_dir}/join.hcl" \
  -env-output "${work_dir}/join.env" \
  -check-files=true

grep -Fq 'node_id = "vault-nitro-a"' "${work_dir}/bootstrap.hcl"
grep -Fq 'node_id = "vault-nitro-b"' "${work_dir}/join.hcl"
if grep -Fq 'retry_join {' "${work_dir}/bootstrap.hcl"; then
  echo "bootstrap config unexpectedly contains retry_join" >&2
  exit 1
fi
[[ "$(grep -Fc 'retry_join {' "${work_dir}/join.hcl")" -eq 1 ]]
grep -Fq 'leader_api_addr = "https://vault-a.internal:18200"' "${work_dir}/join.hcl"
grep -Fq 'leader_tls_servername = "vault.internal"' "${work_dir}/join.hcl"
grep -Fq 'leader_client_cert_file = ' "${work_dir}/join.hcl"
grep -Fq 'leader_client_key_file = ' "${work_dir}/join.hcl"
grep -Fq 'tls_require_and_verify_client_cert = true' "${work_dir}/bootstrap.hcl"
grep -Fq 'tls_require_and_verify_client_cert = true' "${work_dir}/join.hcl"
grep -Fq 'address = "10.0.0.2:18200"' "${work_dir}/join.hcl"
grep -Fq 'cluster_address = "10.0.0.2:18201"' "${work_dir}/join.hcl"
grep -Fq "path = \"${work_dir}/node-a/raft\"" "${work_dir}/bootstrap.hcl"
grep -Fq "path = \"${work_dir}/node-b/raft\"" "${work_dir}/join.hcl"
[[ "$(jq -r '.image.digest' "${bootstrap_manifest}")" == "$(jq -r '.image.digest' "${join_manifest}")" ]]
[[ "$(jq -r '.image.eifSha384' "${bootstrap_manifest}")" == "$(jq -r '.image.eifSha384' "${join_manifest}")" ]]
[[ "$(jq -r '.seal.keyId' "${bootstrap_manifest}")" == "$(jq -r '.seal.keyId' "${join_manifest}")" ]]
[[ "$(jq -r '.node.id' "${bootstrap_manifest}")" != "$(jq -r '.node.id' "${join_manifest}")" ]]
[[ "$(jq -r '.node.veilAddress' "${bootstrap_manifest}")" != "$(jq -r '.node.veilAddress' "${join_manifest}")" ]]
grep -Fq 'org.spiral-safe.veil.certificate-name="spiral-safe-attestation.invalid"' "${nitro_dir}/Dockerfile"
grep -Fq 'ENV VEIL_FQDN="spiral-safe-attestation.invalid"' "${nitro_dir}/Dockerfile"
if grep -Eq '^ARG[[:space:]]+VEIL_FQDN' "${nitro_dir}/Dockerfile"; then
  echo "VEIL_FQDN must remain a shared measured image value, not a node build argument" >&2
  exit 1
fi

echo "PASS: same-image topology/config proof with a shared Veil sentinel, distinct routed addresses/node IDs, retry_join mTLS, and temp durable directories."
echo "LIMIT: this is not Nitro persistence, cross-host routing, KMS, attestation, or live quorum proof."
