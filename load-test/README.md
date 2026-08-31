# Endpoint load tests

`suite.mjs` covers the service probes, wallet API, developer/admin console
authentication walls, and Stripe webhook rejection path with bounded,
scenario-specific requests. It is dependency-free and refuses remote targets,
remote plaintext bearer tokens, and mutating wallet scenarios unless each risk
is explicitly enabled. Console mutation routes are called without a session,
so they exercise the access boundary without creating keys, accounts, Checkout
sessions, or subscriptions.

Run the non-mutating smoke suite:

```sh
SPIRAL_SAFE_API_TOKEN=spiral-safe-local-development-only npm run load:smoke
```

Run ten requests against every route, including registration/session mutations:

```sh
SPIRAL_SAFE_API_TOKEN=spiral-safe-local-development-only npm run load:all -- \
  --requests 10 \
  --concurrency 2
```

The default `safe` set covers `/healthz`, `/readyz`, `/console.css`, every
developer/admin route and method without a session, deliberately rejected
developer/admin login attempts (401/429 for invalid credentials or throttling,
or 403 when the exact console Origin differs), an invalid Stripe webhook, an
unauthenticated `/check` request, and an authenticated missing-user `/check`.
The `all` set additionally covers `/init`, `/create`, `/signin`, and
`/complete`. The latter three use invalid or missing-user inputs: WebAuthn
challenges and counters make replaying one successful assertion across
concurrent workers incorrect. Use the separate lifecycle test for a successful
registration and signing ceremony.

Every scenario reports status counts, errors, throughput, and min/p50/p95/p99/max
latency independently. Redirects are observed without following them so an
authentication wall cannot be misreported as the eventual login page, and each
concurrent WebAuthn-negative probe receives a unique placeholder ceremony ID.
Override an environment-specific status contract with,
for example, `--expect signin=404,422`. Use `--chain ethereum` to exercise the
Ethereum registration/signing entry path.

Run `node load-test/suite.mjs --help` for the complete safety and tuning options.
Only test systems you own or are explicitly authorized to load.
