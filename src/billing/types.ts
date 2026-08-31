export const API_SCOPES = [
  "wallets:read",
  "wallets:write",
  "signatures:create",
] as const;

export type APIScope = (typeof API_SCOPES)[number];
export type UsageMetric = "active_wallet" | "transaction_signed";
export type AccountStatus = "active" | "past_due" | "suspended";
export type ConsoleRole = "developer" | "admin";

export interface Plan {
  id: string;
  name: string;
  activeWalletLimit: number | null;
  transactionLimit: number | null;
  walletUnitAmount: number | null;
  transactionUnitAmount: number | null;
  stripeProductId?: string;
  stripePriceId?: string;
  metronomeProductId?: string;
  metronomeRateCardId?: string;
  demo: boolean;
}

export interface Account {
  id: string;
  tenant: string;
  name: string;
  email: string;
  status: AccountStatus;
  planId: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  metronomeCustomerId: string;
  metronomeStripeMappingVerifiedAt?: Date;
  metronomeVerifiedStripeCustomerId?: string;
  metronomeVerifiedCustomerId?: string;
  metronomeVerifiedPlanId?: string;
  metronomeVerifiedRateCardId?: string;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface APIKeyRecord {
  id: string;
  accountId: string;
  name: string;
  prefix: string;
  secretHash: string;
  scopes: APIScope[];
  users: string[];
  createdAt: Date;
  lastUsedAt?: Date;
  revokedAt?: Date;
}

export interface AuthenticatedAPIKey {
  apiKeyId: string;
  accountId: string;
  tenant: string;
  accountStatus: AccountStatus;
  prefix: string;
  lastUsedAt?: Date;
  metronomeStripeMappingVerified: boolean;
  scopes: Set<APIScope>;
  users: Set<string>;
}

export interface ConsoleUser {
  id: string;
  accountId?: string;
  email: string;
  role: ConsoleRole;
  passwordHash: string;
  createdAt: Date;
  disabledAt?: Date;
}

export interface ConsoleSession {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface UsageReservationInput {
  accountId: string;
  metric: UsageMetric;
  idempotencyKey: string;
  quantity?: number;
  walletKey?: string;
  occurredAt?: Date;
  reservedAt?: Date;
  reservationTtlMs?: number;
  properties?: Record<string, string>;
}

export interface UsageReservation {
  id: string;
  accountId: string;
  metric: UsageMetric;
  idempotencyKey: string;
  quantity: number;
  created: boolean;
  status: "reserved" | "committed";
  used: number;
  limit: number | null;
}

export interface UsageSummary {
  accountId: string;
  periodStart: Date;
  periodEnd: Date;
  activeWallets: number;
  transactions: number;
  activeWalletLimit: number | null;
  transactionLimit: number | null;
  planId: string;
  planName: string;
  walletUnitAmount: number | null;
  transactionUnitAmount: number | null;
  estimatedPeriodAmount: number | null;
  daily: Array<{
    date: string;
    activeWallets: number;
    transactions: number;
  }>;
}

export interface AdminSummary {
  accounts: number;
  activeAccounts: number;
  activeWallets: number;
  transactions: number;
  pendingOutbox: number;
  deadLetterOutbox: number;
  estimatedCurrentPeriodAmount: number | null;
}

export interface MetronomeStripeMapping {
  stripeCustomerId: string;
  metronomeCustomerId: string;
  planId: string;
  metronomeRateCardId: string;
}

export interface OutboxRecord {
  id: string;
  accountId: string;
  transactionId: string;
  customerId: string;
  eventType: "spiral_active_wallet" | "spiral_transaction_signed";
  timestamp: Date;
  properties: Record<string, string>;
  attempts: number;
}

export interface BillingStore {
  initialize(): Promise<void>;
  ready(): Promise<boolean>;
  close(): Promise<void>;
  putPlan(plan: Plan): Promise<void>;
  listPlans(): Promise<Plan[]>;
  putAccount(account: Account): Promise<void>;
  createAccountWithDeveloper(
    account: Account,
    user: ConsoleUser,
  ): Promise<void>;
  getAccount(accountId: string): Promise<Account | undefined>;
  findAccountByTenant(tenant: string): Promise<Account | undefined>;
  listAccounts(): Promise<Account[]>;
  updateAccountBilling(
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
  ): Promise<void>;
  markMetronomeStripeMappingVerified(
    accountId: string,
    expected: MetronomeStripeMapping,
    verifiedAt: Date,
  ): Promise<boolean>;
  clearStripeSubscription(
    accountId: string,
    expectedSubscriptionId: string,
  ): Promise<void>;
  createAPIKey(record: APIKeyRecord): Promise<void>;
  findAPIKeyByHash(
    secretHash: string,
  ): Promise<AuthenticatedAPIKey | undefined>;
  touchAPIKey(id: string, usedAt: Date): Promise<void>;
  listAPIKeys(accountId: string): Promise<APIKeyRecord[]>;
  revokeAPIKey(
    accountId: string,
    id: string,
    revokedAt: Date,
  ): Promise<boolean>;
  putConsoleUser(user: ConsoleUser): Promise<void>;
  findConsoleUserByEmail(email: string): Promise<ConsoleUser | undefined>;
  createSession(session: ConsoleSession): Promise<void>;
  findSessionByHash(
    tokenHash: string,
  ): Promise<{ session: ConsoleSession; user: ConsoleUser } | undefined>;
  deleteSession(tokenHash: string): Promise<void>;
  reserveUsage(input: UsageReservationInput): Promise<UsageReservation>;
  commitUsage(reservationId: string): Promise<void>;
  cancelUsage(reservationId: string): Promise<void>;
  usageSummary(accountId: string): Promise<UsageSummary>;
  adminSummary(): Promise<AdminSummary>;
  claimOutbox(limit: number, now: Date): Promise<OutboxRecord[]>;
  completeOutbox(ids: string[]): Promise<void>;
  retryOutbox(
    ids: string[],
    nextAttemptAt: Date,
    errorCode: string,
  ): Promise<void>;
  deadLetterOutbox(ids: string[], errorCode: string): Promise<void>;
  claimWebhookEvent(
    eventId: string,
    eventType: string,
    receivedAt: Date,
  ): Promise<"claimed" | "processed" | "busy">;
  completeWebhookEvent(eventId: string, processedAt: Date): Promise<void>;
  releaseWebhookEvent(eventId: string): Promise<void>;
}

export class BillingStateError extends Error {
  constructor(
    public readonly kind: "payment_required" | "quota_exceeded",
    public readonly used: number,
    public readonly limit: number | null,
  ) {
    super(
      kind === "payment_required"
        ? "The account is not in an active billing state"
        : `The plan quota is exhausted (${used}/${limit})`,
    );
  }
}
