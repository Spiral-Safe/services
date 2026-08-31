import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { BillingConfig, loadBillingConfig } from "./billing/config";

export const SUPPORTED_CHAINS = ["solana", "ethereum"] as const;
export type Chain = (typeof SUPPORTED_CHAINS)[number];

export interface APIPrincipal {
  tenant: string;
  /** Undefined is permitted only for explicit development-mode wildcard access. */
  users?: Set<string>;
}

export interface ServiceConfig {
  devMode: boolean;
  port: number;
  trustProxy: boolean | number;
  apiTokenHashes: Map<string, APIPrincipal>;
  allowedOrigins: Set<string>;
  vaultAddress: string;
  vaultToken?: string;
  vaultKubernetes?: {
    role: string;
    jwtPath: string;
    authPath: string;
  };
  rateLimitWindowMs: number;
  rateLimitMax: number;
  rateLimitBuckets: number;
  maxPayloadBytes: number;
  billing: BillingConfig;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`expected a positive integer, received ${value}`);
  }
  return parsed;
}

function parseJSONMap(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      `${label} must be a JSON object mapping credentials to tenants`,
    );
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(
      `${label} must be a JSON object mapping credentials to tenants`,
    );
  }
  return parsed as Record<string, unknown>;
}

export function hashAPIToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function parseTokens(
  env: NodeJS.ProcessEnv,
  devMode: boolean,
): Map<string, APIPrincipal> {
  const hashes = new Map<string, APIPrincipal>();
  if (env.API_TOKENS) {
    for (const [token, value] of Object.entries(
      parseJSONMap(env.API_TOKENS, "API_TOKENS"),
    )) {
      if (!devMode && token.length < 24) {
        throw new Error(
          "production API tokens must contain at least 24 characters",
        );
      }
      hashes.set(
        hashAPIToken(token),
        parsePrincipal(value, "API_TOKENS", devMode),
      );
    }
  }
  if (env.API_TOKEN) {
    if (!devMode && env.API_TOKEN.length < 24) {
      throw new Error(
        "production API tokens must contain at least 24 characters",
      );
    }
    const users = (env.API_USERS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!devMode && users.length === 0) {
      throw new Error(
        "production API_TOKEN requires a non-empty API_USERS allowlist",
      );
    }
    hashes.set(hashAPIToken(env.API_TOKEN), {
      tenant: env.API_TENANT || "local",
      ...(users.length > 0 ? { users: new Set(users) } : {}),
    });
  }
  if (env.API_TOKEN_HASHES) {
    for (const [hash, value] of Object.entries(
      parseJSONMap(env.API_TOKEN_HASHES, "API_TOKEN_HASHES"),
    )) {
      if (!/^[a-f0-9]{64}$/i.test(hash)) {
        throw new Error("API_TOKEN_HASHES keys must be SHA-256 hex");
      }
      hashes.set(
        hash.toLowerCase(),
        parsePrincipal(value, "API_TOKEN_HASHES", devMode),
      );
    }
  }
  return hashes;
}

function parsePrincipal(
  value: unknown,
  label: string,
  devMode: boolean,
): APIPrincipal {
  if (typeof value === "string") {
    if (!devMode) {
      throw new Error(
        `${label} production values must be {"tenant":"...","users":["..."]}`,
      );
    }
    return { tenant: value };
  }
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} values must define tenant and users`);
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.tenant !== "string" ||
    !Array.isArray(candidate.users) ||
    candidate.users.length === 0 ||
    !candidate.users.every((user) => typeof user === "string")
  ) {
    throw new Error(
      `${label} values must define a tenant and non-empty users array`,
    );
  }
  return {
    tenant: candidate.tenant,
    users: new Set(candidate.users as string[]),
  };
}

function validateIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._@-]{0,63})$/.test(value)) {
    throw new Error(`${label} must be 1-64 safe identifier characters`);
  }
}

function parseVaultAddress(value: string, devMode: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("VAULT_ADDRESS must be an absolute HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    throw new Error(
      "VAULT_ADDRESS must be an HTTP(S) origin without credentials, path, query, or fragment",
    );
  }
  if (!devMode && parsed.protocol !== "https:") {
    throw new Error("VAULT_ADDRESS must use HTTPS outside development mode");
  }
  if (devMode && parsed.protocol === "http:") {
    const allowedDevelopmentHosts = new Set([
      "localhost",
      "127.0.0.1",
      "[::1]",
      "::1",
      "vault", // Docker Compose service DNS; the published ports remain loopback-only.
    ]);
    if (!allowedDevelopmentHosts.has(parsed.hostname)) {
      throw new Error(
        "development HTTP VAULT_ADDRESS must be loopback or the local Compose vault service",
      );
    }
  }
  return parsed.origin;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServiceConfig {
  const devMode = env.SERVICE_DEV_MODE === "true";
  const apiTokenHashes = parseTokens(env, devMode);
  const billing = loadBillingConfig(env, devMode);
  if (!devMode && billing.mode !== "disabled" && apiTokenHashes.size > 0) {
    throw new Error(
      "production billing mode uses database-backed API keys; remove static API token mappings",
    );
  }
  const allowedOrigins = new Set(
    (env.CORS_ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  const vaultToken = env.VAULT_TOKEN;
  const kubernetesRole = env.VAULT_K8S_ROLE;

  if (apiTokenHashes.size === 0 && billing.mode === "disabled") {
    throw new Error("API_TOKEN_HASHES, API_TOKENS, or API_TOKEN is required");
  }
  for (const principal of apiTokenHashes.values()) {
    validateIdentifier(principal.tenant, "API tenant");
    for (const user of principal.users || []) {
      validateIdentifier(user, "authorized API user");
    }
  }
  if (allowedOrigins.size === 0) {
    throw new Error("CORS_ALLOWED_ORIGINS is required");
  }
  for (const origin of allowedOrigins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`invalid CORS origin: ${origin}`);
    }
    if (
      !devMode &&
      parsed.protocol !== "https:" &&
      parsed.protocol !== "chrome-extension:"
    ) {
      throw new Error(
        `production CORS origin must use HTTPS or chrome-extension: ${origin}`,
      );
    }
    if (
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== "" && parsed.pathname !== "/") ||
      origin !== `${parsed.protocol}//${parsed.host}`
    ) {
      throw new Error(
        `CORS allowlist entries must be exact origins: ${origin}`,
      );
    }
  }
  if (!devMode && vaultToken) {
    throw new Error(
      "VAULT_TOKEN is forbidden outside development mode; use VAULT_K8S_ROLE for short-lived workload authentication",
    );
  }
  if (!vaultToken && !kubernetesRole) {
    throw new Error("VAULT_TOKEN or VAULT_K8S_ROLE is required");
  }

  const authPath = (env.VAULT_K8S_AUTH_PATH || "auth/kubernetes")
    .replace(/^\/+|\/+$/g, "")
    .trim();
  if (authPath.includes("..") || !/^[A-Za-z0-9_./-]+$/.test(authPath)) {
    throw new Error("VAULT_K8S_AUTH_PATH is invalid");
  }

  return {
    devMode,
    port: positiveInteger(env.PORT, 3000),
    trustProxy: env.TRUST_PROXY ? positiveInteger(env.TRUST_PROXY, 1) : false,
    apiTokenHashes,
    allowedOrigins,
    vaultAddress: parseVaultAddress(
      env.VAULT_ADDRESS || env.VAULT_ADDR || "http://127.0.0.1:8200",
      devMode,
    ),
    vaultToken,
    vaultKubernetes: kubernetesRole
      ? {
          role: kubernetesRole,
          jwtPath:
            env.VAULT_K8S_JWT_PATH ||
            "/var/run/secrets/kubernetes.io/serviceaccount/token",
          authPath,
        }
      : undefined,
    rateLimitWindowMs: positiveInteger(env.RATE_LIMIT_WINDOW_MS, 60_000),
    rateLimitMax: positiveInteger(env.RATE_LIMIT_MAX, devMode ? 300 : 60),
    rateLimitBuckets: positiveInteger(env.RATE_LIMIT_BUCKETS, 10_000),
    maxPayloadBytes: positiveInteger(env.MAX_SIGNING_PAYLOAD_BYTES, 128 * 1024),
    billing,
  };
}

export async function readKubernetesJWT(path: string): Promise<string> {
  const jwt = (await readFile(path, "utf8")).trim();
  if (!jwt) throw new Error("Kubernetes service-account token is empty");
  return jwt;
}
