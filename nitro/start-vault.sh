#!/bin/sh
set -u

export VAULT_ADDR=http://127.0.0.1:8200

su-exec vault vault server -config=/vault/config/vault.hcl &
vault_pid="$!"

while kill -0 "${vault_pid}" 2>/dev/null; do
  vault status >/dev/null 2>&1
  status="$?"
  if [ "${status}" -eq 0 ] || [ "${status}" -eq 2 ]; then
    break
  fi
  sleep 1
done

if ! kill -0 "${vault_pid}" 2>/dev/null; then
  wait "${vault_pid}"
  exit "$?"
fi

wget -q -O /dev/null http://127.0.0.1:8080/veil/ready
wait "${vault_pid}"
