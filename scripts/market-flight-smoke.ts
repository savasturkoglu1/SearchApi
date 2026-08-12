import path from "node:path";

import { ApiCaptureManager } from "../src/managers/api-capture.manager.js";
import { BrowserManager } from "../src/managers/browser.manager.js";
import { BrowserRpcTransport } from "../src/travel/browser-rpc.transport.js";
import { GoogleTravelSearch } from "../src/travel/google-travel.search.js";

const locale = process.env.SMOKE_LOCALE ?? "fi-FI";
const timezoneId = process.env.SMOKE_TIMEZONE_ID ?? "Europe/Helsinki";
const language = process.env.SMOKE_LANGUAGE ?? "fi";
const country = process.env.SMOKE_COUNTRY ?? "FI";
const currency = process.env.SMOKE_CURRENCY ?? "EUR";
const origin = process.env.SMOKE_ORIGIN ?? "HEL";
const destination = process.env.SMOKE_DESTINATION ?? "IST";
const departureDate = process.env.SMOKE_DEPARTURE_DATE ?? futureDate(45);
const returnDate = process.env.SMOKE_RETURN_DATE ?? futureDate(52);
const captureDirectory = path.resolve(
  process.env.SMOKE_CAPTURE_DIR ?? ".api-capiture/market-smoke",
);
const browser = new BrowserManager({
  engine: process.env.BROWSER_ENGINE === "playwright" ? "playwright" : "patchright",
  headless: process.env.BROWSER_HEADLESS === "true",
  channel: process.env.BROWSER_CHANNEL || "chrome",
  maxContexts: 2,
  contextOptions: {
    locale,
    timezoneId,
    geolocation: { latitude: 60.1699, longitude: 24.9384, accuracy: 50 },
    permissions: ["geolocation"],
  },
});
const capture = new ApiCaptureManager({
  directory: captureDirectory,
  maxBodyBytes: 2 * 1024 * 1024,
  includeSensitive: false,
});
const search = new GoogleTravelSearch(new BrowserRpcTransport(browser, capture), 90_000);

try {
  await browser.start();
  const diagnosticPage = await browser.newPage("market-profile-diagnostic");
  const runtimeProfile = await diagnosticPage.evaluate(() => ({
    language: navigator.language,
    languages: navigator.languages,
    timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));
  const browserProfile = {
    ...runtimeProfile,
    configuredCoordinates: { latitude: 60.1699, longitude: 24.9384 },
  };
  await browser.closePage(diagnosticPage);
  process.stdout.write(`${JSON.stringify({ browserProfile, captureDirectory }, null, 2)}\n`);

  const result = await search.searchFlights({
    origin,
    destination,
    departureDate,
    returnDate,
    adults: 1,
    children: 0,
    cabin: "economy",
    currency,
    language,
    country,
  });
  process.stdout.write(`${JSON.stringify({
    browserProfile,
    query: result.query,
    searchUrl: result.searchUrl,
    offerCount: result.offers.length,
    offers: result.offers.slice(0, 5).map((offer) => ({
      airline: offer.outboundSegments.map((segment) => segment.airlineName).join(" + "),
      departureTime: offer.outboundSegments[0]?.departureTime,
      arrivalTime: offer.outboundSegments.at(-1)?.arrivalTime,
      stops: offer.stops,
      totalPrice: offer.totalPrice,
      currency: offer.currency,
    })),
  }, null, 2)}\n`);
} finally {
  await search.closeAll();
  await browser.stop();
}

function futureDate(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
