import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PostgresBillingStore } from "./postgres-store";
import { hashPassword, hashSecret, issueAPIKey } from "./security";

const databaseURL = process.env.TEST_DATABASE_URL;

test(
  "PostgreSQL migration supports account, key, usage, outbox, and mapping flows",
  { skip: databaseURL ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const store = new PostgresBillingStore(databaseURL!, false);
    const accountId = randomUUID();
    const developerId = randomUUID();
    const webhookEventId = `evt_${randomUUID()}`;
    const planId = `integration_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const tenant = `integration-${randomUUID().slice(0, 12)}`;
    const email = `${tenant}@example.test`;
    try {
      await store.initialize();
      await store.putPlan({
        id: planId,
        name: "PostgreSQL integration fixture",
        activeWalletLimit: 2,
        transactionLimit: 3,
        walletUnitAmount: 5,
        transactionUnitAmount: 2,
        stripeProductId: `prod_${planId}`,
        stripePriceId: `price_${planId}`,
        metronomeProductId: `metro_product_${planId}`,
        metronomeRateCardId: `metro_rate_${planId}`,
        demo: true,
      });
      const now = new Date();
      await store.createAccountWithDeveloper(
        {
          id: accountId,
          tenant,
          name: "PostgreSQL integration account",
          email,
          status: "active",
          planId,
          stripeCustomerId: `cus_${accountId}`,
          metronomeCustomerId: `metro_${accountId}`,
          billingPeriodStart: new Date(now.getTime() - 60_000),
          billingPeriodEnd: new Date(now.getTime() + 60_000),
          createdAt: now,
          updatedAt: now,
        },
        {
          id: developerId,
          accountId,
          email,
          role: "developer",
          passwordHash: await hashPassword("postgres-integration-password"),
          createdAt: now,
        },
      );

      const pepper = "postgres-integration-pepper-000000000000";
      const issued = await issueAPIKey(store, pepper, {
        accountId,
        name: "Integration key",
        scopes: ["wallets:read", "signatures:create"],
        users: ["integration-user"],
        live: false,
      });
      const principal = await store.findAPIKeyByHash(
        hashSecret(issued.secret, pepper),
      );
      assert.equal(principal?.tenant, tenant);

      assert.equal(
        await store.markMetronomeStripeMappingVerified(
          accountId,
          {
            stripeCustomerId: `cus_${accountId}`,
            metronomeCustomerId: "stale-metronome-alias",
            planId,
            metronomeRateCardId: `metro_rate_${planId}`,
          },
          now,
        ),
        false,
      );
      assert.equal(
        await store.markMetronomeStripeMappingVerified(
          accountId,
          {
            stripeCustomerId: `cus_${accountId}`,
            metronomeCustomerId: `metro_${accountId}`,
            planId,
            metronomeRateCardId: `metro_rate_${planId}`,
          },
          now,
        ),
        true,
      );
      assert.equal(
        (await store.getAccount(accountId))?.metronomeVerifiedCustomerId,
        `metro_${accountId}`,
      );
      assert.equal(
        (await store.findAPIKeyByHash(hashSecret(issued.secret, pepper)))
          ?.metronomeStripeMappingVerified,
        true,
      );

      const reservation = await store.reserveUsage({
        accountId,
        metric: "transaction_signed",
        idempotencyKey: `ceremony-${randomUUID()}`,
        properties: { chain: "ethereum" },
      });
      await store.commitUsage(reservation.id);
      assert.equal((await store.usageSummary(accountId)).transactions, 1);
      const outbox = await store.claimOutbox(10, new Date());
      assert.equal(outbox.length, 1);
      assert.equal(outbox[0].customerId, `metro_${accountId}`);
      await store.completeOutbox(outbox.map(({ id }) => id));

      assert.equal(
        await store.claimWebhookEvent(webhookEventId, "fixture", now),
        "claimed",
      );
      await store.completeWebhookEvent(webhookEventId, now);
      assert.equal(
        await store.claimWebhookEvent(webhookEventId, "fixture", now),
        "processed",
      );
      assert.equal(await store.ready(), true);
    } finally {
      await store.pool.query("DELETE FROM billing_accounts WHERE id=$1", [
        accountId,
      ]);
      await store.pool.query(
        "DELETE FROM billing_stripe_webhook_events WHERE event_id=$1",
        [webhookEventId],
      );
      await store.pool.query("DELETE FROM billing_plans WHERE id=$1", [planId]);
      await store.close();
    }
  },
);
