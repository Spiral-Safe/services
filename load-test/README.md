# Endpoint load tests

`suite.mjs` covers the service health probes and every API endpoint with bounded,
scenario-specific requests. It is dependency-free and refuses remote targets,
remote plaintext bearer tokens, and mutating scenarios unless each risk is
explicitly enabled.

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

The default `safe` set covers `/healthz`, `/readyz`, an unauthenticated `/check`
request, and an authenticated missing-user `/check`. The `all` set additionally
covers `/init`, `/create`, `/signin`, and `/complete`. The latter three use
invalid or missing-user inputs: WebAuthn challenges and counters make replaying
one successful assertion across concurrent workers incorrect. Use the separate
lifecycle test for a successful registration and signing ceremony.

Every scenario reports status counts, errors, throughput, and min/p50/p95/p99/max
latency independently. Override an environment-specific status contract with,
for example, `--expect signin=404,422`. Use `--chain ethereum` to exercise the
Ethereum registration/signing entry path.

Run `node load-test/suite.mjs --help` for the complete safety and tuning options.
Only test systems you own or are explicitly authorized to load.
