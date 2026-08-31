import { randomUUID, timingSafeEqual } from "node:crypto";
import express, { Application, NextFunction, Request, Response } from "express";
import Stripe from "stripe";
import {
  BillingRuntime,
  isMetronomeMappingCurrent,
  newAccountId,
} from "./runtime";
import {
  csrfToken,
  hashPassword,
  hashSessionToken,
  issueAPIKey,
  newSessionToken,
  validateScopes,
  verifyPassword,
} from "./security";
import { Account, ConsoleRole, ConsoleUser } from "./types";

interface SessionContext {
  rawToken: string;
  user: ConsoleUser;
}

const loginAttempts = new Map<string, { startedAt: number; count: number }>();

function route(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => void handler(req, res).catch(next);
}

function escapeHTML(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function layout(title: string, content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(title)} · Spiral Safe</title><link rel="stylesheet" href="/console.css"></head><body><main><header><a href="/developer">Spiral Safe</a><span>Account console</span></header>${content}</main></body></html>`;
}

function cookieName(devMode: boolean): string {
  return devMode ? "spiral_session" : "__Host-spiral_session";
}

function cookies(req: Request): Map<string, string> {
  const values = new Map<string, string>();
  for (const item of (req.get("cookie") || "").split(";")) {
    const separator = item.indexOf("=");
    if (separator > 0) {
      values.set(
        item.slice(0, separator).trim(),
        decodeURIComponent(item.slice(separator + 1)),
      );
    }
  }
  return values;
}

function setSessionCookie(
  res: Response,
  runtime: BillingRuntime,
  token: string,
): void {
  const secure = runtime.config.mode !== "memory";
  res.append(
    "Set-Cookie",
    `${cookieName(!secure)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(runtime.config.sessionTtlMs / 1000)}${secure ? "; Secure" : ""}`,
  );
}

function clearSessionCookie(res: Response, runtime: BillingRuntime): void {
  const secure = runtime.config.mode !== "memory";
  res.append(
    "Set-Cookie",
    `${cookieName(!secure)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`,
  );
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function exactOrigin(req: Request, runtime: BillingRuntime): boolean {
  return req.get("origin") === runtime.config.consoleOrigin;
}

async function session(
  req: Request,
  runtime: BillingRuntime,
): Promise<SessionContext | undefined> {
  const rawToken = cookies(req).get(
    cookieName(runtime.config.mode === "memory"),
  );
  if (!rawToken) return undefined;
  const found = await runtime.store.findSessionByHash(
    hashSessionToken(rawToken, runtime.config.sessionSecret!),
  );
  return found && { rawToken, user: found.user };
}

async function requireSession(
  req: Request,
  res: Response,
  runtime: BillingRuntime,
  role: ConsoleRole,
): Promise<SessionContext | undefined> {
  const context = await session(req, runtime);
  if (!context || context.user.role !== role) {
    res.redirect(303, `/${role}/login`);
    return undefined;
  }
  return context;
}

function verifyMutation(
  req: Request,
  res: Response,
  runtime: BillingRuntime,
  context: SessionContext,
): boolean {
  const supplied = String(req.body?.csrf || req.get("x-csrf-token") || "");
  const expected = csrfToken(context.rawToken, runtime.config.sessionSecret!);
  if (!exactOrigin(req, runtime) || !same(supplied, expected)) {
    res.status(403).type("text").send("Cross-site request rejected");
    return false;
  }
  return true;
}

function limitedLogin(req: Request, email: string): boolean {
  const now = Date.now();
  const key = `${req.ip}:${email.trim().toLowerCase()}`;
  const entry = loginAttempts.get(key);
  if (!entry || entry.startedAt + 15 * 60_000 <= now) {
    if (entry) loginAttempts.delete(key);
    if (loginAttempts.size >= 10_000) {
      for (const [candidate, value] of loginAttempts) {
        if (value.startedAt + 15 * 60_000 <= now) {
          loginAttempts.delete(candidate);
        }
      }
      if (loginAttempts.size >= 10_000) return true;
    }
    loginAttempts.set(key, { startedAt: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > 5;
}

function loginPage(role: ConsoleRole, error = ""): string {
  return layout(
    `${role} login`,
    `<section class="card"><h1>${role === "admin" ? "Administrator" : "Developer"} login</h1>${error ? `<p class="error">${escapeHTML(error)}</p>` : ""}<form method="post" action="/${role}/login"><label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form></section>`,
  );
}

function csrfField(context: SessionContext, runtime: BillingRuntime): string {
  return `<input type="hidden" name="csrf" value="${escapeHTML(csrfToken(context.rawToken, runtime.config.sessionSecret!))}">`;
}

async function developerPage(
  runtime: BillingRuntime,
  context: SessionContext,
): Promise<string> {
  const account = await runtime.store.getAccount(context.user.accountId!);
  if (!account) throw new Error("developer account is missing");
  const [plans, keys, usage] = await Promise.all([
    runtime.store.listPlans(),
    runtime.store.listAPIKeys(account.id),
    runtime.store.usageSummary(account.id),
  ]);
  const csrf = csrfField(context, runtime);
  const mappingCurrent = isMetronomeMappingCurrent(account, plans);
  const planOptions = plans
    .filter((plan) => plan.stripePriceId)
    .map(
      (plan) =>
        `<option value="${escapeHTML(plan.id)}">${escapeHTML(plan.name)}</option>`,
    )
    .join("");
  const keyRows = keys
    .map(
      (key) =>
        `<tr><td>${escapeHTML(key.name)}</td><td><code>${escapeHTML(key.prefix)}…</code></td><td>${escapeHTML(key.scopes.join(", "))}</td><td>${escapeHTML(key.users.join(", "))}</td><td>${key.revokedAt ? "revoked" : "active"}</td><td>${key.revokedAt ? "" : `<form method="post" action="/developer/api-keys/${encodeURIComponent(key.id)}/revoke">${csrf}<button class="secondary" type="submit">Revoke</button></form>`}</td></tr>`,
    )
    .join("");
  const dailyRows = usage.daily
    .map(
      (day) =>
        `<tr><td>${escapeHTML(day.date)}</td><td>${day.activeWallets}</td><td>${day.transactions}</td></tr>`,
    )
    .join("");
  const rateSummary =
    usage.walletUnitAmount === null || usage.transactionUnitAmount === null
      ? "Unit estimates are not configured for this plan."
      : `Operator estimate: ${usage.walletUnitAmount} minor units per active wallet and ${usage.transactionUnitAmount} per transaction; current period ${usage.estimatedPeriodAmount} minor units.`;
  return layout(
    "Developer",
    `<nav><a href="/developer">Developer</a><form method="post" action="/developer/logout">${csrf}<button class="link" type="submit">Sign out</button></form></nav>
    <section class="card" data-recording="developer-overview"><h1>${escapeHTML(account.name)}</h1><p>Tenant <code>${escapeHTML(account.tenant)}</code> · plan <strong>${escapeHTML(account.planId)}</strong> · status <strong>${escapeHTML(account.status)}</strong>${runtime.config.metronome ? ` · usage invoicing <strong>${mappingCurrent ? "verified" : "provisioning required"}</strong>` : ""}</p></section>
    <section class="card" data-recording="developer-usage"><h2>Current usage</h2><div class="metrics"><p><strong>${usage.activeWallets}</strong><span>active wallets / ${usage.activeWalletLimit ?? "unlimited"}</span></p><p><strong>${usage.transactions}</strong><span>transactions / ${usage.transactionLimit ?? "unlimited"}</span></p></div><p>${escapeHTML(rateSummary)} Metronome remains the usage-rating authority when configured.</p><table><thead><tr><th>UTC day</th><th>Active wallets</th><th>Transactions</th></tr></thead><tbody>${dailyRows || `<tr><td colspan="3">No committed usage this period.</td></tr>`}</tbody></table></section>
    <section class="card" data-recording="developer-api-keys"><h2>API keys</h2><p>Secrets appear once. Store them in a secrets manager.</p><table><thead><tr><th>Name</th><th>Prefix</th><th>Scopes</th><th>Users</th><th>Status</th><th></th></tr></thead><tbody>${keyRows || `<tr><td colspan="6">No keys yet.</td></tr>`}</tbody></table><h3>Create a scoped key</h3><form method="post" action="/developer/api-keys"><label>Name<input name="name" maxlength="100" required></label><label>Users (comma-separated)<input name="users" placeholder="alice" required></label><fieldset><legend>Scopes</legend><label><input type="checkbox" name="scopes" value="wallets:read" checked> Read wallets</label><label><input type="checkbox" name="scopes" value="wallets:write" checked> Register wallets</label><label><input type="checkbox" name="scopes" value="signatures:create" checked> Create signatures</label></fieldset>${csrf}<button type="submit" data-recording="developer-create-key">Create key</button></form></section>
    <section class="card"><h2>Subscription</h2>${runtime.stripe && planOptions ? `${account.stripeSubscriptionId ? `<p>An existing subscription must be changed in the Customer Portal.</p>` : `<form method="post" action="/developer/billing/checkout"><label>Plan<select name="planId">${planOptions}</select></label>${csrf}<button type="submit">Open hosted Checkout</button></form>`}<form method="post" action="/developer/billing/portal">${csrf}<button class="secondary" type="submit">Manage subscription</button></form>` : `<p>Stripe is not configured in this environment.</p>`}</section>`,
  );
}

async function adminPage(
  runtime: BillingRuntime,
  context: SessionContext,
): Promise<string> {
  const [summary, accounts, plans] = await Promise.all([
    runtime.store.adminSummary(),
    runtime.store.listAccounts(),
    runtime.store.listPlans(),
  ]);
  const csrf = csrfField(context, runtime);
  const accountRows = accounts
    .map(
      (account) =>
        `<tr><td>${escapeHTML(account.name)}</td><td><code>${escapeHTML(account.tenant)}</code></td><td>${escapeHTML(account.planId)}</td><td>${escapeHTML(account.status)}</td><td><a href="/admin?account=${encodeURIComponent(account.id)}" data-recording="admin-select-tenant">Inspect</a></td></tr>`,
    )
    .join("");
  const planOptions = plans
    .map(
      (plan) =>
        `<option value="${escapeHTML(plan.id)}">${escapeHTML(plan.name)}</option>`,
    )
    .join("");
  let selected = "";
  const selectedId =
    typeof (context as any).selectedAccountId === "string"
      ? (context as any).selectedAccountId
      : "";
  if (selectedId) {
    const account = await runtime.store.getAccount(selectedId);
    if (account) {
      const usage = await runtime.store.usageSummary(account.id);
      const mappingCurrent = isMetronomeMappingCurrent(account, plans);
      const selectedPlan = plans.find((plan) => plan.id === account.planId);
      const verifyMapping =
        runtime.config.metronome &&
        account.stripeCustomerId &&
        selectedPlan?.metronomeRateCardId &&
        !mappingCurrent
          ? `<form method="post" action="/admin/accounts/${encodeURIComponent(account.id)}/metronome-verified">${csrf}<p>Confirm the exact values independently in Stripe and Metronome. Stored provider identifiers are not rendered into this page or its recordings.</p><label>Local plan ID<input name="planId" value="${escapeHTML(selectedPlan.id)}" readonly required></label><label>Stripe customer ID<input name="stripeCustomerId" autocomplete="off" maxlength="255" required></label><label>Metronome customer ingest alias<input name="metronomeCustomerId" autocomplete="off" maxlength="255" required></label><label>Metronome rate card ID<input name="metronomeRateCardId" autocomplete="off" maxlength="255" required></label><button type="submit">Verify and attest mapping</button></form>`
          : "";
      const safeAccount = {
        name: account.name,
        tenant: account.tenant,
        status: account.status,
        planId: account.planId,
        usageInvoicing: runtime.config.metronome
          ? mappingCurrent
            ? "verified"
            : "provisioning required"
          : "not configured",
      };
      selected = `<section class="card"><h2>${escapeHTML(account.name)}</h2><pre>${escapeHTML(JSON.stringify({ account: safeAccount, usage }, null, 2))}</pre>${verifyMapping}</section>`;
    }
  }
  return layout(
    "Admin",
    `<nav><a href="/admin">Admin</a><form method="post" action="/admin/logout">${csrf}<button class="link" type="submit">Sign out</button></form></nav>
    <section class="card" data-recording="admin-overview"><h1>Platform overview</h1><div class="metrics"><p><strong>${summary.accounts}</strong><span>accounts</span></p><p><strong>${summary.activeWallets}</strong><span>active-wallet units in current account periods</span></p><p><strong>${summary.transactions}</strong><span>transactions in current account periods</span></p><p><strong>${summary.estimatedCurrentPeriodAmount ?? "n/a"}</strong><span>operator-estimated minor units in current account periods</span></p></div><p>Usage totals follow each account's current billing period. Estimates use configured unit rates; Metronome is authoritative when enabled.</p></section>
    <section class="card" data-recording="admin-tenants"><h2>Accounts</h2><table><thead><tr><th>Name</th><th>Tenant</th><th>Plan</th><th>Status</th><th></th></tr></thead><tbody>${accountRows || `<tr><td colspan="5">No accounts.</td></tr>`}</tbody></table><h3>Create account</h3><form method="post" action="/admin/accounts"><label>Name<input name="name" required maxlength="120"></label><label>Tenant<input name="tenant" required maxlength="64"></label><label>Developer email<input type="email" name="email" required></label><label>Temporary password<input type="password" name="password" minlength="12" required></label><label>Plan<select name="planId">${planOptions}</select></label>${csrf}<button type="submit">Create account</button></form></section>
    ${selected}<section class="card" data-recording="admin-audit"><h2>Delivery audit</h2><p>${summary.pendingOutbox} pending · ${summary.deadLetterOutbox} dead-letter usage records</p></section>`,
  );
}

export function registerStripeWebhook(
  app: Application,
  runtime?: BillingRuntime,
): void {
  app.post(
    "/billing/stripe/webhook",
    express.raw({ type: "application/json", limit: "1mb" }),
    route(async (req, res) => {
      if (!runtime?.stripe) {
        res
          .status(404)
          .json({ error: { code: "not_found", message: "route not found" } });
        return;
      }
      const signature = req.get("stripe-signature");
      if (!signature || !Buffer.isBuffer(req.body)) {
        res.status(400).json({
          error: { code: "invalid_signature", message: "invalid webhook" },
        });
        return;
      }
      let event: Stripe.Event;
      try {
        event = runtime.stripe.constructEvent(req.body, signature);
      } catch {
        res.status(400).json({
          error: { code: "invalid_webhook", message: "invalid webhook" },
        });
        return;
      }
      try {
        await runtime.stripe.processEvent(event, runtime.store);
        res.status(200).json({ received: true });
      } catch (error) {
        const busy =
          error instanceof Error &&
          error.message.includes("already being processed");
        res.status(busy ? 503 : 500).json({
          error: {
            code: busy ? "webhook_busy" : "webhook_processing_failed",
            message: "webhook delivery should be retried",
          },
        });
      }
    }),
  );
}

export function registerConsoleRoutes(
  app: Application,
  runtime?: BillingRuntime,
): void {
  app.get("/console.css", (_req, res) => {
    res
      .type("css")
      .send(
        `:root{font-family:Inter,system-ui,sans-serif;color:#14213d;background:#f4f7fb}*{box-sizing:border-box}body{margin:0}main{max-width:1100px;margin:auto;padding:2rem}header,nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem}a{color:#2255aa}.card{background:white;border:1px solid #dce3ef;border-radius:14px;padding:1.4rem;margin:1rem 0;box-shadow:0 8px 30px #1020400d}label{display:block;margin:.8rem 0}input,select{display:block;width:100%;max-width:32rem;padding:.65rem;border:1px solid #aab6c8;border-radius:7px}button{background:#2458cc;color:white;border:0;border-radius:7px;padding:.7rem 1rem;cursor:pointer}.secondary,.link{background:#e8eef9;color:#18366f}.metrics{display:flex;gap:1rem;flex-wrap:wrap}.metrics p{display:flex;flex-direction:column;min-width:150px}.metrics strong{font-size:2rem}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid #e3e8f0;padding:.65rem;vertical-align:top}code,pre{overflow:auto}.error{color:#9d1c1c}`,
      );
  });
  if (!runtime) return;
  const dummyPasswordHash = hashPassword(
    "spiral-safe-dummy-password-not-an-account",
  );
  app.use(
    ["/developer", "/admin"],
    express.urlencoded({ extended: false, limit: "32kb" }),
  );

  for (const role of ["developer", "admin"] as const) {
    app.get(`/${role}/login`, (_req, res) =>
      res.status(200).type("html").send(loginPage(role)),
    );
    app.post(
      `/${role}/login`,
      route(async (req, res) => {
        const email = typeof req.body?.email === "string" ? req.body.email : "";
        const password =
          typeof req.body?.password === "string" ? req.body.password : "";
        const rateLimited = limitedLogin(req, email);
        const user = await runtime.store.findConsoleUserByEmail(email);
        const passwordValid = await verifyPassword(
          password,
          user?.passwordHash || (await dummyPasswordHash),
        );
        const valid =
          !rateLimited &&
          exactOrigin(req, runtime) &&
          !!user &&
          user.role === role &&
          !user.disabledAt &&
          passwordValid;
        if (!valid) {
          res
            .status(rateLimited ? 429 : 401)
            .type("html")
            .send(loginPage(role, "Invalid credentials"));
          return;
        }
        const rawToken = newSessionToken();
        await runtime.store.createSession({
          id: randomUUID(),
          userId: user.id,
          tokenHash: hashSessionToken(rawToken, runtime.config.sessionSecret!),
          expiresAt: new Date(Date.now() + runtime.config.sessionTtlMs),
          createdAt: new Date(),
        });
        setSessionCookie(res, runtime, rawToken);
        res.redirect(303, `/${role}`);
      }),
    );
    app.post(
      `/${role}/logout`,
      route(async (req, res) => {
        const context = await session(req, runtime);
        if (context && verifyMutation(req, res, runtime, context)) {
          await runtime.store.deleteSession(
            hashSessionToken(context.rawToken, runtime.config.sessionSecret!),
          );
          clearSessionCookie(res, runtime);
          res.redirect(303, `/${role}/login`);
        } else if (!context) {
          clearSessionCookie(res, runtime);
          res.redirect(303, `/${role}/login`);
        }
      }),
    );
  }

  app.get(
    "/developer",
    route(async (req, res) => {
      const context = await requireSession(req, res, runtime, "developer");
      if (context)
        res
          .status(200)
          .type("html")
          .send(await developerPage(runtime, context));
    }),
  );
  app.get(
    "/developer/api/usage",
    route(async (req, res) => {
      const context = await requireSession(req, res, runtime, "developer");
      if (context)
        res
          .status(200)
          .json(await runtime.store.usageSummary(context.user.accountId!));
    }),
  );
  app.post(
    "/developer/api-keys",
    route(async (req, res) => {
      const context = await requireSession(req, res, runtime, "developer");
      if (!context || !verifyMutation(req, res, runtime, context)) return;
      try {
        const scopes = validateScopes(
          Array.isArray(req.body.scopes)
            ? req.body.scopes
            : [req.body.scopes].filter(Boolean),
        );
        const users = String(req.body.users || "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        const issued = await issueAPIKey(
          runtime.store,
          runtime.config.apiKeyPepper!,
          {
            accountId: context.user.accountId!,
            name: String(req.body.name || ""),
            scopes,
            users,
            live: runtime.config.mode === "postgres",
          },
        );
        res
          .status(201)
          .type("html")
          .send(
            layout(
              "API key created",
              `<section class="card"><h1>Copy this key now</h1><p>It will not be shown again.</p><code>${escapeHTML(issued.secret)}</code><p><a href="/developer">Return to dashboard</a></p></section>`,
            ),
          );
      } catch (error) {
        res
          .status(400)
          .type("text")
          .send(error instanceof Error ? error.message : "invalid key");
      }
    }),
  );
  app.post(
    "/developer/api-keys/:id/revoke",
    route(async (req, res) => {
      const context = await requireSession(req, res, runtime, "developer");
      if (!context || !verifyMutation(req, res, runtime, context)) return;
      await runtime.store.revokeAPIKey(
        context.user.accountId!,
        String(req.params.id),
        new Date(),
      );
      res.redirect(303, "/developer");
    }),
  );
  app.post(
    "/developer/billing/checkout",
    route(async (req, res) => {
      const context = await requireSession(req, res, runtime, "developer");
      if (!context || !verifyMutation(req, res, runtime, context)) return;
      if (!runtime.stripe) {
        res.status(503).type("text").send("Stripe is not configured");
        return;
      }
      const account = await runtime.store.getAccount(context.user.accountId!);
      const plan = (await runtime.store.listPlans()).find(
        (item) => item.id === req.body.planId,
      );
      if (!account || !plan) {
        res.status(404).type("text").send("Account or plan not found");
        return;
      }
      if (account.stripeSubscriptionId) {
        res
          .status(409)
          .type("text")
          .send("Use the Customer Portal to manage the existing subscription");
        return;
      }
      const checkout = await runtime.stripe.createCheckout(account, plan);
      res.redirect(303, checkout.url);
    }),
  );
  app.post(
    "/developer/billing/portal",
    route(async (req, res) => {
      const context = await requireSession(req, res, runtime, "developer");
      if (!context || !verifyMutation(req, res, runtime, context)) return;
      if (!runtime.stripe) {
        res.status(503).type("text").send("Stripe is not configured");
        return;
      }
      const account = await runtime.store.getAccount(context.user.accountId!);
      if (!account) {
        res.status(404).type("text").send("Account not found");
        return;
      }
      const portal = await runtime.stripe.createPortal(account);
      res.redirect(303, portal.url);
    }),
  );

  app.get(
    "/admin",
    route(async (req, res) => {
      const context = await requireSession(req, res, runtime, "admin");
      if (!context) return;
      (context as any).selectedAccountId =
        typeof req.query.account === "string" ? req.query.account : "";
      res
        .status(200)
        .type("html")
        .send(await adminPage(runtime, context));
    }),
  );
  app.get(
    "/admin/api/analytics",
    route(async (req, res) => {
      const context = await requireSession(req, res, runtime, "admin");
      if (!context) return;
      const accounts = await runtime.store.listAccounts();
      res.status(200).json({
        aggregate: await runtime.store.adminSummary(),
        accounts: await Promise.all(
          accounts.map(async (account) => ({
            account: { ...account, email: undefined },
            usage: await runtime.store.usageSummary(account.id),
          })),
        ),
      });
    }),
  );
  app.post(
    "/admin/accounts",
    route(async (req, res) => {
      const context = await requireSession(req, res, runtime, "admin");
      if (!context || !verifyMutation(req, res, runtime, context)) return;
      const tenant = String(req.body.tenant || "");
      const name = String(req.body.name || "");
      const email = String(req.body.email || "")
        .trim()
        .toLowerCase();
      const password = String(req.body.password || "");
      const planId = String(req.body.planId || "");
      if (
        !/^[A-Za-z0-9](?:[A-Za-z0-9._@-]{0,63})$/.test(tenant) ||
        !name ||
        name.length > 120 ||
        !/^\S+@\S+\.\S+$/.test(email) ||
        !(await runtime.store.listPlans()).some((plan) => plan.id === planId)
      ) {
        res.status(400).type("text").send("Invalid account fields");
        return;
      }
      const id = newAccountId();
      const now = new Date();
      const periodEnd = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
      );
      const account: Account = {
        id,
        tenant,
        name,
        email,
        status: "past_due",
        planId,
        metronomeCustomerId: `spiral_${id}`,
        billingPeriodStart: now,
        billingPeriodEnd: periodEnd,
        createdAt: now,
        updatedAt: now,
      };
      try {
        const developer: ConsoleUser = {
          id: randomUUID(),
          accountId: account.id,
          email,
          role: "developer",
          passwordHash: await hashPassword(password),
          createdAt: now,
        };
        await runtime.store.createAccountWithDeveloper(account, developer);
        res.redirect(303, `/admin?account=${encodeURIComponent(account.id)}`);
      } catch {
        res.status(409).type("text").send("Account could not be created");
      }
    }),
  );
  app.post(
    "/admin/accounts/:id/metronome-verified",
    route(async (req, res) => {
      const context = await requireSession(req, res, runtime, "admin");
      if (!context || !verifyMutation(req, res, runtime, context)) return;
      if (!runtime.config.metronome) {
        res.status(409).type("text").send("Metronome is not configured");
        return;
      }
      try {
        const account = await runtime.store.getAccount(String(req.params.id));
        const plan = (await runtime.store.listPlans()).find(
          (item) => item.id === account?.planId,
        );
        const suppliedStripeCustomer = String(req.body.stripeCustomerId || "");
        const suppliedMetronomeCustomer = String(
          req.body.metronomeCustomerId || "",
        );
        const suppliedPlan = String(req.body.planId || "");
        const suppliedRateCard = String(req.body.metronomeRateCardId || "");
        if (
          !account?.stripeCustomerId ||
          !plan?.metronomeRateCardId ||
          suppliedStripeCustomer !== account.stripeCustomerId ||
          suppliedMetronomeCustomer !== account.metronomeCustomerId ||
          suppliedPlan !== account.planId ||
          suppliedRateCard !== plan.metronomeRateCardId
        ) {
          throw new Error(
            "provider mapping does not match local account state",
          );
        }
        const verified = await runtime.store.markMetronomeStripeMappingVerified(
          account.id,
          {
            stripeCustomerId: suppliedStripeCustomer,
            metronomeCustomerId: suppliedMetronomeCustomer,
            planId: suppliedPlan,
            metronomeRateCardId: suppliedRateCard,
          },
          new Date(),
        );
        if (!verified) {
          throw new Error("provider mapping changed during verification");
        }
        res.redirect(
          303,
          `/admin?account=${encodeURIComponent(String(req.params.id))}`,
        );
      } catch {
        res
          .status(409)
          .type("text")
          .send(
            "Provider mapping does not match the selected account and plan",
          );
      }
    }),
  );
}
