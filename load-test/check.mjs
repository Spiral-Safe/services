#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const defaults = {
  url: "http://127.0.0.1:3000/check",
  concurrency: 1,
  requests: 10,
  duration: 0,
  timeout: 5_000,
  expectedStatus: 404,
  allowRemote: false,
};

function usage() {
  console.log(`Usage: node load-test/check.mjs [options]

Exercises the read-only Express -> Vault POST /check flow with unique usernames.

Options:
  --smoke                 One request with concurrency 1
  --url URL               Endpoint (default: ${defaults.url})
  --concurrency N         Workers, 1-256 (default: ${defaults.concurrency})
  --requests N            Total requests (default: ${defaults.requests})
  --duration SECONDS      Run for a duration instead of a request count
  --timeout MS            Per-request timeout (default: ${defaults.timeout})
  --expected-status CODE  Expected HTTP status (default: ${defaults.expectedStatus})
  --allow-remote          Permit a non-loopback URL
  --help                  Show this message
`);
}

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const config = { ...defaults };
  let smoke = false;
  let requestsSet = false;
  let durationSet = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };

    switch (arg) {
      case "--smoke":
        smoke = true;
        break;
      case "--url":
        config.url = next();
        break;
      case "--concurrency":
        config.concurrency = positiveInteger(next(), arg, 256);
        break;
      case "--requests":
        config.requests = positiveInteger(next(), arg);
        requestsSet = true;
        break;
      case "--duration":
        config.duration = positiveInteger(next(), arg, 86_400);
        durationSet = true;
        break;
      case "--timeout":
        config.timeout = positiveInteger(next(), arg, 300_000);
        break;
      case "--expected-status":
        config.expectedStatus = positiveInteger(next(), arg, 599);
        break;
      case "--allow-remote":
        config.allowRemote = true;
        break;
      case "--help":
      case "-h":
        usage();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  if (requestsSet && durationSet) {
    throw new Error("choose either --requests or --duration, not both");
  }
  if (durationSet) config.requests = 0;
  if (smoke) {
    config.concurrency = 1;
    config.requests = 1;
    config.duration = 0;
  }

  const endpoint = new URL(config.url);
  if (!["http:", "https:"].includes(endpoint.protocol)) {
    throw new Error("--url must use http or https");
  }
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (!config.allowRemote && !loopbackHosts.has(endpoint.hostname)) {
    throw new Error("non-loopback URLs require --allow-remote");
  }

  return config;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const runId = randomUUID();
  const startedAt = performance.now();
  const deadline = config.duration ? startedAt + config.duration * 1_000 : Infinity;
  const latencies = [];
  const statuses = new Map();
  const errors = new Map();
  let claimed = 0;
  let completed = 0;
  let unexpected = 0;

  async function worker() {
    while (true) {
      const now = performance.now();
      if (now >= deadline) return;
      if (config.requests && claimed >= config.requests) return;
      const sequence = claimed;
      claimed += 1;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeout);
      const requestStarted = performance.now();
      try {
        const response = await fetch(config.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: `load-${runId}-${sequence}` }),
          signal: controller.signal,
        });
        await response.arrayBuffer();
        statuses.set(response.status, (statuses.get(response.status) || 0) + 1);
        if (response.status !== config.expectedStatus) unexpected += 1;
      } catch (error) {
        const name = error?.name || "Error";
        errors.set(name, (errors.get(name) || 0) + 1);
        unexpected += 1;
      } finally {
        clearTimeout(timer);
        latencies.push(performance.now() - requestStarted);
        completed += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: config.concurrency }, () => worker()));

  const elapsedMs = performance.now() - startedAt;
  const sorted = [...latencies].sort((a, b) => a - b);
  const summary = {
    url: config.url,
    concurrency: config.concurrency,
    completed,
    elapsedSeconds: Number((elapsedMs / 1_000).toFixed(3)),
    requestsPerSecond: Number((completed / (elapsedMs / 1_000)).toFixed(2)),
    expectedStatus: config.expectedStatus,
    statuses: Object.fromEntries([...statuses].sort(([a], [b]) => a - b)),
    errors: Object.fromEntries(errors),
    latencyMs: {
      min: Number((sorted[0] || 0).toFixed(2)),
      p50: Number(percentile(sorted, 0.5).toFixed(2)),
      p95: Number(percentile(sorted, 0.95).toFixed(2)),
      p99: Number(percentile(sorted, 0.99).toFixed(2)),
      max: Number((sorted.at(-1) || 0).toFixed(2)),
    },
  };

  console.log(JSON.stringify(summary, null, 2));
  if (unexpected > 0 || completed === 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`load test configuration error: ${error.message}`);
  process.exitCode = 2;
});
