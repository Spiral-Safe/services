import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const migration = await readFile(
    resolve(process.cwd(), "migrations/001_billing.sql"),
    "utf8",
  );
  const pool = new Pool({
    connectionString,
    ssl:
      process.env.DATABASE_SSL === "false"
        ? false
        : { rejectUnauthorized: true },
  });
  try {
    await pool.query(migration);
    console.log(
      JSON.stringify({ level: "info", message: "billing migration applied" }),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      level: "error",
      message:
        error instanceof Error ? error.message : "billing migration failed",
    }),
  );
  process.exitCode = 1;
});
