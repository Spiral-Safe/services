import { createHash } from "node:crypto";
import Stripe from "stripe";
import { MetronomeConfig, StripeBillingConfig } from "./config";
import { Account, BillingStore, Plan } from "./types";

export const STRIPE_API_VERSION = "2026-07-29.dahlia" as const;

function deterministicLetters(value: string, length: number): string {
  const digest = createHash("sha256").update(value).digest();
  return [...digest.subarray(0, length)]
    .map((byte) => String.fromCharCode(97 + (byte % 26)))
    .join("");
}

export class StripeBilling {
  readonly client: Stripe;

  constructor(
    private readonly config: StripeBillingConfig,
    client?: Stripe,
  ) {
    this.client =
      client ||
      new Stripe(config.apiKey, {
        apiVersion: STRIPE_API_VERSION,
        appInfo: { name: "Spiral Safe", version: "1.0.0" },
      });
  }

  async createCheckout(
    account: Account,
    plan: Plan,
  ): Promise<{ id: string; url: string }> {
    if (account.stripeSubscriptionId) {
      throw new Error(
        "the account already has a subscription; use the Customer Portal",
      );
    }
    if (!plan.stripePriceId || !plan.stripeProductId) {
      throw new Error(
        "the selected plan has no Stripe Product and Price mapping",
      );
    }
    const intent = `${account.id}:${this.config.checkoutIntentVersion}`;
    const integrationIdentifier = `spiral_safe_${deterministicLetters(intent, 8)}`;
    const session = await this.client.checkout.sessions.create(
      {
        mode: "subscription",
        ...(account.stripeCustomerId
          ? { customer: account.stripeCustomerId }
          : { customer_email: account.email }),
        client_reference_id: account.id,
        line_items: [{ price: plan.stripePriceId, quantity: 1 }],
        success_url: this.config.checkoutSuccessUrl,
        cancel_url: this.config.checkoutCancelUrl,
        integration_identifier: integrationIdentifier,
        metadata: {
          account_id: account.id,
          plan_id: plan.id,
          stripe_product_id: plan.stripeProductId,
        },
        subscription_data: {
          metadata: { account_id: account.id, plan_id: plan.id },
        },
      },
      {
        idempotencyKey: `checkout:${intent}`,
      },
    );
    if (!session.url)
      throw new Error("Stripe Checkout did not return a hosted URL");
    return { id: session.id, url: session.url };
  }

  async createPortal(account: Account): Promise<{ id: string; url: string }> {
    if (!account.stripeCustomerId)
      throw new Error("the account has no Stripe customer");
    const session = await this.client.billingPortal.sessions.create({
      customer: account.stripeCustomerId,
      return_url: this.config.portalReturnUrl,
    });
    return { id: session.id, url: session.url };
  }

  constructEvent(rawBody: Buffer, signature: string): Stripe.Event {
    return this.client.webhooks.constructEvent(
      rawBody,
      signature,
      this.config.webhookSecret,
    );
  }

  private async syncSubscription(
    subscriptionId: string,
    store: BillingStore,
    fallbackAccountId?: string | null,
  ): Promise<void> {
    const subscription =
      await this.client.subscriptions.retrieve(subscriptionId);
    const accountId = subscription.metadata.account_id || fallbackAccountId;
    if (!accountId) return;
    const account = await store.getAccount(accountId);
    if (!account) throw new Error("billing account not found");
    if (
      account.stripeSubscriptionId &&
      account.stripeSubscriptionId !== subscription.id
    ) {
      return;
    }
    const plans = await store.listPlans();
    const priceIds = subscription.items.data.map((item) => item.price.id);
    const mappedPlans = plans.filter(
      (plan) => !!plan.stripePriceId && priceIds.includes(plan.stripePriceId),
    );
    if (subscription.items.data.length !== 1 || mappedPlans.length !== 1) {
      throw new Error(
        "Stripe subscription must contain exactly one mapped base-plan Price",
      );
    }
    const currentPlan = mappedPlans[0];
    const periods = subscription.items.data.map((item) => ({
      start: item.current_period_start,
      end: item.current_period_end,
    }));
    if (
      periods.length === 0 ||
      periods.some(
        ({ start, end }) =>
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          end <= start,
      )
    ) {
      throw new Error("Stripe subscription has invalid item billing periods");
    }
    const periodStart = Math.min(...periods.map(({ start }) => start));
    const periodEnd = Math.max(...periods.map(({ end }) => end));
    const status = ["active", "trialing"].includes(subscription.status)
      ? "active"
      : ["past_due", "unpaid", "incomplete"].includes(subscription.status)
        ? "past_due"
        : "suspended";
    await store.updateAccountBilling(accountId, {
      status,
      stripeCustomerId:
        typeof subscription.customer === "string"
          ? subscription.customer
          : subscription.customer.id,
      stripeSubscriptionId: subscription.id,
      planId: currentPlan.id,
      billingPeriodStart: new Date(periodStart * 1_000),
      billingPeriodEnd: new Date(periodEnd * 1_000),
    });
    if (["canceled", "incomplete_expired"].includes(subscription.status)) {
      await store.clearStripeSubscription(accountId, subscription.id);
    }
  }

  async processEvent(
    event: Stripe.Event,
    store: BillingStore,
  ): Promise<boolean> {
    const claim = await store.claimWebhookEvent(
      event.id,
      event.type,
      new Date(),
    );
    if (claim === "processed") return false;
    if (claim === "busy")
      throw new Error("Stripe webhook event is already being processed");
    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          const accountId =
            session.metadata?.account_id || session.client_reference_id;
          const subscriptionId =
            typeof session.subscription === "string"
              ? session.subscription
              : session.subscription?.id;
          if (subscriptionId) {
            await this.syncSubscription(subscriptionId, store, accountId);
          } else {
            throw new Error(
              "Stripe subscription Checkout completed without a subscription",
            );
          }
          break;
        }
        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.deleted": {
          const eventSubscription = event.data.object as Stripe.Subscription;
          await this.syncSubscription(
            eventSubscription.id,
            store,
            eventSubscription.metadata.account_id,
          );
          break;
        }
        default:
          break;
      }
      await store.completeWebhookEvent(event.id, new Date());
      return true;
    } catch (error) {
      await store.releaseWebhookEvent(event.id);
      throw error;
    }
  }
}

export class MetronomeExporter {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: MetronomeConfig,
    private readonly store: BillingStore,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly reportBackgroundError: () => void = () => {
      console.error(
        JSON.stringify({
          level: "error",
          message: "Metronome usage export failed; retry will continue",
        }),
      );
    },
  ) {}

  private runScheduled(): void {
    void this.runOnce().catch(() => {
      try {
        this.reportBackgroundError();
      } catch {
        // Reporting must not turn a contained task error into an unhandled
        // rejection.
      }
    });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.runScheduled(), this.config.intervalMs);
    this.timer.unref();
    this.runScheduled();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const records = await this.store.claimOutbox(
        this.config.batchSize,
        this.now(),
      );
      if (records.length === 0) return 0;
      const ids = records.map((record) => record.id);
      try {
        const response = await this.fetchImplementation(this.config.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(
            records.map((record) => ({
              transaction_id: record.transactionId,
              customer_id: record.customerId,
              event_type: record.eventType,
              timestamp: record.timestamp.toISOString(),
              properties: Object.fromEntries(
                Object.entries(record.properties).map(([key, value]) => [
                  key,
                  String(value),
                ]),
              ),
            })),
          ),
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) {
          await this.store.completeOutbox(ids);
          return records.length;
        }
        const code = `metronome_http_${response.status}`;
        if (response.status === 429 || response.status >= 500) {
          const attempt = Math.max(...records.map((record) => record.attempts));
          const backoff = Math.min(
            300_000,
            1_000 * 2 ** Math.min(attempt - 1, 8),
          );
          await this.store.retryOutbox(
            ids,
            new Date(this.now().getTime() + backoff),
            code,
          );
          return 0;
        }
        await this.store.deadLetterOutbox(ids, code);
        return 0;
      } catch {
        const attempt = Math.max(...records.map((record) => record.attempts));
        const backoff = Math.min(
          300_000,
          1_000 * 2 ** Math.min(attempt - 1, 8),
        );
        await this.store.retryOutbox(
          ids,
          new Date(this.now().getTime() + backoff),
          "metronome_network_error",
        );
        return 0;
      }
    } finally {
      this.running = false;
    }
  }
}
