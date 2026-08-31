import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chooseAnnotationPlacement, fileSafe } from "./annotation.mjs";
import { startFixtureServer } from "./fixture-server.mjs";
import {
  createCaptureTimeline,
  parseArgs,
  presentedOffsetMs,
  selectFlows,
  startPageCapture,
  validateConsoleCSP,
  validateManifest,
  validateRunID,
} from "./record.mjs";

const recordingDirectory = dirname(fileURLToPath(import.meta.url));

test("the recording manifest defines four unique annotated flows", async () => {
  const manifest = JSON.parse(
    await readFile(resolve(recordingDirectory, "manifest.json"), "utf8"),
  );
  assert.doesNotThrow(() => validateManifest(manifest));
  assert.deepEqual(
    manifest.flows.map(({ id }) => id),
    [
      "extension-demo",
      "standalone-wallet",
      "developer-dashboard",
      "admin-dashboard",
    ],
  );
  for (const flow of manifest.flows) {
    for (const step of flow.steps) {
      assert.ok(step.section);
      assert.ok(step.title);
      assert.ok(step.description);
      assert.ok(step.targets.length > 0);
    }
  }
  assert.deepEqual(
    selectFlows(manifest.flows, "standalone-wallet,admin-dashboard").map(
      ({ id }) => id,
    ),
    ["standalone-wallet", "admin-dashboard"],
  );
  assert.throws(
    () => selectFlows(manifest.flows, "not-a-flow"),
    /Unknown recording flow/,
  );
});

test("recorder arguments are explicit and reject unknown flags", () => {
  assert.deepEqual(
    parseArgs([
      "--flow",
      "extension-demo",
      "--run-id",
      "test-run",
      "--skip-build",
      "--headless",
      "--no-video",
    ]),
    {
      flow: "extension-demo",
      video: false,
      runId: "test-run",
      skipBuild: true,
      headless: true,
    },
  );
  assert.throws(() => parseArgs(["--unknown"]), /Unknown recording option/);
  assert.equal(fileSafe("API keys / Create"), "api-keys-create");
  assert.equal(validateRunID("release-demo_01"), "release-demo_01");
  assert.throws(() => validateRunID("../../escape"), /Recording run ID/);
  assert.doesNotThrow(() =>
    validateConsoleCSP(
      "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; object-src 'none'",
    ),
  );
  assert.throws(
    () =>
      validateConsoleCSP(
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; frame-ancestors 'none'; object-src 'none'",
      ),
    /unsafe inline\/eval/,
  );
});

test("annotation placement avoids the highlighted target and fixture badge", () => {
  const viewport = { width: 1440, height: 900 };
  const card = { width: 462, height: 150 };
  const badge = {
    left: 18,
    top: 851,
    right: 311,
    bottom: 882,
    width: 293,
    height: 31,
  };
  assert.equal(
    chooseAnnotationPlacement({ viewport, card, target: null, badge }).name,
    "top-right",
  );
  assert.deepEqual(
    chooseAnnotationPlacement({
      viewport,
      card,
      badge,
      target: {
        left: 194,
        top: 129,
        right: 1246,
        bottom: 307,
        width: 1052,
        height: 178,
      },
    }),
    {
      name: "bottom-right",
      left: 960,
      top: 732,
      preference: 2,
      badgeOverlap: 0,
      targetOverlap: 0,
    },
  );
  assert.equal(
    chooseAnnotationPlacement({
      viewport,
      card,
      badge,
      target: {
        left: 990,
        top: 650,
        right: 1240,
        bottom: 720,
        width: 250,
        height: 70,
      },
    }).name,
    "top-right",
  );
});

test("capture timelines use the page-video clock supplied by the launcher", () => {
  const startedAtMs = Date.parse("2026-08-31T03:00:00.123Z");
  const timeline = createCaptureTimeline(
    {
      id: "extension-demo",
      title: "Extension",
      description: "Fixture capture",
    },
    "extension/dist",
    startedAtMs,
  );
  assert.equal(timeline.startedAt, "2026-08-31T03:00:00.123Z");
  assert.equal(timeline.flowId, "extension-demo");
  assert.equal(timeline.source, "extension/dist");
  assert.deepEqual(timeline.steps, []);
  assert.deepEqual(timeline.warnings, []);
});

test("video capture adopts the first presented-frame timestamp exactly", async () => {
  const calls = [];
  let options;
  const page = {
    screencast: {
      async start(value) {
        calls.push("start");
        options = value;
        queueMicrotask(() => {
          value.onFrame({ timestamp: 2_400 });
          value.onFrame({ timestamp: 2_440 });
        });
      },
      async stop() {
        calls.push("stop");
      },
    },
  };

  const capture = await startPageCapture(page, {
    video: true,
    videoPath: "/tmp/fixture-recording.webm",
    videoSize: { width: 1440, height: 900 },
  });

  assert.equal(capture.startedAtMs, 2_400);
  assert.equal(capture.timingBasis, "playwright-first-presented-frame");
  assert.equal(options.path, "/tmp/fixture-recording.webm");
  assert.deepEqual(options.size, { width: 1440, height: 900 });
  assert.equal(presentedOffsetMs(2_400, 2_860), 460);
  await capture.stop();
  await capture.stop();
  assert.deepEqual(calls, ["start", "stop"]);
});

test("capture without video uses page-ready time and skips screencast", async () => {
  const page = {
    screencast: {
      async start() {
        assert.fail("screencast must not start when video is disabled");
      },
    },
  };

  const capture = await startPageCapture(page, {
    video: false,
    now: () => 9_000,
  });

  assert.equal(capture.startedAtMs, 9_000);
  assert.equal(capture.timingBasis, "page-ready-wall-clock");
  await capture.stop();
});

test("loopback fixture completes deterministic registration and signing", async (t) => {
  const fixture = await startFixtureServer();
  t.after(() => fixture.close());

  const statusResponse = await fetch(`${fixture.origin}/__fixture/status`);
  assert.equal(statusResponse.status, 200);
  assert.equal(statusResponse.headers.get("x-spiral-fixture-mode"), "true");
  const status = await statusResponse.json();
  assert.equal(status.fixtureMode, true);
  assert.match(status.label, /FIXTURE MODE/);

  const firstInit = await fixtureRequest(fixture.origin, "/init", {
    username: "recording-test",
    chain: "ethereum",
  });
  assert.equal(firstInit.response.status, 200);
  assert.match(firstInit.body.address, /^0x[0-9a-f]{40}$/);
  assert.equal(firstInit.body.ceremonyId.length, 43);

  await fixture.reset();
  const repeatedInit = await fixtureRequest(fixture.origin, "/init", {
    username: "recording-test",
    chain: "ethereum",
  });
  assert.equal(repeatedInit.body.ceremonyId, firstInit.body.ceremonyId);
  assert.equal(repeatedInit.body.address, firstInit.body.address);

  const created = await fixtureRequest(fixture.origin, "/create", {
    username: "recording-test",
    chain: "ethereum",
    ceremonyId: repeatedInit.body.ceremonyId,
    credential: {
      id: "fixture-public-credential",
      rawId: "fixture-public-credential",
    },
  });
  assert.equal(created.response.status, 200);

  const started = await fixtureRequest(fixture.origin, "/signin", {
    username: "recording-test",
    chain: "ethereum",
    operation: "message",
    payload: Buffer.from("fixture message").toString("base64"),
  });
  assert.equal(started.response.status, 200);
  assert.equal(started.body.options.publicKey.userVerification, "required");

  const completed = await fixtureRequest(fixture.origin, "/complete", {
    username: "recording-test",
    chain: "ethereum",
    operation: "message",
    ceremonyId: started.body.ceremonyId,
    credential: { id: "fixture-public-credential" },
  });
  assert.equal(completed.response.status, 200);
  assert.equal(completed.body.operation, "message");
  assert.equal(Buffer.from(completed.body.signature, "base64").length, 65);
  assert.doesNotMatch(JSON.stringify(completed.body), /should-never-appear/);

  const replayed = await fixtureRequest(fixture.origin, "/complete", {
    username: "recording-test",
    chain: "ethereum",
    operation: "message",
    ceremonyId: started.body.ceremonyId,
    credential: { id: "fixture-public-credential" },
  });
  assert.equal(replayed.response.status, 422);
});

test("dashboard pages are fixture-labeled and expose stable recording hooks", async (t) => {
  const fixture = await startFixtureServer();
  t.after(() => fixture.close());
  for (const kind of ["developer", "admin"]) {
    assert.ok(
      ["actual", "fixture-fallback"].includes(fixture.dashboardSources[kind]),
    );
    const response = await fetch(fixture.pages[kind]);
    assert.equal(response.status, 200);
    const html = await response.text();
    if (fixture.dashboardSources[kind] === "fixture-fallback") {
      assert.match(html, /Fixture mode/i);
      assert.match(html, new RegExp(`data-recording="${kind}-`));
    }
  }
});

async function fixtureRequest(origin, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      Authorization: "Bearer should-never-appear",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}
