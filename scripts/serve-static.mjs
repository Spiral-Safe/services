import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const publicDirectory = resolve(fileURLToPath(new URL("../public/", import.meta.url)));
const port = Number(process.env.CLIENT_PORT || 9080);
const listenHost = process.env.CLIENT_HOST || "127.0.0.1";
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
]);
const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; connect-src 'self' http://localhost:* http://127.0.0.1:* http://[::1]:*; form-action 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy":
    "publickey-credentials-create=(self), publickey-credentials-get=(self)",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname);
    const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = resolve(publicDirectory, relativePath);
    if (!filePath.startsWith(publicDirectory + sep)) {
      response.writeHead(403, securityHeaders).end("Forbidden");
      return;
    }
    const details = await stat(filePath);
    if (!details.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      ...securityHeaders,
      "Cache-Control": "no-store",
      "Content-Length": details.size,
      "Content-Type": contentTypes.get(extname(filePath)) || "application/octet-stream",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response
      .writeHead(404, {
        ...securityHeaders,
        "Content-Type": "text/plain; charset=utf-8",
      })
      .end("Not found");
  }
}).listen(port, listenHost, () => {
  console.log(`Demo listening on ${listenHost}:${port}`);
});
