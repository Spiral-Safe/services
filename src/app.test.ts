import assert from "node:assert/strict";
import { Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { createApp } from "./app";
import { hashAPIToken, ServiceConfig } from "./config";
import { VaultResponseError } from "./vault";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

function config(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    devMode: true,
    port: 3000,
    trustProxy: false,
    apiTokenHashes: new Map([
      [
        hashAPIToken("dev-only-test-token"),
        { tenant: "tenant-a", users: new Set(["alice"]) },
      ],
    ]),
    allowedOrigins: new Set(["http://localhost:9080"]),
    vaultAddress: "http://vault.invalid",
    vaultToken: "not-root",
    rateLimitWindowMs: 60_000,
    rateLimitMax: 100,
    rateLimitBuckets: 100,
    maxPayloadBytes: 1024,
    billing: {
      mode: "disabled",
      databaseSSL: true,
      sessionTtlMs: 8 * 60 * 60 * 1_000,
      usageReservationTtlMs: 5 * 60_000,
      plans: [],
      demoSeed: false,
    },
    ...overrides,
  };
}

async function start(vault: {
  post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  ready(): Promise<boolean>;
}): Promise<string> {
  const server = createApp(config(), vault).listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

const authorizedHeaders = {
  Authorization: "Bearer dev-only-test-token",
  "Content-Type": "application/json",
  Origin: "http://localhost:9080",
};

const assertionCredential = {
  id: "YQ",
  rawId: "YQ",
  type: "public-key",
  response: {
    clientDataJSON: "YQ",
    authenticatorData: "YQ",
    signature: "YQ",
  },
};

test("health and readiness are unauthenticated", async () => {
  const baseURL = await start({
    async ready() {
      return true;
    },
    async post() {
      throw new Error("unexpected");
    },
  });
  assert.equal((await fetch(`${baseURL}/healthz`)).status, 200);
  assert.equal((await fetch(`${baseURL}/readyz`)).status, 200);
});

test("wallet routes authenticate and inject the server-side tenant", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const baseURL = await start({
    async ready() {
      return true;
    },
    async post(path, body) {
      calls.push({ path, body });
      return { chain: body.chain, address: "wallet-address" };
    },
  });

  const rejected = await fetch(`${baseURL}/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "alice" }),
  });
  assert.equal(rejected.status, 401);
  assert.equal(rejected.headers.get("x-powered-by"), null);

  const accepted = await fetch(`${baseURL}/check`, {
    method: "POST",
    headers: authorizedHeaders,
    body: JSON.stringify({ username: "alice", tenant: "attacker-controlled" }),
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(calls, [
    {
      path: "check",
      body: { tenant: "tenant-a", username: "alice", chain: "solana" },
    },
  ]);
  assert.equal(
    accepted.headers.get("access-control-allow-origin"),
    "http://localhost:9080",
  );

  const forbidden = await fetch(`${baseURL}/check`, {
    method: "POST",
    headers: authorizedHeaders,
    body: JSON.stringify({ username: "bob" }),
  });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error.code, "user_forbidden");
  assert.equal(calls.length, 1, "forbidden users must not reach Vault");
});

test("signing accepts payload and the legacy rawTx alias", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const baseURL = await start({
    async ready() {
      return true;
    },
    async post(_path, body) {
      calls.push(body);
      return { options: {} };
    },
  });
  const response = await fetch(`${baseURL}/signin`, {
    method: "POST",
    headers: authorizedHeaders,
    body: JSON.stringify({
      username: "alice",
      chain: "ethereum",
      operation: "message",
      rawTx: Buffer.from("hello").toString("base64"),
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(calls[0].payload, "aGVsbG8=");
  assert.equal(calls[0].operation, "message");
});

test("completion reconciles the requested operation before releasing output", async () => {
  const calls: Array<Record<string, unknown>> = [];
  let vaultOperation: "transaction" | "message" | undefined = "message";
  const baseURL = await start({
    async ready() {
      return true;
    },
    async post(_path, body) {
      calls.push(body);
      return {
        operation: vaultOperation,
        signature: "must-not-leak-on-mismatch",
      };
    },
  });
  const complete = (
    operation: "transaction" | "message" | undefined,
    id: string,
  ) =>
    fetch(`${baseURL}/complete`, {
      method: "POST",
      headers: authorizedHeaders,
      body: JSON.stringify({
        username: "alice",
        chain: "solana",
        ...(operation ? { operation } : {}),
        ceremonyId: id.repeat(32),
        credential: assertionCredential,
      }),
    });

  const message = await complete("message", "m");
  assert.equal(message.status, 200);
  assert.equal((await message.json()).signature, "must-not-leak-on-mismatch");
  assert.equal(calls[0].operation, "message");

  const mismatch = await complete("transaction", "t");
  assert.equal(mismatch.status, 502);
  const error = await mismatch.json();
  assert.equal(error.error.code, "vault_operation_mismatch");
  assert.equal(error.signature, undefined);
  assert.equal(calls[1].operation, "transaction");

  vaultOperation = undefined;
  const missingOperation = await complete("message", "o");
  assert.equal(missingOperation.status, 502);
  const missingError = await missingOperation.json();
  assert.equal(missingError.error.code, "vault_operation_mismatch");
  assert.equal(missingError.signature, undefined);

  vaultOperation = "transaction";
  const legacyDefault = await complete(undefined, "d");
  assert.equal(legacyDefault.status, 200);
  assert.equal(calls[3].operation, "transaction");
});

test("validation and Vault errors have stable JSON mappings", async () => {
  const baseURL = await start({
    async ready() {
      return true;
    },
    async post() {
      throw new VaultResponseError(400, ["invalid WebAuthn credential"]);
    },
  });
  const invalidChain = await fetch(`${baseURL}/check`, {
    method: "POST",
    headers: authorizedHeaders,
    body: JSON.stringify({ username: "alice", chain: "bitcoin" }),
  });
  assert.equal(invalidChain.status, 400);
  assert.equal((await invalidChain.json()).error.code, "unsupported_chain");

  const emptyCredential = await fetch(`${baseURL}/create`, {
    method: "POST",
    headers: authorizedHeaders,
    body: JSON.stringify({
      username: "alice",
      chain: "ethereum",
      ceremonyId: "0123456789abcdef0123456789abcdef",
      credential: {},
    }),
  });
  assert.equal(emptyCredential.status, 400);
  assert.equal((await emptyCredential.json()).error.code, "invalid_credential");

  const invalidCredential = await fetch(`${baseURL}/create`, {
    method: "POST",
    headers: authorizedHeaders,
    body: JSON.stringify({
      username: "alice",
      chain: "ethereum",
      ceremonyId: "0123456789abcdef0123456789abcdef",
      credential: {
        id: "YQ",
        rawId: "YQ",
        type: "public-key",
        response: { clientDataJSON: "YQ", attestationObject: "YQ" },
      },
    }),
  });
  assert.equal(invalidCredential.status, 422);
  assert.equal(
    (await invalidCredential.json()).error.code,
    "vault_rejected_request",
  );
});

test("an uninitialized registration maps to wallet_not_found", async () => {
  const baseURL = await start({
    async ready() {
      return true;
    },
    async post() {
      throw new VaultResponseError(400, [
        "404 registration was not initialized",
      ]);
    },
  });
  const response = await fetch(`${baseURL}/create`, {
    method: "POST",
    headers: authorizedHeaders,
    body: JSON.stringify({
      username: "alice",
      chain: "solana",
      ceremonyId: "0123456789abcdef0123456789abcdef",
      credential: {
        id: "YQ",
        rawId: "YQ",
        type: "public-key",
        response: { clientDataJSON: "YQ", attestationObject: "YQ" },
      },
    }),
  });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "wallet_not_found");
});
