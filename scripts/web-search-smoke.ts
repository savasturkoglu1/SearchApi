import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ApiCaptureManager } from "../src/managers/api-capture.manager.js";
import { BrowserManager } from "../src/managers/browser.manager.js";
import { BrowserRpcTransport } from "../src/travel/browser-rpc.transport.js";
import { GoogleTravelSearch } from "../src/travel/google-travel.search.js";

const captureDirectory = await mkdtemp(path.join(os.tmpdir(), "web-search-smoke-"));
const browser = new BrowserManager({
  engine: process.env.BROWSER_ENGINE === "playwright" ? "playwright" : "patchright",
  headless: process.env.BROWSER_HEADLESS !== "false",
  channel: process.env.BROWSER_CHANNEL || "chrome",
  maxContexts: 1,
});
const capture = new ApiCaptureManager({
  directory: captureDirectory,
  maxBodyBytes: 2 * 1024 * 1024,
  includeSensitive: false,
});
const search = new GoogleTravelSearch(new BrowserRpcTransport(browser, capture), 90_000);
const queries = (process.env.SMOKE_WEB_QUERIES ?? "airport transfer|varşova gezi planı")
  .split("|")
  .map((query) => query.trim())
  .filter(Boolean);

try {
  const summaries = [];
  for (const query of queries) {
    const result = await search.searchWeb({
      query,
      limit: 5,
      language: "tr",
      country: "TR",
      safeSearch: true,
    });
    if (result.results.length === 0) {
      throw new Error(`Google web smoke aramasında sonuç dönmedi: ${query}`);
    }
    summaries.push({
      query,
      count: result.results.length,
      first: {
        title: result.results[0]?.title,
        url: result.results[0]?.url,
      },
    });
  }
  process.stdout.write(`${JSON.stringify(summaries)}\n`);
} finally {
  await search.closeAll();
  await browser.stop();
  await rm(captureDirectory, { recursive: true, force: true });
}
