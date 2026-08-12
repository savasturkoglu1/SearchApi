import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  BrowserManager,
  type BrowserManagerOptions,
} from "../src/managers/browser.manager.js";

const profileDirectory = await mkdtemp(path.join(os.tmpdir(), "market-session-smoke-"));
const createBrowser = () => new BrowserManager({
  engine: process.env.BROWSER_ENGINE === "playwright" ? "playwright" : "patchright",
  headless: process.env.BROWSER_HEADLESS !== "false",
  channel: process.env.BROWSER_CHANNEL || "chrome",
  maxContexts: 3,
  contextOptions: {
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    geolocation: { latitude: 50.1109, longitude: 8.6821, accuracy: 50 },
    permissions: ["geolocation"],
  },
  sessionMode: "persistent",
  userDataDir: profileDirectory,
} satisfies BrowserManagerOptions);

let browser = createBrowser();

try {
  await browser.start();
  const warmPage = await browser.newPage("warm");
  await warmPage.context().addCookies([
    {
      name: "market_session_smoke",
      value: "shared",
      url: "https://www.google.com",
      expires: Math.floor(Date.now() / 1_000) + 86_400,
    },
  ]);

  const searchPage = await browser.newPage("search");
  const observed = await searchPage.evaluate(() => ({
    locale: navigator.language,
    timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));
  const cookies = await searchPage.context().cookies("https://www.google.com");
  const shared = cookies.some(
    (cookie) => cookie.name === "market_session_smoke" && cookie.value === "shared",
  );

  if (!shared) {
    throw new Error("Warm market context çerezi arama sayfasına taşınmadı");
  }
  if (observed.locale !== "de-DE" || observed.timezoneId !== "Europe/Berlin") {
    throw new Error(`Market profili korunmadı: ${observed.locale}/${observed.timezoneId}`);
  }

  await browser.stop();
  browser = createBrowser();
  await browser.start();
  const restartedPage = await browser.newPage("restarted");
  const restartedCookies = await restartedPage.context().cookies("https://www.google.com");
  const persisted = restartedCookies.some(
    (cookie) => cookie.name === "market_session_smoke" && cookie.value === "shared",
  );
  process.stdout.write(`${JSON.stringify({ observed, shared, persisted })}\n`);
  if (!persisted) {
    throw new Error("Market context çerezi browser restartından sonra kayboldu");
  }
} finally {
  await browser.stop();
  await rm(profileDirectory, { recursive: true, force: true });
}
