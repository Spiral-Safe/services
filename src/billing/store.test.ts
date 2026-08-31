import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryBillingStore } from "./memory-store";
import { BillingStateError, Plan } from "./types";

const plan: Plan = {
  id: "test",
  name: "Test fixture",
  activeWalletLimit: 1,
  transactionLimit: 2,
  walletUnitAmount: 0,
  transactionUnitAmount: 0,
  metronomeProductId: "metro_product_test",
  metronomeRateCardId: "metro_rate_test",
  demo: true,
};

async function store() {
  const value = new MemoryBillingStore();
  await value.putPlan(plan);
  await value.putAccount({
    id: "00000000-0000-4000-8000-000000000011",
    tenant: "tenant-a",
    name: "Test",
    email: "test@example.test",
    status: "active",
    planId: plan.id,
    metronomeCustomerId: "customer-test",
    billingPeriodStart: new Date("2026-08-01T00:00:00Z"),
    billingPeriodEnd: new Date("2026-09-01T00:00:00Z"),
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: new Date("2026-08-01T00:00:00Z"),
  });
  return value;
}

function mapping(stripeCustomerId: string) {
  return {
    stripeCustomerId,
    metronomeCustomerId: "customer-test",
    planId: plan.id,
    metronomeRateCardId: plan.metronomeRateCardId!,
  };
}

test("usage reservations enforce quotas and commit idempotently", async () => {
  const value = await store();
  const first = await value.reserveUsage({
    accountId: "00000000-0000-4000-8000-000000000011",
    metric: "active_wallet",
    idempotencyKey: "period:alice:solana",
    walletKey: "tenant-a:alice:solana",
    occurredAt: new Date("2026-08-10T00:00:00Z"),
  });
  await value.commitUsage(first.id);
  await value.commitUsage(first.id);
  const duplicate = await value.reserveUsage({
    accountId: first.accountId,
    metric: "active_wallet",
    idempotencyKey: "period:alice:solana",
    occurredAt: new Date("2026-08-10T00:00:00Z"),
  });
  assert.equal(duplicate.created, false);
  await assert.rejects(
    value.reserveUsage({
      accountId: first.accountId,
      metric: "active_wallet",
      idempotencyKey: "period:bob:solana",
      occurredAt: new Date("2026-08-10T00:00:00Z"),
    }),
    (error: unknown) =>
      error instanceof BillingStateError && error.kind === "quota_exceeded",
  );
  const summary = await value.usageSummary(first.accountId);
  assert.equal(summary.activeWallets, 1);
  assert.equal((await value.claimOutbox(100, new Date())).length, 1);
});

test("failed work can cancel a reservation without consuming quota", async () => {
  const value = await store();
  const reserved = await value.reserveUsage({
    accountId: "00000000-0000-4000-8000-000000000011",
    metric: "transaction_signed",
    idempotencyKey: "ceremony-one",
    occurredAt: new Date("2026-08-10T00:00:00Z"),
  });
  await value.cancelUsage(reserved.id);
  const retried = await value.reserveUsage({
    accountId: reserved.accountId,
    metric: "transaction_signed",
    idempotencyKey: "ceremony-one",
    occurredAt: new Date("2026-08-10T00:00:00Z"),
  });
  assert.equal(retried.created, true);
});

test("stale reservations are reclaimed without charging an unknown outcome", async () => {
  const value = await store();
  const first = await value.reserveUsage({
    accountId: "00000000-0000-4000-8000-000000000011",
    metric: "transaction_signed",
    idempotencyKey: "ceremony-stale",
    occurredAt: new Date("2026-08-10T00:00:00Z"),
    reservedAt: new Date("2026-08-10T00:00:00Z"),
    reservationTtlMs: 60_000,
  });
  const reclaimed = await value.reserveUsage({
    accountId: first.accountId,
    metric: "transaction_signed",
    idempotencyKey: "ceremony-stale",
    occurredAt: new Date("2026-08-10T00:02:00Z"),
    reservedAt: new Date("2026-08-10T00:02:00Z"),
    reservationTtlMs: 60_000,
  });
  assert.equal(reclaimed.created, true);
  assert.notEqual(reclaimed.id, first.id);
  assert.equal((await value.usageSummary(first.accountId)).transactions, 0);
});

test("an existing wallet is metered once again after a billing-period rollover", async () => {
  const value = await store();
  const accountId = "00000000-0000-4000-8000-000000000011";
  const wallet = "opaque-wallet";
  const august = await value.reserveUsage({
    accountId,
    metric: "active_wallet",
    idempotencyKey: `2026-08-01T00:00:00.000Z:${wallet}`,
    walletKey: wallet,
    occurredAt: new Date("2026-08-10T00:00:00Z"),
  });
  await value.commitUsage(august.id);
  await value.updateAccountBilling(accountId, {
    billingPeriodStart: new Date("2026-09-01T00:00:00Z"),
    billingPeriodEnd: new Date("2026-10-01T00:00:00Z"),
  });
  const september = await value.reserveUsage({
    accountId,
    metric: "active_wallet",
    idempotencyKey: `2026-09-01T00:00:00.000Z:${wallet}`,
    walletKey: wallet,
    occurredAt: new Date("2026-09-02T00:00:00Z"),
  });
  await value.commitUsage(september.id);
  assert.equal(september.created, true);
  assert.equal((await value.usageSummary(accountId)).activeWallets, 1);
  assert.equal((await value.adminSummary()).activeWallets, 1);
});

test("inactive accounts produce an explicit payment-required state", async () => {
  const value = await store();
  await value.updateAccountBilling("00000000-0000-4000-8000-000000000011", {
    status: "past_due",
  });
  await assert.rejects(
    value.reserveUsage({
      accountId: "00000000-0000-4000-8000-000000000011",
      metric: "transaction_signed",
      idempotencyKey: "ceremony",
    }),
    (error: unknown) =>
      error instanceof BillingStateError && error.kind === "payment_required",
  );
});

test("an expired local billing period fails closed until Stripe refreshes it", async () => {
  const value = await store();
  const accountId = "00000000-0000-4000-8000-000000000011";
  await value.updateAccountBilling(accountId, {
    billingPeriodStart: new Date("2026-07-01T00:00:00Z"),
    billingPeriodEnd: new Date("2026-08-01T00:00:00Z"),
  });
  await assert.rejects(
    value.reserveUsage({
      accountId,
      metric: "transaction_signed",
      idempotencyKey: "outside-current-period",
      occurredAt: new Date("2026-08-10T00:00:00Z"),
    }),
    (error: unknown) =>
      error instanceof BillingStateError && error.kind === "payment_required",
  );
});

test("webhook claims are atomic and retryable after release", async () => {
  const value = await store();
  assert.equal(
    await value.claimWebhookEvent("evt_1", "test", new Date()),
    "claimed",
  );
  assert.equal(
    await value.claimWebhookEvent("evt_1", "test", new Date()),
    "busy",
  );
  await value.releaseWebhookEvent("evt_1");
  assert.equal(
    await value.claimWebhookEvent("evt_1", "test", new Date()),
    "claimed",
  );
  await value.completeWebhookEvent("evt_1", new Date());
  assert.equal(
    await value.claimWebhookEvent("evt_1", "test", new Date()),
    "processed",
  );
});

test("Metronome mapping attestation atomically binds customer aliases, plan, and rate card", async () => {
  const value = await store();
  const accountId = "00000000-0000-4000-8000-000000000011";
  await value.updateAccountBilling(accountId, {
    stripeCustomerId: "cus_one",
    stripeSubscriptionId: "sub_one",
  });
  assert.equal(
    await value.markMetronomeStripeMappingVerified(
      accountId,
      { ...mapping("cus_one"), metronomeCustomerId: "stale-alias" },
      new Date("2026-08-10T00:00:00Z"),
    ),
    false,
  );
  assert.equal(
    await value.markMetronomeStripeMappingVerified(
      accountId,
      mapping("cus_one"),
      new Date("2026-08-10T00:00:00Z"),
    ),
    true,
  );
  assert.equal(
    (await value.getAccount(accountId))?.metronomeVerifiedStripeCustomerId,
    "cus_one",
  );
  assert.equal(
    (await value.getAccount(accountId))?.metronomeVerifiedCustomerId,
    "customer-test",
  );
  await value.updateAccountBilling(accountId, { stripeCustomerId: "cus_one" });
  assert.ok(
    (await value.getAccount(accountId))?.metronomeStripeMappingVerifiedAt,
  );
  await value.updateAccountBilling(accountId, { stripeCustomerId: "cus_two" });
  assert.equal(
    (await value.getAccount(accountId))?.metronomeStripeMappingVerifiedAt,
    undefined,
  );
  assert.equal(
    await value.markMetronomeStripeMappingVerified(
      accountId,
      mapping("cus_two"),
      new Date(),
    ),
    true,
  );
  await value.clearStripeSubscription(accountId, "sub_one");
  assert.equal(
    (await value.getAccount(accountId))?.metronomeStripeMappingVerifiedAt,
    undefined,
  );
  await value.updateAccountBilling(accountId, {
    stripeSubscriptionId: "sub_two",
  });
  assert.equal(
    await value.markMetronomeStripeMappingVerified(
      accountId,
      mapping("cus_two"),
      new Date(),
    ),
    true,
  );
  await value.putPlan({ ...plan, metronomeRateCardId: "metro_rate_replaced" });
  assert.equal(
    (await value.getAccount(accountId))?.metronomeStripeMappingVerifiedAt,
    undefined,
  );
});
