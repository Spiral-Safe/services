import assert from "node:assert/strict";
import { test } from "node:test";
import Stripe from "stripe";
import { MetronomeExporter, StripeBilling } from "./integrations";
import { MemoryBillingStore } from "./memory-store";
import { Account, Plan } from "./types";

const plan: Plan = {
  id: "launch",
  name: "Launch",
  activeWalletLimit: 10,
  transactionLimit: 100,
  walletUnitAmount: 1,
  transactionUnitAmount: 1,
  stripeProductId: "prod_launch",
  stripePriceId: "price_launch",
  metronomeProductId: "metro_product_launch",
  metronomeRateCardId: "metro_rate_launch",
  demo: false,
};
const account: Account = {
  id: "00000000-0000-4000-8000-000000000031",
  tenant: "tenant-c",
  name: "Customer",
  email: "customer@example.test",
  status: "active",
  planId: plan.id,
  metronomeCustomerId: "customer-alias",
  billingPeriodStart: new Date("2026-08-01T00:00:00Z"),
  billingPeriodEnd: new Date("2026-09-01T00:00:00Z"),
  createdAt: new Date("2026-08-01T00:00:00Z"),
  updatedAt: new Date("2026-08-01T00:00:00Z"),
};

async function store() {
  const value = new MemoryBillingStore();
  await value.putPlan(plan);
  await value.putAccount(account);
  return value;
}

function mapping(stripeCustomerId: string, selectedPlan: Plan = plan) {
  return {
    stripeCustomerId,
    metronomeCustomerId: account.metronomeCustomerId,
    planId: selectedPlan.id,
    metronomeRateCardId: selectedPlan.metronomeRateCardId!,
  };
}

test("Checkout uses hosted subscriptions, a stable idempotency key, and no forced payment/tax fields", async () => {
  const requests: any[] = [];
  const optionSets: any[] = [];
  const fake = {
    checkout: {
      sessions: {
        async create(body: any, supplied: any) {
          requests.push(body);
          optionSets.push(supplied);
          return { id: "cs_test", url: "https://checkout.stripe.test/session" };
        },
      },
    },
    billingPortal: {
      sessions: {
        create: async () => ({ id: "bps", url: "https://billing.stripe.test" }),
      },
    },
    webhooks: {},
  } as unknown as Stripe;
  const billing = new StripeBilling(
    {
      apiKey: "rk_test_fixture",
      webhookSecret: "whsec_fixture",
      checkoutSuccessUrl: "https://console.example/success",
      checkoutCancelUrl: "https://console.example/cancel",
      portalReturnUrl: "https://console.example/developer",
      checkoutIntentVersion: "v1",
    },
    fake,
  );
  await billing.createCheckout(account, plan);
  await billing.createCheckout(account, plan);
  const request = requests[0];
  const options = optionSets[0];
  assert.equal(request.mode, "subscription");
  assert.equal(request.line_items[0].price, "price_launch");
  assert.match(request.integration_identifier, /^spiral_safe_[a-z]{8}$/);
  assert.equal("payment_method_types" in request, false);
  assert.equal("automatic_tax" in request, false);
  assert.equal(options.idempotencyKey, `checkout:${account.id}:v1`);
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(optionSets[1], optionSets[0]);
});

test("Checkout refuses to create a second base subscription", async () => {
  let called = false;
  const fake = {
    checkout: {
      sessions: {
        async create() {
          called = true;
          return { id: "unexpected", url: "https://checkout.stripe.test" };
        },
      },
    },
  } as unknown as Stripe;
  const billing = new StripeBilling(
    {
      apiKey: "rk_test_fixture",
      webhookSecret: "whsec_fixture",
      checkoutSuccessUrl: "https://console.example/success",
      checkoutCancelUrl: "https://console.example/cancel",
      portalReturnUrl: "https://console.example/developer",
      checkoutIntentVersion: "v1",
    },
    fake,
  );
  await assert.rejects(
    billing.createCheckout(
      { ...account, stripeSubscriptionId: "sub_existing" },
      plan,
    ),
    /Customer Portal/,
  );
  assert.equal(called, false);
});

test("Stripe event processing claims each event once", async () => {
  const value = await store();
  const billing = new StripeBilling(
    {
      apiKey: "rk_test_fixture",
      webhookSecret: "whsec_fixture",
      checkoutSuccessUrl: "https://console.example/success",
      checkoutCancelUrl: "https://console.example/cancel",
      portalReturnUrl: "https://console.example/developer",
      checkoutIntentVersion: "v1",
    },
    {} as Stripe,
  );
  const event = {
    id: "evt_test",
    type: "unknown.event",
    data: { object: {} },
  } as unknown as Stripe.Event;
  assert.equal(await billing.processEvent(event, value), true);
  assert.equal(await billing.processEvent(event, value), false);
});

test("Stripe webhooks retrieve current subscription state and use item period bounds", async () => {
  const value = await store();
  await value.updateAccountBilling(account.id, { status: "past_due" });
  const firstStart = Date.parse("2026-08-01T00:00:00Z") / 1_000;
  const secondEnd = Date.parse("2026-09-05T00:00:00Z") / 1_000;
  const current = {
    id: "sub_current",
    status: "active",
    customer: "cus_current",
    metadata: { account_id: account.id, plan_id: plan.id },
    items: {
      data: [
        {
          current_period_start: firstStart,
          current_period_end: secondEnd,
          price: { id: plan.stripePriceId },
        },
      ],
    },
  } as unknown as Stripe.Subscription;
  let retrieves = 0;
  const fake = {
    subscriptions: {
      async retrieve(id: string) {
        retrieves += 1;
        assert.equal(id, "sub_current");
        return current;
      },
    },
  } as unknown as Stripe;
  const billing = new StripeBilling(
    {
      apiKey: "rk_test_fixture",
      webhookSecret: "whsec_fixture",
      checkoutSuccessUrl: "https://console.example/success",
      checkoutCancelUrl: "https://console.example/cancel",
      portalReturnUrl: "https://console.example/developer",
      checkoutIntentVersion: "v1",
    },
    fake,
  );
  for (const id of ["evt_newer", "evt_older"]) {
    const staleEvent = {
      id,
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_current",
          status: "canceled",
          metadata: { account_id: account.id },
        },
      },
    } as unknown as Stripe.Event;
    assert.equal(await billing.processEvent(staleEvent, value), true);
  }
  const updated = await value.getAccount(account.id);
  assert.equal(retrieves, 2);
  assert.equal(updated?.status, "active");
  assert.equal(updated?.stripeCustomerId, "cus_current");
  assert.equal(
    updated?.billingPeriodStart.toISOString(),
    "2026-08-01T00:00:00.000Z",
  );
  assert.equal(
    updated?.billingPeriodEnd.toISOString(),
    "2026-09-05T00:00:00.000Z",
  );
});

test("a Portal price change selects the local plan by current Stripe Price", async () => {
  const value = await store();
  const upgradedPlan: Plan = {
    ...plan,
    id: "scale",
    name: "Scale",
    stripeProductId: "prod_scale",
    stripePriceId: "price_scale",
    metronomeProductId: "metro_product_scale",
    metronomeRateCardId: "metro_rate_scale",
  };
  await value.putPlan(upgradedPlan);
  await value.updateAccountBilling(account.id, {
    stripeCustomerId: "cus_before_portal",
    stripeSubscriptionId: "sub_portal",
  });
  await value.markMetronomeStripeMappingVerified(
    account.id,
    mapping("cus_before_portal"),
    new Date(),
  );
  const start = Date.parse("2026-08-01T00:00:00Z") / 1_000;
  const end = Date.parse("2026-09-01T00:00:00Z") / 1_000;
  const fake = {
    subscriptions: {
      async retrieve() {
        return {
          id: "sub_portal",
          status: "active",
          customer: "cus_portal",
          metadata: { account_id: account.id, plan_id: plan.id },
          items: {
            data: [
              {
                current_period_start: start,
                current_period_end: end,
                price: { id: upgradedPlan.stripePriceId },
              },
            ],
          },
        } as unknown as Stripe.Subscription;
      },
    },
  } as unknown as Stripe;
  const billing = new StripeBilling(
    {
      apiKey: "rk_test_fixture",
      webhookSecret: "whsec_fixture",
      checkoutSuccessUrl: "https://console.example/success",
      checkoutCancelUrl: "https://console.example/cancel",
      portalReturnUrl: "https://console.example/developer",
      checkoutIntentVersion: "v1",
    },
    fake,
  );
  await billing.processEvent(
    {
      id: "evt_portal_change",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_portal",
          metadata: { account_id: account.id, plan_id: plan.id },
        },
      },
    } as unknown as Stripe.Event,
    value,
  );
  const changed = await value.getAccount(account.id);
  assert.equal(changed?.planId, upgradedPlan.id);
  assert.equal(changed?.metronomeStripeMappingVerifiedAt, undefined);
});

test("an unmapped Stripe subscription Price fails closed and remains retryable", async () => {
  const value = await store();
  const start = Date.parse("2026-08-01T00:00:00Z") / 1_000;
  const end = Date.parse("2026-09-01T00:00:00Z") / 1_000;
  const fake = {
    subscriptions: {
      async retrieve() {
        return {
          id: "sub_unmapped",
          status: "active",
          customer: "cus_unmapped",
          metadata: { account_id: account.id },
          items: {
            data: [
              {
                current_period_start: start,
                current_period_end: end,
                price: { id: "price_not_configured" },
              },
            ],
          },
        } as unknown as Stripe.Subscription;
      },
    },
  } as unknown as Stripe;
  const billing = new StripeBilling(
    {
      apiKey: "rk_test_fixture",
      webhookSecret: "whsec_fixture",
      checkoutSuccessUrl: "https://console.example/success",
      checkoutCancelUrl: "https://console.example/cancel",
      portalReturnUrl: "https://console.example/developer",
      checkoutIntentVersion: "v1",
    },
    fake,
  );
  const event = {
    id: "evt_unmapped",
    type: "customer.subscription.updated",
    data: {
      object: { id: "sub_unmapped", metadata: { account_id: account.id } },
    },
  } as unknown as Stripe.Event;
  await assert.rejects(
    billing.processEvent(event, value),
    /exactly one mapped base-plan Price/,
  );
  assert.equal((await value.getAccount(account.id))?.planId, plan.id);
  assert.equal(
    await value.claimWebhookEvent(event.id, event.type, new Date()),
    "claimed",
  );
});

test("a terminal subscription is cleared so renewal can use Checkout safely", async () => {
  const value = await store();
  await value.updateAccountBilling(account.id, {
    stripeCustomerId: "cus_current",
    stripeSubscriptionId: "sub_canceled",
  });
  await value.markMetronomeStripeMappingVerified(
    account.id,
    mapping("cus_current"),
    new Date(),
  );
  const start = Date.parse("2026-08-01T00:00:00Z") / 1_000;
  const end = Date.parse("2026-09-01T00:00:00Z") / 1_000;
  let checkoutCalls = 0;
  const fake = {
    subscriptions: {
      async retrieve() {
        return {
          id: "sub_canceled",
          status: "canceled",
          customer: "cus_current",
          metadata: { account_id: account.id, plan_id: plan.id },
          items: {
            data: [
              {
                current_period_start: start,
                current_period_end: end,
                price: { id: plan.stripePriceId },
              },
            ],
          },
        } as unknown as Stripe.Subscription;
      },
    },
    checkout: {
      sessions: {
        async create() {
          checkoutCalls += 1;
          return { id: "cs_renew", url: "https://checkout.stripe.test/renew" };
        },
      },
    },
  } as unknown as Stripe;
  const billing = new StripeBilling(
    {
      apiKey: "rk_test_fixture",
      webhookSecret: "whsec_fixture",
      checkoutSuccessUrl: "https://console.example/success",
      checkoutCancelUrl: "https://console.example/cancel",
      portalReturnUrl: "https://console.example/developer",
      checkoutIntentVersion: "renewal-v1",
    },
    fake,
  );
  await billing.processEvent(
    {
      id: "evt_canceled",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_canceled",
          metadata: { account_id: account.id, plan_id: plan.id },
        },
      },
    } as unknown as Stripe.Event,
    value,
  );
  const canceled = await value.getAccount(account.id);
  assert.equal(canceled?.status, "suspended");
  assert.equal(canceled?.stripeSubscriptionId, undefined);
  assert.equal(canceled?.metronomeStripeMappingVerifiedAt, undefined);
  await billing.createCheckout(canceled!, plan);
  assert.equal(checkoutCalls, 1);
});

test("Metronome exporter sends string properties and completes durable outbox records", async () => {
  const value = await store();
  const usage = await value.reserveUsage({
    accountId: account.id,
    metric: "transaction_signed",
    idempotencyKey: "ceremony-test",
    occurredAt: new Date("2026-08-10T00:00:00Z"),
    properties: { chain: "solana" },
  });
  await value.commitUsage(usage.id);
  let body: any;
  const exporter = new MetronomeExporter(
    {
      apiToken: "token-not-logged",
      endpoint: "https://api.metronome.test/v1/ingest",
      intervalMs: 10_000,
      batchSize: 100,
      stripeInvoicingVerified: false,
    },
    value,
    (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response("", { status: 200 });
    }) as typeof fetch,
    () => new Date("2026-08-10T00:01:00Z"),
  );
  assert.equal(await exporter.runOnce(), 1);
  assert.equal(body.length, 1);
  assert.equal(body[0].event_type, "spiral_transaction_signed");
  assert.equal(body[0].customer_id, "customer-alias");
  assert.equal(body[0].properties.quantity, "1");
  assert.equal(body[0].properties.metronome_product_id, "metro_product_launch");
  assert.equal(body[0].properties.metronome_rate_card_id, "metro_rate_launch");
  assert.equal((await value.adminSummary()).pendingOutbox, 0);
});

test("Metronome non-retryable 4xx responses dead-letter instead of looping", async () => {
  const value = await store();
  const usage = await value.reserveUsage({
    accountId: account.id,
    metric: "transaction_signed",
    idempotencyKey: "ceremony-invalid",
    occurredAt: new Date("2026-08-10T00:00:00Z"),
  });
  await value.commitUsage(usage.id);
  const exporter = new MetronomeExporter(
    {
      apiToken: "token-not-logged",
      endpoint: "https://api.metronome.test/v1/ingest",
      intervalMs: 10_000,
      batchSize: 100,
      stripeInvoicingVerified: false,
    },
    value,
    (async () => new Response("", { status: 400 })) as typeof fetch,
    () => new Date("2026-08-10T00:01:00Z"),
  );
  assert.equal(await exporter.runOnce(), 0);
  assert.equal((await value.adminSummary()).deadLetterOutbox, 1);
});

test("scheduled Metronome store failures are contained and reported", async () => {
  const value = new MemoryBillingStore();
  value.claimOutbox = async () => {
    throw new Error("database fixture unavailable");
  };
  let reports = 0;
  const exporter = new MetronomeExporter(
    {
      apiToken: "fixture-token",
      endpoint: "https://api.metronome.com/v1/ingest",
      intervalMs: 60_000,
      batchSize: 100,
      stripeInvoicingVerified: true,
    },
    value,
    fetch,
    () => new Date(),
    () => {
      reports += 1;
    },
  );
  exporter.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  exporter.stop();
  assert.equal(reports, 1);
  await assert.rejects(
    () => exporter.runOnce(),
    /database fixture unavailable/,
  );
});
