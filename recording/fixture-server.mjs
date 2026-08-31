import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, Transaction } from "@solana/web3.js";
import { startDashboardServer } from "./dashboard-server.mjs";

const recordingDirectory = dirname(fileURLToPath(import.meta.url));
const servicesDirectory = resolve(recordingDirectory, "..");
const extensionDirectory = resolve(servicesDirectory, "..", "extension");
const publicDirectory = resolve(servicesDirectory, "public");
const extensionDemoDirectory = resolve(extensionDirectory, "demo", "dist");
const fixtureDirectory = resolve(recordingDirectory, "fixtures");
const fixtureKeypair = Keypair.fromSeed(
  Uint8Array.from({ length: 32 }, (_, index) => index + 1),
);

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
]);

export async function startFixtureServer({
  port = 0,
  dashboards = false,
} = {}) {
  const state = createFixtureState();
  const fallbackDashboardPages = await detectDashboardPages();
  const server = createServer((request, response) => {
    void handleRequest(request, response, state, fallbackDashboardPages);
  });

  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture server did not expose a TCP port");
  }
  const origin = `http://localhost:${address.port}`;
  let dashboard;
  try {
    dashboard = dashboards ? await startDashboardServer() : undefined;
  } catch (error) {
    await closeServer(server);
    throw error;
  }
  const dashboardPages = dashboard
    ? {
        developer: {
          url: dashboard.pages.developer,
          loginUrl: dashboard.loginPages.developer,
          source: dashboard.source,
        },
        admin: {
          url: dashboard.pages.admin,
          loginUrl: dashboard.loginPages.admin,
          source: dashboard.source,
        },
      }
    : Object.fromEntries(
        Object.entries(fallbackDashboardPages).map(([kind, page]) => [
          kind,
          {
            url: `${origin}${page.path}`,
            loginUrl: null,
            source: page.source,
          },
        ]),
      );
  return {
    origin,
    fixtureMode: true,
    pages: {
      extensionDemo: `${origin}/extension-demo/`,
      standaloneWallet: `${origin}/wallet/?api=${encodeURIComponent(origin)}`,
      developer: dashboardPages.developer.url,
      admin: dashboardPages.admin.url,
    },
    dashboardLoginPages: {
      developer: dashboardPages.developer.loginUrl,
      admin: dashboardPages.admin.loginUrl,
    },
    dashboardCredentials: dashboard?.credentials,
    dashboardSources: {
      developer: dashboardPages.developer.source,
      admin: dashboardPages.admin.source,
    },
    async reset() {
      resetFixtureState(state);
    },
    async close() {
      try {
        await dashboard?.close();
      } finally {
        await closeServer(server);
      }
    },
  };
}

async function closeServer(server) {
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

function createFixtureState() {
  return {
    sequence: 0,
    wallets: new Map(),
    ceremonies: new Map(),
  };
}

function resetFixtureState(state) {
  state.sequence = 0;
  state.wallets.clear();
  state.ceremonies.clear();
}

async function detectDashboardPages() {
  return {
    developer: await detectPage(
      [
        [resolve(publicDirectory, "developer.html"), "/developer.html"],
        [resolve(publicDirectory, "developer", "index.html"), "/developer/"],
        [
          resolve(publicDirectory, "dashboard", "developer.html"),
          "/dashboard/developer.html",
        ],
      ],
      "/recording-fixtures/developer.html",
    ),
    admin: await detectPage(
      [
        [resolve(publicDirectory, "admin.html"), "/admin.html"],
        [resolve(publicDirectory, "admin", "index.html"), "/admin/"],
        [
          resolve(publicDirectory, "dashboard", "admin.html"),
          "/dashboard/admin.html",
        ],
      ],
      "/recording-fixtures/admin.html",
    ),
  };
}

async function detectPage(candidates, fallbackPath) {
  for (const [file, path] of candidates) {
    try {
      await access(file);
      return { path, source: "actual" };
    } catch {
      // Try the next known dashboard location.
    }
  }
  return { path: fallbackPath, source: "fixture-fallback" };
}

async function handleRequest(request, response, state, dashboardPages) {
  try {
    const url = new URL(request.url || "/", "http://localhost");
    setCommonHeaders(request, response);
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/__fixture/status") {
      respondJSON(response, 200, {
        fixtureMode: true,
        label: "FIXTURE MODE · synthetic local data",
        solanaAddress: fixtureKeypair.publicKey.toBase58(),
        dashboards: dashboardPages,
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/__fixture/reset") {
      resetFixtureState(state);
      respondJSON(response, 200, { fixtureMode: true, reset: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/rpc") {
      await handleRPC(request, response);
      return;
    }
    if (
      request.method === "POST" &&
      ["/init", "/create", "/check", "/signin", "/complete"].includes(
        url.pathname,
      )
    ) {
      await handleWalletAPI(request, response, state, url.pathname);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      respondJSON(response, 405, {
        error: {
          code: "method_not_allowed",
          message: "Fixture route is read-only",
        },
      });
      return;
    }
    await handleStatic(url.pathname, request.method, response);
  } catch (error) {
    respondJSON(response, 500, {
      error: {
        code: "fixture_error",
        message: error instanceof Error ? error.message : "Fixture failed",
      },
    });
  }
}

function setCommonHeaders(request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Spiral-Fixture-Mode", "true");
  const origin = request.headers.origin;
  if (
    typeof origin === "string" &&
    (/^chrome-extension:\/\/[a-p]{32}$/.test(origin) ||
      /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin))
  ) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader(
    "Access-Control-Allow-Headers",
    "authorization, content-type, x-request-id",
  );
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

async function handleWalletAPI(request, response, state, path) {
  const body = await readJSONBody(request);
  const username = String(body.username || "");
  const chain = body.chain === "ethereum" ? "ethereum" : "solana";
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/.test(username)) {
    respondJSON(response, 400, {
      error: {
        code: "invalid_username",
        message: "Fixture username is invalid",
      },
    });
    return;
  }
  const key = `${username}:${chain}`;
  const wallet = state.wallets.get(key);

  if (path === "/init") {
    const current = wallet || {
      username,
      chain,
      address:
        chain === "solana"
          ? fixtureKeypair.publicKey.toBase58()
          : "0x1111111111111111111111111111111111111111",
      credentialId: null,
      registered: false,
    };
    state.wallets.set(key, current);
    const ceremonyId = nextID(state, `registration:${key}`);
    state.ceremonies.set(ceremonyId, { type: "registration", key });
    respondJSON(response, 200, {
      fixtureMode: true,
      chain,
      address: current.address,
      ...(chain === "solana" ? { pubKey: current.address } : {}),
      ceremonyId,
      options: registrationOptions(state, username),
    });
    return;
  }

  if (!wallet) {
    respondJSON(response, 404, {
      error: { code: "wallet_not_found", message: "Fixture wallet not found" },
    });
    return;
  }

  if (path === "/create") {
    const ceremony = consumeCeremony(
      state,
      body.ceremonyId,
      "registration",
      key,
    );
    if (!ceremony) {
      respondJSON(response, 422, {
        error: {
          code: "fixture_ceremony",
          message: "Fixture ceremony is invalid",
        },
      });
      return;
    }
    wallet.credentialId = String(
      body.credential?.rawId || body.credential?.id || "",
    );
    if (!wallet.credentialId) {
      respondJSON(response, 400, {
        error: {
          code: "invalid_credential",
          message: "Credential is required",
        },
      });
      return;
    }
    wallet.registered = true;
    respondJSON(response, 200, walletResponse(wallet));
    return;
  }

  if (!wallet.registered) {
    respondJSON(response, 404, {
      error: {
        code: "wallet_not_found",
        message: "Fixture wallet registration is incomplete",
      },
    });
    return;
  }

  if (path === "/check") {
    respondJSON(response, 200, walletResponse(wallet));
    return;
  }

  if (path === "/signin") {
    const operation = body.operation === "message" ? "message" : "transaction";
    if (chain === "ethereum" && operation !== "message") {
      respondJSON(response, 422, {
        error: {
          code: "unsupported_operation",
          message: "Fixture Ethereum supports EIP-191 messages only",
        },
      });
      return;
    }
    const ceremonyId = nextID(state, `authentication:${key}`);
    state.ceremonies.set(ceremonyId, {
      type: "authentication",
      key,
      operation,
      payload: String(body.payload || body.rawTx || ""),
    });
    respondJSON(response, 200, {
      ...walletResponse(wallet),
      fixtureMode: true,
      ceremonyId,
      options: assertionOptions(state, wallet),
    });
    return;
  }

  const ceremony = consumeCeremony(
    state,
    body.ceremonyId,
    "authentication",
    key,
  );
  if (!ceremony) {
    respondJSON(response, 422, {
      error: {
        code: "fixture_ceremony",
        message: "Fixture ceremony is invalid",
      },
    });
    return;
  }
  const requestedOperation =
    body.operation === "message" ? "message" : "transaction";
  if (requestedOperation !== ceremony.operation) {
    respondJSON(response, 422, {
      error: {
        code: "fixture_operation_mismatch",
        message: "Fixture completion operation does not match its ceremony",
      },
    });
    return;
  }
  const result = await fixtureSignature(wallet, ceremony);
  respondJSON(response, 200, {
    ...walletResponse(wallet),
    fixtureMode: true,
    operation: ceremony.operation,
    ...result,
  });
}

function walletResponse(wallet) {
  return {
    chain: wallet.chain,
    address: wallet.address,
    ...(wallet.chain === "solana" ? { pubKey: wallet.address } : {}),
  };
}

function registrationOptions(state, username) {
  return {
    publicKey: {
      challenge: nextID(state, "registration-challenge"),
      rp: { id: "localhost", name: "Spiral Safe fixture" },
      user: {
        id: createHash("sha256")
          .update(`fixture:${username}`)
          .digest("base64url"),
        name: username,
        displayName: `${username} (fixture)`,
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
      },
      attestation: "none",
      timeout: 60_000,
    },
  };
}

function assertionOptions(state, wallet) {
  return {
    publicKey: {
      challenge: nextID(state, "assertion-challenge"),
      rpId: "localhost",
      allowCredentials: [
        {
          id: wallet.credentialId,
          type: "public-key",
          transports: ["internal"],
        },
      ],
      userVerification: "required",
      timeout: 60_000,
    },
  };
}

function nextID(state, scope) {
  state.sequence += 1;
  return createHash("sha256")
    .update(`spiral-safe-recording:${scope}:${state.sequence}`)
    .digest("base64url");
}

function consumeCeremony(state, value, type, key) {
  const id = typeof value === "string" ? value : "";
  const ceremony = state.ceremonies.get(id);
  state.ceremonies.delete(id);
  if (!ceremony || ceremony.type !== type || ceremony.key !== key) return null;
  return ceremony;
}

async function fixtureSignature(wallet, ceremony) {
  if (wallet.chain === "solana" && ceremony.operation === "transaction") {
    const transaction = Transaction.from(
      Buffer.from(ceremony.payload, "base64"),
    );
    transaction.partialSign(fixtureKeypair);
    return {
      encodedTX: transaction
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString("base64"),
    };
  }
  const size = wallet.chain === "ethereum" ? 65 : 64;
  const signature = Buffer.alloc(
    size,
    wallet.chain === "ethereum" ? 0x45 : 0x53,
  );
  if (wallet.chain === "ethereum") signature[size - 1] = 0;
  return { signature: signature.toString("base64") };
}

async function handleRPC(request, response) {
  const body = await readJSONBody(request);
  let result;
  if (body.method === "getLatestBlockhash") {
    result = {
      context: { slot: 424_242 },
      value: {
        blockhash: "11111111111111111111111111111111",
        lastValidBlockHeight: 999_999,
      },
    };
  } else if (body.method === "sendTransaction") {
    result = "1".repeat(64);
  } else if (body.method === "getHealth") {
    result = "ok";
  } else {
    respondJSON(response, 200, {
      jsonrpc: "2.0",
      id: body.id ?? 1,
      error: { code: -32601, message: "Fixture RPC method not implemented" },
    });
    return;
  }
  respondJSON(response, 200, { jsonrpc: "2.0", id: body.id ?? 1, result });
}

async function readJSONBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_048_576) throw new Error("Fixture request exceeds 1 MiB");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function handleStatic(pathname, method, response) {
  const requested = decodeURIComponent(pathname);
  let root;
  let relative;
  if (requested === "/wallet" || requested === "/wallet/") {
    root = publicDirectory;
    relative = "index.html";
  } else if (requested.startsWith("/extension-demo/")) {
    root = extensionDemoDirectory;
    relative = requested.slice("/extension-demo/".length) || "index.html";
  } else if (requested.startsWith("/recording-fixtures/")) {
    root = fixtureDirectory;
    relative = requested.slice("/recording-fixtures/".length);
  } else {
    root = publicDirectory;
    relative = requested.replace(/^\/+/, "") || "index.html";
  }
  const file = resolve(root, relative);
  if (!file.startsWith(root + sep)) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }
  try {
    const details = await stat(file);
    if (!details.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "Content-Type":
        contentTypes.get(extname(file)) || "application/octet-stream",
      "Content-Length": details.size,
    });
    if (method === "HEAD") {
      response.end();
      return;
    }
    response.end(await readFile(file));
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

function respondJSON(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}
