#!/bin/sh

nitriding -fqdn spiralsafe.com -appwebsrv http://127.0.0.1:8203 -ext-pub-port 443 -intport 8080 &
echo "[sh] Started nitriding."

sleep 1

export VAULT_ADDR="http://127.0.0.1:8200"
sh -c "vault server -config=/vault/vault.hcl & sleep 5 ; vault operator init & wait"
echo "[sh] Ran spiralsafe script."
