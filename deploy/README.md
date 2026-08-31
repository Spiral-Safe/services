# Kubernetes and Skaffold deployment

The default local workflow builds the Vault plugin image, API service, and
browser demo as three Skaffold artifacts. The `production` profile deliberately
excludes the demo and builds only Vault and the API; it renders a three-node
Vault integrated-storage topology and requires operator-supplied identity, TLS,
unseal, registry, and API credentials.

## Local development

Requirements: Docker, Skaffold v2, `kubectl`, Kustomize, and a current local
Kubernetes cluster such as kind, minikube, or Docker Desktop.

From the `services` directory:

```sh
skaffold dev
```

Skaffold builds all three images, applies `deploy/overlays/local`, tails logs,
and forwards these ports:

| Component | Local address |
| --- | --- |
| Browser demo | `http://localhost:9080/?api=http://localhost:3000` |
| API | `http://localhost:3000` |
| Vault dev API | `http://localhost:8200` |

The checked-in local credentials are deliberately non-secret: bearer token
`spiral-safe-local-development-only` and Vault dev token `root`. They exist
only in the local overlay. Local Vault is in-memory, single-node, HTTP-only,
and must never be exposed or used as a production baseline.

Render without changing a cluster:

```sh
skaffold render --offline=true --digest-source=none
kustomize build deploy/overlays/local
kustomize build deploy/overlays/production
```

## Production-intent topology

The production overlay chooses Vault integrated Raft storage because HashiCorp
recommends it for most Kubernetes deployments. Each of three Vault pods has its
own retained data and audit PVC, end-to-end TLS, AWS KMS auto-unseal inputs,
anti-affinity, a disruption budget, a headless peer service, and an active-node
service. The application uses its Kubernetes service-account JWT to obtain a
short-lived Vault token; it never receives a root token.

The manifests also provide restricted pod security settings and ingress
NetworkPolicies. Vault egress remains provider-controlled because Kubernetes API
and KMS endpoints differ by cluster. Restrict it to exact private endpoints once
those addresses are known. The API's egress is restricted to DNS and Vault.

This is a source-controlled operating baseline, not a zero-input production
installer. Before applying it, provide all of the following:

1. A registry and immutable image policy. Use a registry path you control with
   `--default-repo`; production builds are pushed.
2. A default or explicitly patched `StorageClass` with the intended encryption,
   zone topology, snapshot, retention, and IOPS settings.
3. A `vault-tls` Secret containing `tls.crt`, `tls.key`, and `ca.crt`. The
   certificate SANs must cover `vault-active`, `vault-internal`, and the
   StatefulSet peer names (normally `*.vault-internal.spiral-safe.svc`). The
   `leader_tls_servername` in `vault-config.yaml` must match a SAN.
4. A `vault-unseal` ConfigMap containing `AWS_REGION` and
   `VAULT_AWSKMS_SEAL_KEY_ID`. Bind the `vault` ServiceAccount to a narrowly
   scoped cloud workload identity that can use only that key. Do not create
   long-lived AWS credential Secrets.
5. A `spiral-service-auth` Secret whose `API_TOKEN_HASHES` key is a JSON map
   from SHA-256 bearer-token digests to principals. Every principal must have a
   tenant and a non-empty, explicit username allowlist, for example
   `{"0000000000000000000000000000000000000000000000000000000000000000":{"tenant":"tenant-a","users":["alice"]}}`.
   Replace the all-zero digest with the real token's SHA-256 digest. The
   cleartext token is never stored in Kubernetes. No `VAULT_TOKEN` key is used
   in production.
6. Replace every `REPLACE_ME.invalid` in the production Kustomization with the
   exact WebAuthn relying-party ID and allowed browser-extension origins. The
   checked-in browser demo is local-only and is removed from the production
   overlay. Add API ingress or Gateway resources with end-to-end TLS for your
   provider; none are guessed here.
7. Label only the ingress-controller namespace with
   `spiral-safe.io/ingress-access=allowed` and only its selected pods with
   `spiral-safe.io/ingress=true`. An operator pod that must reach Vault directly
   needs `spiral-safe.io/vault-operator=true` in the `spiral-safe` namespace.
8. Review the cluster-scoped `system:auth-delegator` binding used by Vault's
   Kubernetes auth method.

Example creation shapes (substitute values through your secret manager or
GitOps secret controller; do not put real values in shell history or Git):

```sh
kubectl -n spiral-safe create secret generic vault-tls \
  --from-file=tls.crt=/secure/path/tls.crt \
  --from-file=tls.key=/secure/path/tls.key \
  --from-file=ca.crt=/secure/path/ca.crt

kubectl -n spiral-safe create configmap vault-unseal \
  --from-literal=AWS_REGION=REPLACE_ME \
  --from-literal=VAULT_AWSKMS_SEAL_KEY_ID=REPLACE_ME
```

Create `spiral-service-auth` with the platform's external-secret mechanism, then
deploy:

```sh
skaffold run -p production --default-repo REGISTRY/PROJECT
```

The Vault pods will start but remain unready until the cluster is initialized.
Initialize exactly once through an authenticated operator path and immediately
store the recovery keys and initial root token in an approved offline workflow.
Never print them into CI or pod logs. After unseal, port-forward the active
service over your operator channel, export a short-lived operator token, and run:

```sh
VAULT_ADDR=https://127.0.0.1:8200 \
VAULT_CACERT=/secure/path/ca.crt \
VAULT_TLS_SERVER_NAME=vault-active \
VAULT_TOKEN=REDACTED \
./deploy/scripts/bootstrap-vault.sh
```

The script computes the plugin checksum inside `vault-0`, registers and enables
the plugin, enables the file audit device, creates a least-privilege policy, and
configures the `spiral-service` Kubernetes auth role. It does not initialize,
unseal, mint, save, or echo a root token.

## Safe node joining and scaling

Raft replicates encrypted Vault data to every voter. New replicas are not
anonymous community nodes. A joining pod must be scheduled by the controlled
StatefulSet, possess the trusted Vault TLS identity, use the authorized KMS
workload identity, pass NetworkPolicy and RBAC controls, and reach an existing
leader through the pinned `retry_join` endpoints. Scale through a reviewed
manifest change, preserve an odd voter count, and verify:

```sh
vault operator raft list-peers
```

Do not share the TLS key, KMS permission, Kubernetes credentials, or recovery
material with arbitrary operators. If independent parties should contribute
nodes, design a separate admission, certificate issuance, attestation,
governance, and removal protocol first.

Use scheduled Raft snapshots, encrypted off-cluster storage, tested restores,
PVC snapshots, and documented quorum-loss recovery. None of those can be safely
hard-coded without the target cloud and backup system. Consul is a valid
alternative storage backend, but adds a second distributed system and is not
included here.

The file audit device writes to a retained PVC on whichever Vault pod handles a
request. Ship those files to an immutable central sink, alert on delivery and
free-space failures, and test failover so records from every potential leader
are collected. A persistent local audit file alone is not a complete audit
program.

## Known release blockers

* Vault 1.21.4, the Go 1.26 builders, and the application Node base images are
  digest-pinned. Keep every input pinned and run normal image vulnerability and
  provenance checks rather than treating those pins as permanent.
* The full WebAuthn/signing, rolling-upgrade, snapshot/restore, and KMS recovery
  suites still need to run on the target production cluster before release.
* TLS, KMS policy, storage class, backup target, public routing, DNS, API token
  issuance, and monitoring destinations are deployment-specific external inputs.
* The bootstrap has not been exercised against a real cloud KMS and production
  Kubernetes cluster.
* The Nitro/Veil path in `../nitro/` is a separate topology; Kubernetes does not
  transparently turn these pods into Nitro Enclaves.

Primary references:

* [Vault on Kubernetes deployment guide](https://developer.hashicorp.com/vault/tutorials/kubernetes/kubernetes-raft-deployment-guide)
* [Vault HA with Raft and TLS](https://developer.hashicorp.com/vault/docs/deploy/kubernetes/helm/examples/ha-tls)
* [Vault integrated storage](https://developer.hashicorp.com/vault/docs/configuration/storage/raft)
* [Kubernetes NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
* [Kubernetes PodDisruptionBudget](https://kubernetes.io/docs/tasks/run-application/configure-pdb/)
* [Skaffold configuration reference](https://skaffold.dev/docs/references/yaml/)
