import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "./suite.mjs";

test("safe scenarios require a token because check reaches Vault", () => {
  assert.throws(() => parseArgs([], {}), /authenticated scenarios require/);
});

test("smoke expands the safe suite with bounded concurrency", () => {
  const config = parseArgs(["--smoke", "--token", "test-token"], {});
  assert.deepEqual(config.scenarios, ["healthz", "readyz", "auth-reject", "check"]);
  assert.equal(config.requests, 1);
  assert.equal(config.concurrency, 1);
});

test("all endpoint coverage requires an explicit mutation opt-in", () => {
  assert.throws(
    () => parseArgs(["--scenario", "all", "--token", "test-token"], {}),
    /--allow-mutations/,
  );
});

test("all endpoint coverage includes every HTTP route", () => {
  const config = parseArgs(
    ["--scenario", "all", "--token", "test-token", "--allow-mutations"],
    {},
  );
  assert.deepEqual(config.scenarios, [
    "healthz",
    "readyz",
    "auth-reject",
    "check",
    "init",
    "create",
    "signin",
    "complete",
  ]);
});

test("remote targets and plaintext remote tokens require separate opt-ins", () => {
  assert.throws(
    () =>
      parseArgs(
        ["--base-url", "https://example.com", "--token", "test-token"],
        {},
      ),
    /--allow-remote/,
  );
  assert.throws(
    () =>
      parseArgs(
        [
          "--base-url",
          "http://example.com",
          "--token",
          "test-token",
          "--allow-remote",
        ],
        {},
      ),
    /--insecure-http-remote/,
  );
});

test("base URLs cannot smuggle credentials or query state", () => {
  assert.throws(
    () =>
      parseArgs(
        ["--base-url", "http://user:pass@localhost:3000", "--token", "test-token"],
        {},
      ),
    /cannot include credentials/,
  );
  assert.throws(
    () =>
      parseArgs(
        ["--base-url", "http://localhost:3000?target=other", "--token", "test-token"],
        {},
      ),
    /cannot include credentials/,
  );
});

test("expected status overrides accept multiple codes", () => {
  const config = parseArgs(
    [
      "--scenario",
      "signin",
      "--token",
      "test-token",
      "--allow-mutations",
      "--expect",
      "signin=404,409",
    ],
    {},
  );
  assert.deepEqual(config.expectedOverrides.get("signin"), [404, 409]);
});
