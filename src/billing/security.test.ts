import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryBillingStore } from "./memory-store";
import {
  hashPassword,
  hashSecret,
  issueAPIKey,
  opaqueIdentifier,
  verifyPassword,
} from "./security";

async function preparedStore() {
  const store = new MemoryBillingStore();
  await store.putPlan({
    id: "fixture",
    name: "Fixture",
    activeWalletLimit: 10,
    transactionLimit: 10,
    walletUnitAmount: 0,
    transactionUnitAmount: 0,
    demo: true,
  });
  const now = new Date();
  await store.putAccount({
    id: "00000000-0000-4000-8000-000000000021",
    tenant: "tenant-b",
    name: "Fixture",
    email: "dev@example.test",
    status: "active",
    planId: "fixture",
    metronomeCustomerId: "fixture",
    billingPeriodStart: new Date(now.getTime() - 1_000),
    billingPeriodEnd: new Date(now.getTime() + 100_000),
    createdAt: now,
    updatedAt: now,
  });
  return store;
}

test("API keys are stored only as hashes and revoke immediately", async () => {
  const store = await preparedStore();
  const pepper = "p".repeat(32);
  const issued = await issueAPIKey(store, pepper, {
    accountId: "00000000-0000-4000-8000-000000000021",
    name: "CI key",
    scopes: ["wallets:read"],
    users: ["alice"],
    live: false,
  });
  assert.match(issued.secret, /^ssk_test_[a-f0-9]{10}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.record.secretHash, hashSecret(issued.secret, pepper));
  assert.ok(!(JSON.stringify(issued.record) as string).includes(issued.secret));
  const authenticated = await store.findAPIKeyByHash(
    hashSecret(issued.secret, pepper),
  );
  assert.equal(authenticated?.tenant, "tenant-b");
  await store.revokeAPIKey(
    issued.record.accountId,
    issued.record.id,
    new Date(),
  );
  assert.equal(
    await store.findAPIKeyByHash(hashSecret(issued.secret, pepper)),
    undefined,
  );
});

test("console passwords use salted scrypt hashes", async () => {
  const left = await hashPassword("correct horse battery staple");
  const right = await hashPassword("correct horse battery staple");
  assert.notEqual(left, right);
  assert.equal(
    await verifyPassword("correct horse battery staple", left),
    true,
  );
  assert.equal(await verifyPassword("wrong password", left), false);
});

test("wallet identifiers are domain-separated and keyed", () => {
  const identity = JSON.stringify(["tenant-b", "alice", "solana"]);
  const first = opaqueIdentifier(identity, "p".repeat(32));
  assert.equal(first, opaqueIdentifier(identity, "p".repeat(32)));
  assert.notEqual(first, opaqueIdentifier(identity, "q".repeat(32)));
  assert.ok(!first.includes("alice"));
});
