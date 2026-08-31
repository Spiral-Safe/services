import assert from "node:assert/strict";
import { test } from "node:test";
import { hashAPIToken, loadConfig } from "./config";

const productionToken = "spiral-safe-production-token-for-tests";

function productionEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    API_TOKEN_HASHES: JSON.stringify({
      [hashAPIToken(productionToken)]: {
        tenant: "tenant-a",
        users: ["alice"],
      },
    }),
    CORS_ALLOWED_ORIGINS: "https://wallet.example",
    VAULT_ADDRESS: "https://vault.example:8200",
    VAULT_K8S_ROLE: "spiral-safe",
    ...overrides,
  };
}

test("production accepts hashed API tokens and an HTTPS Vault origin", () => {
  const config = loadConfig(productionEnv());
  assert.equal(
    config.apiTokenHashes.get(hashAPIToken(productionToken))?.tenant,
    "tenant-a",
  );
  assert.deepEqual(
    [
      ...(config.apiTokenHashes.get(hashAPIToken(productionToken))?.users ||
        []),
    ],
    ["alice"],
  );
  assert.equal(config.vaultAddress, "https://vault.example:8200");
  assert.equal(config.devMode, false);
});

test("production rejects every static Vault token and plaintext HTTP origins", () => {
  assert.throws(
    () => loadConfig(productionEnv({ VAULT_TOKEN: "root" })),
    /VAULT_TOKEN is forbidden/,
  );
  assert.throws(
    () =>
      loadConfig(
        productionEnv({ VAULT_TOKEN: "hvs.could-still-be-a-root-token" }),
      ),
    /VAULT_TOKEN is forbidden/,
  );
  assert.throws(
    () =>
      loadConfig(
        productionEnv({ CORS_ALLOWED_ORIGINS: "http://wallet.example" }),
      ),
    /production CORS origin must use HTTPS/,
  );
  assert.throws(
    () =>
      loadConfig(productionEnv({ VAULT_ADDRESS: "http://vault.example:8200" })),
    /must use HTTPS/,
  );
});

test("production token maps require explicit authorized users", () => {
  assert.throws(
    () =>
      loadConfig(
        productionEnv({
          API_TOKEN_HASHES: JSON.stringify({
            [hashAPIToken(productionToken)]: "tenant-a",
          }),
        }),
      ),
    /production values must be/,
  );
  assert.throws(
    () =>
      loadConfig(
        productionEnv({
          API_TOKEN_HASHES: JSON.stringify({
            [hashAPIToken(productionToken)]: {
              tenant: "tenant-a",
              users: [],
            },
          }),
        }),
      ),
    /non-empty users array/,
  );
});

test("Vault and CORS configuration rejects URL state beyond an origin", () => {
  assert.throws(
    () =>
      loadConfig(
        productionEnv({ VAULT_ADDRESS: "https://user@vault.example:8200" }),
      ),
    /without credentials/,
  );
  assert.throws(
    () =>
      loadConfig(
        productionEnv({ CORS_ALLOWED_ORIGINS: "https://wallet.example/path" }),
      ),
    /exact origins/,
  );
});

test("explicit development mode limits plaintext Vault hosts", () => {
  const base = {
    SERVICE_DEV_MODE: "true",
    API_TOKEN: "local-token",
    CORS_ALLOWED_ORIGINS: "http://localhost:9080",
    VAULT_TOKEN: "root",
  };
  assert.equal(
    loadConfig({ ...base, VAULT_ADDRESS: "http://127.0.0.1:8200" })
      .vaultAddress,
    "http://127.0.0.1:8200",
  );
  assert.equal(
    loadConfig({ ...base, VAULT_ADDRESS: "http://vault:8200" }).vaultAddress,
    "http://vault:8200",
  );
  assert.throws(
    () => loadConfig({ ...base, VAULT_ADDRESS: "http://vault.example:8200" }),
    /development HTTP VAULT_ADDRESS must be loopback/,
  );
});

test("seeded billing uses the deterministic in-memory development store only", () => {
  const config = loadConfig({
    SERVICE_DEV_MODE: "true",
    API_TOKEN: "local-token",
    CORS_ALLOWED_ORIGINS: "http://localhost:9080",
    VAULT_TOKEN: "root",
    BILLING_MODE: "memory",
    BILLING_DEMO_SEED: "true",
    API_KEY_PEPPER: "p".repeat(32),
    CONSOLE_SESSION_SECRET: "s".repeat(32),
    CONSOLE_ORIGIN: "http://localhost:3000",
  });
  assert.equal(config.billing.mode, "memory");
  assert.deepEqual(
    config.billing.plans.map((plan) => plan.id),
    ["sandbox", "launch", "scale"],
  );
  assert.ok(config.billing.plans.every((plan) => plan.demo));
  assert.throws(
    () =>
      loadConfig({
        SERVICE_DEV_MODE: "true",
        API_TOKEN: "local-token",
        CORS_ALLOWED_ORIGINS: "http://localhost:9080",
        VAULT_TOKEN: "root",
        BILLING_MODE: "memory",
        BILLING_DEMO_SEED: "true",
        API_KEY_PEPPER: "p".repeat(32),
        CONSOLE_SESSION_SECRET: "s".repeat(32),
        CONSOLE_ORIGIN: "http://localhost:3000",
        BILLING_RESERVATION_TTL_MS: "1000",
      }),
    /must be between 60000 and 3600000/,
  );
});

test("production platform billing requires PostgreSQL and operator-defined plans", () => {
  const plan = JSON.stringify([
    {
      id: "production",
      name: "Production",
      activeWalletLimit: 100,
      transactionLimit: 1000,
      walletUnitAmount: 25,
      transactionUnitAmount: 1,
      stripeProductId: "prod_operator",
      stripePriceId: "price_operator",
      metronomeProductId: "metro_product_operator",
      metronomeRateCardId: "metro_rate_card_operator",
    },
  ]);
  const config = loadConfig(
    productionEnv({
      API_TOKEN_HASHES: undefined,
      BILLING_MODE: "postgres",
      DATABASE_URL: "postgresql://billing.example/spiral",
      API_KEY_PEPPER: "p".repeat(32),
      CONSOLE_SESSION_SECRET: "s".repeat(32),
      CONSOLE_ORIGIN: "https://console.example",
      BILLING_PLANS_JSON: plan,
      STRIPE_API_KEY: "rk_live_fixture",
      STRIPE_WEBHOOK_SECRET: "whsec_fixture",
      STRIPE_CHECKOUT_SUCCESS_URL: "https://console.example/success",
      STRIPE_CHECKOUT_CANCEL_URL: "https://console.example/cancel",
      STRIPE_PORTAL_RETURN_URL: "https://console.example/developer",
      METRONOME_API_TOKEN: "metronome-fixture",
      METRONOME_STRIPE_INVOICING_VERIFIED: "true",
    }),
  );
  assert.equal(config.billing.mode, "postgres");
  assert.equal(config.apiTokenHashes.size, 0);
  assert.equal(config.billing.plans[0].walletUnitAmount, 25);
  assert.equal(config.billing.consoleOrigin, "https://console.example");
  assert.throws(
    () =>
      loadConfig(
        productionEnv({
          API_TOKEN_HASHES: undefined,
          BILLING_MODE: "postgres",
          DATABASE_URL: "postgresql://billing.example/spiral",
          API_KEY_PEPPER: "p".repeat(32),
          CONSOLE_SESSION_SECRET: "s".repeat(32),
          CONSOLE_ORIGIN: "https://console.example",
          BILLING_PLANS_JSON: plan,
        }),
      ),
    /requires both Stripe and Metronome/,
  );
  assert.throws(
    () =>
      loadConfig(
        productionEnv({
          BILLING_MODE: "memory",
          API_KEY_PEPPER: "p".repeat(32),
          CONSOLE_SESSION_SECRET: "s".repeat(32),
          CONSOLE_ORIGIN: "https://console.example",
          BILLING_PLANS_JSON: plan,
        }),
      ),
    /in-memory billing store is development-only/,
  );
});
