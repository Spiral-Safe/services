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

rfc3339_from_epoch() {
  local epoch="$1"
  if date -u -r "${epoch}" '+%Y-%m-%dT%H:%M:%SZ' >/dev/null 2>&1; then
    date -u -r "${epoch}" '+%Y-%m-%dT%H:%M:%SZ'
  else
    date -u -d "@${epoch}" '+%Y-%m-%dT%H:%M:%SZ'
  fi
}

source_dir="${work_dir}/source"
mkdir -p "${source_dir}/nitro" "${work_dir}/bin"
printf 'FROM scratch\n' >"${source_dir}/nitro/Dockerfile"
git -C "${source_dir}" init -q
git -C "${source_dir}" config user.name test
git -C "${source_dir}" config user.email test@example.com
git -C "${source_dir}" config commit.gpgsign false
git -C "${source_dir}" add nitro/Dockerfile
git -C "${source_dir}" commit -q -m initial
source_revision="$(git -C "${source_dir}" rev-parse HEAD)"

image_eif="${work_dir}/same-image.eif"
printf 'same signed EIF test fixture\n' >"${image_eif}"
if command -v sha384sum >/dev/null 2>&1; then
  eif_sha384="$(sha384sum "${image_eif}" | awk '{print $1}')"
else
  eif_sha384="$(shasum -a 384 "${image_eif}" | awk '{print $1}')"
fi
issued_at="$(rfc3339_from_epoch "$(date +%s)")"
expires_at="$(rfc3339_from_epoch "$(( $(date +%s) + 600 ))")"
manifest="${work_dir}/node.json"
jq -n \
  --arg eifSha384 "${eif_sha384}" \
  --arg sourceRevision "${source_revision}" \
  --arg issuedAt "${issued_at}" \
  --arg expiresAt "${expires_at}" '
    {
      schemaVersion: 1,
      image: {
        digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        eifSha384: $eifSha384,
        sourceRevision: $sourceRevision,
        veilRevision: "2b8c06ca651e09b21832f6fc4ae2605371386f76"
      },
      node: {
        mode: "join",
        id: "vault-nitro-b",
        raftPath: "/vault/data",
        pluginDirectory: "/vault/plugins",
        veilAddress: "https://vault-b.example:8443",
        apiAddress: "https://vault-b.internal:18200",
        clusterAddress: "https://vault-b.internal:18201",
        loopbackApiBind: "127.0.0.1:8200",
        tunnelApiBind: "10.0.0.2:18200",
        tunnelClusterBind: "10.0.0.2:18201",
        durableStorageBridge: "attested-volume-provider/v1",
        externalL4Route: "private-overlay/v1"
      },
      application: {
        webAuthnRpId: "wallet.example.com",
        webAuthnRpOrigins: ["https://wallet.example.com"]
      },
      tls: {
        certificateFile: "/run/spiral-safe/secrets/node.crt",
        privateKeyFile: "/run/spiral-safe/secrets/node.key",
        clientCAFile: "/run/spiral-safe/secrets/operator-ca.crt",
        joinCAFile: "/run/spiral-safe/secrets/raft-ca.crt",
        joinClientCertFile: "/run/spiral-safe/secrets/raft-client.crt",
        joinClientKeyFile: "/run/spiral-safe/secrets/raft-client.key",
        leaderServerName: "vault.internal"
      },
      leaders: {apiAddresses: ["https://vault-a.internal:18200"]},
      seal: {
        type: "awskms",
        region: "us-east-1",
        keyId: "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000000"
      },
      admission: {
        issuedAt: $issuedAt,
        expiresAt: $expiresAt,
        minimumVoters: 3,
        requireVeilVerification: true,
        requireMTLS: true,
        requireSharedAutoUnseal: true
      }
    }
  ' >"${manifest}"
chmod 0600 "${manifest}"

order_log="${work_dir}/order.log"
export TEST_ORDER_LOG="${order_log}"
export TEST_SOURCE_DIR="${source_dir}"
cat >"${work_dir}/bin/veil-verify" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo veil-verify >>"${TEST_ORDER_LOG}"
if [[ "${FAIL_VEIL_VERIFY:-false}" == "true" ]]; then
  exit 1
fi
: >"${TEST_SOURCE_DIR}/enclave.tar"
EOF
cat >"${work_dir}/bin/admission-hook" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo admission-hook >>"${TEST_ORDER_LOG}"
[[ -n "${SPIRAL_VERIFIED_NODE_ID:-}" ]]
[[ -n "${SPIRAL_VERIFIED_EIF_SHA384:-}" ]]
printf 'secret-ref://test/%s/bundle-1\n' "${SPIRAL_VERIFIED_NODE_ID}"
EOF
cat >"${work_dir}/bin/vault" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "status -format=json")
    printf '%s\n' '{"initialized":true,"sealed":false,"storage_type":"raft","seal_type":"awskms"}'
    ;;
  "operator raft list-peers -format=json")
    printf '%s\n' '{"data":{"config":{"servers":[{"address":"vault-a.internal:18201","node_id":"vault-nitro-a","voter":true},{"address":"vault-b.internal:18201","node_id":"vault-nitro-b","voter":true},{"address":"vault-c.internal:18201","node_id":"vault-nitro-c","voter":true}]}}}'
    ;;
  "operator raft autopilot state -format=json")
    if [[ "${TEST_UNHEALTHY_AUTOPILOT:-false}" == "true" ]]; then
      printf '%s\n' '{"healthy":false,"failure_tolerance":0,"servers":{"vault-nitro-a":{"healthy":true},"vault-nitro-b":{"healthy":false},"vault-nitro-c":{"healthy":true}}}'
    else
      printf '%s\n' '{"healthy":true,"failure_tolerance":1,"servers":{"vault-nitro-a":{"healthy":true},"vault-nitro-b":{"healthy":true},"vault-nitro-c":{"healthy":true}}}'
    fi
    ;;
  *)
    exit 1
    ;;
esac
EOF
chmod 0700 "${work_dir}/bin/veil-verify" "${work_dir}/bin/admission-hook" "${work_dir}/bin/vault"

bundle_reference="$(
  SPIRAL_NODE_CONFIG_BIN="${renderer}" \
    VEIL_VERIFY_BIN="${work_dir}/bin/veil-verify" \
    SPIRAL_ENROLLMENT_HOOK="${work_dir}/bin/admission-hook" \
    "${nitro_dir}/enroll-node.sh" admit "${manifest}" "${image_eif}" "${source_dir}"
)"
[[ "${bundle_reference}" == "secret-ref://test/vault-nitro-b/bundle-1" ]]
[[ "$(sed -n '1p' "${order_log}")" == "veil-verify" ]]
[[ "$(sed -n '2p' "${order_log}")" == "admission-hook" ]]
[[ ! -e "${source_dir}/enclave.tar" ]]

: >"${order_log}"
if SPIRAL_NODE_CONFIG_BIN="${renderer}" \
  VEIL_VERIFY_BIN="${work_dir}/bin/veil-verify" \
  SPIRAL_ENROLLMENT_HOOK="${work_dir}/bin/admission-hook" \
  FAIL_VEIL_VERIFY=true \
  "${nitro_dir}/enroll-node.sh" admit "${manifest}" "${image_eif}" "${source_dir}" >/dev/null 2>&1; then
  echo "admission unexpectedly succeeded after Veil verification failure" >&2
  exit 1
fi
[[ "$(cat "${order_log}")" == "veil-verify" ]]

for tls_file in ca.crt client.crt client.key; do
  : >"${work_dir}/${tls_file}"
done
chmod 0600 "${work_dir}/client.key"
membership_result="$(
  SPIRAL_NODE_CONFIG_BIN="${renderer}" \
    VAULT_BIN="${work_dir}/bin/vault" \
    VAULT_CACERT="${work_dir}/ca.crt" \
    VAULT_CLIENT_CERT="${work_dir}/client.crt" \
    VAULT_CLIENT_KEY="${work_dir}/client.key" \
    VAULT_TLS_SERVER_NAME=vault.internal \
    VAULT_TOKEN=test-token-not-logged \
    SPIRAL_MEMBERSHIP_WAIT_SECONDS=0 \
    "${nitro_dir}/enroll-node.sh" check "${manifest}"
)"
jq -e '.status == "healthy" and .nodeId == "vault-nitro-b" and .minimumVoters == 3 and .voterCount == 3' <<<"${membership_result}" >/dev/null

if SPIRAL_NODE_CONFIG_BIN="${renderer}" \
  VAULT_BIN="${work_dir}/bin/vault" \
  VAULT_CACERT="${work_dir}/ca.crt" \
  VAULT_CLIENT_CERT="${work_dir}/client.crt" \
  VAULT_CLIENT_KEY="${work_dir}/client.key" \
  VAULT_TLS_SERVER_NAME=vault.internal \
  VAULT_TOKEN=test-token-not-logged \
  TEST_UNHEALTHY_AUTOPILOT=true \
  SPIRAL_MEMBERSHIP_WAIT_SECONDS=0 \
  "${nitro_dir}/enroll-node.sh" check "${manifest}" >/dev/null 2>&1; then
  echo "membership check unexpectedly accepted unhealthy Autopilot state" >&2
  exit 1
fi

echo "PASS: admission fails closed, emits only a bundle reference after verification, and rejects unhealthy Raft/Autopilot state."
