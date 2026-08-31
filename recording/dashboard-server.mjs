import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const recordingDirectory = dirname(fileURLToPath(import.meta.url));
const requireBuilt = createRequire(import.meta.url);

const credentials = Object.freeze({
  developer: Object.freeze({
    email: "developer@example.test",
    password: "demo-developer-only",
  }),
  admin: Object.freeze({
    email: "admin@example.test",
    password: "demo-admin-only",
  }),
});

export async function startDashboardServer() {
  let application;
  const server = createServer((request, response) => {
    if (!application) {
      response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Recording console is starting");
      return;
    }
    application(request, response);
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Recording console did not expose a TCP port");
  }
  const origin = `http://localhost:${address.port}`;
  let runtime;
  try {
    const { createApp } = requireBuilt(
      resolve(recordingDirectory, "..", "dist", "app.js"),
    );
    const { loadConfig } = requireBuilt(
      resolve(recordingDirectory, "..", "dist", "config.js"),
    );
    const { createBillingRuntime } = requireBuilt(
      resolve(recordingDirectory, "..", "dist", "billing", "runtime.js"),
    );
    const config = loadConfig(recordingEnvironment(origin));
    runtime = await createBillingRuntime(config.billing);
    if (!runtime) throw new Error("Recording billing runtime was not created");
    await seedRecordingDashboard(runtime.store);
    application = createApp(
      config,
      {
        async ready() {
          return true;
        },
        async post() {
          throw new Error(
            "Vault wallet routes are unavailable in dashboard fixture mode",
          );
        },
      },
      runtime,
    );
  } catch (error) {
    await runtime?.close().catch(() => {});
    await closeServer(server);
    throw error;
  }
  return {
    origin,
    fixtureMode: true,
    source: "actual-billing-console",
    credentials,
    pages: {
      developer: `${origin}/developer`,
      admin: `${origin}/admin`,
    },
    loginPages: {
      developer: `${origin}/developer/login`,
      admin: `${origin}/admin/login`,
    },
    async close() {
      await closeServer(server);
      await runtime.close();
    },
  };
}

function recordingEnvironment(origin) {
  return {
    SERVICE_DEV_MODE: "true",
    BILLING_MODE: "memory",
    BILLING_DEMO_SEED: "true",
    API_KEY_PEPPER: "recording-only-api-key-pepper-000000000000",
    CONSOLE_SESSION_SECRET: "recording-only-session-secret-00000000000",
    CONSOLE_ORIGIN: origin,
    CORS_ALLOWED_ORIGINS: origin,
    VAULT_ADDRESS: "http://127.0.0.1:8200",
    VAULT_TOKEN: "fixture-not-a-vault-token",
    DEMO_DEVELOPER_EMAIL: credentials.developer.email,
    DEMO_DEVELOPER_PASSWORD: credentials.developer.password,
    DEMO_ADMIN_EMAIL: credentials.admin.email,
    DEMO_ADMIN_PASSWORD: credentials.admin.password,
  };
}

async function seedRecordingDashboard(store) {
  const [account] = await store.listAccounts();
  if (!account) throw new Error("Recording demo account was not seeded");
  await store.createAPIKey({
    id: "00000000-0000-4000-8000-000000000010",
    accountId: account.id,
    name: "Recorder fixture key",
    prefix: "ssk_fixture",
    secretHash: "0".repeat(64),
    scopes: ["wallets:read", "wallets:write", "signatures:create"],
    users: ["recording-user"],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  const walletUsage = await store.reserveUsage({
    accountId: account.id,
    metric: "active_wallet",
    idempotencyKey: "recording-active-wallets",
    quantity: 2,
    walletKey: "fixture-wallets",
    occurredAt: new Date(),
    properties: { fixture_mode: "true" },
  });
  await store.commitUsage(walletUsage.id);
  const transactionUsage = await store.reserveUsage({
    accountId: account.id,
    metric: "transaction_signed",
    idempotencyKey: "recording-transactions",
    quantity: 24,
    occurredAt: new Date(),
    properties: { fixture_mode: "true" },
  });
  await store.commitUsage(transactionUsage.id);
}

async function closeServer(server) {
  await new Promise((resolvePromise) => {
    server.close(() => resolvePromise());
  });
}
