#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

const scenarioDefinitions = {
  healthz: {
    method: "GET",
    path: "/healthz",
    expected: [200],
    authenticated: false,
    mutating: false,
  },
  readyz: {
    method: "GET",
    path: "/readyz",
    expected: [200],
    authenticated: false,
    mutating: false,
  },
  "console-css": {
    method: "GET",
    path: "/console.css",
    expected: [200],
    authenticated: false,
    mutating: false,
  },
  "developer-login": {
    method: "GET",
    path: "/developer/login",
    expected: [200, 401],
    authenticated: false,
    mutating: false,
  },
  "developer-login-reject": {
    method: "POST",
    path: "/developer/login",
    expected: [401, 403, 429],
    authenticated: false,
    mutating: false,
    form: () => ({
      email: "load-test-invalid@example.test",
      password: "not-a-real-console-password",
    }),
  },
  "developer-wall": {
    method: "GET",
    path: "/developer",
    expected: [303, 401],
    authenticated: false,
    mutating: false,
  },
  "developer-usage-wall": {
    method: "GET",
    path: "/developer/api/usage",
    expected: [303, 401],
    authenticated: false,
    mutating: false,
  },
  "developer-key-wall": {
    method: "POST",
    path: "/developer/api-keys",
    expected: [303, 401],
    authenticated: false,
    mutating: false,
  },
  "developer-key-revoke-wall": {
    method: "POST",
    path: "/developer/api-keys/00000000-0000-4000-8000-000000000000/revoke",
    expected: [303, 401],
    authenticated: false,
    mutating: false,
  },
  "developer-checkout-wall": {
    method: "POST",
    path: "/developer/billing/checkout",
    expected: [303, 401],
    authenticated: false,
    mutating: false,
  },
  "developer-portal-wall": {
    method: "POST",
    path: "/developer/billing/portal",
    expected: [303, 401],
    authenticated: false,
    mutating: false,
  },
  "developer-logout-wall": {
    method: "POST",
    path: "/developer/logout",
    expected: [303, 401],
    authenticated: false,
    mutating: false,
  },
  "admin-login": {
    method: "GET",
    path: "/admin/login",
    expected: [200, 401],
    authenticated: false,
    mutating: false,
  },
  "admin-login-reject": {
    method: "POST",
    path: "/admin/login",
    expected: [401, 403, 429],
    authenticated: false,
    mutating: false,
    form: () => ({
      email: "load-test-invalid@example.test",
      password: "not-a-real-console-password",
    }),
  },
  "admin-wall": {
    method: "GET",
    path: "/admin",
    expected: [303, 401],
    authenticated: false,
    mutating: false,
  },
  "admin-analytics-wall": {
    method: "GET",
    path: "/admin/api/analytics",
    expected: [303, 401],
    authenticated: false,
    mutating: false,
  },
  "admin-account-wall": {
    method: "POST",
    path: "/admin/accounts",
    expected: [303, 401],
    authenticated: false,
    mutating: false,
  },
  "admin-metronome-wall": {
    method: "POST",
    path: "/admin/accounts/00000000-0000-4000-8000-000000000000/metronome-verified",
    expected: [303, 401],
    authenticated: false,
    mutating: false,
  },
  "admin-logout-wall": {
    method: "POST",
    path: "/admin/logout",
    expected: [303, 401],
    authenticated: false,
    mutating: false,
  },
  "stripe-webhook-reject": {
    method: "POST",
    path: "/billing/stripe/webhook",
    expected: [400, 404],
    authenticated: false,
    mutating: false,
    body: () => ({}),
  },
  "auth-reject": {
    method: "POST",
    path: "/check",
    expected: [401],
    authenticated: false,
    mutating: false,
    body: ({ username }) => ({ username }),
  },
  check: {
    method: "POST",
    path: "/check",
    expected: [404],
    authenticated: true,
    mutating: false,
    body: ({ username }) => ({ username }),
  },
  init: {
    method: "POST",
    path: "/init",
    expected: [200],
    authenticated: true,
    mutating: true,
    body: ({ username, chain }) => ({ username, chain }),
  },
  create: {
    method: "POST",
    path: "/create",
    expected: [400, 404, 422],
    authenticated: true,
    mutating: true,
    body: ({ username, chain }) => ({
      username,
      chain,
      ceremonyId: Buffer.from(username).toString("base64url"),
      credential: {
        id: "a",
        rawId: "a",
        type: "public-key",
        response: { clientDataJSON: "a", attestationObject: "a" },
      },
    }),
  },
  signin: {
    method: "POST",
    path: "/signin",
    expected: [400, 404, 422],
    authenticated: true,
    mutating: true,
    body: ({ username, chain }) => ({
      username,
      chain,
      operation: "message",
      payload: Buffer.from("spiral-safe-load-test").toString("base64"),
    }),
  },
  complete: {
    method: "POST",
    path: "/complete",
    expected: [400, 404, 422],
    authenticated: true,
    mutating: true,
    body: ({ username, chain }) => ({
      username,
      chain,
      ceremonyId: Buffer.from(username).toString("base64url"),
      credential: {
        id: "a",
        rawId: "a",
        type: "public-key",
        response: {
          clientDataJSON: "a",
          authenticatorData: "a",
          signature: "a",
        },
      },
    }),
  },
};

const consoleScenarioNames = [
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
];
const safeScenarioNames = [
  "healthz",
  "readyz",
  ...consoleScenarioNames,
  "auth-reject",
  "check",
];
const allScenarioNames = [
  ...safeScenarioNames,
  "init",
  "create",
  "signin",
  "complete",
];

function usage() {
  console.log(`Usage: node load-test/suite.mjs [options]

Runs bounded load checks against every Spiral Safe HTTP endpoint. By default it
uses only non-mutating scenarios and loopback targets.

Options:
  --base-url URL           Service origin (default: http://127.0.0.1:3000)
  --token TOKEN            Bearer token (or SPIRAL_SAFE_API_TOKEN)
  --scenario NAME          Repeat or comma-separate; safe, all, or an endpoint
                           (${Object.keys(scenarioDefinitions).join(", ")})
  --requests N             Requests per scenario, 1-100000 (default: 10)
  --concurrency N          Workers per scenario, 1-256 (default: 1)
  --timeout MS             Per-request timeout, 1-300000 (default: 5000)
  --chain NAME             solana or ethereum (default: solana)
  --expect NAME=CODES      Override expected statuses, e.g. signin=404,422
  --allow-mutations        Required for init/create/signin/complete
  --allow-remote           Required for non-loopback targets
  --insecure-http-remote   Also required to send a token over remote HTTP
  --smoke                  One request per selected scenario, concurrency 1
  --help                   Show this message

The create/signin/complete cases exercise validation or missing-user paths;
they do not reuse WebAuthn assertions. Use the lifecycle test for successful
cryptographic ceremony coverage.
`);
}

function integer(value, name, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

function nextValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`${option} requires a value`);
  return value;
}

function expandScenarios(values) {
  const names = values.flatMap((value) => value.split(",")).filter(Boolean);
  const requested = names.length ? names : ["safe"];
  const expanded = requested.flatMap((name) => {
    if (name === "safe") return safeScenarioNames;
    if (name === "all") return allScenarioNames;
    if (!scenarioDefinitions[name])
      throw new Error(`unknown scenario: ${name}`);
    return [name];
  });
  return [...new Set(expanded)];
}

export function parseArgs(argv, env = process.env) {
  const config = {
    baseUrl: "http://127.0.0.1:3000",
    token: env.SPIRAL_SAFE_API_TOKEN || "",
    scenarios: [],
    requests: 10,
    concurrency: 1,
    timeout: 5_000,
    chain: "solana",
    expectedOverrides: new Map(),
    allowMutations: false,
    allowRemote: false,
    insecureHttpRemote: false,
  };
  let smoke = false;

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    switch (option) {
      case "--base-url":
        config.baseUrl = nextValue(argv, index, option);
        index += 1;
        break;
      case "--token":
        config.token = nextValue(argv, index, option);
        index += 1;
        break;
      case "--scenario":
        config.scenarios.push(nextValue(argv, index, option));
        index += 1;
        break;
      case "--requests":
        config.requests = integer(
          nextValue(argv, index, option),
          option,
          100_000,
        );
        index += 1;
        break;
      case "--concurrency":
        config.concurrency = integer(
          nextValue(argv, index, option),
          option,
          256,
        );
        index += 1;
        break;
      case "--timeout":
        config.timeout = integer(
          nextValue(argv, index, option),
          option,
          300_000,
        );
        index += 1;
        break;
      case "--chain":
        config.chain = nextValue(argv, index, option);
        index += 1;
        break;
      case "--expect": {
        const override = nextValue(argv, index, option);
        index += 1;
        const separator = override.indexOf("=");
        if (separator < 1)
          throw new Error("--expect must use NAME=CODE[,CODE]");
        const name = override.slice(0, separator);
        if (!scenarioDefinitions[name])
          throw new Error(`unknown scenario in --expect: ${name}`);
        const codes = override
          .slice(separator + 1)
          .split(",")
          .map((code) => integer(code, "status code", 599));
        config.expectedOverrides.set(name, codes);
        break;
      }
      case "--allow-mutations":
        config.allowMutations = true;
        break;
      case "--allow-remote":
        config.allowRemote = true;
        break;
      case "--insecure-http-remote":
        config.insecureHttpRemote = true;
        break;
      case "--smoke":
        smoke = true;
        break;
      case "--help":
      case "-h":
        return { help: true };
      default:
        throw new Error(`unknown option: ${option}`);
    }
  }

  config.scenarios = expandScenarios(config.scenarios);
  if (!["solana", "ethereum"].includes(config.chain)) {
    throw new Error("--chain must be solana or ethereum");
  }
  if (smoke) {
    config.requests = 1;
    config.concurrency = 1;
  }

  const origin = new URL(config.baseUrl);
  if (!["http:", "https:"].includes(origin.protocol)) {
    throw new Error("--base-url must use http or https");
  }
  if (origin.username || origin.password || origin.search || origin.hash) {
    throw new Error(
      "--base-url cannot include credentials, a query, or a fragment",
    );
  }
  const loopback = LOOPBACK_HOSTS.has(origin.hostname);
  if (!loopback && !config.allowRemote) {
    throw new Error("non-loopback targets require --allow-remote");
  }
  const selected = config.scenarios.map((name) => scenarioDefinitions[name]);
  if (
    selected.some((scenario) => scenario.mutating) &&
    !config.allowMutations
  ) {
    throw new Error("mutating scenarios require --allow-mutations");
  }
  if (selected.some((scenario) => scenario.authenticated) && !config.token) {
    throw new Error(
      "authenticated scenarios require --token or SPIRAL_SAFE_API_TOKEN",
    );
  }
  if (
    !loopback &&
    origin.protocol === "http:" &&
    config.token &&
    !config.insecureHttpRemote
  ) {
    throw new Error(
      "refusing to send a token over remote HTTP without --insecure-http-remote",
    );
  }
  origin.pathname = origin.pathname.replace(/\/+$/, "");
  config.baseUrl = origin.toString().replace(/\/$/, "");
  return config;
}

function percentile(sorted, fraction) {
  if (!sorted.length) return 0;
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  ];
}

function latencySummary(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    min: Number((sorted[0] || 0).toFixed(2)),
    p50: Number(percentile(sorted, 0.5).toFixed(2)),
    p95: Number(percentile(sorted, 0.95).toFixed(2)),
    p99: Number(percentile(sorted, 0.99).toFixed(2)),
    max: Number((sorted.at(-1) || 0).toFixed(2)),
  };
}

async function runScenario(config, name, runId, fetchImpl) {
  const definition = scenarioDefinitions[name];
  const expected = config.expectedOverrides.get(name) || definition.expected;
  const statusCounts = new Map();
  const errorCounts = new Map();
  const latencies = [];
  let claimed = 0;
  let unexpected = 0;
  const startedAt = performance.now();

  async function worker() {
    while (claimed < config.requests) {
      const sequence = claimed;
      claimed += 1;
      const username = `load-${runId}-${name}-${sequence}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeout);
      const requestStarted = performance.now();
      const headers = { accept: "application/json" };
      if (definition.authenticated)
        headers.authorization = `Bearer ${config.token}`;
      const body = definition.body?.({ username, chain: config.chain });
      const form = definition.form?.({ username, chain: config.chain });
      if (body !== undefined) headers["content-type"] = "application/json";
      if (form !== undefined) {
        headers["content-type"] = "application/x-www-form-urlencoded";
        headers.origin = config.baseUrl;
      }

      try {
        const response = await fetchImpl(
          `${config.baseUrl}${definition.path}`,
          {
            method: definition.method,
            headers,
            redirect: "manual",
            body:
              body !== undefined
                ? JSON.stringify(body)
                : form !== undefined
                  ? new URLSearchParams(form).toString()
                  : undefined,
            signal: controller.signal,
          },
        );
        await response.arrayBuffer();
        statusCounts.set(
          response.status,
          (statusCounts.get(response.status) || 0) + 1,
        );
        if (!expected.includes(response.status)) unexpected += 1;
      } catch (error) {
        const errorName = error?.name || "Error";
        errorCounts.set(errorName, (errorCounts.get(errorName) || 0) + 1);
        unexpected += 1;
      } finally {
        clearTimeout(timer);
        latencies.push(performance.now() - requestStarted);
      }
    }
  }

  await Promise.all(Array.from({ length: config.concurrency }, () => worker()));
  const elapsedMs = performance.now() - startedAt;
  return {
    scenario: name,
    method: definition.method,
    path: definition.path,
    mutating: definition.mutating,
    expectedStatuses: expected,
    completed: latencies.length,
    unexpected,
    statuses: Object.fromEntries([...statusCounts].sort(([a], [b]) => a - b)),
    errors: Object.fromEntries(errorCounts),
    elapsedSeconds: Number((elapsedMs / 1_000).toFixed(3)),
    requestsPerSecond: Number(
      (latencies.length / (elapsedMs / 1_000)).toFixed(2),
    ),
    latencyMs: latencySummary(latencies),
  };
}

export async function run(config, fetchImpl = fetch) {
  const runId = randomUUID();
  const results = [];
  for (const name of config.scenarios) {
    results.push(await runScenario(config, name, runId, fetchImpl));
  }
  return {
    baseUrl: config.baseUrl,
    chain: config.chain,
    concurrency: config.concurrency,
    requestsPerScenario: config.requests,
    scenarios: results,
    totals: {
      completed: results.reduce((sum, result) => sum + result.completed, 0),
      unexpected: results.reduce((sum, result) => sum + result.unexpected, 0),
    },
  };
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  if (config.help) {
    usage();
    return;
  }
  const result = await run(config);
  console.log(JSON.stringify(result, null, 2));
  if (result.totals.completed === 0 || result.totals.unexpected > 0)
    process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`load test configuration error: ${error.message}`);
    process.exitCode = 2;
  });
}
