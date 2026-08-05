import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ApiCaptureManager } from "../src/managers/api-capture.manager.js";
import { BrowserManager } from "../src/managers/browser.manager.js";
import { BrowserRpcTransport } from "../src/travel/browser-rpc.transport.js";
import { GoogleTravelSearch } from "../src/travel/google-travel.search.js";

const captureDirectory = await mkdtemp(path.join(os.tmpdir(), "travel-search-smoke-"));
const browser = new BrowserManager({
  engine: process.env.BROWSER_ENGINE === "playwright" ? "playwright" : "patchright",
  headless: process.env.BROWSER_HEADLESS === "true",
  channel: process.env.BROWSER_CHANNEL || "chrome",
  maxContexts: 2,
});
const capture = new ApiCaptureManager({
  directory: captureDirectory,
  maxBodyBytes: 2 * 1024 * 1024,
  includeSensitive: false,
});
const search = new GoogleTravelSearch(new BrowserRpcTransport(browser, capture), 90_000);

try {
  const departure = process.env.SMOKE_DEPARTURE_DATE ?? futureDate(50);
  const returning = process.env.SMOKE_RETURN_DATE ?? futureDate(57);
  const checkIn = futureDate(60);
  const checkOut = futureDate(63);
  const flight = await search.searchFlights({
    origin: process.env.SMOKE_ORIGIN ?? "IST",
    destination: process.env.SMOKE_DESTINATION ?? "AMS",
    departureDate: departure,
    returnDate: returning,
    adults: envInteger("SMOKE_ADULTS", 3),
    children: envInteger("SMOKE_CHILDREN", 2),
    cabin: "economy",
    currency: "TRY",
    language: "tr",
  });
  const outboundOfferId = flight.offers[0]?.sourceOfferId;
  if (!outboundOfferId) throw new Error("Smoke aramasında gidiş offerId dönmedi");
  const returns = await search.searchFlightReturns({ offerId: outboundOfferId });
  const returnOfferId = returns.offers[0]?.sourceOfferId;
  if (!returnOfferId) throw new Error("Smoke aramasında dönüş offerId dönmedi");
  const bookings = await search.searchFlightBookings({ offerId: returnOfferId });
  const hotel = await search.searchHotels({
    destination: "Amsterdam",
    checkIn,
    checkOut,
    adults: 2,
    rooms: 1,
    children: 0,
    currency: "TRY",
    language: "tr",
  });
  console.log(JSON.stringify({
    flights: flight.offers.length,
    returns: returns.offers.length,
    bookingOptions: bookings.bookingOptions.length,
    hasSingleBookingUrl: Boolean(bookings.bookingUrl),
    hotels: hotel.stays.length,
    hotelsWithBookingUrl: hotel.stays.filter((stay) => stay.bookingUrl).length,
  }));
  if (
    flight.offers.length === 0 ||
    returns.offers.length === 0 ||
    bookings.bookingOptions.length === 0 ||
    hotel.stays.length === 0
  ) {
    process.exitCode = 1;
  }
} finally {
  await search.closeAll();
  await browser.stop();
  await rm(captureDirectory, { recursive: true, force: true });
}

function futureDate(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function envInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) throw new Error(`${name} tam sayı olmalı`);
  return parsed;
}
