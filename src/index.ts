import { createServer } from "node:http";
import { createApp } from "./app";
import { loadConfig } from "./config";

function main(): void {
  const config = loadConfig();
  const server = createServer(createApp(config));
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
      }),
    );
  });
}

try {
  main();
} catch (error) {
  console.error(
    JSON.stringify({
      level: "error",
      message:
        error instanceof Error ? error.message : "service configuration failed",
    }),
  );
  process.exitCode = 1;
}
