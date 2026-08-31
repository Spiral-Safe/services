import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { PostgresBillingStore } from "./postgres-store";
import { hashPassword } from "./security";

export function parseAdminBootstrapArgs(args: string[]): {
  email: string;
  passwordFile: string;
} {
  if (
    args.includes("--password") ||
    args.some((arg) => arg.startsWith("--password="))
  ) {
    throw new Error(
      "plaintext password arguments are forbidden; use --password-file",
    );
  }
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!value || !["--email", "--password-file"].includes(key)) {
      throw new Error("usage: --email <address> --password-file <path>");
    }
    values.set(key, value);
  }
  const email = (values.get("--email") || "").trim().toLowerCase();
  const passwordFile = values.get("--password-file") || "";
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 320 || !passwordFile) {
    throw new Error("a valid email and password file are required");
  }
  return { email, passwordFile: resolve(passwordFile) };
}

export async function readBootstrapPassword(path: string): Promise<string> {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 4_096) {
      throw new Error(
        "password file must be a regular file no larger than 4096 bytes",
      );
    }
    const password = (await handle.readFile("utf8")).replace(/\r?\n$/, "");
    if (password.includes("\0")) throw new Error("password file is invalid");
    return password;
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  const { email, passwordFile } = parseAdminBootstrapArgs(
    process.argv.slice(2),
  );
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const ssl = process.env.DATABASE_SSL !== "false";
  if (!ssl && process.env.SERVICE_DEV_MODE !== "true") {
    throw new Error("DATABASE_SSL cannot be disabled outside development");
  }
  const password = await readBootstrapPassword(passwordFile);
  const passwordHash = await hashPassword(password);
  const store = new PostgresBillingStore(connectionString, ssl);
  try {
    await store.initialize();
    await store.upsertAdmin({
      id: randomUUID(),
      email,
      role: "admin",
      passwordHash,
      createdAt: new Date(),
    });
    console.log(
      JSON.stringify({ level: "info", message: "admin console user ready" }),
    );
  } finally {
    await store.close();
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(
      JSON.stringify({
        level: "error",
        message:
          error instanceof Error ? error.message : "admin bootstrap failed",
      }),
    );
    process.exitCode = 1;
  });
}
