import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import { ApiCaptureManager } from "../src/managers/api-capture.manager.js";
import { BrowserManager } from "../src/managers/browser.manager.js";
import { ContextManager } from "../src/managers/context.manager.js";

const captureDirectory = await mkdtemp(path.join(os.tmpdir(), "browser-capture-smoke-"));
const engine = process.env.BROWSER_ENGINE === "playwright" ? "playwright" : "patchright";
const browserManager = new BrowserManager({
  engine,
  headless: true,
  maxContexts: 1,
  ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
});
const captureManager = new ApiCaptureManager({
  directory: captureDirectory,
  maxBodyBytes: 1_024 * 1_024,
  includeSensitive: false,
});
const contextManager = new ContextManager(browserManager, captureManager, 1);

const fixtureServer = createServer((request, response) => {
  if (request.url === "/api/data") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, source: "browser-smoke" }));
    return;
  }

  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><script>
    fetch('/api/data', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ route: 'IST-AMS' })
    });
  </script>`);
});

await new Promise<void>((resolve, reject) => {
  fixtureServer.once("error", reject);
  fixtureServer.listen(0, "127.0.0.1", resolve);
});
const address = fixtureServer.address();
if (!address || typeof address === "string") throw new Error("Fixture portu alınamadı");

try {
  const context = await contextManager.create({ url: `http://127.0.0.1:${address.port}` });
  const deadline = Date.now() + 5_000;
  while ((captureManager.getSummary(context.id)?.captured ?? 0) < 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const closed = await contextManager.close(context.id);
  if (closed.captured !== 1) {
    throw new Error(`Beklenen 1 fetch yerine ${closed.captured} capture oluştu`);
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, engine, captured: closed.captured, captureDirectory: closed.directory }, null, 2)}\n`,
  );
} finally {
  await contextManager.closeAll();
  await browserManager.stop();
  await new Promise<void>((resolve, reject) => {
    fixtureServer.close((error) => (error ? reject(error) : resolve()));
  });
  await rm(captureDirectory, { recursive: true, force: true });
}
