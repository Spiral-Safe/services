import { randomUUID } from "node:crypto";
import { Pool, PoolClient, QueryResultRow } from "pg";
import {
  Account,
  AdminSummary,
  APIKeyRecord,
  APIScope,
  AuthenticatedAPIKey,
  BillingStateError,
  BillingStore,
  ConsoleSession,
  ConsoleUser,
  MetronomeStripeMapping,
  OutboxRecord,
  Plan,
  UsageMetric,
  UsageReservation,
  UsageReservationInput,
  UsageSummary,
} from "./types";

function date(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

function mapPlan(row: QueryResultRow): Plan {
  return {
    id: row.id,
    name: row.name,
    activeWalletLimit: row.active_wallet_limit,
    transactionLimit: row.transaction_limit,
    walletUnitAmount: row.wallet_unit_amount,
    transactionUnitAmount: row.transaction_unit_amount,
    stripeProductId: optional(row.stripe_product_id),
    stripePriceId: optional(row.stripe_price_id),
    metronomeProductId: optional(row.metronome_product_id),
    metronomeRateCardId: optional(row.metronome_rate_card_id),
    demo: row.demo,
  };
}

function mapAccount(row: QueryResultRow): Account {
  return {
    id: row.id,
    tenant: row.tenant,
    name: row.name,
    email: row.email,
    status: row.status,
    planId: row.plan_id,
    stripeCustomerId: optional(row.stripe_customer_id),
    stripeSubscriptionId: optional(row.stripe_subscription_id),
    metronomeCustomerId: row.metronome_customer_id,
    metronomeStripeMappingVerifiedAt: row.metronome_stripe_mapping_verified_at
      ? date(row.metronome_stripe_mapping_verified_at)
      : undefined,
    metronomeVerifiedStripeCustomerId: optional(
      row.metronome_verified_stripe_customer_id,
    ),
    metronomeVerifiedCustomerId: optional(row.metronome_verified_customer_id),
    metronomeVerifiedPlanId: optional(row.metronome_verified_plan_id),
    metronomeVerifiedRateCardId: optional(row.metronome_verified_rate_card_id),
    billingPeriodStart: date(row.billing_period_start),
    billingPeriodEnd: date(row.billing_period_end),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

function mapKey(row: QueryResultRow): APIKeyRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    prefix: row.prefix,
    secretHash: row.secret_hash,
    scopes: row.scopes as APIScope[],
    users: row.users,
    createdAt: date(row.created_at),
    lastUsedAt: row.last_used_at ? date(row.last_used_at) : undefined,
    revokedAt: row.revoked_at ? date(row.revoked_at) : undefined,
  };
}

export class PostgresBillingStore implements BillingStore {
  readonly pool: Pool;

  constructor(connectionString: string, ssl = true) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: ssl ? { rejectUnauthorized: true } : false,
    });
  }

  async initialize(): Promise<void> {
    const result = await this.pool.query<{ table_name: string | null }>(
      "SELECT to_regclass('public.billing_accounts')::text AS table_name",
    );
    if (!result.rows[0]?.table_name) {
      throw new Error(
        "billing schema is missing; run `npm run billing:migrate` before startup",
      );
    }
  }

  async ready(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async putPlan(plan: Plan): Promise<void> {
    await this.pool.query(
      `INSERT INTO billing_plans
       (id,name,active_wallet_limit,transaction_limit,wallet_unit_amount,
        transaction_unit_amount,stripe_product_id,stripe_price_id,metronome_product_id,
        metronome_rate_card_id,demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,
         active_wallet_limit=EXCLUDED.active_wallet_limit,
         transaction_limit=EXCLUDED.transaction_limit,
         wallet_unit_amount=EXCLUDED.wallet_unit_amount,
         transaction_unit_amount=EXCLUDED.transaction_unit_amount,
         stripe_product_id=EXCLUDED.stripe_product_id,
         stripe_price_id=EXCLUDED.stripe_price_id,
         metronome_product_id=EXCLUDED.metronome_product_id,
         metronome_rate_card_id=EXCLUDED.metronome_rate_card_id,
         demo=EXCLUDED.demo, updated_at=now()`,
      [
        plan.id,
        plan.name,
        plan.activeWalletLimit,
        plan.transactionLimit,
        plan.walletUnitAmount,
        plan.transactionUnitAmount,
        plan.stripeProductId || null,
        plan.stripePriceId || null,
        plan.metronomeProductId || null,
        plan.metronomeRateCardId || null,
        plan.demo,
      ],
    );
    await this.pool.query(
      `UPDATE billing_accounts SET metronome_stripe_mapping_verified_at=NULL,
         metronome_verified_stripe_customer_id=NULL,metronome_verified_customer_id=NULL,
         metronome_verified_plan_id=NULL,
         metronome_verified_rate_card_id=NULL,updated_at=now()
       WHERE plan_id=$1 AND metronome_stripe_mapping_verified_at IS NOT NULL
         AND metronome_verified_rate_card_id IS DISTINCT FROM $2`,
      [plan.id, plan.metronomeRateCardId || null],
    );
  }

  async listPlans(): Promise<Plan[]> {
    const result = await this.pool.query(
      "SELECT * FROM billing_plans ORDER BY name",
    );
    return result.rows.map(mapPlan);
  }

  async putAccount(account: Account): Promise<void> {
    await this.pool.query(
      `INSERT INTO billing_accounts
       (id,tenant,name,email,status,plan_id,stripe_customer_id,stripe_subscription_id,
        metronome_customer_id,metronome_stripe_mapping_verified_at,
        metronome_verified_stripe_customer_id,metronome_verified_customer_id,
        metronome_verified_plan_id,
        metronome_verified_rate_card_id,billing_period_start,billing_period_end,
        created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (id) DO UPDATE SET tenant=EXCLUDED.tenant,name=EXCLUDED.name,
         email=EXCLUDED.email,status=EXCLUDED.status,plan_id=EXCLUDED.plan_id,
         stripe_customer_id=EXCLUDED.stripe_customer_id,
         stripe_subscription_id=EXCLUDED.stripe_subscription_id,
         metronome_customer_id=EXCLUDED.metronome_customer_id,
         metronome_stripe_mapping_verified_at=EXCLUDED.metronome_stripe_mapping_verified_at,
         metronome_verified_stripe_customer_id=EXCLUDED.metronome_verified_stripe_customer_id,
         metronome_verified_customer_id=EXCLUDED.metronome_verified_customer_id,
         metronome_verified_plan_id=EXCLUDED.metronome_verified_plan_id,
         metronome_verified_rate_card_id=EXCLUDED.metronome_verified_rate_card_id,
         billing_period_start=EXCLUDED.billing_period_start,
         billing_period_end=EXCLUDED.billing_period_end,updated_at=EXCLUDED.updated_at`,
      [
        account.id,
        account.tenant,
        account.name,
        account.email,
        account.status,
        account.planId,
        account.stripeCustomerId || null,
        account.stripeSubscriptionId || null,
        account.metronomeCustomerId,
        account.metronomeStripeMappingVerifiedAt || null,
        account.metronomeVerifiedStripeCustomerId || null,
        account.metronomeVerifiedCustomerId || null,
        account.metronomeVerifiedPlanId || null,
        account.metronomeVerifiedRateCardId || null,
        account.billingPeriodStart,
        account.billingPeriodEnd,
        account.createdAt,
        account.updatedAt,
      ],
    );
  }

  async createAccountWithDeveloper(
    account: Account,
    user: ConsoleUser,
  ): Promise<void> {
    if (user.role !== "developer" || user.accountId !== account.id) {
      throw new Error("developer must belong to the new account");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO billing_accounts
         (id,tenant,name,email,status,plan_id,stripe_customer_id,stripe_subscription_id,
          metronome_customer_id,metronome_stripe_mapping_verified_at,
          metronome_verified_stripe_customer_id,metronome_verified_customer_id,
          metronome_verified_plan_id,
          metronome_verified_rate_card_id,billing_period_start,billing_period_end,
          created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          account.id,
          account.tenant,
          account.name,
          account.email,
          account.status,
          account.planId,
          account.stripeCustomerId || null,
          account.stripeSubscriptionId || null,
          account.metronomeCustomerId,
          account.metronomeStripeMappingVerifiedAt || null,
          account.metronomeVerifiedStripeCustomerId || null,
          account.metronomeVerifiedCustomerId || null,
          account.metronomeVerifiedPlanId || null,
          account.metronomeVerifiedRateCardId || null,
          account.billingPeriodStart,
          account.billingPeriodEnd,
          account.createdAt,
          account.updatedAt,
        ],
      );
      await client.query(
        `INSERT INTO billing_console_users
         (id,account_id,email,role,password_hash,created_at,disabled_at)
         VALUES ($1,$2,lower($3),$4,$5,$6,$7)`,
        [
          user.id,
          user.accountId,
          user.email,
          user.role,
          user.passwordHash,
          user.createdAt,
          user.disabledAt || null,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getAccount(accountId: string): Promise<Account | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM billing_accounts WHERE id=$1",
      [accountId],
    );
    return result.rows[0] && mapAccount(result.rows[0]);
  }

  async findAccountByTenant(tenant: string): Promise<Account | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM billing_accounts WHERE tenant=$1",
      [tenant],
    );
    return result.rows[0] && mapAccount(result.rows[0]);
  }

  async listAccounts(): Promise<Account[]> {
    const result = await this.pool.query(
      "SELECT * FROM billing_accounts ORDER BY created_at DESC",
    );
    return result.rows.map(mapAccount);
  }

  async updateAccountBilling(accountId: string, update: any): Promise<void> {
    const entries = Object.entries(update).filter(
      ([, value]) => value !== undefined,
    );
    if (entries.length === 0) return;
    const columns: Record<string, string> = {
      status: "status",
      planId: "plan_id",
      stripeCustomerId: "stripe_customer_id",
      stripeSubscriptionId: "stripe_subscription_id",
      billingPeriodStart: "billing_period_start",
      billingPeriodEnd: "billing_period_end",
    };
    const assignments = entries.map(
      ([key], index) => `${columns[key]}=$${index + 2}`,
    );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE billing_accounts SET ${assignments.join(",")}, updated_at=now() WHERE id=$1`,
        [accountId, ...entries.map(([, value]) => value)],
      );
      if (result.rowCount !== 1) throw new Error("billing account not found");
      await client.query(
        `UPDATE billing_accounts a SET metronome_stripe_mapping_verified_at=NULL,
           metronome_verified_stripe_customer_id=NULL,metronome_verified_customer_id=NULL,
           metronome_verified_plan_id=NULL,
           metronome_verified_rate_card_id=NULL
         FROM billing_plans p
         WHERE a.id=$1 AND p.id=a.plan_id
           AND a.metronome_stripe_mapping_verified_at IS NOT NULL
           AND (a.metronome_verified_stripe_customer_id IS DISTINCT FROM a.stripe_customer_id
             OR a.metronome_verified_customer_id IS DISTINCT FROM a.metronome_customer_id
             OR a.metronome_verified_plan_id IS DISTINCT FROM a.plan_id
             OR a.metronome_verified_rate_card_id IS DISTINCT FROM p.metronome_rate_card_id)`,
        [accountId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markMetronomeStripeMappingVerified(
    accountId: string,
    expected: MetronomeStripeMapping,
    verifiedAt: Date,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE billing_accounts a
       SET metronome_stripe_mapping_verified_at=$6,
         metronome_verified_stripe_customer_id=$2,
         metronome_verified_customer_id=$3,
         metronome_verified_plan_id=$4,
         metronome_verified_rate_card_id=$5,
         updated_at=now()
       FROM billing_plans p
       WHERE a.id=$1 AND p.id=a.plan_id
         AND a.stripe_customer_id=$2
         AND a.metronome_customer_id=$3
         AND a.plan_id=$4
         AND p.metronome_rate_card_id=$5`,
      [
        accountId,
        expected.stripeCustomerId,
        expected.metronomeCustomerId,
        expected.planId,
        expected.metronomeRateCardId,
        verifiedAt,
      ],
    );
    return result.rowCount === 1;
  }

  async clearStripeSubscription(
    accountId: string,
    expectedSubscriptionId: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE billing_accounts SET stripe_subscription_id=NULL,
         metronome_stripe_mapping_verified_at=NULL,
         metronome_verified_stripe_customer_id=NULL,metronome_verified_customer_id=NULL,
         metronome_verified_plan_id=NULL,
         metronome_verified_rate_card_id=NULL,updated_at=now()
       WHERE id=$1 AND stripe_subscription_id=$2`,
      [accountId, expectedSubscriptionId],
    );
  }

  async createAPIKey(record: APIKeyRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO billing_api_keys
       (id,account_id,name,prefix,secret_hash,scopes,users,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        record.id,
        record.accountId,
        record.name,
        record.prefix,
        record.secretHash,
        record.scopes,
        record.users,
        record.createdAt,
      ],
    );
  }

  async findAPIKeyByHash(
    secretHash: string,
  ): Promise<AuthenticatedAPIKey | undefined> {
    const result = await this.pool.query(
      `SELECT k.id,k.account_id,k.prefix,k.scopes,k.users,k.last_used_at,a.tenant,a.status,
              (a.metronome_stripe_mapping_verified_at IS NOT NULL
               AND a.metronome_verified_stripe_customer_id IS NOT DISTINCT FROM a.stripe_customer_id
               AND a.metronome_verified_customer_id IS NOT DISTINCT FROM a.metronome_customer_id
               AND a.metronome_verified_plan_id IS NOT DISTINCT FROM a.plan_id
               AND a.metronome_verified_rate_card_id IS NOT DISTINCT FROM p.metronome_rate_card_id)
                metronome_stripe_mapping_verified
       FROM billing_api_keys k JOIN billing_accounts a ON a.id=k.account_id
       JOIN billing_plans p ON p.id=a.plan_id
       WHERE k.secret_hash=$1 AND k.revoked_at IS NULL`,
      [secretHash],
    );
    const row = result.rows[0];
    return (
      row && {
        apiKeyId: row.id,
        accountId: row.account_id,
        tenant: row.tenant,
        accountStatus: row.status,
        prefix: row.prefix,
        lastUsedAt: row.last_used_at ? date(row.last_used_at) : undefined,
        metronomeStripeMappingVerified: row.metronome_stripe_mapping_verified,
        scopes: new Set(row.scopes),
        users: new Set(row.users),
      }
    );
  }

  async touchAPIKey(id: string, usedAt: Date): Promise<void> {
    await this.pool.query(
      `UPDATE billing_api_keys SET last_used_at=$2
       WHERE id=$1 AND revoked_at IS NULL
         AND (last_used_at IS NULL OR last_used_at < $2 - interval '5 minutes')`,
      [id, usedAt],
    );
  }

  async listAPIKeys(accountId: string): Promise<APIKeyRecord[]> {
    const result = await this.pool.query(
      "SELECT * FROM billing_api_keys WHERE account_id=$1 ORDER BY created_at DESC",
      [accountId],
    );
    return result.rows.map(mapKey);
  }

  async revokeAPIKey(
    accountId: string,
    id: string,
    revokedAt: Date,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE billing_api_keys SET revoked_at=$3
       WHERE account_id=$1 AND id=$2 AND revoked_at IS NULL`,
      [accountId, id, revokedAt],
    );
    return result.rowCount === 1;
  }

  async putConsoleUser(user: ConsoleUser): Promise<void> {
    await this.pool.query(
      `INSERT INTO billing_console_users
       (id,account_id,email,role,password_hash,created_at,disabled_at)
       VALUES ($1,$2,lower($3),$4,$5,$6,$7)
       ON CONFLICT (email) DO UPDATE SET account_id=EXCLUDED.account_id,
         role=EXCLUDED.role,password_hash=EXCLUDED.password_hash,
         disabled_at=EXCLUDED.disabled_at`,
      [
        user.id,
        user.accountId || null,
        user.email,
        user.role,
        user.passwordHash,
        user.createdAt,
        user.disabledAt || null,
      ],
    );
  }

  async upsertAdmin(user: ConsoleUser): Promise<void> {
    if (user.role !== "admin" || user.accountId) {
      throw new Error("bootstrap user must be an account-independent admin");
    }
    const result = await this.pool.query(
      `INSERT INTO billing_console_users
       (id,account_id,email,role,password_hash,created_at,disabled_at)
       VALUES ($1,NULL,lower($2),'admin',$3,$4,NULL)
       ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash,
         disabled_at=NULL
       WHERE billing_console_users.role='admin'
         AND billing_console_users.account_id IS NULL
       RETURNING id`,
      [user.id, user.email, user.passwordHash, user.createdAt],
    );
    if (result.rowCount !== 1) {
      throw new Error("email belongs to a non-admin console user");
    }
  }

  async findConsoleUserByEmail(
    email: string,
  ): Promise<ConsoleUser | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM billing_console_users WHERE email=lower($1)",
      [email.trim()],
    );
    const row = result.rows[0];
    return (
      row && {
        id: row.id,
        accountId: optional(row.account_id),
        email: row.email,
        role: row.role,
        passwordHash: row.password_hash,
        createdAt: date(row.created_at),
        disabledAt: row.disabled_at ? date(row.disabled_at) : undefined,
      }
    );
  }

  async createSession(session: ConsoleSession): Promise<void> {
    await this.pool.query(
      `INSERT INTO billing_console_sessions (id,user_id,token_hash,expires_at,created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        session.id,
        session.userId,
        session.tokenHash,
        session.expiresAt,
        session.createdAt,
      ],
    );
  }

  async findSessionByHash(
    tokenHash: string,
  ): Promise<{ session: ConsoleSession; user: ConsoleUser } | undefined> {
    const result = await this.pool.query(
      `SELECT s.id AS session_id,s.user_id,s.token_hash,s.expires_at,
              s.created_at AS session_created_at,u.*
       FROM billing_console_sessions s
       JOIN billing_console_users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.expires_at>now() AND u.disabled_at IS NULL`,
      [tokenHash],
    );
    const row = result.rows[0];
    return (
      row && {
        session: {
          id: row.session_id,
          userId: row.user_id,
          tokenHash: row.token_hash,
          expiresAt: date(row.expires_at),
          createdAt: date(row.session_created_at),
        },
        user: {
          id: row.user_id,
          accountId: optional(row.account_id),
          email: row.email,
          role: row.role,
          passwordHash: row.password_hash,
          createdAt: date(row.created_at),
        },
      }
    );
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM billing_console_sessions WHERE token_hash=$1",
      [tokenHash],
    );
  }

  async reserveUsage(input: UsageReservationInput): Promise<UsageReservation> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const accountResult = await client.query(
        `SELECT a.*,p.active_wallet_limit,p.transaction_limit
         FROM billing_accounts a JOIN billing_plans p ON p.id=a.plan_id
         WHERE a.id=$1 FOR UPDATE OF a`,
        [input.accountId],
      );
      const account = accountResult.rows[0];
      if (!account) throw new Error("billing account not found");
      if (account.status !== "active")
        throw new BillingStateError("payment_required", 0, null);
      const occurredAt = input.occurredAt || new Date();
      if (
        occurredAt < date(account.billing_period_start) ||
        occurredAt >= date(account.billing_period_end)
      ) {
        throw new BillingStateError("payment_required", 0, null);
      }
      const reservedAt = input.reservedAt || new Date();
      const reservationTtlMs = input.reservationTtlMs ?? 5 * 60_000;
      if (!Number.isSafeInteger(reservationTtlMs) || reservationTtlMs <= 0) {
        throw new Error("usage reservation TTL is invalid");
      }
      await client.query(
        `DELETE FROM billing_usage_events
         WHERE status='reserved'
           AND reserved_at <= $1::timestamptz - ($2::bigint * interval '1 millisecond')`,
        [reservedAt, reservationTtlMs],
      );
      const limit =
        input.metric === "active_wallet"
          ? account.active_wallet_limit
          : account.transaction_limit;
      const existing = await client.query(
        `SELECT * FROM billing_usage_events
         WHERE account_id=$1 AND metric=$2 AND idempotency_key=$3`,
        [input.accountId, input.metric, input.idempotencyKey],
      );
      const used = await this.usedInPeriod(
        client,
        input.accountId,
        input.metric,
        account.billing_period_start,
        account.billing_period_end,
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        const row = existing.rows[0];
        return {
          id: row.id,
          accountId: row.account_id,
          metric: row.metric,
          idempotencyKey: row.idempotency_key,
          quantity: row.quantity,
          created: false,
          status: row.status,
          used,
          limit,
        };
      }
      const quantity = input.quantity || 1;
      if (!Number.isSafeInteger(quantity) || quantity < 1)
        throw new Error("usage quantity is invalid");
      if (limit !== null && used + quantity > limit) {
        throw new BillingStateError("quota_exceeded", used, limit);
      }
      const usageId = randomUUID();
      const inserted = await client.query(
        `INSERT INTO billing_usage_events
         (id,account_id,metric,idempotency_key,quantity,wallet_key,status,occurred_at,reserved_at,properties)
         VALUES ($1,$2,$3,$4,$5,$6,'reserved',$7,$8,$9) RETURNING *`,
        [
          usageId,
          input.accountId,
          input.metric,
          input.idempotencyKey,
          quantity,
          input.walletKey || null,
          occurredAt,
          reservedAt,
          input.properties || {},
        ],
      );
      await client.query("COMMIT");
      return {
        id: inserted.rows[0].id,
        accountId: input.accountId,
        metric: input.metric,
        idempotencyKey: input.idempotencyKey,
        quantity,
        created: true,
        status: "reserved",
        used: used + quantity,
        limit,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async usedInPeriod(
    client: PoolClient,
    accountId: string,
    metric: UsageMetric,
    start: Date,
    end: Date,
  ): Promise<number> {
    const result = await client.query<{ used: string }>(
      `SELECT COALESCE(sum(quantity),0)::text AS used FROM billing_usage_events
       WHERE account_id=$1 AND metric=$2 AND status IN ('reserved','committed')
         AND occurred_at >= $3 AND occurred_at < $4`,
      [accountId, metric, start, end],
    );
    return Number(result.rows[0].used);
  }

  async commitUsage(reservationId: string): Promise<void> {
    await this.pool.query(
      `WITH committed AS (
         UPDATE billing_usage_events SET status='committed',committed_at=now()
         WHERE id=$1 AND status='reserved' RETURNING *
       )
       INSERT INTO billing_usage_outbox
       (id,account_id,transaction_id,customer_id,event_type,event_timestamp,properties)
       SELECT 'usage:'||c.id,c.account_id,c.id,
         COALESCE(a.metronome_verified_customer_id,a.metronome_customer_id),
         CASE WHEN c.metric='active_wallet' THEN 'spiral_active_wallet'
              ELSE 'spiral_transaction_signed' END,
         c.occurred_at,
         c.properties || jsonb_build_object('quantity',c.quantity::text,'metric',c.metric) ||
           CASE WHEN c.wallet_key IS NULL THEN '{}'::jsonb
                ELSE jsonb_build_object('wallet_key',c.wallet_key) END ||
           CASE WHEN p.metronome_product_id IS NULL THEN '{}'::jsonb
                ELSE jsonb_build_object('metronome_product_id',p.metronome_product_id) END ||
           CASE WHEN p.metronome_rate_card_id IS NULL THEN '{}'::jsonb
                ELSE jsonb_build_object('metronome_rate_card_id',p.metronome_rate_card_id) END
       FROM committed c JOIN billing_accounts a ON a.id=c.account_id
       JOIN billing_plans p ON p.id=a.plan_id
       ON CONFLICT (id) DO NOTHING`,
      [reservationId],
    );
  }

  async cancelUsage(reservationId: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM billing_usage_events WHERE id=$1 AND status='reserved'",
      [reservationId],
    );
  }

  async usageSummary(accountId: string): Promise<UsageSummary> {
    const [result, dailyResult] = await Promise.all([
      this.pool.query(
        `SELECT a.id,a.billing_period_start,a.billing_period_end,
              p.id plan_id,p.name plan_name,p.active_wallet_limit,p.transaction_limit,
              p.wallet_unit_amount,p.transaction_unit_amount,
              COALESCE(sum(u.quantity) FILTER (WHERE u.metric='active_wallet'),0)::int active_wallets,
              COALESCE(sum(u.quantity) FILTER (WHERE u.metric='transaction_signed'),0)::int transactions
       FROM billing_accounts a JOIN billing_plans p ON p.id=a.plan_id
       LEFT JOIN billing_usage_events u ON u.account_id=a.id AND u.status='committed'
         AND u.occurred_at>=a.billing_period_start AND u.occurred_at<a.billing_period_end
       WHERE a.id=$1
       GROUP BY a.id,p.id,p.name,p.active_wallet_limit,p.transaction_limit,
         p.wallet_unit_amount,p.transaction_unit_amount`,
        [accountId],
      ),
      this.pool.query(
        `SELECT to_char(u.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS usage_day,
                COALESCE(sum(u.quantity) FILTER (WHERE u.metric='active_wallet'),0)::int active_wallets,
                COALESCE(sum(u.quantity) FILTER (WHERE u.metric='transaction_signed'),0)::int transactions
         FROM billing_usage_events u JOIN billing_accounts a ON a.id=u.account_id
         WHERE u.account_id=$1 AND u.status='committed'
           AND u.occurred_at>=a.billing_period_start AND u.occurred_at<a.billing_period_end
         GROUP BY 1 ORDER BY 1`,
        [accountId],
      ),
    ]);
    const row = result.rows[0];
    if (!row) throw new Error("billing account not found");
    const estimatedPeriodAmount =
      row.wallet_unit_amount === null || row.transaction_unit_amount === null
        ? null
        : row.active_wallets * row.wallet_unit_amount +
          row.transactions * row.transaction_unit_amount;
    return {
      accountId,
      periodStart: date(row.billing_period_start),
      periodEnd: date(row.billing_period_end),
      activeWallets: row.active_wallets,
      transactions: row.transactions,
      activeWalletLimit: row.active_wallet_limit,
      transactionLimit: row.transaction_limit,
      planId: row.plan_id,
      planName: row.plan_name,
      walletUnitAmount: row.wallet_unit_amount,
      transactionUnitAmount: row.transaction_unit_amount,
      estimatedPeriodAmount,
      daily: dailyResult.rows.map((item) => ({
        date: item.usage_day,
        activeWallets: item.active_wallets,
        transactions: item.transactions,
      })),
    };
  }

  async adminSummary(): Promise<AdminSummary> {
    const result = await this.pool.query(
      `SELECT
        (SELECT count(*)::int FROM billing_accounts) accounts,
        (SELECT count(*)::int FROM billing_accounts WHERE status='active') active_accounts,
        (SELECT COALESCE(sum(u.quantity),0)::int
          FROM billing_usage_events u JOIN billing_accounts a ON a.id=u.account_id
          WHERE u.status='committed' AND u.metric='active_wallet'
            AND u.occurred_at>=a.billing_period_start
            AND u.occurred_at<a.billing_period_end) active_wallets,
        (SELECT COALESCE(sum(u.quantity),0)::int
          FROM billing_usage_events u JOIN billing_accounts a ON a.id=u.account_id
          WHERE u.status='committed' AND u.metric='transaction_signed'
            AND u.occurred_at>=a.billing_period_start
            AND u.occurred_at<a.billing_period_end) transactions,
        (SELECT count(*)::int FROM billing_usage_outbox WHERE state='pending') pending_outbox,
        (SELECT count(*)::int FROM billing_usage_outbox WHERE state='dead') dead_letter_outbox,
        CASE WHEN EXISTS (
          SELECT 1 FROM billing_accounts a JOIN billing_plans p ON p.id=a.plan_id
          WHERE p.wallet_unit_amount IS NULL OR p.transaction_unit_amount IS NULL
        ) THEN NULL ELSE (
          SELECT COALESCE(sum(u.quantity * CASE WHEN u.metric='active_wallet'
            THEN p.wallet_unit_amount ELSE p.transaction_unit_amount END),0)::bigint
          FROM billing_accounts a JOIN billing_plans p ON p.id=a.plan_id
          LEFT JOIN billing_usage_events u ON u.account_id=a.id AND u.status='committed'
            AND u.occurred_at>=a.billing_period_start AND u.occurred_at<a.billing_period_end
        ) END estimated_current_period_amount`,
    );
    const row = result.rows[0];
    return {
      accounts: row.accounts,
      activeAccounts: row.active_accounts,
      activeWallets: row.active_wallets,
      transactions: row.transactions,
      pendingOutbox: row.pending_outbox,
      deadLetterOutbox: row.dead_letter_outbox,
      estimatedCurrentPeriodAmount:
        row.estimated_current_period_amount === null
          ? null
          : Number(row.estimated_current_period_amount),
    };
  }

  async claimOutbox(limit: number, now: Date): Promise<OutboxRecord[]> {
    const result = await this.pool.query(
      `WITH claimed AS (
         SELECT id FROM billing_usage_outbox
         WHERE state='pending' AND next_attempt_at<=$1
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $2
       )
       UPDATE billing_usage_outbox o SET attempts=o.attempts+1,
         next_attempt_at=$1 + interval '60 seconds'
       FROM claimed WHERE o.id=claimed.id
       RETURNING o.*`,
      [now, Math.max(1, Math.min(limit, 100))],
    );
    return result.rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      transactionId: row.transaction_id,
      customerId: row.customer_id,
      eventType: row.event_type,
      timestamp: date(row.event_timestamp),
      properties: row.properties,
      attempts: row.attempts,
    }));
  }

  async completeOutbox(ids: string[]): Promise<void> {
    if (ids.length)
      await this.pool.query(
        "UPDATE billing_usage_outbox SET state='delivered',delivered_at=now() WHERE id=ANY($1)",
        [ids],
      );
  }

  async retryOutbox(
    ids: string[],
    nextAttemptAt: Date,
    errorCode: string,
  ): Promise<void> {
    if (ids.length)
      await this.pool.query(
        `UPDATE billing_usage_outbox SET next_attempt_at=$2,last_error=$3
         WHERE id=ANY($1) AND state='pending'`,
        [ids, nextAttemptAt, errorCode.slice(0, 128)],
      );
  }

  async deadLetterOutbox(ids: string[], errorCode: string): Promise<void> {
    if (ids.length)
      await this.pool.query(
        "UPDATE billing_usage_outbox SET state='dead',last_error=$2 WHERE id=ANY($1)",
        [ids, errorCode.slice(0, 128)],
      );
  }

  async claimWebhookEvent(
    eventId: string,
    eventType: string,
    receivedAt: Date,
  ): Promise<"claimed" | "processed" | "busy"> {
    const inserted = await this.pool.query(
      `INSERT INTO billing_stripe_webhook_events(event_id,event_type,state,received_at)
       VALUES ($1,$2,'processing',$3)
       ON CONFLICT(event_id) DO UPDATE SET event_type=EXCLUDED.event_type,
         state='processing',received_at=EXCLUDED.received_at,processed_at=NULL
       WHERE billing_stripe_webhook_events.state='processing'
         AND billing_stripe_webhook_events.received_at <=
           EXCLUDED.received_at - interval '5 minutes'`,
      [eventId, eventType, receivedAt],
    );
    if (inserted.rowCount === 1) return "claimed";
    const existing = await this.pool.query<{
      state: "processing" | "processed";
    }>("SELECT state FROM billing_stripe_webhook_events WHERE event_id=$1", [
      eventId,
    ]);
    return existing.rows[0]?.state === "processed" ? "processed" : "busy";
  }

  async completeWebhookEvent(
    eventId: string,
    processedAt: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE billing_stripe_webhook_events SET state='processed',processed_at=$2
       WHERE event_id=$1 AND state='processing'`,
      [eventId, processedAt],
    );
  }

  async releaseWebhookEvent(eventId: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM billing_stripe_webhook_events WHERE event_id=$1 AND state='processing'",
      [eventId],
    );
  }
}
