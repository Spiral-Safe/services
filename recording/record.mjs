#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { recordingDefaults } from "./playwright.config.mjs";
import {
  clearAnnotatedStep,
  fileSafe,
  firstVisibleTarget,
  installRecordingSafety,
  showAnnotatedStep,
} from "./annotation.mjs";
import { startFixtureServer } from "./fixture-server.mjs";

const recordingDirectory = dirname(fileURLToPath(import.meta.url));
const servicesDirectory = resolve(recordingDirectory, "..");
const extensionDirectory = resolve(servicesDirectory, "..", "extension");
const manifestPath = resolve(recordingDirectory, "manifest.json");
const defaultOutputRoot = resolve(recordingDirectory, "output");
const defaultChromePaths = [
  chromium.executablePath(),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

export async function runRecordings(options = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateManifest(manifest);
  const selected = selectFlows(manifest.flows, options.flow || "all");
  const browserPath = await resolveBrowserPath(options.browserPath);
  const runId = validateRunID(
    options.runId || new Date().toISOString().replace(/[:.]/g, "-"),
  );
  const outputParent = resolve(options.outputRoot || defaultOutputRoot);
  const outputRoot = resolve(outputParent, runId);
  const holdMs = integerOption(options.holdMs, recordingDefaults.holdMs);
  const settleMs = integerOption(options.settleMs, recordingDefaults.settleMs);
  await mkdir(outputRoot, { recursive: true });

  if (!options.skipBuild) await buildRecordingInputs(selected);
  const fixture = await startFixtureServer({
    dashboards: selected.some((flow) => flow.id.endsWith("-dashboard")),
  });
  let preflightSecurity;
  try {
    preflightSecurity = await preflightDashboardSecurity(fixture, selected);
  } catch (error) {
    await fixture.close();
    throw error;
  }
  const startedAt = new Date().toISOString();
  const runManifest = {
    schemaVersion: manifest.schemaVersion,
    name: manifest.name,
    runId,
    startedAt,
    completedAt: null,
    fixtureMode: manifest.fixtureMode,
    browser: {
      engine: "chromium",
      executable: basename(browserPath),
      headless: !!options.headless,
    },
    credentialPolicy:
      "Loopback fixture marker only; no production API, Vault, Stripe, cloud, or wallet credential is read or recorded.",
    capturePolicy:
      "Raw console headers are asserted before any bypass-enabled browser context starts. CSP is bypassed only so the review overlay can be injected.",
    preflightSecurity,
    flows: [],
  };

  try {
    for (const flow of selected) {
      await fixture.reset();
      const result = await recordFlow({
        flow,
        fixture,
        browserPath,
        outputRoot,
        holdMs,
        settleMs,
        headless: !!options.headless,
        video: options.video !== false,
      });
      runManifest.flows.push(result);
      await writeJSON(resolve(outputRoot, "manifest.json"), runManifest);
    }
  } finally {
    await fixture.close();
  }
  runManifest.completedAt = new Date().toISOString();
  await writeJSON(resolve(outputRoot, "manifest.json"), runManifest);
  await writeJSON(resolve(outputParent, "latest.json"), {
    runId,
    manifest: `${runId}/manifest.json`,
    completedAt: runManifest.completedAt,
  });
  return { outputRoot, manifest: runManifest };
}

async function recordFlow({
  flow,
  fixture,
  browserPath,
  outputRoot,
  holdMs,
  settleMs,
  headless,
  video,
}) {
  const flowDirectory = resolve(outputRoot, flow.id);
  const screenshotDirectory = resolve(flowDirectory, "screenshots");
  await mkdir(screenshotDirectory, { recursive: true });
  const tracePath = resolve(flowDirectory, "trace.zip");
  const videoPath = resolve(flowDirectory, "recording.webm");
  const timelinePath = resolve(flowDirectory, "timeline.json");
  let started = Date.now();
  let timeline = createCaptureTimeline(flow, sourceFor(flow, fixture), started);
  let resources;
  let capture;
  try {
    resources =
      flow.id === "extension-demo"
        ? await launchExtension({ browserPath })
        : await launchPage({ browserPath, headless });
    const { context, page } = resources;
    capture = await startPageCapture(page, {
      video,
      videoPath,
      videoSize: recordingDefaults.videoSize,
    });
    started = capture.startedAtMs;
    timeline = createCaptureTimeline(flow, sourceFor(flow, fixture), started);
    timeline.timingBasis = capture.timingBasis;
    const browserErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push("console-error");
    });
    page.on("pageerror", () => browserErrors.push("page-error"));
    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
      title: flow.title,
    });
    await attachFixtureWebAuthn(page);
    await routeSolanaFixture(page);
    await executeFlow({
      flow,
      fixture,
      page,
      context,
      timeline,
      screenshotDirectory,
      holdMs,
      settleMs,
    });
    if (browserErrors.length > 0) {
      timeline.warnings.push(
        `${browserErrors.length} browser error event(s) occurred`,
      );
    }
    await clearAnnotatedStep(page).catch(() => {});
    await context.tracing.stop({ path: tracePath });
    const captureCompletedAt = Date.now();
    await capture.stop();
    await page.close();
    await resources.close();
    timeline.completedAt = new Date(captureCompletedAt).toISOString();
    timeline.durationMs = captureCompletedAt - started;
    await writeJSON(timelinePath, timeline);
    return {
      id: flow.id,
      title: flow.title,
      status: timeline.warnings.length ? "passed-with-warnings" : "passed",
      fixtureMode: true,
      source: timeline.source,
      durationMs: timeline.durationMs,
      timingBasis: timeline.timingBasis,
      artifacts: {
        video: video ? `${flow.id}/recording.webm` : null,
        trace: `${flow.id}/trace.zip`,
        timeline: `${flow.id}/timeline.json`,
        screenshots: `${flow.id}/screenshots`,
      },
      warnings: timeline.warnings,
    };
  } catch (error) {
    timeline.completedAt = new Date().toISOString();
    timeline.durationMs = Date.now() - started;
    timeline.error = safeError(error);
    await writeJSON(timelinePath, timeline);
    if (capture) await capture.stop().catch(() => {});
    if (resources) await resources.close().catch(() => {});
    await rm(videoPath, { force: true }).catch(() => {});
    return {
      id: flow.id,
      title: flow.title,
      status: "failed",
      fixtureMode: true,
      source: timeline.source,
      durationMs: timeline.durationMs,
      artifacts: {
        video: null,
        trace: null,
        timeline: `${flow.id}/timeline.json`,
        screenshots: `${flow.id}/screenshots`,
      },
      error: timeline.error,
    };
  }
}

async function launchPage({ browserPath, headless }) {
  const browser = await chromium.launch({
    executablePath: browserPath,
    headless,
    slowMo: 35,
  });
  const context = await browser.newContext({
    viewport: recordingDefaults.viewport,
    deviceScaleFactor: 1,
    colorScheme: recordingDefaults.colorScheme,
    bypassCSP: true,
  });
  const page = await context.newPage();
  return {
    context,
    page,
    async close() {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}

async function launchExtension({ browserPath }) {
  const extensionPath = resolve(extensionDirectory, "dist");
  await access(resolve(extensionPath, "manifest.json"));
  const profileDirectory = await mkdtemp(
    join(tmpdir(), "spiral-safe-recording-"),
  );
  const context = await chromium.launchPersistentContext(profileDirectory, {
    executablePath: browserPath,
    headless: false,
    viewport: recordingDefaults.viewport,
    deviceScaleFactor: 1,
    colorScheme: recordingDefaults.colorScheme,
    bypassCSP: true,
    slowMo: 35,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  const page = await context.newPage();
  return {
    context,
    page,
    profileDirectory,
    async close() {
      await context.close().catch(() => {});
      await rm(profileDirectory, { recursive: true, force: true }).catch(
        () => {},
      );
    },
  };
}

export async function startPageCapture(
  page,
  { video, videoPath, videoSize, firstFrameTimeoutMs = 5_000, now = Date.now },
) {
  if (!video) {
    return {
      startedAtMs: now(),
      timingBasis: "page-ready-wall-clock",
      async stop() {},
    };
  }
  let resolveFirstFrame;
  const firstFrame = new Promise((resolvePromise) => {
    resolveFirstFrame = resolvePromise;
  });
  let firstFrameSeen = false;
  await page.screencast.start({
    path: videoPath,
    size: videoSize,
    onFrame({ timestamp }) {
      if (firstFrameSeen) return;
      firstFrameSeen = true;
      resolveFirstFrame(timestamp);
    },
  });
  let timer;
  let startedAtMs;
  try {
    startedAtMs = await Promise.race([
      firstFrame,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for first video frame")),
          firstFrameTimeoutMs,
        );
      }),
    ]);
  } catch (error) {
    await page.screencast.stop().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!Number.isFinite(startedAtMs)) {
    await page.screencast.stop().catch(() => {});
    throw new Error("First video frame omitted a valid timestamp");
  }
  let stopPromise;
  return {
    startedAtMs,
    timingBasis: "playwright-first-presented-frame",
    stop() {
      stopPromise ||= page.screencast.stop();
      return stopPromise;
    },
  };
}

async function attachFixtureWebAuthn(page) {
  const session = await page.context().newCDPSession(page);
  await session.send("WebAuthn.enable", { enableUI: false });
  await session.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return session;
}

async function routeSolanaFixture(page) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
    if (
      ["http:", "https:"].includes(url.protocol) &&
      !loopback.has(url.hostname) &&
      url.origin !== "https://api.devnet.solana.com"
    ) {
      await route.abort("blockedbyclient");
      return;
    }
    if (url.origin !== "https://api.devnet.solana.com") {
      await route.continue();
      return;
    }
    let request = {};
    try {
      request = route.request().postDataJSON();
    } catch {
      // Return a stable JSON-RPC error below.
    }
    const result =
      request.method === "getLatestBlockhash"
        ? {
            context: { slot: 424_242 },
            value: {
              blockhash: "11111111111111111111111111111111",
              lastValidBlockHeight: 999_999,
            },
          }
        : "1".repeat(64);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: request.id || 1, result }),
    });
  });
}

async function executeFlow({
  flow,
  fixture,
  page,
  context,
  timeline,
  screenshotDirectory,
  holdMs,
  settleMs,
}) {
  if (flow.id === "extension-demo") {
    await executeExtensionFlow({
      flow,
      fixture,
      page,
      context,
      timeline,
      screenshotDirectory,
      holdMs,
      settleMs,
    });
    return;
  }
  if (flow.id === "standalone-wallet") {
    await executeWalletFlow({
      flow,
      fixture,
      page,
      timeline,
      screenshotDirectory,
      holdMs,
      settleMs,
    });
    return;
  }
  await executeDashboardFlow({
    flow,
    fixture,
    page,
    timeline,
    screenshotDirectory,
    holdMs,
    settleMs,
  });
}

async function executeExtensionFlow(args) {
  const { flow, fixture, page, context } = args;
  let worker = context.serviceWorkers()[0];
  if (!worker)
    worker = await context.waitForEvent("serviceworker", { timeout: 20_000 });
  const extensionId = new URL(worker.url()).host;
  await page.goto(`chrome-extension://${extensionId}/hello.html`, {
    waitUntil: "domcontentloaded",
  });
  await runAnnotatedAction(args, flow.steps[0], async () => {
    await page.locator("#backendUrl").fill(fixture.origin);
    await page.locator("#username").fill("recording-user");
    await page.locator("#apiToken").fill("fixture-not-a-secret");
    await page.locator("#solanaRpcUrl").fill(`${fixture.origin}/rpc`);
    await page.locator("#solanaCluster").selectOption("solana:devnet");
    await page
      .locator("#allowedOrigins")
      .fill(new URL(fixture.pages.extensionDemo).origin);
    await page.locator("#settingsForm button[type=submit]").click();
    await page
      .locator("#status[data-tone=success]")
      .waitFor({ timeout: 10_000 });
  });
  await page.goto(fixture.pages.extensionDemo, { waitUntil: "networkidle" });
  await installRecordingSafety(page);
  await runAnnotatedAction(args, flow.steps[1], async () => {
    await page.waitForFunction(
      () =>
        document
          .querySelector("#walletStatus")
          ?.textContent?.includes("discovered"),
      null,
      { timeout: 15_000 },
    );
  });
  await runAnnotatedAction(args, flow.steps[2], async () => {
    await page.locator("#register").click();
    await page.waitForFunction(
      () =>
        document
          .querySelector("#output")
          ?.textContent?.includes("Register passkey completed"),
      null,
      { timeout: 20_000 },
    );
  });
  await runAnnotatedAction(args, flow.steps[3], async () => {
    await page.locator("#signMessage").click();
    await page.waitForFunction(
      () =>
        document
          .querySelector("#output")
          ?.textContent?.includes("Sign message completed"),
      null,
      { timeout: 20_000 },
    );
  });
  await runAnnotatedAction(args, flow.steps[4], async () => {
    await page.locator("#signTransaction").click();
    await page.waitForFunction(
      () =>
        document
          .querySelector("#output")
          ?.textContent?.includes("Sign transaction completed"),
      null,
      { timeout: 20_000 },
    );
  });
}

async function executeWalletFlow(args) {
  const { flow, fixture, page } = args;
  await page.goto(fixture.pages.standaloneWallet, { waitUntil: "networkidle" });
  await installRecordingSafety(page);
  await runAnnotatedAction(args, flow.steps[0], async () => {});
  await runAnnotatedAction(args, flow.steps[1], async () => {
    await page.locator("#username-register").fill("wallet-recording");
    await page.locator("#username-sign").fill("wallet-recording");
    await page.locator("#chain-register").selectOption("ethereum");
    await page.locator("#chain-sign").selectOption("ethereum");
  });
  await runAnnotatedAction(args, flow.steps[2], async () => {
    await page.locator("#register").click();
    await page.waitForFunction(
      () => document.querySelector("#publicKey")?.textContent?.startsWith("0x"),
      null,
      { timeout: 20_000 },
    );
  });
  await runAnnotatedAction(args, flow.steps[3], async () => {
    await page
      .locator("#message")
      .fill("Spiral Safe fixture recording message");
    await page.locator("#transaction").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#rawTransaction")?.textContent !==
        "Not available",
      null,
      { timeout: 10_000 },
    );
  });
  await runAnnotatedAction(args, flow.steps[4], async () => {
    await page.locator("#authenticate").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#signedTransaction")?.textContent !==
        "Not available",
      null,
      { timeout: 20_000 },
    );
  });
}

async function executeDashboardFlow(args) {
  const { flow, fixture, page, timeline } = args;
  const kind = flow.id === "developer-dashboard" ? "developer" : "admin";
  timeline.source = fixture.dashboardSources[kind];
  const steps = [...flow.steps];
  if (timeline.source === "actual-billing-console") {
    const loginPage = fixture.dashboardLoginPages[kind];
    const loginCredential = fixture.dashboardCredentials[kind];
    const loginResponse = await page.goto(loginPage, {
      waitUntil: "networkidle",
    });
    assertConsoleResponse(loginResponse, `${kind} login`, timeline);
    await installRecordingSafety(page);
    const loginStep = steps.shift();
    await runAnnotatedAction(args, loginStep, async () => {
      const dashboardResponse = page.waitForResponse(
        (response) => {
          const url = new URL(response.url());
          return (
            response.request().resourceType() === "document" &&
            url.origin === new URL(fixture.pages[kind]).origin &&
            url.pathname === `/${kind}` &&
            response.status() === 200
          );
        },
        { timeout: 20_000 },
      );
      await page.locator('input[name="email"]').fill(loginCredential.email);
      await page
        .locator('input[name="password"]')
        .fill(loginCredential.password);
      await page
        .locator(`form[action="/${kind}/login"] button[type="submit"]`)
        .click();
      assertConsoleResponse(
        await dashboardResponse,
        `${kind} dashboard`,
        timeline,
      );
      await page.waitForLoadState("networkidle");
    });
  } else {
    const target = new URL(fixture.pages[kind]);
    target.searchParams.set("recordingFixture", "1");
    await page.goto(target.toString(), { waitUntil: "networkidle" });
    await installRecordingSafety(page);
    const loginStep = steps.shift();
    await runAnnotatedAction(args, loginStep, async () => {});
    timeline.warnings.push(
      `${kind} dashboard used the static fixture fallback instead of the built console route`,
    );
  }
  for (const step of steps) {
    await runAnnotatedAction(args, step, async () => {
      if (step.id === "overview") return;
      const match = await firstVisibleTarget(page, step.targets || []);
      if (!match) {
        timeline.warnings.push(`No actionable selector found for ${step.id}`);
        return;
      }
      if (
        step.id === "create-key" &&
        timeline.source === "actual-billing-console"
      ) {
        await page
          .locator('input[name="name"]')
          .fill("Recorder fixture key draft");
        await page.locator('input[name="users"]').fill("recording-user");
        await match.locator.hover();
        return;
      }
      const tagName = await match.locator.evaluate(
        (element) => element.tagName,
      );
      if (!["A", "BUTTON", "INPUT"].includes(tagName)) {
        await match.locator.scrollIntoViewIfNeeded();
        await match.locator.hover();
        return;
      }
      await match.locator.click();
      if (step.id === "select-tenant") {
        await page.waitForLoadState("networkidle");
      }
    });
  }
}

function assertConsoleResponse(response, label, timeline) {
  if (!response) throw new Error(`${label} returned no document response`);
  const headers = response.headers();
  validateConsoleHeaders(headers, label);
  timeline.securityAssertions ||= [];
  timeline.securityAssertions.push({
    document: label,
    status: response.status(),
    csp: "header-passed-in-capture-context",
    nosniff: "passed",
    referrerPolicy: "same-origin",
  });
}

async function preflightDashboardSecurity(fixture, flows) {
  const kinds = flows
    .filter((flow) => flow.id.endsWith("-dashboard"))
    .map((flow) => (flow.id === "developer-dashboard" ? "developer" : "admin"));
  const checks = [];
  for (const kind of kinds) {
    if (fixture.dashboardSources[kind] !== "actual-billing-console") continue;
    const response = await fetch(fixture.dashboardLoginPages[kind], {
      redirect: "manual",
    });
    if (response.status !== 200) {
      throw new Error(`${kind} login preflight returned ${response.status}`);
    }
    const headers = Object.fromEntries(response.headers.entries());
    validateConsoleHeaders(headers, `${kind} login preflight`);
    checks.push({
      document: `${kind} login`,
      status: response.status,
      timing: "before-browser-context",
      csp: "passed",
      nosniff: "passed",
      referrerPolicy: "same-origin",
    });
  }
  return checks;
}

function validateConsoleHeaders(headers, label) {
  validateConsoleCSP(headers["content-security-policy"]);
  if (headers["x-content-type-options"] !== "nosniff") {
    throw new Error(`${label} omitted x-content-type-options: nosniff`);
  }
  if (headers["referrer-policy"] !== "same-origin") {
    throw new Error(`${label} omitted referrer-policy: same-origin`);
  }
}

export function validateConsoleCSP(value) {
  if (typeof value !== "string")
    throw new Error("Console response omitted CSP");
  const required = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ];
  for (const directive of required) {
    if (!value.includes(directive)) {
      throw new Error(`Console CSP omitted ${directive}`);
    }
  }
  if (/unsafe-inline|unsafe-eval/i.test(value)) {
    throw new Error("Console CSP enables an unsafe inline/eval source");
  }
}

async function runAnnotatedAction(
  { page, timeline, screenshotDirectory, holdMs, settleMs },
  step,
  action,
) {
  const number = timeline.steps.length + 1;
  const screenshotName = `${String(number).padStart(2, "0")}-${fileSafe(step.id)}.png`;
  const screenshotPath = resolve(screenshotDirectory, screenshotName);
  const annotation = await showAnnotatedStep(page, step, number, {
    fixtureLabel: "FIXTURE MODE · synthetic local data",
    screenshotPath,
    holdMs,
  });
  const shownAt = annotation.shownAtMs;
  await clearAnnotatedStep(page);
  const actionStartedAt = Date.now();
  await action(annotation.target);
  await page.waitForTimeout(settleMs);
  const actionCompletedAt = Date.now();
  timeline.steps.push({
    number,
    id: step.id,
    section: step.section,
    title: step.title,
    description: step.description,
    targetSelector: annotation.selector,
    annotationPlacement: annotation.placement,
    screenshot: `screenshots/${screenshotName}`,
    shownAt: new Date(shownAt).toISOString(),
    relativeStartMs: presentedOffsetMs(Date.parse(timeline.startedAt), shownAt),
    actionStartedAfterMs: presentedOffsetMs(shownAt, actionStartedAt),
    actionDurationMs: actionCompletedAt - actionStartedAt,
  });
}

export function presentedOffsetMs(captureStartedAtMs, presentedAtMs) {
  return Math.max(0, Math.round(presentedAtMs - captureStartedAtMs));
}

export function createCaptureTimeline(flow, source, startedAtMs) {
  return {
    schemaVersion: 1,
    flowId: flow.id,
    title: flow.title,
    description: flow.description,
    fixtureMode: true,
    source,
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: null,
    durationMs: null,
    steps: [],
    warnings: [],
  };
}

async function buildRecordingInputs(flows) {
  if (flows.some((flow) => flow.id.endsWith("-dashboard"))) {
    await runCommand("npm", ["run", "build"], servicesDirectory);
  }
  if (flows.some((flow) => flow.id === "standalone-wallet")) {
    await runCommand("npm", ["run", "build:client"], servicesDirectory);
  }
  if (flows.some((flow) => flow.id === "extension-demo")) {
    await runCommand("npm", ["run", "build"], extensionDirectory);
    await runCommand("npm", ["run", "build:demo"], extensionDirectory);
  }
}

async function runCommand(command, args, cwd) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else
        reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

async function resolveBrowserPath(explicit) {
  const candidates = [
    explicit,
    process.env.SPIRAL_RECORDING_BROWSER,
    ...defaultChromePaths,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next installed Chromium-family browser.
    }
  }
  throw new Error(
    "No Chromium-family browser found. Set SPIRAL_RECORDING_BROWSER or install Playwright Chromium.",
  );
}

export function selectFlows(flows, selection) {
  const ids =
    selection === "all" ? flows.map(({ id }) => id) : selection.split(",");
  const selected = ids.map((id) => flows.find((flow) => flow.id === id));
  if (selected.some((flow) => !flow)) {
    const missing = ids.filter((id) => !flows.some((flow) => flow.id === id));
    throw new Error(`Unknown recording flow(s): ${missing.join(", ")}`);
  }
  return selected;
}

export function validateManifest(manifest) {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.flows)) {
    throw new Error("Recording manifest schema is invalid");
  }
  const ids = new Set();
  for (const flow of manifest.flows) {
    if (
      !flow.id ||
      ids.has(flow.id) ||
      !Array.isArray(flow.steps) ||
      !flow.steps.length
    ) {
      throw new Error(`Recording flow is invalid: ${flow.id || "missing id"}`);
    }
    ids.add(flow.id);
    for (const step of flow.steps) {
      if (!step.id || !step.section || !step.title || !step.description) {
        throw new Error(`Recording step is invalid in ${flow.id}`);
      }
    }
  }
}

export function validateRunID(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(value))) {
    throw new Error(
      "Recording run ID must be 1-128 letters, numbers, dots, underscores, or hyphens",
    );
  }
  return String(value);
}

function sourceFor(flow, fixture) {
  if (flow.id === "developer-dashboard")
    return fixture.dashboardSources.developer;
  if (flow.id === "admin-dashboard") return fixture.dashboardSources.admin;
  return flow.source;
}

function integerOption(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 60_000) {
    throw new Error(
      "Recording timing options must be integers from 0 to 60000",
    );
  }
  return parsed;
}

function safeError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : "Recording failed",
  };
}

async function writeJSON(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function parseArgs(argv) {
  const options = { flow: "all", video: true };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--flow")
      options.flow = requiredValue(argv, ++index, option);
    else if (option === "--output")
      options.outputRoot = requiredValue(argv, ++index, option);
    else if (option === "--browser")
      options.browserPath = requiredValue(argv, ++index, option);
    else if (option === "--hold-ms")
      options.holdMs = requiredValue(argv, ++index, option);
    else if (option === "--settle-ms")
      options.settleMs = requiredValue(argv, ++index, option);
    else if (option === "--run-id")
      options.runId = requiredValue(argv, ++index, option);
    else if (option === "--skip-build") options.skipBuild = true;
    else if (option === "--headless") options.headless = true;
    else if (option === "--no-video") options.video = false;
    else if (option === "--help" || option === "-h") options.help = true;
    else throw new Error(`Unknown recording option: ${option}`);
  }
  return options;
}

function requiredValue(argv, index, option) {
  if (!argv[index]) throw new Error(`${option} requires a value`);
  return argv[index];
}

function printHelp() {
  console.log(`Usage: node recording/record.mjs [options]

Options:
  --flow ID[,ID]    extension-demo, standalone-wallet, developer-dashboard,
                    admin-dashboard, or all (default)
  --output DIR      output parent (default recording/output)
  --browser PATH    Chromium-family executable
  --hold-ms N       annotation hold before each action (default 900)
  --settle-ms N     pause after each action (default 650)
  --run-id NAME     stable output subdirectory name
  --skip-build      reuse existing client/extension bundles
  --headless        run non-extension flows headless
  --no-video        emit trace/screenshots/timeline without WebM
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const result = await runRecordings(options);
  for (const flow of result.manifest.flows) {
    console.log(`${flow.id}: ${flow.status}`);
  }
  console.log(
    `Recording manifest: ${resolve(result.outputRoot, "manifest.json")}`,
  );
  if (result.manifest.flows.some(({ status }) => status === "failed")) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
