import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, run } from "./suite.mjs";

test("safe scenarios require a token because check reaches Vault", () => {
  assert.throws(() => parseArgs([], {}), /authenticated scenarios require/);
});

test("smoke expands the safe suite with bounded concurrency", () => {
  const config = parseArgs(["--smoke", "--token", "test-token"], {});
  assert.deepEqual(config.scenarios, [
    "healthz",
    "readyz",
    "console-css",
    "developer-login",
    "developer-login-reject",
    "developer-wall",
    "developer-usage-wall",
    "developer-key-wall",
    "developer-key-revoke-wall",
    "developer-checkout-wall",
    "developer-portal-wall",
    "developer-logout-wall",
    "admin-login",
    "admin-login-reject",
    "admin-wall",
    "admin-analytics-wall",
    "admin-account-wall",
    "admin-metronome-wall",
    "admin-logout-wall",
    "stripe-webhook-reject",
    "auth-reject",
    "check",
  ]);
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
    "console-css",
    "developer-login",
    "developer-login-reject",
    "developer-wall",
    "developer-usage-wall",
    "developer-key-wall",
    "developer-key-revoke-wall",
    "developer-checkout-wall",
    "developer-portal-wall",
    "developer-logout-wall",
    "admin-login",
    "admin-login-reject",
    "admin-wall",
    "admin-analytics-wall",
    "admin-account-wall",
    "admin-metronome-wall",
    "admin-logout-wall",
    "stripe-webhook-reject",
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
        [
          "--base-url",
          "http://user:pass@localhost:3000",
          "--token",
          "test-token",
        ],
        {},
      ),
    /cannot include credentials/,
  );
  assert.throws(
    () =>
      parseArgs(
        [
          "--base-url",
          "http://localhost:3000?target=other",
          "--token",
          "test-token",
        ],
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

test("login probes accept an exact-Origin rejection", async () => {
  const config = parseArgs(
    ["--scenario", "developer-login-reject", "--token", "test-token"],
    {},
  );
  const result = await run(config, async (_url, init) => {
    assert.equal(init.headers.origin, "http://127.0.0.1:3000");
    assert.equal(
      init.headers["content-type"],
      "application/x-www-form-urlencoded",
    );
    assert.equal(init.redirect, "manual");
    return new Response("", { status: 403 });
  });
  assert.equal(result.totals.unexpected, 0);
});

test("requests preserve redirects and use unique ceremony identifiers", async () => {
  const config = parseArgs(
    [
      "--scenario",
      "complete",
      "--token",
      "test-token",
      "--allow-mutations",
      "--requests",
      "3",
      "--concurrency",
      "2",
    ],
    {},
  );
  const ceremonies = [];
  const result = await run(config, async (_url, init) => {
    assert.equal(init.redirect, "manual");
    ceremonies.push(JSON.parse(init.body).ceremonyId);
    return new Response("", { status: 404 });
  });
  assert.equal(result.totals.unexpected, 0);
  assert.equal(ceremonies.length, 3);
  assert.equal(new Set(ceremonies).size, 3);
});
