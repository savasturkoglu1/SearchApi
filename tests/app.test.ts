import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright";

import type { ContentExtractionResult } from "../src/content/content-extractor.js";
import type {
  MarketContentExtractionInput,
  MarketContentExtractor,
} from "../src/content/market-content.extractor.js";
import type { DestinationResearchResult } from "../src/destination/destination-research.js";
import { buildApp, listenApp, type AppDependencies } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { MARKET_PROFILES } from "../src/markets/market-profile.js";
import { ApiCaptureManager } from "../src/managers/api-capture.manager.js";
import type { BrowserPageProvider, BrowserStatus } from "../src/managers/browser.manager.js";
import type {
  ContextRegistry,
  ContextSnapshot,
  CreateContextInput,
} from "../src/managers/context.manager.js";
import type {
  FlightSearchResult,
  FlightBookingResult,
  FlightLocationSuggestion,
  HotelSearchResult,
  WebSearchResult,
} from "../src/travel/travel-search.js";
import type {
  MarketAccommodationSearchInput,
  MarketDestinationResearchInput,
  MarketFlightOfferSelectionInput,
  MarketFlightSearchInput,
  MarketTravelSearch,
  MarketWebSearchInput,
} from "../src/travel/market-travel.search.js";

const token = "0123456789abcdef";

class FakeBrowserManager implements BrowserPageProvider {
  running = false;

  async start() {
    this.running = true;
  }

  async stop() {
    this.running = false;
  }

  async newPage(): Promise<Page> {
    throw new Error("testte çağrılmamalı");
  }

  async closePage(): Promise<void> {}

  status(): BrowserStatus {
    return {
      running: this.running,
      engine: "patchright",
      headless: true,
      channel: null,
      openPages: 0,
      sessionMode: "isolated",
    };
  }
}

class FakeContextManager implements ContextRegistry {
  private readonly context: ContextSnapshot = {
    id: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-08-04T00:00:00.000Z",
    pages: ["about:blank"],
    capture: {
      contextId: "11111111-1111-4111-8111-111111111111",
      directory: "/tmp/test",
      startedAt: "2026-08-04T00:00:00.000Z",
      captured: 0,
      failed: 0,
      active: true,
    },
  };

  async create(_input: CreateContextInput) {
    return this.context;
  }

  list() {
    return [this.context];
  }

  get() {
    return this.context;
  }

  async navigate(_id: string, url: string) {
    return { ...this.context, pages: [url] };
  }

  async close() {
    return { ...this.context.capture, active: false };
  }

  async closeAll(): Promise<void> {}
}

class FakeMarketContentExtractor implements MarketContentExtractor {
  lastInput?: MarketContentExtractionInput;

  async extract(input: MarketContentExtractionInput): Promise<ContentExtractionResult> {
    this.lastInput = input;
    return {
      pages: [{
        requestedUrl: input.urls[0] ?? "https://example.com",
        finalUrl: input.urls[0] ?? "https://example.com",
        title: "Amsterdam Gezi Rehberi",
        text: "Temizlenmiş gezi yazısı",
        chunks: [{ id: "page-1-chunk-1", text: "Temizlenmiş gezi yazısı" }],
        contentLength: 24,
        truncated: false,
        extractionMode: "http",
        contentTrust: "external_untrusted",
        contentHash: "a".repeat(64),
        retrievedAt: "2026-08-06T00:00:00.000Z",
      }],
      errors: [],
    };
  }

  async closeAll(): Promise<void> {}
}

class FakeTravelSearch implements MarketTravelSearch {
  lastHotelInput?: MarketAccommodationSearchInput;
  lastVacationRentalInput?: MarketAccommodationSearchInput;
  lastDestinationInput?: MarketDestinationResearchInput;
  startCalls = 0;

  async startAll(): Promise<void> {
    this.startCalls += 1;
  }

  status() {
    return [];
  }

  async searchWeb(input: MarketWebSearchInput): Promise<WebSearchResult> {
    const profile = MARKET_PROFILES[input.marketProfile];
    return {
      query: {
        text: input.query,
        language: profile.language,
        country: profile.country,
        safeSearch: input.safeSearch,
      },
      results: [],
      searchUrl: "https://www.google.com/search",
      retrievedAt: "2026-08-05T00:00:00.000Z",
      errors: [],
    };
  }

  async suggestFlightLocations(): Promise<FlightLocationSuggestion[]> {
    return [];
  }

  async searchFlights(input: MarketFlightSearchInput): Promise<FlightSearchResult> {
    const profile = MARKET_PROFILES[input.marketProfile];
    return {
      query: {
        originAirports: [input.origin],
        destinationAirports: [input.destination],
        tripType: input.returnDate ? "round_trip" : "one_way",
        departureDate: input.departureDate,
        passengers: {
          adults: input.adults,
          children: input.children,
          infantsInSeat: 0,
          infantsOnLap: 0,
        },
        cabinClass: input.cabin,
        currency: profile.currency,
        locale: profile.language,
        ...(input.returnDate ? { returnDate: input.returnDate } : {}),
      },
      offers: [],
      searchUrl: "https://www.google.com/travel/flights",
      errors: [],
    };
  }

  async searchFlightReturns(_input: MarketFlightOfferSelectionInput): Promise<FlightSearchResult> {
    throw new Error("testte çağrılmamalı");
  }

  async searchFlightBookings(_input: MarketFlightOfferSelectionInput): Promise<FlightBookingResult> {
    throw new Error("testte çağrılmamalı");
  }

  async searchHotels(input: MarketAccommodationSearchInput): Promise<HotelSearchResult> {
    this.lastHotelInput = input;
    return this.stayResult(input, "hotels");
  }

  async searchVacationRentals(input: MarketAccommodationSearchInput): Promise<HotelSearchResult> {
    this.lastVacationRentalInput = input;
    return this.stayResult(input, "vacation_rentals");
  }

  async researchDestination(
    input: MarketDestinationResearchInput,
  ): Promise<DestinationResearchResult> {
    this.lastDestinationInput = input;
    const profile = MARKET_PROFILES[input.marketProfile];
    return {
      destination: input.destination,
      query: {
        interests: input.interests,
        language: profile.language,
        country: profile.country,
      },
      places: [],
      articles: [],
      searchUrls: { articles: [] },
      retrievedAt: "2026-08-06T00:00:00.000Z",
      errors: [],
    };
  }

  private stayResult(
    input: MarketAccommodationSearchInput,
    propertyType: "hotels" | "vacation_rentals",
  ): HotelSearchResult {
    const profile = MARKET_PROFILES[input.marketProfile];
    return {
      query: {
        location: input.destination,
        checkInDate: input.checkIn,
        checkOutDate: input.checkOut,
        guests: { adults: input.adults, children: input.children },
        propertyType,
        currency: profile.currency,
        locale: profile.language,
      },
      stays: [],
      searchUrl: "https://www.google.com/travel/search",
      errors: [],
    };
  }

  async closeAll(): Promise<void> {}
}

function config(captureDirectory: string): AppConfig {
  return {
    host: "127.0.0.1",
    port: 3045,
    apiToken: token,
    browser: {
      engine: "patchright",
      headless: true,
      maxContexts: 1,
      profileDirectory: path.join(captureDirectory, "browser-profiles"),
    },
    capture: {
      directory: captureDirectory,
      maxBodyBytes: 1024,
      includeSensitive: false,
    },
    search: { timeoutMs: 90_000 },
  };
}

function dependencies(
  captureDirectory: string,
  travelSearch: FakeTravelSearch,
): AppDependencies {
  return {
    browserManager: new FakeBrowserManager(),
    contextManager: new FakeContextManager(),
    captureManager: new ApiCaptureManager({
      directory: captureDirectory,
      maxBodyBytes: 1024,
      includeSensitive: false,
    }),
    travelSearch,
    contentExtractor: new FakeMarketContentExtractor(),
  };
}

test("port çakışan ikinci app market browser'larını başlatmaz", async () => {
  const firstDirectory = await mkdtemp(path.join(os.tmpdir(), "browser-app-first-"));
  const secondDirectory = await mkdtemp(path.join(os.tmpdir(), "browser-app-second-"));
  const firstTravel = new FakeTravelSearch();
  const secondTravel = new FakeTravelSearch();
  const firstDependencies = dependencies(firstDirectory, firstTravel);
  const secondDependencies = dependencies(secondDirectory, secondTravel);
  const first = buildApp(config(firstDirectory), firstDependencies);
  const second = buildApp(config(secondDirectory), secondDependencies);

  try {
    await listenApp(first, firstDependencies, { host: "127.0.0.1", port: 0 });
    const address = first.server.address();
    assert.ok(address && typeof address !== "string");

    await assert.rejects(
      listenApp(second, secondDependencies, { host: "127.0.0.1", port: address.port }),
      (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE",
    );
    assert.equal(firstTravel.startCalls, 1);
    assert.equal(secondTravel.startCalls, 0);
  } finally {
    await Promise.allSettled([first.close(), second.close()]);
    await Promise.all([
      rm(firstDirectory, { recursive: true, force: true }),
      rm(secondDirectory, { recursive: true, force: true }),
    ]);
  }
});

test("/v1 route'ları tokensız erişimi reddeder", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "browser-app-test-"));
  const dependencies: AppDependencies = {
    browserManager: new FakeBrowserManager(),
    contextManager: new FakeContextManager(),
    captureManager: new ApiCaptureManager({
      directory,
      maxBodyBytes: 1024,
      includeSensitive: false,
    }),
    travelSearch: new FakeTravelSearch(),
    contentExtractor: new FakeMarketContentExtractor(),
  };
  const app = buildApp(config(directory), dependencies);

  const response = await app.inject({ method: "GET", url: "/v1/browser" });
  assert.equal(response.statusCode, 401);

  await app.close();
  await rm(directory, { recursive: true, force: true });
});

test("token ile context oluşturur ve URL şemasını doğrular", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "browser-app-test-"));
  const dependencies: AppDependencies = {
    browserManager: new FakeBrowserManager(),
    contextManager: new FakeContextManager(),
    captureManager: new ApiCaptureManager({
      directory,
      maxBodyBytes: 1024,
      includeSensitive: false,
    }),
    travelSearch: new FakeTravelSearch(),
    contentExtractor: new FakeMarketContentExtractor(),
  };
  const app = buildApp(config(directory), dependencies);

  const created = await app.inject({
    method: "POST",
    url: "/v1/contexts",
    headers: { authorization: `Bearer ${token}` },
    payload: { url: "https://example.com" },
  });
  assert.equal(created.statusCode, 201);

  const invalid = await app.inject({
    method: "POST",
    url: "/v1/contexts",
    headers: { "x-api-token": token },
    payload: { url: "file:///etc/passwd" },
  });
  assert.equal(invalid.statusCode, 400);

  await app.close();
  await rm(directory, { recursive: true, force: true });
});

test("uçuş route'u yetişkin ve çocuk sayılarını arama servisine aktarır", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "browser-app-test-"));
  const dependencies: AppDependencies = {
    browserManager: new FakeBrowserManager(),
    contextManager: new FakeContextManager(),
    captureManager: new ApiCaptureManager({
      directory,
      maxBodyBytes: 1024,
      includeSensitive: false,
    }),
    travelSearch: new FakeTravelSearch(),
    contentExtractor: new FakeMarketContentExtractor(),
  };
  const app = buildApp(config(directory), dependencies);

  const response = await app.inject({
    method: "POST",
    url: "/v1/search/flights",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      origin: "IST",
      destination: "AMS",
      departureDate: "2026-09-23",
      marketProfile: "TR-IST",
      adults: 3,
      children: 2,
      cabin: "economy",
    },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json<FlightSearchResult>();
  assert.equal(body.query.passengers.adults, 3);
  assert.equal(body.query.passengers.children, 2);
  assert.ok(Array.isArray(body.errors));

  const missingProfile = await app.inject({
    method: "POST",
    url: "/v1/search/flights",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      origin: "IST",
      destination: "AMS",
      departureDate: "2026-09-23",
    },
  });
  assert.equal(missingProfile.statusCode, 400);

  await app.close();
  await rm(directory, { recursive: true, force: true });
});

test("otel ve kiralık yer route'ları ayrı arama davranışlarını çağırır", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "browser-app-test-"));
  const travelSearch = new FakeTravelSearch();
  const dependencies: AppDependencies = {
    browserManager: new FakeBrowserManager(),
    contextManager: new FakeContextManager(),
    captureManager: new ApiCaptureManager({
      directory,
      maxBodyBytes: 1024,
      includeSensitive: false,
    }),
    travelSearch,
    contentExtractor: new FakeMarketContentExtractor(),
  };
  const app = buildApp(config(directory), dependencies);
  const payload = {
    marketProfile: "TR-IST",
    destination: "Kalkan",
    checkIn: "2026-08-13",
    checkOut: "2026-08-20",
    adults: 2,
    rooms: 1,
    children: 0,
  };

  const rentals = await app.inject({
    method: "POST",
    url: "/v1/search/vacation-rentals",
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
  assert.equal(rentals.statusCode, 200);
  assert.equal(travelSearch.lastVacationRentalInput?.destination, "Kalkan");

  const hotels = await app.inject({
    method: "POST",
    url: "/v1/search/hotels",
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
  assert.equal(hotels.statusCode, 200);
  assert.equal(travelSearch.lastHotelInput?.destination, "Kalkan");

  await app.close();
  await rm(directory, { recursive: true, force: true });
});

test("destinasyon araştırması gezilecek yer ve gezi yazısı parametrelerini aktarır", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "browser-app-test-"));
  const travelSearch = new FakeTravelSearch();
  const app = buildApp(config(directory), dependencies(directory, travelSearch));

  const response = await app.inject({
    method: "POST",
    url: "/v1/research/destinations",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      destination: "Amsterdam",
      interests: ["müzeler", "yerel yemekler"],
      maxPlaces: 8,
      maxArticles: 6,
      marketProfile: "TR-IST",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(travelSearch.lastDestinationInput, {
    destination: "Amsterdam",
    interests: ["müzeler", "yerel yemekler"],
    maxPlaces: 8,
    maxArticles: 6,
    safeSearch: true,
    marketProfile: "TR-IST",
  });
  const body = response.json<DestinationResearchResult>();
  assert.equal(body.query.language, "tr");
  assert.ok(Array.isArray(body.places));
  assert.ok(Array.isArray(body.articles));

  const invalid = await app.inject({
    method: "POST",
    url: "/v1/research/destinations",
    headers: { authorization: `Bearer ${token}` },
    payload: { destination: "Amsterdam", maxPlaces: 50, marketProfile: "TR-IST" },
  });
  assert.equal(invalid.statusCode, 400);

  await app.close();
  await rm(directory, { recursive: true, force: true });
});

test("içerik çıkarma route'u URL listesini ayrı scraper modülüne aktarır", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "browser-app-test-"));
  const contentExtractor = new FakeMarketContentExtractor();
  const runtime = dependencies(directory, new FakeTravelSearch());
  runtime.contentExtractor = contentExtractor;
  const app = buildApp(config(directory), runtime);

  const response = await app.inject({
    method: "POST",
    url: "/v1/content/extract",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      urls: ["https://example.com/amsterdam-guide"],
      marketProfile: "TR-IST",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(contentExtractor.lastInput, {
    urls: ["https://example.com/amsterdam-guide"],
    marketProfile: "TR-IST",
    maxCharactersPerPage: 30_000,
    renderMode: "auto",
  });
  const body = response.json<ContentExtractionResult>();
  assert.equal(body.pages[0]?.title, "Amsterdam Gezi Rehberi");
  assert.equal(body.pages[0]?.chunks[0]?.id, "page-1-chunk-1");

  const invalid = await app.inject({
    method: "POST",
    url: "/v1/content/extract",
    headers: { authorization: `Bearer ${token}` },
    payload: { urls: ["file:///etc/passwd"], marketProfile: "TR-IST" },
  });
  assert.equal(invalid.statusCode, 400);

  await app.close();
  await rm(directory, { recursive: true, force: true });
});
