import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  parseAdminBootstrapArgs,
  readBootstrapPassword,
} from "./bootstrap-admin";

test("admin bootstrap accepts only a password file", async () => {
  assert.throws(
    () =>
      parseAdminBootstrapArgs([
        "--email",
        "admin@example.test",
        "--password",
        "plaintext-is-forbidden",
      ]),
    /password arguments are forbidden/,
  );
  const directory = await mkdtemp(join(tmpdir(), "spiral-admin-test-"));
  try {
    const passwordFile = join(directory, "password");
    await writeFile(passwordFile, "correct horse battery staple\n", {
      mode: 0o600,
    });
    const parsed = parseAdminBootstrapArgs([
      "--password-file",
      passwordFile,
      "--email",
      "ADMIN@example.test",
    ]);
    assert.equal(parsed.email, "admin@example.test");
    assert.equal(
      await readBootstrapPassword(parsed.passwordFile),
      "correct horse battery staple",
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
