import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ServiceConfig } from "./config";
import { KubernetesTokenProvider, VaultClient } from "./vault";

async function withJWT(run: (jwtPath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "spiral-safe-vault-test-"));
  const jwtPath = join(directory, "token");
  try {
    await writeFile(jwtPath, "service-account-jwt\n", { mode: 0o600 });
    await run(jwtPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("Kubernetes tokens cache only until the lease refresh boundary", async () => {
  await withJWT(async (jwtPath) => {
    let now = 1_000;
    let loginCalls = 0;
    const fakeFetch = (async (_input: unknown, init?: RequestInit) => {
      loginCalls += 1;
      assert.deepEqual(JSON.parse(String(init?.body)), {
        role: "spiral-safe",
        jwt: "service-account-jwt",
      });
      return response({
        auth: { client_token: `token-${loginCalls}`, lease_duration: 10 },
      });
    }) as typeof fetch;
    const provider = new KubernetesTokenProvider(
      "https://vault.example",
      "spiral-safe",
      jwtPath,
      "auth/kubernetes",
      fakeFetch,
      () => now,
    );

    assert.equal(await provider.token(), "token-1");
    now = 8_999;
    assert.equal(await provider.token(), "token-1");
    assert.equal(loginCalls, 1);
    now = 9_000;
    assert.equal(await provider.token(), "token-2");
    assert.equal(loginCalls, 2);
    provider.invalidate();
    assert.equal(await provider.token(), "token-3");
    assert.equal(loginCalls, 3);
  });
});

test("a Vault 403 invalidates Kubernetes auth and retries once", async () => {
  await withJWT(async (jwtPath) => {
    let loginCalls = 0;
    const requestTokens: string[] = [];
    const fakeFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.endsWith("/auth/kubernetes/login")) {
        loginCalls += 1;
        return response({
          auth: { client_token: `token-${loginCalls}`, lease_duration: 60 },
        });
      }
      requestTokens.push(
        String((init?.headers as Record<string, string>)["X-Vault-Token"]),
      );
      return requestTokens.length === 1
        ? response({ errors: ["permission denied"] }, 403)
        : response({ data: { chain: "solana", address: "wallet" } });
    }) as typeof fetch;
    const provider = new KubernetesTokenProvider(
      "https://vault.example",
      "spiral-safe",
      jwtPath,
      "auth/kubernetes",
      fakeFetch,
    );
    const config = {
      vaultAddress: "https://vault.example",
    } as ServiceConfig;
    const client = new VaultClient(config, fakeFetch, provider);

    assert.deepEqual(await client.post("check", { username: "alice" }), {
      chain: "solana",
      address: "wallet",
    });
    assert.equal(loginCalls, 2);
    assert.deepEqual(requestTokens, ["token-1", "token-2"]);
  });
});
