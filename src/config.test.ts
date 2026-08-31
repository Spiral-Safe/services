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
