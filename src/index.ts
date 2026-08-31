import { createServer } from "node:http";
import { createApp } from "./app";
import { createBillingRuntime } from "./billing/runtime";
import { loadConfig } from "./config";

async function main(): Promise<void> {
  const config = loadConfig();
  const billing = await createBillingRuntime(config.billing);
  const server = createServer(createApp(config, undefined, billing));
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.listen(config.port, "0.0.0.0", () => {
    console.log(
      JSON.stringify({
        level: "info",
        message: "service listening",
        port: config.port,
        devMode: config.devMode,
        billingMode: config.billing.mode,
      }),
    );
  });
  const shutdown = async () => {
    server.close();
    await billing?.close();
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      level: "error",
      message:
        error instanceof Error ? error.message : "service configuration failed",
    }),
  );
  process.exitCode = 1;
});
