# Kubernetes and Skaffold deployment

The default local workflow builds the Vault plugin image, API service, and
browser demo as three Skaffold artifacts. The `production` profile deliberately
excludes the demo and builds only Vault and the API; it renders a three-node
Vault integrated-storage topology and requires operator-supplied identity, TLS,
unseal, registry, PostgreSQL, billing-provider, and secret inputs.

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
those addresses are known. The API's checked-in egress is restricted to DNS,
Vault, a same-namespace pod labeled
`spiral-safe.io/billing-database=allowed` on PostgreSQL port 5432, and a
different same-namespace pod labeled `spiral-safe.io/billing-gateway=allowed`
on HTTPS port 443. Those selectors do not authorize a Service, another
namespace, a managed database, Stripe, or Metronome. Supply a target-specific
database/provider route or reviewed egress gateway; do not open generic
Internet egress.

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
5. Production values for `BILLING_PLANS_JSON`, `CONSOLE_ORIGIN`, Stripe
   Checkout success/cancel and Portal return URLs, the reviewed Metronome
   ingest settings, and a deliberate
   `METRONOME_STRIPE_INVOICING_VERIFIED=true` only after an end-to-end sandbox
   invoice proves the environment mapping. Every production plan needs a
   distinct Stripe Product/base Price and distinct Metronome Product/rate-card
   IDs.
6. A `spiral-service-billing` Secret delivered through the platform's external
   secret mechanism, with `DATABASE_URL`, independent random
   `API_KEY_PEPPER` and `CONSOLE_SESSION_SECRET`, a least-privilege restricted
   `STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET`, and `METRONOME_API_TOKEN`.
   Production billing rejects `spiral-service-auth`, `API_TOKEN_HASHES`,
   `API_TOKENS`, and `API_TOKEN`; developer-issued PostgreSQL-backed keys are
   used instead. No `VAULT_TOKEN` key is used by the service.
7. A PostgreSQL migration/backup/restore plan and target-specific egress. The
   checked-in migration init container is idempotent but currently uses the
   same `DATABASE_URL` as the runtime; split schema-owner and service roles
   before production.
8. Replace every `REPLACE_ME.invalid` in the production Kustomization with the
   exact WebAuthn relying-party ID and allowed browser-extension origins. The
   checked-in browser demo is local-only and is removed from the production
   overlay. Add API ingress or Gateway resources with end-to-end TLS for your
   provider; none are guessed here.
9. Label only the ingress-controller namespace with
   `spiral-safe.io/ingress-access=allowed` and only its selected pods with
   `spiral-safe.io/ingress=true`. An operator pod that must reach Vault directly
   needs `spiral-safe.io/vault-operator=true` in the `spiral-safe` namespace.
10. Review the cluster-scoped `system:auth-delegator` binding used by Vault's
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

Create the billing Secret and non-secret plan/URL configuration through the
platform's secret/GitOps mechanism, leave demo seeding disabled, and then
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

The service pod also remains unavailable until PostgreSQL is reachable and the
billing migration succeeds. The init container runs
`node dist/billing/migrate.js` as UID 10001 with a read-only root filesystem.
It takes an advisory transaction lock and fails closed without `DATABASE_URL`.
After the schema exists, create or rotate the first account-independent
administrator from a protected operator shell or one-shot job:

```sh
DATABASE_URL='postgresql://...' DATABASE_SSL=true \
  npm run billing:bootstrap-admin -- \
  --email admin@example.com \
  --password-file /run/secrets/spiral_admin_password
```

The CLI rejects `--password`, symlinks, non-regular files, and files larger
than 4 KiB. It cannot promote a developer. Unmount the password file after
use; the product still has no forced password change/reset, SSO, or MFA.

For every account, allow the verified Stripe webhook to record the customer,
subscription, plan, and current period; then provision the exact Metronome
customer/contract/rate-card to that Stripe customer, prove a sandbox invoice,
and record the mapping attestation from the admin console. The attestation is
an operator assertion bound to the current Stripe customer, local plan, and
Metronome rate card. A missing/stale mapping or missing/expired provider period
returns 402 before Vault. No live provider charge is proven by these manifests.

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

## Nitro/Veil admission is a separate topology

The same-image bootstrap/join scaffold in `../nitro/` applies the same quorum
principles to an EIF: exact source and attestation verification, unique Raft
node IDs, an odd minimum voter count, mTLS `retry_join`, a shared auto-unseal
key identity, and post-join `raft list-peers` plus Autopilot checks. Its Veil
listener is attestation-only. Vault API and cluster traffic use separate ports
on Veil's full IP tunnel so the API can require an independent client
certificate.

That scaffold cannot be deployed by this Kustomization and is not an alternate
Kubernetes overlay. Veil gives each EC2 parent/enclave pair the same
`10.0.0.1/10.0.0.2` subnet and does not supply cross-host L4 routing. Nitro also
does not provide durable local storage or a supported run-time file injection
mechanism. A production enclave voter therefore remains blocked on all three of
these external, reviewed components:

1. an attestation-bound manifest, TLS, and KMS-identity delivery agent;
2. a private per-node L4 overlay/forwarder for Vault API and Raft cluster
   addresses; and
3. a rollback-protected durable storage bridge with Raft-compatible fsync,
   fencing, snapshot, restore, and crash semantics.

Do not copy Kubernetes Secrets or PVC assumptions into an EIF, and do not add
an enclave as a voter merely because its container image builds. Follow
`../nitro/README` for the fail-closed admission sequence, configuration-only
simulation, membership proof, and peer-removal/rollback boundaries.

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
