import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";

import type {
  ContentExtractionInput,
  ContentExtractionResult,
  ContentExtractor,
} from "../src/content/content-extractor.js";
import { ProfiledContentExtractor } from "../src/content/market-content.extractor.js";
import { MARKET_PROFILES } from "../src/markets/market-profile.js";
import type { BrowserPageProvider, BrowserStatus } from "../src/managers/browser.manager.js";

class ProbeExtractor implements ContentExtractor {
  readonly inputs: ContentExtractionInput[] = [];

  async extract(input: ContentExtractionInput): Promise<ContentExtractionResult> {
    this.inputs.push(input);
    return { pages: [], errors: [] };
  }
}

class ProbeBrowser implements BrowserPageProvider {
  stopCalls = 0;
  async start(): Promise<void> {}
  async stop(): Promise<void> { this.stopCalls += 1; }
  async newPage(): Promise<Page> { throw new Error("testte çağrılmamalı"); }
  async closePage(): Promise<void> {}
  status(): BrowserStatus {
    return {
      running: false,
      engine: "patchright",
      headless: true,
      channel: "chrome",
      openPages: 0,
      sessionMode: "isolated",
    };
  }
}

test("market profili scraper locale'ini belirler ve browser havuzunu kapatır", async () => {
  const probe = new ProbeExtractor();
  const browser = new ProbeBrowser();
  const profiled = new ProfiledContentExtractor(
    [MARKET_PROFILES["DE-FRA"]],
    () => ({ browserManager: browser, extractor: probe }),
  );

  await profiled.extract({
    marketProfile: "DE-FRA",
    urls: ["https://example.com/berlin"],
    maxCharactersPerPage: 5_000,
    renderMode: "auto",
  });

  assert.equal(probe.inputs[0]?.locale, "de-DE");
  await profiled.closeAll();
  assert.equal(browser.stopCalls, 1);
});
