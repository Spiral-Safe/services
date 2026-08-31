#!/bin/sh
set -eu

if [ -z "${VEIL_FQDN:-}" ]; then
  echo "VEIL_FQDN must be fixed at image build time." >&2
  exit 1
fi

exec veil-daemon \
  -fqdn "${VEIL_FQDN}" \
  -enclave-code-uri "${VEIL_SOURCE_URI:-https://github.com/Spiral-Safe/services}" \
  -ext-port 8443 \
  -int-port 8080 \
  -dns-resolver 10.0.0.1 \
  -app-cmd /usr/local/bin/start-vault
