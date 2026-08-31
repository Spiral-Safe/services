import { randomUUID, timingSafeEqual } from "node:crypto";
import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import {
  registerConsoleRoutes,
  registerStripeWebhook,
} from "./billing/console";
import { BillingRuntime, isMetronomeMappingCurrent } from "./billing/runtime";
import { opaqueIdentifier } from "./billing/security";
import { APIScope, BillingStateError, UsageReservation } from "./billing/types";
import {
  APIPrincipal,
  Chain,
  hashAPIToken,
  ServiceConfig,
  SUPPORTED_CHAINS,
} from "./config";
import { VaultClient, VaultResponseError } from "./vault";

type Operation = "transaction" | "message";

interface AuthenticatedRequest extends Request {
  tenant?: string;
  principal?: APIPrincipal;
  accountId?: string;
  apiKeyId?: string;
  scopes?: Set<APIScope>;
  requestId?: string;
}

class HTTPError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class SlidingWindowLimiter {
  private readonly entries = new Map<
    string,
    { startedAt: number; count: number }
  >();
  private operations = 0;

  constructor(
    private readonly windowMs: number,
    private readonly maximum: number,
    private readonly maximumBuckets: number,
  ) {}

  consume(
    key: string,
    now = Date.now(),
  ): { allowed: boolean; retryAfter: number } {
    this.operations += 1;
    if (
      this.operations % 1_000 === 0 ||
      (!this.entries.has(key) && this.entries.size >= this.maximumBuckets)
    ) {
      for (const [candidate, entry] of this.entries) {
        if (entry.startedAt + this.windowMs <= now)
          this.entries.delete(candidate);
      }
    }
    const current = this.entries.get(key);
    if (!current || current.startedAt + this.windowMs <= now) {
      if (!current && this.entries.size >= this.maximumBuckets) {
        return { allowed: false, retryAfter: 1 };
      }
      this.entries.set(key, { startedAt: now, count: 1 });
      return { allowed: true, retryAfter: 0 };
    }
    current.count += 1;
    if (current.count <= this.maximum) return { allowed: true, retryAfter: 0 };
    return {
      allowed: false,
      retryAfter: Math.max(
        1,
        Math.ceil((current.startedAt + this.windowMs - now) / 1_000),
      ),
    };
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function authenticate(config: ServiceConfig, billing?: BillingRuntime) {
  return (
    req: AuthenticatedRequest,
    _res: Response,
    next: NextFunction,
  ): void => {
    void (async () => {
      const authorization = req.get("authorization") || "";
      if (!authorization.startsWith("Bearer ")) {
        next(
          new HTTPError(
            401,
            "unauthorized",
            "Bearer authentication is required",
          ),
        );
        return;
      }
      const suppliedHash = hashAPIToken(authorization.slice("Bearer ".length));
      let principal: APIPrincipal | undefined;
      for (const [candidateHash, candidatePrincipal] of config.apiTokenHashes) {
        if (constantTimeEqual(suppliedHash, candidateHash))
          principal = candidatePrincipal;
      }
      if (principal) {
        req.principal = principal;
        req.tenant = principal.tenant;
        req.scopes = new Set([
          "wallets:read",
          "wallets:write",
          "signatures:create",
        ]);
        const account =
          billing &&
          (await billing.store.findAccountByTenant(principal.tenant));
        if (billing && (!account || account.status !== "active")) {
          next(
            new HTTPError(
              402,
              "payment_required",
              "The account subscription is not active",
            ),
          );
          return;
        }
        if (
          billing?.config.metronome &&
          (!account ||
            !isMetronomeMappingCurrent(account, billing.config.plans))
        ) {
          next(
            new HTTPError(
              402,
              "billing_provisioning_required",
              "Metronome-to-Stripe billing is not verified for this account",
            ),
          );
          return;
        }
        req.accountId = account?.id;
        next();
        return;
      }
      const dynamic =
        billing &&
        (await billing.authenticate(authorization.slice("Bearer ".length)));
      if (!dynamic) {
        next(new HTTPError(401, "unauthorized", "Bearer token is invalid"));
        return;
      }
      if (dynamic.accountStatus !== "active") {
        next(
          new HTTPError(
            402,
            "payment_required",
            "The account subscription is not active",
          ),
        );
        return;
      }
      if (
        billing?.config.metronome &&
        !dynamic.metronomeStripeMappingVerified
      ) {
        next(
          new HTTPError(
            402,
            "billing_provisioning_required",
            "Metronome-to-Stripe billing is not verified for this account",
          ),
        );
        return;
      }
      req.principal = { tenant: dynamic.tenant, users: dynamic.users };
      req.tenant = dynamic.tenant;
      req.accountId = dynamic.accountId;
      req.apiKeyId = dynamic.apiKeyId;
      req.scopes = dynamic.scopes;
      next();
    })().catch(next);
  };
}

function requireScope(req: AuthenticatedRequest, scope: APIScope): void {
  if (!req.scopes?.has(scope)) {
    throw new HTTPError(403, "scope_forbidden", `API key requires ${scope}`);
  }
}

function parseIdentity(req: AuthenticatedRequest): {
  username: string;
  chain: Chain;
} {
  const username = req.body?.username;
  if (
    typeof username !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._@-]{0,63})$/.test(username)
  ) {
    throw new HTTPError(
      400,
      "invalid_username",
      "username must be 1-64 safe identifier characters",
    );
  }
  const chain = (req.body?.chain || "solana") as string;
  if (!SUPPORTED_CHAINS.includes(chain as Chain)) {
    throw new HTTPError(
      400,
      "unsupported_chain",
      `chain must be one of ${SUPPORTED_CHAINS.join(", ")}`,
    );
  }
  if (req.principal?.users && !req.principal.users.has(username)) {
    throw new HTTPError(
      403,
      "user_forbidden",
      "Bearer token is not authorized for this username",
    );
  }
  return { username, chain: chain as Chain };
}

function requireCredential(
  req: Request,
  ceremony: "registration" | "assertion",
): Record<string, unknown> {
  const credential = req.body?.credential;
  if (
    !credential ||
    Array.isArray(credential) ||
    typeof credential !== "object"
  ) {
    throw new HTTPError(
      400,
      "invalid_credential",
      "credential must be an object",
    );
  }
  const record = credential as Record<string, unknown>;
  const response = record.response;
  const encoded = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 262_144 &&
    /^[A-Za-z0-9_-]+={0,2}$/.test(value);
  const hasCommonShape =
    encoded(record.id) &&
    encoded(record.rawId) &&
    record.type === "public-key" &&
    response !== null &&
    !Array.isArray(response) &&
    typeof response === "object" &&
    encoded((response as Record<string, unknown>).clientDataJSON);
  const responseRecord = response as Record<string, unknown> | undefined;
  const hasCeremonyShape =
    ceremony === "registration"
      ? encoded(responseRecord?.attestationObject)
      : encoded(responseRecord?.authenticatorData) &&
        encoded(responseRecord?.signature);
  if (!hasCommonShape || !hasCeremonyShape) {
    throw new HTTPError(
      400,
      "invalid_credential",
      `credential must be a WebAuthn ${ceremony} response`,
    );
  }
  return record;
}

function requireCeremonyID(req: Request): string {
  const ceremonyID = req.body?.ceremonyId;
  if (
    typeof ceremonyID !== "string" ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(ceremonyID)
  ) {
    throw new HTTPError(400, "invalid_ceremony", "ceremonyId is required");
  }
  return ceremonyID;
}

function requireSigningRequest(
  req: Request,
  maximumBytes: number,
): { operation: Operation; payload: string } {
  const operation = requireOperation(req);
  const payload = req.body?.payload || req.body?.rawTx;
  if (
    typeof payload !== "string" ||
    payload.length === 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)
  ) {
    throw new HTTPError(
      400,
      "invalid_payload",
      "payload must be non-empty standard base64",
    );
  }
  const decoded = Buffer.from(payload, "base64");
  if (decoded.length === 0 || decoded.length > maximumBytes) {
    throw new HTTPError(
      400,
      "invalid_payload",
      `decoded payload must be 1-${maximumBytes} bytes`,
    );
  }
  return { operation, payload };
}

function requireOperation(req: Request): Operation {
  const operation = (req.body?.operation || "transaction") as string;
  if (operation !== "transaction" && operation !== "message") {
    throw new HTTPError(
      400,
      "invalid_operation",
      "operation must be transaction or message",
    );
  }
  return operation as Operation;
}

function asyncRoute(
  route: (req: AuthenticatedRequest, res: Response) => Promise<void>,
): (req: AuthenticatedRequest, res: Response, next: NextFunction) => void {
  return (req, res, next) => void route(req, res).catch(next);
}

export function createApp(
  config: ServiceConfig,
  vault: Pick<VaultClient, "post" | "ready"> = new VaultClient(config),
  billing?: BillingRuntime,
) {
  const app = express();
  const limiter = new SlidingWindowLimiter(
    config.rateLimitWindowMs,
    config.rateLimitMax,
    config.rateLimitBuckets,
  );

  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.use((req: AuthenticatedRequest, res, next) => {
    res.locals.startedAt = process.hrtime.bigint();
    const supplied = req.get("x-request-id");
    req.requestId =
      supplied && /^[A-Za-z0-9._-]{8,128}$/.test(supplied)
        ? supplied
        : randomUUID();
    res.setHeader("x-request-id", req.requestId);
    res.setHeader("x-content-type-options", "nosniff");
    const consoleRequest =
      req.path === "/console.css" ||
      req.path.startsWith("/developer") ||
      req.path.startsWith("/admin");
    res.setHeader(
      "referrer-policy",
      consoleRequest ? "same-origin" : "no-referrer",
    );
    res.setHeader("cache-control", "no-store");
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'",
    );
    res.setHeader(
      "permissions-policy",
      "camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-create=(), publickey-credentials-get=()",
    );
    if (!config.devMode) {
      res.setHeader(
        "strict-transport-security",
        "max-age=31536000; includeSubDomains",
      );
    }
    next();
  });
  app.use(
    cors({
      origin(origin, callback) {
        if (
          !origin ||
          config.allowedOrigins.has(origin) ||
          config.billing.consoleOrigin === origin
        )
          return callback(null, true);
        if (config.devMode && origin.startsWith("chrome-extension://"))
          return callback(null, true);
        callback(
          new HTTPError(
            403,
            "origin_forbidden",
            "request origin is not allowed",
          ),
        );
      },
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Authorization", "Content-Type", "X-Request-ID"],
      exposedHeaders: ["X-Request-ID", "Retry-After"],
      maxAge: 600,
    }),
  );
  registerStripeWebhook(app, billing);
  app.use(express.json({ limit: "256kb", strict: true }));

  app.get("/healthz", (_req, res) => res.status(200).json({ status: "ok" }));
  app.get(
    "/readyz",
    asyncRoute(async (_req, res) => {
      const [vaultReady, billingReady] = await Promise.all([
        vault.ready().catch(() => false),
        billing
          ? billing.store.ready().catch(() => false)
          : Promise.resolve(true),
      ]);
      const ready = vaultReady && billingReady;
      res
        .status(ready ? 200 : 503)
        .json({ status: ready ? "ready" : "not_ready" });
    }),
  );

  registerConsoleRoutes(app, billing);

  app.use(authenticate(config, billing));
  app.use((req: AuthenticatedRequest, res, next) => {
    const result = limiter.consume(`${req.tenant}:${req.ip}`);
    if (!result.allowed) {
      res.setHeader("retry-after", String(result.retryAfter));
      next(new HTTPError(429, "rate_limited", "request rate limit exceeded"));
      return;
    }
    next();
  });

  const identityBody = (req: AuthenticatedRequest) => {
    const identity = parseIdentity(req);
    return { tenant: req.tenant!, ...identity };
  };

  const reserveUsage = async (
    req: AuthenticatedRequest,
    metric: "active_wallet" | "transaction_signed",
    idempotencyKey: string,
    walletKey?: string,
  ): Promise<UsageReservation | undefined> => {
    if (!billing || !req.accountId) return undefined;
    let scopedKey = idempotencyKey;
    if (metric === "active_wallet") {
      const account = await billing.store.getAccount(req.accountId);
      if (!account)
        throw new HTTPError(
          402,
          "payment_required",
          "Billing account not found",
        );
      scopedKey = `${account.billingPeriodStart.toISOString()}:${idempotencyKey}`;
    }
    return billing.store.reserveUsage({
      accountId: req.accountId,
      metric,
      idempotencyKey: scopedKey,
      walletKey,
      reservationTtlMs: billing.config.usageReservationTtlMs,
      properties: req.apiKeyId ? { api_key_id: req.apiKeyId } : {},
    });
  };

  const withActiveWalletUsage = async <T>(
    req: AuthenticatedRequest,
    identity: { username: string; chain: Chain },
    operation: () => Promise<T>,
  ): Promise<T> => {
    const walletKey =
      billing &&
      opaqueIdentifier(
        JSON.stringify([req.tenant, identity.username, identity.chain]),
        billing.config.apiKeyPepper!,
      );
    const reservation = walletKey
      ? await reserveUsage(req, "active_wallet", walletKey, walletKey)
      : undefined;
    if (
      reservation &&
      !reservation.created &&
      reservation.status === "reserved"
    ) {
      throw new HTTPError(
        409,
        "usage_in_progress",
        "A matching billable operation is already in progress",
      );
    }
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      if (reservation?.created)
        await billing!.store.cancelUsage(reservation.id);
      throw error;
    }
    if (reservation) await billing!.store.commitUsage(reservation.id);
    return result;
  };

  app.post(
    "/init",
    asyncRoute(async (req, res) => {
      requireScope(req, "wallets:write");
      res.status(200).json(await vault.post("users", identityBody(req)));
    }),
  );
  app.post(
    "/create",
    asyncRoute(async (req, res) => {
      requireScope(req, "wallets:write");
      const identity = parseIdentity(req);
      const ceremonyId = requireCeremonyID(req);
      const result = await withActiveWalletUsage(req, identity, () =>
        vault.post("users", {
          tenant: req.tenant!,
          ...identity,
          ceremonyId,
          credential: requireCredential(req, "registration"),
        }),
      );
      res.status(200).json(result);
    }),
  );
  app.post(
    "/check",
    asyncRoute(async (req, res) => {
      requireScope(req, "wallets:read");
      const identity = parseIdentity(req);
      const result = await withActiveWalletUsage(req, identity, () =>
        vault.post("check", { tenant: req.tenant!, ...identity }),
      );
      res.status(200).json(result);
    }),
  );
  app.post(
    "/signin",
    asyncRoute(async (req, res) => {
      requireScope(req, "signatures:create");
      const identity = parseIdentity(req);
      const signing = requireSigningRequest(req, config.maxPayloadBytes);
      const result = await withActiveWalletUsage(req, identity, () =>
        vault.post("auth", {
          tenant: req.tenant!,
          ...identity,
          ...signing,
        }),
      );
      res.status(200).json(result);
    }),
  );
  app.post(
    "/complete",
    asyncRoute(async (req, res) => {
      requireScope(req, "signatures:create");
      const identity = parseIdentity(req);
      const ceremonyId = requireCeremonyID(req);
      const operation = requireOperation(req);
      const reservation =
        operation === "transaction"
          ? await reserveUsage(req, "transaction_signed", ceremonyId)
          : undefined;
      if (
        reservation &&
        !reservation.created &&
        reservation.status === "reserved"
      ) {
        throw new HTTPError(
          409,
          "usage_in_progress",
          "A matching billable operation is already in progress",
        );
      }
      if (
        reservation &&
        !reservation.created &&
        reservation.status === "committed"
      ) {
        throw new HTTPError(
          409,
          "usage_already_committed",
          "This billable ceremony has already completed",
        );
      }
      let result;
      try {
        result = await vault.post("auth", {
          tenant: req.tenant!,
          ...identity,
          ceremonyId,
          operation,
          credential: requireCredential(req, "assertion"),
        });
      } catch (error) {
        if (reservation?.created)
          await billing!.store.cancelUsage(reservation.id);
        throw error;
      }
      if (result.operation !== operation) {
        if (reservation?.created)
          await billing!.store.cancelUsage(reservation.id);
        throw new HTTPError(
          502,
          "vault_operation_mismatch",
          "Vault signing operation did not match the requested operation",
        );
      }
      if (reservation) await billing!.store.commitUsage(reservation.id);
      res.status(200).json(result);
    }),
  );

  app.use((_req, _res, next) =>
    next(new HTTPError(404, "not_found", "route not found")),
  );
  app.use(
    (
      error: unknown,
      req: AuthenticatedRequest,
      res: Response,
      _next: NextFunction,
    ) => {
      let status = 500;
      let code = "internal_error";
      let message = "request failed";
      if (error instanceof HTTPError) {
        ({ status, code, message } = error);
      } else if (error instanceof BillingStateError) {
        status = error.kind === "payment_required" ? 402 : 429;
        code = error.kind;
        message = error.message;
      } else if (error instanceof VaultResponseError) {
        const detail = error.errors.join(" ").toLowerCase();
        if (detail.includes("404") || error.status === 404) {
          status = 404;
          code = "wallet_not_found";
        } else if (detail.includes("409")) {
          status = 409;
          code = "wallet_conflict";
        } else if (
          error.status === 400 ||
          detail.includes("credential") ||
          detail.includes("payload") ||
          detail.includes("webauthn") ||
          detail.includes("operation")
        ) {
          status = 422;
          code = "vault_rejected_request";
        } else {
          status = 502;
          code = "vault_error";
        }
        message = status >= 500 ? "Vault request failed" : error.message;
      } else if (error instanceof SyntaxError && "body" in error) {
        status = 400;
        code = "invalid_json";
        message = "request body must be valid JSON";
      }
      const startedAt = res.locals.startedAt as bigint | undefined;
      const durationMs = startedAt
        ? Number(process.hrtime.bigint() - startedAt) / 1e6
        : 0;
      console.error(
        JSON.stringify({
          level: status >= 500 ? "error" : "warn",
          requestId: req.requestId,
          method: req.method,
          path: req.path,
          status,
          tenant: req.tenant,
          durationMs: Math.round(durationMs),
        }),
      );
      res
        .status(status)
        .json({ error: { code, message }, requestId: req.requestId });
    },
  );

  return app;
}
