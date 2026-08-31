import assert from "node:assert/strict";
import { Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { createApp } from "../app";
import { ServiceConfig } from "../config";
import { MemoryBillingStore } from "./memory-store";
import { BillingRuntime } from "./runtime";
import { hashSecret, issueAPIKey } from "./security";

const servers: Server[] = [];
afterEach(
  async () =>
    void (await Promise.all(
      servers
        .splice(0)
        .map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
    )),
);

async function fixture() {
  const store = new MemoryBillingStore();
  await store.putPlan({
    id: "test",
    name: "Test",
    activeWalletLimit: 1,
    transactionLimit: 2,
    walletUnitAmount: 0,
    transactionUnitAmount: 0,
    demo: true,
  });
  const now = new Date();
  const accountId = "00000000-0000-4000-8000-000000000041";
  await store.putAccount({
    id: accountId,
    tenant: "tenant-d",
    name: "Test",
    email: "dev@example.test",
    status: "active",
    planId: "test",
    metronomeCustomerId: "customer-d",
    billingPeriodStart: new Date(now.getTime() - 60_000),
    billingPeriodEnd: new Date(now.getTime() + 60_000),
    createdAt: now,
    updatedAt: now,
  });
  const pepper = "p".repeat(32);
  const issued = await issueAPIKey(store, pepper, {
    accountId,
    name: "Test key",
    scopes: ["wallets:read", "wallets:write", "signatures:create"],
    users: ["alice"],
    live: false,
  });
  const billingConfig = {
    mode: "memory" as const,
    databaseSSL: false,
    apiKeyPepper: pepper,
    sessionSecret: "s".repeat(32),
    sessionTtlMs: 60_000,
    usageReservationTtlMs: 5 * 60_000,
    consoleOrigin: "http://localhost:3000",
    plans: [],
    demoSeed: false,
  };
  const runtime: BillingRuntime = {
    config: billingConfig,
    store,
    async authenticate(secret) {
      return store.findAPIKeyByHash(hashSecret(secret, pepper));
    },
    async close() {},
  };
  const config: ServiceConfig = {
    devMode: true,
    port: 3000,
    trustProxy: false,
    apiTokenHashes: new Map(),
    allowedOrigins: new Set(["http://localhost:9080"]),
    vaultAddress: "http://vault.invalid",
    vaultToken: "root",
    rateLimitWindowMs: 60_000,
    rateLimitMax: 100,
    rateLimitBuckets: 100,
    maxPayloadBytes: 1024,
    billing: billingConfig,
  };
  const calls: string[] = [];
  let completionOperationOverride: string | undefined;
  const app = createApp(
    config,
    {
      async ready() {
        return true;
      },
      async post(path, body) {
        calls.push(path);
        const isCompletion =
          path === "auth" && typeof body.credential === "object";
        return {
          address: "wallet",
          encodedTX: "signed",
          operation:
            isCompletion && completionOperationOverride
              ? completionOperationOverride
              : body.operation,
        };
      },
    },
    runtime,
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    token: issued.secret,
    store,
    accountId,
    calls,
    setCompletionOperation(operation?: string) {
      completionOperationOverride = operation;
    },
  };
}

function credential(assertion: boolean) {
  return {
    id: "YQ",
    rawId: "YQ",
    type: "public-key",
    response: assertion
      ? { clientDataJSON: "YQ", authenticatorData: "YQ", signature: "YQ" }
      : { clientDataJSON: "YQ", attestationObject: "YQ" },
  };
}

test("dynamic API keys enforce users and bill successful lifecycle completions idempotently", async () => {
  const value = await fixture();
  const headers = {
    Authorization: `Bearer ${value.token}`,
    "Content-Type": "application/json",
  };
  const forbidden = await fetch(`${value.baseURL}/check`, {
    method: "POST",
    headers,
    body: JSON.stringify({ username: "bob" }),
  });
  assert.equal(forbidden.status, 403);
  assert.equal(value.calls.length, 0);

  const created = await fetch(`${value.baseURL}/create`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      username: "alice",
      chain: "solana",
      ceremonyId: "c".repeat(32),
      credential: credential(false),
    }),
  });
  assert.equal(created.status, 200);
  const checked = await fetch(`${value.baseURL}/check`, {
    method: "POST",
    headers,
    body: JSON.stringify({ username: "alice", chain: "solana" }),
  });
  assert.equal(checked.status, 200);
  const signedIn = await fetch(`${value.baseURL}/signin`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      username: "alice",
      chain: "solana",
      operation: "message",
      payload: Buffer.from("test").toString("base64"),
    }),
  });
  assert.equal(signedIn.status, 200);
  const secondWallet = await fetch(`${value.baseURL}/create`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      username: "alice",
      chain: "ethereum",
      ceremonyId: "d".repeat(32),
      credential: credential(false),
    }),
  });
  assert.equal(secondWallet.status, 429);

  const completeMessage = await fetch(`${value.baseURL}/complete`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      username: "alice",
      chain: "solana",
      operation: "message",
      ceremonyId: "e".repeat(32),
      credential: credential(true),
    }),
  });
  assert.equal(completeMessage.status, 200);
  let summary = await value.store.usageSummary(value.accountId);
  assert.equal(summary.transactions, 0);

  const transactionSignin = await fetch(`${value.baseURL}/signin`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      username: "alice",
      chain: "solana",
      operation: "transaction",
      payload: Buffer.from("transaction").toString("base64"),
    }),
  });
  assert.equal(transactionSignin.status, 200);
  const completeTransaction = () =>
    fetch(`${value.baseURL}/complete`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        username: "alice",
        chain: "solana",
        operation: "transaction",
        ceremonyId: "f".repeat(32),
        credential: credential(true),
      }),
    });
  assert.equal((await completeTransaction()).status, 200);
  const replay = await completeTransaction();
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error.code, "usage_already_committed");
  assert.equal(value.calls.length, 6);
  summary = await value.store.usageSummary(value.accountId);
  assert.equal(summary.activeWallets, 1);
  assert.equal(summary.transactions, 1);
});

test("Vault operation mismatches fail closed and cancel transaction usage", async () => {
  const value = await fixture();
  const ceremonyId = "m".repeat(32);
  value.setCompletionOperation("message");
  const request = () =>
    fetch(`${value.baseURL}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${value.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: "alice",
        chain: "solana",
        operation: "transaction",
        ceremonyId,
        credential: credential(true),
      }),
    });

  const mismatched = await request();
  assert.equal(mismatched.status, 502);
  const body = await mismatched.json();
  assert.equal(body.error.code, "vault_operation_mismatch");
  assert.equal(body.encodedTX, undefined);
  assert.equal(body.signature, undefined);
  assert.equal(
    (await value.store.usageSummary(value.accountId)).transactions,
    0,
  );

  value.setCompletionOperation();
  assert.equal((await request()).status, 200);
  assert.equal(
    (await value.store.usageSummary(value.accountId)).transactions,
    1,
  );
});

test("inactive dynamic-key accounts return payment required before Vault", async () => {
  const value = await fixture();
  await value.store.updateAccountBilling(value.accountId, {
    status: "past_due",
  });
  const response = await fetch(`${value.baseURL}/check`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${value.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ username: "alice" }),
  });
  assert.equal(response.status, 402);
  assert.equal((await response.json()).error.code, "payment_required");
  assert.equal(value.calls.length, 0);
});

test("a duplicate reserved ceremony is rejected before a second Vault call", async () => {
  const value = await fixture();
  const ceremonyId = "f".repeat(32);
  await value.store.reserveUsage({
    accountId: value.accountId,
    metric: "transaction_signed",
    idempotencyKey: ceremonyId,
  });
  const response = await fetch(`${value.baseURL}/complete`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${value.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username: "alice",
      chain: "solana",
      ceremonyId,
      credential: credential(true),
    }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "usage_in_progress");
  assert.equal(value.calls.length, 0);
});

test("a commit failure leaves an ambiguous successful operation reserved", async () => {
  const value = await fixture();
  const ceremonyId = "a".repeat(32);
  const originalCommit = value.store.commitUsage.bind(value.store);
  value.store.commitUsage = async () => {
    throw new Error("database unavailable after Vault success");
  };
  const request = () =>
    fetch(`${value.baseURL}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${value.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: "alice",
        chain: "solana",
        ceremonyId,
        credential: credential(true),
      }),
    });
  assert.equal((await request()).status, 500);
  value.store.commitUsage = originalCommit;
  const retry = await request();
  assert.equal(retry.status, 409);
  assert.equal((await retry.json()).error.code, "usage_in_progress");
  assert.deepEqual(value.calls, ["auth"]);
});
