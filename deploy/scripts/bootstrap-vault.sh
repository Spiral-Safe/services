#!/usr/bin/env bash
set -euo pipefail

namespace="${KUBE_NAMESPACE:-spiral-safe}"
pod="${VAULT_POD:-vault-0}"
plugin_path="${VAULT_PLUGIN_PATH:-/vault/plugins/spiral-safe}"

for command_name in awk grep kubectl vault; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Required command is missing: ${command_name}" >&2
    exit 1
  fi
done

if [[ -z "${VAULT_ADDR:-}" || -z "${VAULT_TOKEN:-}" ]]; then
  echo "Set VAULT_ADDR and a short-lived operator VAULT_TOKEN before running this script." >&2
  exit 1
fi

if ! vault status >/dev/null; then
  echo "Vault must be initialized and unsealed before bootstrap." >&2
  exit 1
fi

checksum="$({
  kubectl exec -n "${namespace}" "${pod}" -- sha256sum "${plugin_path}"
} | awk '{print $1}')"

if [[ ! "${checksum}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Could not determine the plugin SHA-256 checksum from ${pod}." >&2
  exit 1
fi

vault plugin register \
  -command=spiral-safe \
  -sha256="${checksum}" \
  secret spiral-safe

if ! vault secrets list -format=json | grep -q '"spiral-safe/"'; then
  vault secrets enable -path=spiral-safe spiral-safe
fi

if ! vault audit list -format=json | grep -q '"file/"'; then
  vault audit enable file file_path=/vault/audit/audit.log
fi

if ! vault auth list -format=json | grep -q '"kubernetes/"'; then
  vault auth enable kubernetes
fi

vault write auth/kubernetes/config \
  kubernetes_host=https://kubernetes.default.svc:443

vault policy write spiral-service - <<'HCL'
path "spiral-safe/*" {
  capabilities = ["create", "read", "update"]
}
HCL

vault write auth/kubernetes/role/spiral-service \
  bound_service_account_names=spiral-service \
  bound_service_account_namespaces="${namespace}" \
  policies=spiral-service \
  token_ttl=15m \
  token_max_ttl=1h

echo "Vault plugin, audit device, policy, and Kubernetes auth role are configured."
echo "Unset VAULT_TOKEN in this shell now."
