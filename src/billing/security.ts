import {
  createHmac,
  randomBytes,
  randomUUID,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";
import { APIKeyRecord, API_SCOPES, APIScope, BillingStore } from "./types";

function derivePassword(
  password: string,
  salt: Buffer,
  length: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      length,
      { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, derived) => (error ? reject(error) : resolve(derived)),
    );
  });
}

function equal(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export function hashSecret(secret: string, pepper: string): string {
  return createHmac("sha256", pepper).update(secret).digest("hex");
}

export function hashSessionToken(token: string, secret: string): string {
  return hashSecret(`session:${token}`, secret);
}

export function csrfToken(token: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`csrf:${token}`)
    .digest("base64url");
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 1024) {
    throw new Error("password must contain 12-1024 characters");
  }
  const salt = randomBytes(16);
  const derived = await derivePassword(password, salt, 32);
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [algorithm, n, r, p, saltValue, hashValue] = encoded.split("$");
  if (
    algorithm !== "scrypt" ||
    n !== "16384" ||
    r !== "8" ||
    p !== "1" ||
    !saltValue ||
    !hashValue ||
    password.length > 1024
  ) {
    return false;
  }
  try {
    const salt = Buffer.from(saltValue, "base64url");
    const expected = Buffer.from(hashValue, "base64url");
    const derived = await derivePassword(password, salt, expected.length);
    return equal(derived, expected);
  } catch {
    return false;
  }
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function validateScopes(value: unknown): APIScope[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("at least one scope is required");
  const scopes = [...new Set(value)];
  if (
    !scopes.every((scope): scope is APIScope =>
      API_SCOPES.includes(scope as APIScope),
    )
  ) {
    throw new Error(`scopes must be selected from ${API_SCOPES.join(", ")}`);
  }
  return scopes;
}

export async function issueAPIKey(
  store: BillingStore,
  pepper: string,
  input: {
    accountId: string;
    name: string;
    scopes: APIScope[];
    users: string[];
    live: boolean;
  },
): Promise<{ secret: string; record: APIKeyRecord }> {
  const suffix = randomBytes(5).toString("hex");
  const prefix = `ssk_${input.live ? "live" : "test"}_${suffix}`;
  const secret = `${prefix}.${randomBytes(32).toString("base64url")}`;
  const record: APIKeyRecord = {
    id: randomUUID(),
    accountId: input.accountId,
    name: input.name.trim(),
    prefix,
    secretHash: hashSecret(secret, pepper),
    scopes: [...input.scopes],
    users: [...new Set(input.users)],
    createdAt: new Date(),
  };
  if (!record.name || record.name.length > 100)
    throw new Error("API key name is invalid");
  if (
    record.users.length === 0 ||
    !record.users.every((user) =>
      /^[A-Za-z0-9](?:[A-Za-z0-9._@-]{0,63})$/.test(user),
    )
  ) {
    throw new Error("API key users must contain safe tenant-local identifiers");
  }
  await store.createAPIKey(record);
  return { secret, record };
}

export function opaqueIdentifier(value: string, pepper: string): string {
  return createHmac("sha256", pepper)
    .update("spiral-safe:wallet-identifier:v1\0")
    .update(value)
    .digest("base64url");
}
