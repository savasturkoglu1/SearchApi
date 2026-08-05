import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright";

import { buildApp, type AppDependencies } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { ApiCaptureManager } from "../src/managers/api-capture.manager.js";
import type { BrowserPageProvider, BrowserStatus } from "../src/managers/browser.manager.js";
import type {
  ContextRegistry,
  ContextSnapshot,
  CreateContextInput,
} from "../src/managers/context.manager.js";
import type {
  FlightSearchInput,
  FlightSearchResult,
  FlightBookingResult,
  FlightOfferSelectionInput,
  FlightLocationSuggestion,
  HotelSearchInput,
  HotelSearchResult,
  VacationRentalSearchInput,
  TravelSearch,
} from "../src/travel/travel-search.js";

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

class FakeTravelSearch implements TravelSearch {
  lastHotelInput?: HotelSearchInput;
  lastVacationRentalInput?: VacationRentalSearchInput;

  async suggestFlightLocations(): Promise<FlightLocationSuggestion[]> {
    return [];
  }

  async searchFlights(input: FlightSearchInput): Promise<FlightSearchResult> {
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
        currency: input.currency,
        locale: input.language,
        ...(input.returnDate ? { returnDate: input.returnDate } : {}),
      },
      offers: [],
      searchUrl: "https://www.google.com/travel/flights",
      errors: [],
    };
  }

  async searchFlightReturns(_input: FlightOfferSelectionInput): Promise<FlightSearchResult> {
    throw new Error("testte çağrılmamalı");
  }

  async searchFlightBookings(_input: FlightOfferSelectionInput): Promise<FlightBookingResult> {
    throw new Error("testte çağrılmamalı");
  }

  async searchHotels(input: HotelSearchInput): Promise<HotelSearchResult> {
    this.lastHotelInput = input;
    return this.stayResult(input, "hotels");
  }

  async searchVacationRentals(input: VacationRentalSearchInput): Promise<HotelSearchResult> {
    this.lastVacationRentalInput = input;
    return this.stayResult(input, "vacation_rentals");
  }

  private stayResult(
    input: HotelSearchInput | VacationRentalSearchInput,
    propertyType: "hotels" | "vacation_rentals",
  ): HotelSearchResult {
    return {
      query: {
        location: input.destination,
        checkInDate: input.checkIn,
        checkOutDate: input.checkOut,
        guests: { adults: input.adults, children: input.children },
        propertyType,
        currency: input.currency,
        locale: input.language,
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
    },
    capture: {
      directory: captureDirectory,
      maxBodyBytes: 1024,
      includeSensitive: false,
    },
    search: { timeoutMs: 90_000 },
  };
}

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
  };
  const app = buildApp(config(directory), dependencies);
  const payload = {
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
