# Spiral Safe services

> Development prototype. It has not been audited. The Compose profile uses
> Vault dev mode, a known root token, and a known API token and must never be
> exposed to another machine or reused as a production configuration.

This repository contains:

- a Vault secrets-engine plugin that stores wallets behind Vault's encrypted
  storage barrier and requires WebAuthn before releasing a signature;
- an authenticated HTTP adapter for extension and web clients;
- a browser demo for Solana transactions and Ethereum EIP-191 messages;
- Kubernetes/Skaffold and enclave experiments documented in their own folders.

The chain signer is deliberately separated from the WebAuthn ceremony. Solana
supports transaction and message signing. Ethereum demonstrates expansion with
a secp256k1 address and EIP-191 message signing; Ethereum transaction signing is
not implemented yet. Ethereum signatures are standard-base64 `R || S || V`,
where `V` is `0` or `1`.

## Local stack

Docker Compose starts Vault and the plugin on port 8200, the HTTP adapter on
3000, and the browser demo on 9080:

```sh
docker compose build
docker compose up -d
```

Open <http://localhost:9080>. The demo is prefilled with the local-only bearer
token `spiral-safe-local-development-only`. The same token is intentionally
visible in `docker-compose.yaml`; it provides no security outside loopback
development. The demo has no third-party runtime scripts, applies a restrictive
Content Security Policy, renders errors as text, and will send the token only
to a same-host loopback API origin. It is excluded from the production
Kubernetes overlay.

To avoid occupied host ports:

```sh
VAULT_PORT=18200 SERVICE_PORT=13000 CLIENT_PORT=9080 docker compose up -d
```

For an alternate adapter port, open
<http://localhost:9080/?api=http://localhost:13000>. If the demo origin itself
changes, update both `CORS_ALLOWED_ORIGINS` and `WEBAUTHN_RP_ORIGINS` before
rebuilding. Stop the stack with `docker compose down`; Vault dev data is
in-memory and is lost.

## API and ceremony binding

Every wallet route requires `Authorization: Bearer <token>`. In production, a
token maps to a tenant and an explicit username allowlist on the server; a
caller-supplied `tenant` field is ignored and a username outside the allowlist
returns `403` before Vault. Wallets are therefore scoped as
`tenant / authorized username / chain` rather than by the Vault client token.

Registration is a two-step ceremony:

1. `POST /init` with `{username, chain}` returns the wallet address, WebAuthn
   creation options, and an opaque `ceremonyId`.
2. `POST /create` with `{username, chain, ceremonyId, credential}` consumes that
   ID and completes registration.

Signing is also two-step:

1. `POST /signin` with
   `{username, chain, operation, payload}` returns assertion options and a new
   `ceremonyId`. `payload` is standard base64; `rawTx` remains a Solana legacy
   alias.
2. `POST /complete` with
   `{username, chain, operation, ceremonyId, credential}` consumes the ID and
   returns `encodedTX` for a transaction or `signature` for a message. The
   operation defaults to `transaction` for backward compatibility, but message
   callers must send `message`. The adapter returns output only when Vault's
   stored ceremony operation matches the requested operation.

Ceremonies expire after two minutes, are single-use, and are limited to eight
outstanding ceremonies per wallet. This binds concurrent extension tabs to
their own challenge and signing payload. Errors use
`{error: {code, message}, requestId}`. `GET /healthz` and `GET /readyz` are
unauthenticated probe endpoints.

## HTTP and Vault authentication

The adapter fails at startup unless it has an API credential source, a CORS
allowlist, and a Vault authentication method. The source is either the static
principal map described below or PostgreSQL-backed account API keys when
billing is enabled. Outside explicit `SERVICE_DEV_MODE=true`, the adapter also
rejects short static API tokens, HTTP web origins, and every static
`VAULT_TOKEN`; production uses a named Kubernetes role to obtain short-lived
workload tokens. A Vault root token cannot be identified by its text format, so
checking only for the literal development token would not be a security
boundary.

For a billing-disabled deployment, the static-principal environment variables
are:

| Variable                                 | Purpose                                                                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `API_TOKEN_HASHES`                       | JSON map of SHA-256 token hex to `{tenant, users}`; binds each production credential to explicit usernames without storing its plaintext. |
| `CORS_ALLOWED_ORIGINS`                   | Comma-separated exact HTTPS or `chrome-extension://` origins.                                                                             |
| `VAULT_ADDRESS`                          | Vault API origin.                                                                                                                         |
| `VAULT_K8S_ROLE`                         | Enables Vault Kubernetes auth rather than a static token.                                                                                 |
| `VAULT_K8S_JWT_PATH`                     | Projected service-account token path.                                                                                                     |
| `VAULT_K8S_AUTH_PATH`                    | Auth mount, default `auth/kubernetes`.                                                                                                    |
| `WEBAUTHN_RP_ID`                         | WebAuthn relying-party ID passed to the Vault plugin.                                                                                     |
| `WEBAUTHN_RP_ORIGINS`                    | Exact comma-separated origins passed to the plugin.                                                                                       |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` | Per-tenant/IP process limit.                                                                                                              |
| `RATE_LIMIT_BUCKETS`                     | Memory bound for local rate-limit buckets.                                                                                                |

`API_TOKENS` and `API_TOKEN`/`API_TENANT`/`API_USERS` remain bootstrap options;
`VAULT_TOKEN` is development-only. Outside development mode, every token mapping
must include at least one authorized username. This is user-scoped bearer
authorization, not identity federation or proof of the human holding the token;
put production behind an OIDC-aware issuer and centralized/global rate limiter,
with short-lived token rotation and revocation. The adapter never needs a root
token. The Kubernetes manifests include an engine-scoped policy and
workload-auth role.

Production `BILLING_MODE=postgres` does not use this map: it rejects
`API_TOKEN_HASHES`, `API_TOKENS`, and `API_TOKEN`, then authenticates
one-time-reveal `ssk_live_...` keys from PostgreSQL. Those keys resolve the
account, tenant, scopes, and non-empty username allowlist server-side. See the
account section and [`docs/BILLING.md`](docs/BILLING.md) before choosing a
deployment mode.

Billing-disabled production hash-map shape:

```json
{
  "<sha256-token-hex>": {
    "tenant": "tenant-a",
    "users": ["alice", "recovery-operator"]
  }
}
```

## Account platform and usage billing

The adapter now has an optional account layer with PostgreSQL production
storage, one-time-reveal hashed API keys, scoped username authorization,
subscription/quota gates, durable usage/outbox records, and developer/admin
consoles. Production `BILLING_MODE=postgres` is intentionally fail-closed: it
requires Stripe for the base subscription, Metronome as the usage-rating path,
and both environment-level and per-account confirmation that Metronome will
invoice the matching Stripe customer. The memory store and `sandbox`/`launch`/
`scale` tiers are labeled development fixtures only.

`/create`, `/check`, and `/signin` count the first successful use of each opaque
wallet per billing period. Only a successful transaction `/complete` counts a
transaction unit; message signatures, including Ethereum EIP-191, do not.
Reservations prevent concurrent quota oversubscription; committed usage is
exported asynchronously and never blocks signing on Metronome delivery. See
[`docs/BILLING.md`](docs/BILLING.md) for migrations, all environment variables,
Stripe/Metronome provisioning, Checkout recovery, tax release gates, security
boundaries, and the documented crash/reconciliation underbilling window. A
redacted starting configuration is in
[`.env.billing.example`](.env.billing.example).

## WebAuthn verification

The Go test suite performs the complete registration, credential creation,
assertion, and signature completion through Vault's framework dispatcher using
a cryptographic software authenticator. It verifies create-versus-update route
selection, requires authenticator user verification, rejects replay, disables
a credential after a nonzero signature-counter regression, and recovers the
Ethereum address from the resulting EIP-191 signature:

```sh
docker run --rm -v "$PWD:/src" -w /src golang:1.26@sha256:e30143be198ab04cf7ba25fba83ab3a692ca584c994aad0bf131fa0eb32dd8c1 go test ./...
```

That test is deterministic automation, not evidence that every physical
authenticator works. Perform this manual platform-authenticator check before a
release:

1. Start Compose and open <http://localhost:9080> in a current Chrome, Safari,
   Edge, or Firefox profile on the same machine.
2. Choose Solana, register a unique username, and use Touch ID, Windows Hello,
   Android/iOS passkey, or a hardware security key when prompted.
3. Prepare and approve a Solana transaction; deserialize the returned
   `encodedTX` and verify its signer before optionally submitting it to devnet.
4. Repeat with Ethereum and approve an EIP-191 message. Recover the address
   from the returned 65-byte signature and confirm it matches the displayed
   wallet address.
5. Try cancelling, replaying a completed ceremony, using an expired ceremony,
   and opening two simultaneous signing tabs. Each failure must be rejected
   without returning a signature.

Do not use browser developer-tool virtual authenticators for this manual step;
the automated test already covers a software authenticator.

## Development checks

```sh
npm ci
npm run lint
npm test
npm run build:client
npm audit
docker run --rm -v "$PWD:/src" -w /src \
  golang:1.26@sha256:e30143be198ab04cf7ba25fba83ab3a692ca584c994aad0bf131fa0eb32dd8c1 \
  go run golang.org/x/vuln/cmd/govulncheck@v1.7.0 ./...
```

The production and full npm dependency sets currently audit with zero known
advisories after replacing the legacy static server, Browserify, and Mocha
toolchains and applying narrow patched transitive overrides. Re-run the audit
when refreshing the lockfile.

The Go vulnerability scan reports zero reachable vulnerabilities. Its verbose
module view still notes that `golang.org/x/crypto/openpgp` is unmaintained; this
service does not import that package, and the upstream advisory has no fixed
module release. Keep the symbol-level scan as the release gate and re-evaluate
the dependency graph as Vault SDK releases change.

The bounded all-endpoint load suite lives in [`load-test/`](load-test/). Its
defaults are loopback-only; do not aim it at a shared environment without
authorization.

## Annotated product recordings

The Playwright recorder drives the actual unpacked extension demo and standalone
wallet page, plus developer and admin dashboard walkthroughs. Each action has a
numbered on-page callout, highlighted target, screenshot, trace entry, and
timeline entry. Videos are native WebM files.

Vault, Stripe, cloud services, real RPCs, production credentials, and physical
authenticators are replaced by a visibly labeled loopback fixture and Chrome
DevTools Protocol virtual authenticator. The dashboard flows build and serve the
actual `/developer` and `/admin` console routes, log in through their real
session path, and supply an in-memory demo billing runtime plus fake Vault
boundary. See [`recording/README.md`](recording/README.md) for the run commands,
selector contract, CSP assertion, output manifest, and trust boundary.

The Makefile can build and register the plugin against a separately installed
Vault development server. Live Solana devnet scripts are explicit commands and
require your own test keypair:

```sh
make build
make test
make devnet-test
```

## Storage and deployment boundaries

The plugin stores tenant-scoped gob payloads through Vault logical storage;
private keys are never returned by the HTTP API. Storage entries request seal
wrapping when the configured Vault seal supports it. HA durability, unsealing,
backups, and consensus belong to Vault and its storage backend, not the
adapter. See [`deploy/`](deploy/) for the Vault Integrated Storage (Raft) reference topology and
[`nitro/README`](nitro/README) for the Veil enclave experiment and its remaining
trust-boundary limitations.

The new tenant/chain storage layout is intentionally incompatible with records
created by the original client-token-keyed prototype. No automatic migration
is provided; export and re-register development-only wallets rather than
silently interpreting old records.

The original project plan remains in [`BusinessPlan.md`](BusinessPlan.md).
