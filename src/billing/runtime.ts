import { randomUUID } from "node:crypto";
import { BillingConfig } from "./config";
import { MetronomeExporter, StripeBilling } from "./integrations";
import { MemoryBillingStore } from "./memory-store";
import { PostgresBillingStore } from "./postgres-store";
import { hashPassword, hashSecret } from "./security";
import { Account, AuthenticatedAPIKey, BillingStore, Plan } from "./types";

export interface BillingRuntime {
  config: BillingConfig;
  store: BillingStore;
  stripe?: StripeBilling;
  exporter?: MetronomeExporter;
  authenticate(secret: string): Promise<AuthenticatedAPIKey | undefined>;
  close(): Promise<void>;
}

export function isMetronomeMappingCurrent(
  account: Account,
  plans: Plan[],
): boolean {
  const plan = plans.find((candidate) => candidate.id === account.planId);
  return !!(
    account.metronomeStripeMappingVerifiedAt &&
    account.stripeCustomerId &&
    plan?.metronomeRateCardId &&
    account.metronomeVerifiedStripeCustomerId === account.stripeCustomerId &&
    account.metronomeVerifiedCustomerId === account.metronomeCustomerId &&
    account.metronomeVerifiedPlanId === account.planId &&
    account.metronomeVerifiedRateCardId === plan.metronomeRateCardId
  );
}

function currentPeriod(now = new Date()): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

async function seedDemo(
  config: BillingConfig,
  store: BillingStore,
): Promise<void> {
  const now = new Date();
  const period = currentPeriod(now);
  const accountId = "00000000-0000-4000-8000-000000000001";
  await store.putAccount({
    id: accountId,
    tenant: "local",
    name: "Spiral Safe seeded demo",
    email: config.demoDeveloperEmail!,
    status: "active",
    planId: "sandbox",
    metronomeCustomerId: "spiral-demo-local",
    billingPeriodStart: period.start,
    billingPeriodEnd: period.end,
    createdAt: now,
    updatedAt: now,
  });
  await store.putConsoleUser({
    id: "00000000-0000-4000-8000-000000000002",
    accountId,
    email: config.demoDeveloperEmail!,
    role: "developer",
    passwordHash: await hashPassword(config.demoDeveloperPassword!),
    createdAt: now,
  });
  await store.putConsoleUser({
    id: "00000000-0000-4000-8000-000000000003",
    email: config.demoAdminEmail!,
    role: "admin",
    passwordHash: await hashPassword(config.demoAdminPassword!),
    createdAt: now,
  });
}

export async function createBillingRuntime(
  config: BillingConfig,
): Promise<BillingRuntime | undefined> {
  if (config.mode === "disabled") return undefined;
  const store: BillingStore =
    config.mode === "memory"
      ? new MemoryBillingStore()
      : new PostgresBillingStore(config.databaseUrl!, config.databaseSSL);
  await store.initialize();
  for (const plan of config.plans) await store.putPlan(plan);
  if (config.demoSeed) await seedDemo(config, store);
  const stripe = config.stripe && new StripeBilling(config.stripe);
  const exporter =
    config.metronome && new MetronomeExporter(config.metronome, store);
  if (exporter) exporter.start();
  const recentlyTouched = new Map<string, number>();
  return {
    config,
    store,
    stripe,
    exporter,
    async authenticate(secret: string) {
      const hash = hashSecret(secret, config.apiKeyPepper!);
      const principal = await store.findAPIKeyByHash(hash);
      if (principal) {
        const now = Date.now();
        const lastTouch = Math.max(
          principal.lastUsedAt?.getTime() || 0,
          recentlyTouched.get(principal.apiKeyId) || 0,
        );
        if (lastTouch < now - 5 * 60_000) {
          recentlyTouched.set(principal.apiKeyId, now);
          void store
            .touchAPIKey(principal.apiKeyId, new Date(now))
            .catch(() => {
              recentlyTouched.delete(principal.apiKeyId);
            });
        }
      }
      return principal;
    },
    async close() {
      exporter?.stop();
      await store.close();
    },
  };
}

export function newAccountId(): string {
  return randomUUID();
}
