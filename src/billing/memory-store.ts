import { randomUUID } from "node:crypto";
import {
  Account,
  AdminSummary,
  APIKeyRecord,
  AuthenticatedAPIKey,
  BillingStateError,
  BillingStore,
  ConsoleSession,
  ConsoleUser,
  MetronomeStripeMapping,
  OutboxRecord,
  Plan,
  UsageReservation,
  UsageReservationInput,
  UsageSummary,
} from "./types";

interface StoredUsage extends UsageReservation {
  walletKey?: string;
  occurredAt: Date;
  reservedAt: Date;
  properties: Record<string, string>;
}

interface StoredOutbox extends OutboxRecord {
  state: "pending" | "delivered" | "dead";
  nextAttemptAt: Date;
  errorCode?: string;
}

function cloneDate(value: Date): Date {
  return new Date(value.getTime());
}

function cloneAccount(account: Account): Account {
  return {
    ...account,
    billingPeriodStart: cloneDate(account.billingPeriodStart),
    billingPeriodEnd: cloneDate(account.billingPeriodEnd),
    metronomeStripeMappingVerifiedAt:
      account.metronomeStripeMappingVerifiedAt &&
      cloneDate(account.metronomeStripeMappingVerifiedAt),
    createdAt: cloneDate(account.createdAt),
    updatedAt: cloneDate(account.updatedAt),
  };
}

function cloneKey(key: APIKeyRecord): APIKeyRecord {
  return {
    ...key,
    scopes: [...key.scopes],
    users: [...key.users],
    createdAt: cloneDate(key.createdAt),
    lastUsedAt: key.lastUsedAt && cloneDate(key.lastUsedAt),
    revokedAt: key.revokedAt && cloneDate(key.revokedAt),
  };
}

function clearMetronomeMapping(account: Account): void {
  account.metronomeStripeMappingVerifiedAt = undefined;
  account.metronomeVerifiedStripeCustomerId = undefined;
  account.metronomeVerifiedCustomerId = undefined;
  account.metronomeVerifiedPlanId = undefined;
  account.metronomeVerifiedRateCardId = undefined;
}

export class MemoryBillingStore implements BillingStore {
  private readonly plans = new Map<string, Plan>();
  private readonly accounts = new Map<string, Account>();
  private readonly accountByTenant = new Map<string, string>();
  private readonly apiKeys = new Map<string, APIKeyRecord>();
  private readonly apiKeyByHash = new Map<string, string>();
  private readonly users = new Map<string, ConsoleUser>();
  private readonly userByEmail = new Map<string, string>();
  private readonly sessions = new Map<string, ConsoleSession>();
  private readonly usage = new Map<string, StoredUsage>();
  private readonly usageByIdempotency = new Map<string, string>();
  private readonly outbox = new Map<string, StoredOutbox>();
  private readonly webhookEvents = new Map<
    string,
    { state: "processing" | "processed"; claimedAt: Date }
  >();

  async initialize(): Promise<void> {}
  async ready(): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}

  async putPlan(plan: Plan): Promise<void> {
    this.plans.set(plan.id, { ...plan });
    for (const account of this.accounts.values()) {
      if (
        account.planId === plan.id &&
        account.metronomeStripeMappingVerifiedAt &&
        account.metronomeVerifiedRateCardId !== plan.metronomeRateCardId
      ) {
        clearMetronomeMapping(account);
      }
    }
  }

  async listPlans(): Promise<Plan[]> {
    return [...this.plans.values()].map((plan) => ({ ...plan }));
  }

  async putAccount(account: Account): Promise<void> {
    const existing = this.accountByTenant.get(account.tenant);
    if (existing && existing !== account.id) {
      throw new Error("tenant is already assigned to another billing account");
    }
    if (!this.plans.has(account.planId))
      throw new Error("billing plan not found");
    this.accounts.set(account.id, cloneAccount(account));
    this.accountByTenant.set(account.tenant, account.id);
  }

  async createAccountWithDeveloper(
    account: Account,
    user: ConsoleUser,
  ): Promise<void> {
    const normalized = user.email.trim().toLowerCase();
    if (
      user.role !== "developer" ||
      user.accountId !== account.id ||
      this.accountByTenant.has(account.tenant) ||
      this.userByEmail.has(normalized) ||
      !this.plans.has(account.planId)
    ) {
      throw new Error("account or developer conflicts with existing data");
    }
    this.accounts.set(account.id, cloneAccount(account));
    this.accountByTenant.set(account.tenant, account.id);
    this.users.set(user.id, { ...user, email: normalized });
    this.userByEmail.set(normalized, user.id);
  }

  async getAccount(accountId: string): Promise<Account | undefined> {
    const account = this.accounts.get(accountId);
    return account && cloneAccount(account);
  }

  async findAccountByTenant(tenant: string): Promise<Account | undefined> {
    const id = this.accountByTenant.get(tenant);
    return id ? this.getAccount(id) : undefined;
  }

  async listAccounts(): Promise<Account[]> {
    return [...this.accounts.values()].map(cloneAccount);
  }

  async updateAccountBilling(
    accountId: string,
    update: Partial<
      Pick<
        Account,
        | "status"
        | "planId"
        | "stripeCustomerId"
        | "stripeSubscriptionId"
        | "billingPeriodStart"
        | "billingPeriodEnd"
      >
    >,
  ): Promise<void> {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error("billing account not found");
    if (update.planId && !this.plans.has(update.planId)) {
      throw new Error("billing plan not found");
    }
    Object.assign(account, update, { updatedAt: new Date() });
    const plan = this.plans.get(account.planId);
    if (
      account.metronomeStripeMappingVerifiedAt &&
      (account.metronomeVerifiedStripeCustomerId !== account.stripeCustomerId ||
        account.metronomeVerifiedCustomerId !== account.metronomeCustomerId ||
        account.metronomeVerifiedPlanId !== account.planId ||
        account.metronomeVerifiedRateCardId !== plan?.metronomeRateCardId)
    ) {
      clearMetronomeMapping(account);
    }
  }

  async markMetronomeStripeMappingVerified(
    accountId: string,
    expected: MetronomeStripeMapping,
    verifiedAt: Date,
  ): Promise<boolean> {
    const account = this.accounts.get(accountId);
    const plan = account && this.plans.get(account.planId);
    if (
      !account?.stripeCustomerId ||
      !plan?.metronomeRateCardId ||
      account.stripeCustomerId !== expected.stripeCustomerId ||
      account.metronomeCustomerId !== expected.metronomeCustomerId ||
      account.planId !== expected.planId ||
      plan.metronomeRateCardId !== expected.metronomeRateCardId
    ) {
      return false;
    }
    account.metronomeStripeMappingVerifiedAt = cloneDate(verifiedAt);
    account.metronomeVerifiedStripeCustomerId = expected.stripeCustomerId;
    account.metronomeVerifiedCustomerId = expected.metronomeCustomerId;
    account.metronomeVerifiedPlanId = expected.planId;
    account.metronomeVerifiedRateCardId = expected.metronomeRateCardId;
    account.updatedAt = new Date();
    return true;
  }

  async clearStripeSubscription(
    accountId: string,
    expectedSubscriptionId: string,
  ): Promise<void> {
    const account = this.accounts.get(accountId);
    if (account?.stripeSubscriptionId === expectedSubscriptionId) {
      account.stripeSubscriptionId = undefined;
      clearMetronomeMapping(account);
      account.updatedAt = new Date();
    }
  }

  async createAPIKey(record: APIKeyRecord): Promise<void> {
    if (!this.accounts.has(record.accountId))
      throw new Error("billing account not found");
    if (this.apiKeyByHash.has(record.secretHash))
      throw new Error("API key hash already exists");
    this.apiKeys.set(record.id, cloneKey(record));
    this.apiKeyByHash.set(record.secretHash, record.id);
  }

  async findAPIKeyByHash(
    secretHash: string,
  ): Promise<AuthenticatedAPIKey | undefined> {
    const id = this.apiKeyByHash.get(secretHash);
    const key = id && this.apiKeys.get(id);
    if (!key || key.revokedAt) return undefined;
    const account = this.accounts.get(key.accountId);
    if (!account) return undefined;
    return {
      apiKeyId: key.id,
      accountId: account.id,
      tenant: account.tenant,
      accountStatus: account.status,
      prefix: key.prefix,
      lastUsedAt: key.lastUsedAt && cloneDate(key.lastUsedAt),
      metronomeStripeMappingVerified: !!(
        account.metronomeStripeMappingVerifiedAt &&
        account.metronomeVerifiedStripeCustomerId ===
          account.stripeCustomerId &&
        account.metronomeVerifiedCustomerId === account.metronomeCustomerId &&
        account.metronomeVerifiedPlanId === account.planId &&
        account.metronomeVerifiedRateCardId ===
          this.plans.get(account.planId)?.metronomeRateCardId
      ),
      scopes: new Set(key.scopes),
      users: new Set(key.users),
    };
  }

  async touchAPIKey(id: string, usedAt: Date): Promise<void> {
    const key = this.apiKeys.get(id);
    if (key && !key.revokedAt) key.lastUsedAt = cloneDate(usedAt);
  }

  async listAPIKeys(accountId: string): Promise<APIKeyRecord[]> {
    return [...this.apiKeys.values()]
      .filter((key) => key.accountId === accountId)
      .map(cloneKey)
      .sort(
        (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
      );
  }

  async revokeAPIKey(
    accountId: string,
    id: string,
    revokedAt: Date,
  ): Promise<boolean> {
    const key = this.apiKeys.get(id);
    if (!key || key.accountId !== accountId || key.revokedAt) return false;
    key.revokedAt = cloneDate(revokedAt);
    return true;
  }

  async putConsoleUser(user: ConsoleUser): Promise<void> {
    const normalized = user.email.trim().toLowerCase();
    const existing = this.userByEmail.get(normalized);
    if (existing && existing !== user.id)
      throw new Error("console email already exists");
    this.users.set(user.id, { ...user, email: normalized });
    this.userByEmail.set(normalized, user.id);
  }

  async findConsoleUserByEmail(
    email: string,
  ): Promise<ConsoleUser | undefined> {
    const id = this.userByEmail.get(email.trim().toLowerCase());
    const user = id && this.users.get(id);
    return user ? { ...user } : undefined;
  }

  async createSession(session: ConsoleSession): Promise<void> {
    this.sessions.set(session.tokenHash, { ...session });
  }

  async findSessionByHash(
    tokenHash: string,
  ): Promise<{ session: ConsoleSession; user: ConsoleUser } | undefined> {
    const session = this.sessions.get(tokenHash);
    if (!session || session.expiresAt <= new Date()) {
      if (session) this.sessions.delete(tokenHash);
      return undefined;
    }
    const user = this.users.get(session.userId);
    if (!user || user.disabledAt) return undefined;
    return { session: { ...session }, user: { ...user } };
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
  }

  async reserveUsage(input: UsageReservationInput): Promise<UsageReservation> {
    const account = this.accounts.get(input.accountId);
    if (!account) throw new Error("billing account not found");
    const plan = this.plans.get(account.planId);
    if (!plan) throw new Error("billing plan not found");
    if (account.status !== "active")
      throw new BillingStateError("payment_required", 0, null);

    const occurredAt = input.occurredAt || new Date();
    if (
      occurredAt < account.billingPeriodStart ||
      occurredAt >= account.billingPeriodEnd
    ) {
      throw new BillingStateError("payment_required", 0, null);
    }
    const reservedAt = input.reservedAt || new Date();
    const reservationTtlMs = input.reservationTtlMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(reservationTtlMs) || reservationTtlMs <= 0) {
      throw new Error("usage reservation TTL is invalid");
    }
    for (const [id, item] of this.usage) {
      if (
        item.status === "reserved" &&
        item.reservedAt.getTime() <= reservedAt.getTime() - reservationTtlMs
      ) {
        this.usage.delete(id);
        this.usageByIdempotency.delete(
          `${item.accountId}:${item.metric}:${item.idempotencyKey}`,
        );
      }
    }

    const uniqueness = `${account.id}:${input.metric}:${input.idempotencyKey}`;
    const existingId = this.usageByIdempotency.get(uniqueness);
    if (existingId) {
      const existing = this.usage.get(existingId)!;
      return { ...existing, created: false };
    }

    const quantity = input.quantity || 1;
    if (!Number.isSafeInteger(quantity) || quantity < 1)
      throw new Error("usage quantity is invalid");
    const used = [...this.usage.values()]
      .filter(
        (item) =>
          item.accountId === account.id &&
          item.metric === input.metric &&
          item.occurredAt >= account.billingPeriodStart &&
          item.occurredAt < account.billingPeriodEnd,
      )
      .reduce((total, item) => total + item.quantity, 0);
    const limit =
      input.metric === "active_wallet"
        ? plan.activeWalletLimit
        : plan.transactionLimit;
    if (limit !== null && used + quantity > limit) {
      throw new BillingStateError("quota_exceeded", used, limit);
    }

    const id = randomUUID();
    const reservation: StoredUsage = {
      id,
      accountId: account.id,
      metric: input.metric,
      idempotencyKey: input.idempotencyKey,
      quantity,
      created: true,
      status: "reserved",
      used: used + quantity,
      limit,
      walletKey: input.walletKey,
      occurredAt,
      reservedAt,
      properties: { ...(input.properties || {}) },
    };
    this.usage.set(id, reservation);
    this.usageByIdempotency.set(uniqueness, id);
    return { ...reservation };
  }

  async commitUsage(reservationId: string): Promise<void> {
    const usage = this.usage.get(reservationId);
    if (!usage || usage.status === "committed") return;
    usage.status = "committed";
    const account = this.accounts.get(usage.accountId)!;
    const plan = this.plans.get(account.planId)!;
    const id = `usage:${usage.id}`;
    this.outbox.set(id, {
      id,
      accountId: usage.accountId,
      transactionId: usage.id,
      customerId:
        account.metronomeVerifiedCustomerId || account.metronomeCustomerId,
      eventType:
        usage.metric === "active_wallet"
          ? "spiral_active_wallet"
          : "spiral_transaction_signed",
      timestamp: usage.occurredAt,
      properties: {
        quantity: String(usage.quantity),
        metric: usage.metric,
        ...(usage.walletKey ? { wallet_key: usage.walletKey } : {}),
        ...(plan.metronomeProductId
          ? { metronome_product_id: plan.metronomeProductId }
          : {}),
        ...(plan.metronomeRateCardId
          ? { metronome_rate_card_id: plan.metronomeRateCardId }
          : {}),
        ...usage.properties,
      },
      attempts: 0,
      state: "pending",
      nextAttemptAt: new Date(0),
    });
  }

  async cancelUsage(reservationId: string): Promise<void> {
    const usage = this.usage.get(reservationId);
    if (!usage || usage.status !== "reserved") return;
    this.usage.delete(reservationId);
    this.usageByIdempotency.delete(
      `${usage.accountId}:${usage.metric}:${usage.idempotencyKey}`,
    );
  }

  async usageSummary(accountId: string): Promise<UsageSummary> {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error("billing account not found");
    const plan = this.plans.get(account.planId)!;
    const committed = [...this.usage.values()].filter(
      (item) =>
        item.accountId === accountId &&
        item.status === "committed" &&
        item.occurredAt >= account.billingPeriodStart &&
        item.occurredAt < account.billingPeriodEnd,
    );
    const activeWallets = committed
      .filter((item) => item.metric === "active_wallet")
      .reduce((sum, item) => sum + item.quantity, 0);
    const transactions = committed
      .filter((item) => item.metric === "transaction_signed")
      .reduce((sum, item) => sum + item.quantity, 0);
    const byDay = new Map<
      string,
      { activeWallets: number; transactions: number }
    >();
    for (const item of committed) {
      const day = item.occurredAt.toISOString().slice(0, 10);
      const totals = byDay.get(day) || { activeWallets: 0, transactions: 0 };
      if (item.metric === "active_wallet")
        totals.activeWallets += item.quantity;
      else totals.transactions += item.quantity;
      byDay.set(day, totals);
    }
    const estimatedPeriodAmount =
      plan.walletUnitAmount === null || plan.transactionUnitAmount === null
        ? null
        : activeWallets * plan.walletUnitAmount +
          transactions * plan.transactionUnitAmount;
    return {
      accountId,
      periodStart: cloneDate(account.billingPeriodStart),
      periodEnd: cloneDate(account.billingPeriodEnd),
      activeWallets,
      transactions,
      activeWalletLimit: plan.activeWalletLimit,
      transactionLimit: plan.transactionLimit,
      planId: plan.id,
      planName: plan.name,
      walletUnitAmount: plan.walletUnitAmount,
      transactionUnitAmount: plan.transactionUnitAmount,
      estimatedPeriodAmount,
      daily: [...byDay.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, totals]) => ({ date, ...totals })),
    };
  }

  async adminSummary(): Promise<AdminSummary> {
    const committed = [...this.usage.values()].filter(
      (item) => item.status === "committed",
    );
    const currentCommitted = committed.filter((item) => {
      const account = this.accounts.get(item.accountId);
      return (
        account !== undefined &&
        item.occurredAt >= account.billingPeriodStart &&
        item.occurredAt < account.billingPeriodEnd
      );
    });
    let estimatedCurrentPeriodAmount: number | null = 0;
    for (const account of this.accounts.values()) {
      const plan = this.plans.get(account.planId);
      if (
        !plan ||
        plan.walletUnitAmount === null ||
        plan.transactionUnitAmount === null
      ) {
        estimatedCurrentPeriodAmount = null;
        break;
      }
      for (const item of committed) {
        if (
          item.accountId === account.id &&
          item.occurredAt >= account.billingPeriodStart &&
          item.occurredAt < account.billingPeriodEnd
        ) {
          estimatedCurrentPeriodAmount! +=
            item.quantity *
            (item.metric === "active_wallet"
              ? plan.walletUnitAmount
              : plan.transactionUnitAmount);
        }
      }
    }
    return {
      accounts: this.accounts.size,
      activeAccounts: [...this.accounts.values()].filter(
        (account) => account.status === "active",
      ).length,
      activeWallets: currentCommitted
        .filter((item) => item.metric === "active_wallet")
        .reduce((sum, item) => sum + item.quantity, 0),
      transactions: currentCommitted
        .filter((item) => item.metric === "transaction_signed")
        .reduce((sum, item) => sum + item.quantity, 0),
      pendingOutbox: [...this.outbox.values()].filter(
        (item) => item.state === "pending",
      ).length,
      deadLetterOutbox: [...this.outbox.values()].filter(
        (item) => item.state === "dead",
      ).length,
      estimatedCurrentPeriodAmount,
    };
  }

  async claimOutbox(limit: number, now: Date): Promise<OutboxRecord[]> {
    const claimed = [...this.outbox.values()]
      .filter((item) => item.state === "pending" && item.nextAttemptAt <= now)
      .slice(0, Math.max(0, Math.min(limit, 100)));
    for (const item of claimed) {
      item.attempts += 1;
      item.nextAttemptAt = new Date(now.getTime() + 60_000);
    }
    return claimed.map(
      ({
        state: _state,
        nextAttemptAt: _next,
        errorCode: _error,
        ...item
      }) => ({
        ...item,
        properties: { ...item.properties },
      }),
    );
  }

  async completeOutbox(ids: string[]): Promise<void> {
    for (const id of ids) {
      const item = this.outbox.get(id);
      if (item) item.state = "delivered";
    }
  }

  async retryOutbox(
    ids: string[],
    nextAttemptAt: Date,
    errorCode: string,
  ): Promise<void> {
    for (const id of ids) {
      const item = this.outbox.get(id);
      if (item && item.state === "pending") {
        item.nextAttemptAt = cloneDate(nextAttemptAt);
        item.errorCode = errorCode.slice(0, 128);
      }
    }
  }

  async deadLetterOutbox(ids: string[], errorCode: string): Promise<void> {
    for (const id of ids) {
      const item = this.outbox.get(id);
      if (item) {
        item.state = "dead";
        item.errorCode = errorCode.slice(0, 128);
      }
    }
  }

  async claimWebhookEvent(
    eventId: string,
    _eventType: string,
    receivedAt: Date,
  ): Promise<"claimed" | "processed" | "busy"> {
    const record = this.webhookEvents.get(eventId);
    if (record?.state === "processed") return "processed";
    if (
      record?.state === "processing" &&
      record.claimedAt.getTime() > receivedAt.getTime() - 5 * 60_000
    ) {
      return "busy";
    }
    this.webhookEvents.set(eventId, {
      state: "processing",
      claimedAt: cloneDate(receivedAt),
    });
    return "claimed";
  }

  async completeWebhookEvent(
    eventId: string,
    processedAt: Date,
  ): Promise<void> {
    this.webhookEvents.set(eventId, {
      state: "processed",
      claimedAt: cloneDate(processedAt),
    });
  }

  async releaseWebhookEvent(eventId: string): Promise<void> {
    if (this.webhookEvents.get(eventId)?.state === "processing")
      this.webhookEvents.delete(eventId);
  }
}
