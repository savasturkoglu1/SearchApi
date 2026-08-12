import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";

import { BrowserManager } from "../src/managers/browser.manager.js";

test("BrowserPool registry temizliği için kapanmış page'e de close çağrısı yapar", async () => {
  let closeCalls = 0;
  const page = {
    isClosed: () => true,
    close: async () => {
      closeCalls += 1;
    },
  } as unknown as Page;
  const browser = new BrowserManager({
    engine: "patchright",
    headless: true,
    maxContexts: 1,
  });

  await browser.closePage(page);

  assert.equal(closeCalls, 1);
});
