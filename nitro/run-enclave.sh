#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "Usage: $0 IMAGE_EIF VEIL_PROXY" >&2
  exit 1
fi

image_eif="$1"
veil_proxy="$2"

if [[ ! -f "${image_eif}" || ! -x "${veil_proxy}" ]]; then
  echo "The EIF or veil-proxy binary is missing. Run 'make eif tools' first." >&2
  exit 1
fi

sudo "${veil_proxy}" -dns-forwarder &
proxy_pid="$!"

cleanup() {
  sudo kill -INT "${proxy_pid}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

nitro-cli run-enclave \
  --enclave-name spiral-safe-veil \
  --eif-path "${image_eif}" \
  --cpu-count 2 \
  --memory 4096

echo "Veil is reachable from the parent at https://10.0.0.2:8443 while this proxy runs."
echo "The enclave remains running after this script exits; manage it explicitly by name."
wait "${proxy_pid}"
