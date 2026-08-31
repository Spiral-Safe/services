import { Plan } from "./types";

export interface StripeBillingConfig {
  apiKey: string;
  webhookSecret: string;
  checkoutSuccessUrl: string;
  checkoutCancelUrl: string;
  portalReturnUrl: string;
  checkoutIntentVersion: string;
}

export interface MetronomeConfig {
  apiToken: string;
  endpoint: string;
  intervalMs: number;
  batchSize: number;
  stripeInvoicingVerified: boolean;
}

export interface BillingConfig {
  mode: "disabled" | "memory" | "postgres";
  databaseUrl?: string;
  databaseSSL: boolean;
  apiKeyPepper?: string;
  sessionSecret?: string;
  sessionTtlMs: number;
  usageReservationTtlMs: number;
  consoleOrigin?: string;
  plans: Plan[];
  demoSeed: boolean;
  demoDeveloperEmail?: string;
  demoDeveloperPassword?: string;
  demoAdminEmail?: string;
  demoAdminPassword?: string;
  stripe?: StripeBillingConfig;
  metronome?: MetronomeConfig;
}

const demoPlans: Plan[] = [
  {
    id: "sandbox",
    name: "Sandbox demo fixture",
    activeWalletLimit: 5,
    transactionLimit: 100,
    walletUnitAmount: 0,
    transactionUnitAmount: 0,
    demo: true,
  },
  {
    id: "launch",
    name: "Launch demo fixture",
    activeWalletLimit: 100,
    transactionLimit: 10_000,
    walletUnitAmount: 0,
    transactionUnitAmount: 0,
    demo: true,
  },
  {
    id: "scale",
    name: "Scale demo fixture",
    activeWalletLimit: null,
    transactionLimit: null,
    walletUnitAmount: 0,
    transactionUnitAmount: 0,
    demo: true,
  },
];

function integer(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error("billing integer is invalid");
  return parsed;
}

function reservationTtl(value: string | undefined): number {
  const parsed = integer(value, 5 * 60_000);
  if (parsed < 60_000 || parsed > 60 * 60_000) {
    throw new Error(
      "BILLING_RESERVATION_TTL_MS must be between 60000 and 3600000",
    );
  }
  return parsed;
}

function optionalLimit(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer or null`);
  }
  return value as number;
}

function optionalAmount(value: unknown, label: string): number | null {
  return optionalLimit(value, label);
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 255)
    throw new Error(`${label} is invalid`);
  return value;
}

function parsePlans(value: string | undefined): Plan[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("BILLING_PLANS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("BILLING_PLANS_JSON must be a non-empty array");
  }
  const plans = parsed.map((entry, index): Plan => {
    if (!entry || Array.isArray(entry) || typeof entry !== "object") {
      throw new Error(`billing plan ${index} must be an object`);
    }
    const plan = entry as Record<string, unknown>;
    if (
      typeof plan.id !== "string" ||
      !/^[a-z][a-z0-9_-]{1,63}$/.test(plan.id) ||
      typeof plan.name !== "string" ||
      plan.name.length < 1 ||
      plan.name.length > 100
    ) {
      throw new Error(`billing plan ${index} has an invalid id or name`);
    }
    return {
      id: plan.id,
      name: plan.name,
      activeWalletLimit: optionalLimit(
        plan.activeWalletLimit,
        "activeWalletLimit",
      ),
      transactionLimit: optionalLimit(
        plan.transactionLimit,
        "transactionLimit",
      ),
      walletUnitAmount: optionalAmount(
        plan.walletUnitAmount,
        "walletUnitAmount",
      ),
      transactionUnitAmount: optionalAmount(
        plan.transactionUnitAmount,
        "transactionUnitAmount",
      ),
      stripeProductId: optionalString(plan.stripeProductId, "stripeProductId"),
      stripePriceId: optionalString(plan.stripePriceId, "stripePriceId"),
      metronomeProductId: optionalString(
        plan.metronomeProductId,
        "metronomeProductId",
      ),
      metronomeRateCardId: optionalString(
        plan.metronomeRateCardId,
        "metronomeRateCardId",
      ),
      demo: false,
    };
  });
  const unique = (
    field:
      | "id"
      | "stripeProductId"
      | "stripePriceId"
      | "metronomeProductId"
      | "metronomeRateCardId",
  ) => {
    const values = plans.map((plan) => plan[field]).filter(Boolean);
    if (new Set(values).size !== values.length)
      throw new Error(`billing plan ${field} values must be unique`);
  };
  unique("id");
  unique("stripeProductId");
  unique("stripePriceId");
  unique("metronomeProductId");
  unique("metronomeRateCardId");
  return plans;
}

function absoluteURL(
  value: string | undefined,
  label: string,
  devMode: boolean,
): string {
  if (!value) throw new Error(`${label} is required`);
  const parsed = new URL(value);
  if (
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    (!devMode && parsed.protocol !== "https:") ||
    (devMode && !["http:", "https:"].includes(parsed.protocol))
  ) {
    throw new Error(
      `${label} must be an absolute ${devMode ? "HTTP(S)" : "HTTPS"} URL`,
    );
  }
  return parsed.toString();
}

function absoluteOrigin(
  value: string | undefined,
  label: string,
  devMode: boolean,
): string {
  if (!value) throw new Error(`${label} is required`);
  const parsed = new URL(value);
  if (
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.search ||
    parsed.pathname !== "/" ||
    (!devMode && parsed.protocol !== "https:") ||
    (devMode && !["http:", "https:"].includes(parsed.protocol))
  ) {
    throw new Error(
      `${label} must be an absolute ${devMode ? "HTTP(S)" : "HTTPS"} origin`,
    );
  }
  return parsed.origin;
}

export function loadBillingConfig(
  env: NodeJS.ProcessEnv,
  devMode: boolean,
): BillingConfig {
  const requested =
    env.BILLING_MODE ||
    (env.BILLING_DEMO_SEED === "true" ? "memory" : "disabled");
  if (!(["disabled", "memory", "postgres"] as string[]).includes(requested)) {
    throw new Error("BILLING_MODE must be disabled, memory, or postgres");
  }
  const mode = requested as BillingConfig["mode"];
  if (mode === "memory" && !devMode) {
    throw new Error("the in-memory billing store is development-only");
  }
  const demoSeed = env.BILLING_DEMO_SEED === "true";
  if (demoSeed && (!devMode || mode !== "memory")) {
    throw new Error("BILLING_DEMO_SEED requires development memory mode");
  }
  if (mode === "disabled") {
    return {
      mode,
      databaseSSL: true,
      sessionTtlMs: 8 * 60 * 60 * 1_000,
      usageReservationTtlMs: 5 * 60_000,
      plans: [],
      demoSeed: false,
    };
  }

  const apiKeyPepper = env.API_KEY_PEPPER;
  const sessionSecret = env.CONSOLE_SESSION_SECRET;
  if (!apiKeyPepper || apiKeyPepper.length < 32) {
    throw new Error("API_KEY_PEPPER must contain at least 32 characters");
  }
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error(
      "CONSOLE_SESSION_SECRET must contain at least 32 characters",
    );
  }
  if (mode === "postgres" && !env.DATABASE_URL)
    throw new Error("DATABASE_URL is required");
  if (mode === "postgres" && !devMode && env.DATABASE_SSL === "false") {
    throw new Error("DATABASE_SSL cannot be disabled in production");
  }
  const plans = demoSeed
    ? demoPlans.map((plan) => ({ ...plan }))
    : parsePlans(env.BILLING_PLANS_JSON);
  if (plans.length === 0) {
    throw new Error("BILLING_PLANS_JSON is required outside seeded demo mode");
  }

  const consoleOrigin = absoluteOrigin(
    env.CONSOLE_ORIGIN,
    "CONSOLE_ORIGIN",
    devMode,
  );
  let stripe: StripeBillingConfig | undefined;
  if (env.STRIPE_API_KEY) {
    if (!env.STRIPE_API_KEY.startsWith("rk_") && !devMode) {
      throw new Error(
        "production STRIPE_API_KEY must be a least-privilege restricted key (rk_)",
      );
    }
    if (!env.STRIPE_WEBHOOK_SECRET?.startsWith("whsec_")) {
      throw new Error(
        "STRIPE_WEBHOOK_SECRET is required when Stripe is enabled",
      );
    }
    stripe = {
      apiKey: env.STRIPE_API_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      checkoutSuccessUrl: absoluteURL(
        env.STRIPE_CHECKOUT_SUCCESS_URL,
        "STRIPE_CHECKOUT_SUCCESS_URL",
        devMode,
      ),
      checkoutCancelUrl: absoluteURL(
        env.STRIPE_CHECKOUT_CANCEL_URL,
        "STRIPE_CHECKOUT_CANCEL_URL",
        devMode,
      ),
      portalReturnUrl: absoluteURL(
        env.STRIPE_PORTAL_RETURN_URL,
        "STRIPE_PORTAL_RETURN_URL",
        devMode,
      ),
      checkoutIntentVersion: env.STRIPE_CHECKOUT_INTENT_VERSION || "v1",
    };
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(stripe.checkoutIntentVersion)) {
      throw new Error("STRIPE_CHECKOUT_INTENT_VERSION is invalid");
    }
    for (const plan of plans) {
      if (!plan.stripeProductId || !plan.stripePriceId) {
        throw new Error(
          `billing plan ${plan.id} requires distinct stripeProductId and stripePriceId values`,
        );
      }
    }
  }

  const metronome = env.METRONOME_API_TOKEN
    ? {
        apiToken: env.METRONOME_API_TOKEN,
        endpoint:
          env.METRONOME_INGEST_URL || "https://api.metronome.com/v1/ingest",
        intervalMs: integer(env.METRONOME_EXPORT_INTERVAL_MS, 10_000),
        batchSize: Math.min(integer(env.METRONOME_BATCH_SIZE, 100), 100),
        stripeInvoicingVerified:
          env.METRONOME_STRIPE_INVOICING_VERIFIED === "true",
      }
    : undefined;
  if (metronome) {
    const endpoint = new URL(metronome.endpoint);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password
    ) {
      throw new Error("METRONOME_INGEST_URL must be HTTPS without credentials");
    }
    for (const plan of plans) {
      if (!plan.metronomeProductId || !plan.metronomeRateCardId) {
        throw new Error(
          `billing plan ${plan.id} requires metronomeProductId and metronomeRateCardId`,
        );
      }
    }
    if (!devMode && (!stripe || !metronome.stripeInvoicingVerified)) {
      throw new Error(
        "production Metronome usage requires Stripe plus METRONOME_STRIPE_INVOICING_VERIFIED=true",
      );
    }
  }
  if (!devMode && mode === "postgres" && (!stripe || !metronome)) {
    throw new Error(
      "production PostgreSQL billing requires both Stripe and Metronome",
    );
  }

  return {
    mode,
    databaseUrl: env.DATABASE_URL,
    databaseSSL: env.DATABASE_SSL !== "false",
    apiKeyPepper,
    sessionSecret,
    sessionTtlMs: integer(env.CONSOLE_SESSION_TTL_MS, 8 * 60 * 60 * 1_000),
    usageReservationTtlMs: reservationTtl(env.BILLING_RESERVATION_TTL_MS),
    consoleOrigin,
    plans,
    demoSeed,
    demoDeveloperEmail: env.DEMO_DEVELOPER_EMAIL || "developer@example.test",
    demoDeveloperPassword: env.DEMO_DEVELOPER_PASSWORD || "demo-developer-only",
    demoAdminEmail: env.DEMO_ADMIN_EMAIL || "admin@example.test",
    demoAdminPassword: env.DEMO_ADMIN_PASSWORD || "demo-admin-only",
    stripe,
    metronome,
  };
}
