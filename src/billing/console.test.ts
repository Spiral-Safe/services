import assert from "node:assert/strict";
import { Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { createApp } from "../app";
import { ServiceConfig } from "../config";
import { MemoryBillingStore } from "./memory-store";
import { BillingRuntime } from "./runtime";
import { hashPassword } from "./security";

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
    id: "operator",
    name: "Operator plan",
    activeWalletLimit: 10,
    transactionLimit: 100,
    walletUnitAmount: 10,
    transactionUnitAmount: 1,
    metronomeProductId: "product_sensitive_fixture",
    metronomeRateCardId: "rate_sensitive_fixture",
    demo: false,
  });
  const now = new Date();
  const accountId = "00000000-0000-4000-8000-000000000051";
  await store.putAccount({
    id: accountId,
    tenant: "console-tenant",
    name: "Console customer",
    email: "developer@example.test",
    status: "active",
    planId: "operator",
    stripeCustomerId: "cus_sensitive_fixture",
    stripeSubscriptionId: "sub_sensitive_fixture",
    metronomeCustomerId: "console-customer",
    billingPeriodStart: new Date(now.getTime() - 1_000),
    billingPeriodEnd: new Date(now.getTime() + 60_000),
    createdAt: now,
    updatedAt: now,
  });
  await store.putConsoleUser({
    id: "00000000-0000-4000-8000-000000000052",
    accountId,
    email: "developer@example.test",
    role: "developer",
    passwordHash: await hashPassword("developer-password"),
    createdAt: now,
  });
  await store.putConsoleUser({
    id: "00000000-0000-4000-8000-000000000053",
    email: "admin@example.test",
    role: "admin",
    passwordHash: await hashPassword("administrator-password"),
    createdAt: now,
  });
  const billing = {
    mode: "postgres" as const,
    databaseUrl: "postgresql://unused",
    databaseSSL: true,
    apiKeyPepper: "p".repeat(32),
    sessionSecret: "s".repeat(32),
    sessionTtlMs: 60_000,
    usageReservationTtlMs: 5 * 60_000,
    consoleOrigin: "https://console.example",
    plans: [],
    demoSeed: false,
    metronome: {
      apiToken: "metronome-test-token",
      endpoint: "https://api.metronome.com/v1/ingest",
      intervalMs: 10_000,
      batchSize: 100,
      stripeInvoicingVerified: true,
    },
  };
  const runtime: BillingRuntime = {
    config: billing,
    store,
    async authenticate() {
      return undefined;
    },
    async close() {},
  };
  const config: ServiceConfig = {
    devMode: false,
    port: 3000,
    trustProxy: false,
    apiTokenHashes: new Map(),
    allowedOrigins: new Set(["https://console.example"]),
    vaultAddress: "https://vault.example",
    vaultKubernetes: {
      role: "test",
      jwtPath: "/unused",
      authPath: "auth/kubernetes",
    },
    rateLimitWindowMs: 60_000,
    rateLimitMax: 100,
    rateLimitBuckets: 100,
    maxPayloadBytes: 1024,
    billing,
  };
  const server = createApp(
    config,
    {
      async ready() {
        return true;
      },
      async post() {
        return {};
      },
    },
    runtime,
  ).listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return { baseURL: `http://127.0.0.1:${address.port}`, store, accountId };
}

test("developer console rotates secure sessions and reveals API keys once", async () => {
  const value = await fixture();
  const login = await fetch(`${value.baseURL}/developer/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      Origin: "https://console.example",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      email: "developer@example.test",
      password: "developer-password",
    }),
  });
  assert.equal(login.status, 303);
  const setCookie = login.headers.get("set-cookie") || "";
  assert.match(setCookie, /__Host-spiral_session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, /Secure/i);
  const cookie = setCookie.split(";")[0];

  const dashboard = await fetch(`${value.baseURL}/developer`, {
    headers: { Cookie: cookie },
  });
  const html = await dashboard.text();
  assert.equal(dashboard.status, 200);
  assert.match(html, /data-recording="developer-overview"/);
  assert.match(html, /data-recording="developer-api-keys"/);
  assert.match(html, /data-recording="developer-usage"/);
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrf);

  const created = await fetch(`${value.baseURL}/developer/api-keys`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: "https://console.example",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      name: "Browser key",
      users: "alice",
      scopes: "wallets:read",
      csrf: csrf!,
    }),
  });
  const createdHTML = await created.text();
  assert.equal(created.status, 201);
  const secret = createdHTML.match(
    /ssk_live_[a-f0-9]{10}\.[A-Za-z0-9_-]{43}/,
  )?.[0];
  assert.ok(secret);
  const records = await value.store.listAPIKeys(value.accountId);
  assert.equal(records.length, 1);
  assert.ok(!JSON.stringify(records).includes(secret!));
});

test("console mutations require exact Origin and CSRF", async () => {
  const value = await fixture();
  const rejected = await fetch(`${value.baseURL}/developer/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email: "developer@example.test",
      password: "developer-password",
    }),
  });
  assert.equal(rejected.status, 401);
  assert.match(await rejected.text(), /Invalid credentials/);
});

test("admin selected-account view omits personal and provider identifiers", async () => {
  const value = await fixture();
  const login = await fetch(`${value.baseURL}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      Origin: "https://console.example",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      email: "admin@example.test",
      password: "administrator-password",
    }),
  });
  assert.equal(login.status, 303);
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  const dashboard = await fetch(
    `${value.baseURL}/admin?account=${encodeURIComponent(value.accountId)}`,
    { headers: { Cookie: cookie } },
  );
  const html = await dashboard.text();
  assert.equal(dashboard.status, 200);
  assert.match(html, /Console customer/);
  assert.doesNotMatch(html, /developer@example\.test/);
  assert.doesNotMatch(html, /cus_sensitive_fixture/);
  assert.doesNotMatch(html, /sub_sensitive_fixture/);
  assert.doesNotMatch(html, /console-customer/);
  assert.doesNotMatch(html, /rate_sensitive_fixture/);
  assert.match(html, /name="planId" value="operator" readonly/);
  assert.match(html, /Verify and attest mapping/);
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrf);

  const mismatch = await fetch(
    `${value.baseURL}/admin/accounts/${value.accountId}/metronome-verified`,
    {
      method: "POST",
      redirect: "manual",
      headers: {
        Cookie: cookie,
        Origin: "https://console.example",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        csrf: csrf!,
        planId: "operator",
        stripeCustomerId: "cus_wrong",
        metronomeCustomerId: "console-customer",
        metronomeRateCardId: "rate_sensitive_fixture",
      }),
    },
  );
  assert.equal(mismatch.status, 409);
  assert.equal(
    (await value.store.getAccount(value.accountId))
      ?.metronomeStripeMappingVerifiedAt,
    undefined,
  );

  const originalMark = value.store.markMetronomeStripeMappingVerified.bind(
    value.store,
  );
  value.store.markMetronomeStripeMappingVerified = async (
    accountId,
    expected,
    verifiedAt,
  ) => {
    await value.store.updateAccountBilling(accountId, {
      stripeCustomerId: "cus_concurrent_webhook",
    });
    return originalMark(accountId, expected, verifiedAt);
  };
  const raced = await fetch(
    `${value.baseURL}/admin/accounts/${value.accountId}/metronome-verified`,
    {
      method: "POST",
      redirect: "manual",
      headers: {
        Cookie: cookie,
        Origin: "https://console.example",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        csrf: csrf!,
        planId: "operator",
        stripeCustomerId: "cus_sensitive_fixture",
        metronomeCustomerId: "console-customer",
        metronomeRateCardId: "rate_sensitive_fixture",
      }),
    },
  );
  assert.equal(raced.status, 409);
  assert.equal(
    (await value.store.getAccount(value.accountId))
      ?.metronomeStripeMappingVerifiedAt,
    undefined,
  );
  value.store.markMetronomeStripeMappingVerified = originalMark;
  await value.store.updateAccountBilling(value.accountId, {
    stripeCustomerId: "cus_sensitive_fixture",
  });

  const verified = await fetch(
    `${value.baseURL}/admin/accounts/${value.accountId}/metronome-verified`,
    {
      method: "POST",
      redirect: "manual",
      headers: {
        Cookie: cookie,
        Origin: "https://console.example",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        csrf: csrf!,
        planId: "operator",
        stripeCustomerId: "cus_sensitive_fixture",
        metronomeCustomerId: "console-customer",
        metronomeRateCardId: "rate_sensitive_fixture",
      }),
    },
  );
  assert.equal(verified.status, 303);
  assert.ok(
    (await value.store.getAccount(value.accountId))
      ?.metronomeStripeMappingVerifiedAt,
  );
  assert.equal(
    (await value.store.getAccount(value.accountId))
      ?.metronomeVerifiedCustomerId,
    "console-customer",
  );
});
