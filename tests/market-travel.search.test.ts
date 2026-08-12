import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";

import type {
  DestinationResearch,
  DestinationResearchInput,
  DestinationResearchResult,
} from "../src/destination/destination-research.js";
import { MARKET_PROFILES, type MarketProfile } from "../src/markets/market-profile.js";
import type { BrowserPageProvider, BrowserStatus } from "../src/managers/browser.manager.js";
import { ProfiledTravelSearch } from "../src/travel/market-travel.search.js";
import type {
  FlightBookingResult,
  FlightLocationSuggestion,
  FlightOfferSelectionInput,
  FlightSearchInput,
  FlightSearchResult,
  HotelSearchInput,
  StaySearchResult,
  TravelSearch,
  VacationRentalSearchInput,
  WebSearchInput,
  WebSearchResult,
} from "../src/travel/travel-search.js";

class Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
}

class FakeProfileBrowser implements BrowserPageProvider {
  private running = false;
  private openPages = 0;

  constructor(private readonly profile: MarketProfile) {}

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.openPages = 0;
  }

  async newPage(): Promise<Page> {
    this.openPages += 1;
    let closed = false;
    return {
      evaluate: async () => ({
        locale: this.profile.locale,
        timezoneId: this.profile.timezoneId,
      }),
      isClosed: () => closed,
      close: async () => {
        closed = true;
      },
    } as unknown as Page;
  }

  async closePage(page: Page): Promise<void> {
    if (page.isClosed()) return;
    await page.close();
    this.openPages -= 1;
  }

  status(): BrowserStatus {
    return {
      running: this.running,
      engine: "patchright",
      headless: true,
      channel: "chrome",
      openPages: this.openPages,
      sessionMode: "persistent",
    };
  }
}

/**
 * Crawlee BrowserPool davranışını taklit eder: dışarıdan kapanan bir page'in ID kaydı,
 * provider üzerinden closePage çağrılana kadar pool registry'sinde kalabilir.
 */
class RegistryTrackingProfileBrowser implements BrowserPageProvider {
  private running = false;
  private readonly pages = new Map<string, { page: Page; closed: boolean }>();

  constructor(private readonly profile: MarketProfile) {}

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.pages.clear();
  }

  async newPage(id: string): Promise<Page> {
    if (this.pages.has(id)) throw new Error(`Page with ID: ${id} already exists.`);
    const entry = { page: undefined as unknown as Page, closed: false };
    entry.page = {
      evaluate: async () => ({
        locale: this.profile.locale,
        timezoneId: this.profile.timezoneId,
      }),
      isClosed: () => entry.closed,
      close: async () => {
        entry.closed = true;
        this.pages.delete(id);
      },
    } as unknown as Page;
    this.pages.set(id, entry);
    return entry.page;
  }

  async closePage(page: Page): Promise<void> {
    // BrowserPool'un override ettiği page.close(), page zaten browser UI'ından
    // kapanmış olsa bile registry kaydını temizler.
    await page.close();
  }

  closeWarmPageExternally(): void {
    const entry = this.pages.values().next().value as
      | { page: Page; closed: boolean }
      | undefined;
    if (entry) entry.closed = true;
  }

  status(): BrowserStatus {
    return {
      running: this.running,
      engine: "patchright",
      headless: false,
      channel: "chrome",
      openPages: this.pages.size,
      sessionMode: "persistent",
    };
  }
}

class ProbeTravelSearch implements TravelSearch {
  readonly flightInputs: FlightSearchInput[] = [];
  readonly webStarted: string[] = [];
  readonly webBlockers = new Map<string, Deferred>();
  readonly webStartSignals = new Map<string, Deferred>();

  async searchWeb(input: WebSearchInput): Promise<WebSearchResult> {
    this.webStarted.push(input.query);
    this.webStartSignals.get(input.query)?.resolve();
    await this.webBlockers.get(input.query)?.promise;
    return {
      query: {
        text: input.query,
        language: input.language,
        country: input.country,
        safeSearch: input.safeSearch,
      },
      results: [],
      searchUrl: "https://www.google.com/search",
      retrievedAt: "2026-08-05T00:00:00.000Z",
      errors: [],
    };
  }

  async searchFlights(input: FlightSearchInput): Promise<FlightSearchResult> {
    this.flightInputs.push(input);
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
      },
      offers: [],
      errors: [],
    };
  }

  async searchFlightReturns(_input: FlightOfferSelectionInput): Promise<FlightSearchResult> {
    throw new Error("testte çağrılmamalı");
  }

  async searchFlightBookings(_input: FlightOfferSelectionInput): Promise<FlightBookingResult> {
    throw new Error("testte çağrılmamalı");
  }

  async searchHotels(input: HotelSearchInput): Promise<StaySearchResult> {
    return stayResult(input, "hotels");
  }

  async searchVacationRentals(input: VacationRentalSearchInput): Promise<StaySearchResult> {
    return stayResult(input, "vacation_rentals");
  }

  async suggestFlightLocations(): Promise<FlightLocationSuggestion[]> {
    return [];
  }

  async closeAll(): Promise<void> {}
}

class ProbeDestinationResearch implements DestinationResearch {
  readonly inputs: DestinationResearchInput[] = [];

  async research(input: DestinationResearchInput): Promise<DestinationResearchResult> {
    this.inputs.push(input);
    return {
      destination: input.destination,
      query: {
        interests: input.interests,
        language: input.language,
        country: input.country,
      },
      places: [],
      articles: [],
      searchUrls: { articles: [] },
      retrievedAt: "2026-08-06T00:00:00.000Z",
      errors: [],
    };
  }
}

test("market profili browser'ı sıcak tutar ve arama parametrelerini profilden üretir", async () => {
  const search = new ProbeTravelSearch();
  const destinationResearch = new ProbeDestinationResearch();
  const browser = new FakeProfileBrowser(MARKET_PROFILES["DE-FRA"]);
  const profiled = new ProfiledTravelSearch(
    [MARKET_PROFILES["DE-FRA"]],
    () => ({ browserManager: browser, travelSearch: search, destinationResearch }),
  );

  await profiled.startAll();
  assert.equal(profiled.status()[0]?.ready, true);
  assert.equal(profiled.status()[0]?.browser.openPages, 1);

  await profiled.searchFlights({
    marketProfile: "DE-FRA",
    origin: "FRA",
    destination: "IST",
    departureDate: "2026-09-19",
    returnDate: "2026-09-26",
    adults: 1,
    children: 0,
    cabin: "economy",
  });

  assert.equal(search.flightInputs[0]?.language, "de");
  assert.equal(search.flightInputs[0]?.country, "DE");
  assert.equal(search.flightInputs[0]?.currency, "EUR");

  await profiled.researchDestination({
    marketProfile: "DE-FRA",
    destination: "Berlin",
    interests: ["museums"],
    maxPlaces: 5,
    maxArticles: 4,
    safeSearch: true,
  });
  assert.equal(destinationResearch.inputs[0]?.language, "de");
  assert.equal(destinationResearch.inputs[0]?.country, "DE");

  await profiled.closeAll();
  assert.equal(profiled.status()[0]?.ready, false);
  assert.equal(profiled.status()[0]?.browser.running, false);
});

test("dışarıdan kapanan warm page registry kaydı temizlenip yeniden açılır", async () => {
  const profile = MARKET_PROFILES["TR-IST"];
  const browser = new RegistryTrackingProfileBrowser(profile);
  const search = new ProbeTravelSearch();
  const profiled = new ProfiledTravelSearch(
    [profile],
    () => ({
      browserManager: browser,
      travelSearch: search,
      destinationResearch: new ProbeDestinationResearch(),
    }),
  );

  await profiled.startAll();
  browser.closeWarmPageExternally();
  assert.equal(profiled.status()[0]?.ready, false);
  assert.equal(profiled.status()[0]?.browser.openPages, 1);

  await profiled.searchFlights({
    marketProfile: "TR-IST",
    origin: "IST",
    destination: "AMS",
    departureDate: "2026-10-15",
    returnDate: "2026-10-22",
    adults: 1,
    children: 0,
    cabin: "economy",
  });

  assert.equal(profiled.status()[0]?.ready, true);
  assert.equal(profiled.status()[0]?.browser.openPages, 1);
  await profiled.closeAll();
});

test("aynı market isteklerini sıraya alır, farklı marketleri paralel çalıştırır", async () => {
  const searches = new Map<string, ProbeTravelSearch>();
  const profiled = new ProfiledTravelSearch(
    [MARKET_PROFILES["DE-FRA"], MARKET_PROFILES["FR-PAR"]],
    (profile) => {
      const search = new ProbeTravelSearch();
      searches.set(profile.id, search);
      return {
        browserManager: new FakeProfileBrowser(profile),
        travelSearch: search,
        destinationResearch: new ProbeDestinationResearch(),
      };
    },
  );
  await profiled.startAll();

  const german = searches.get("DE-FRA");
  const french = searches.get("FR-PAR");
  assert.ok(german);
  assert.ok(french);
  const firstGate = new Deferred();
  const firstStarted = new Deferred();
  german.webBlockers.set("first", firstGate);
  german.webStartSignals.set("first", firstStarted);

  const first = profiled.searchWeb({
    marketProfile: "DE-FRA",
    query: "first",
    limit: 5,
    safeSearch: true,
  });
  await firstStarted.promise;
  const second = profiled.searchWeb({
    marketProfile: "DE-FRA",
    query: "second",
    limit: 5,
    safeSearch: true,
  });

  try {
    await profiled.searchWeb({
      marketProfile: "FR-PAR",
      query: "parallel",
      limit: 5,
      safeSearch: true,
    });

    assert.deepEqual(german.webStarted, ["first"]);
    assert.deepEqual(french.webStarted, ["parallel"]);
    const germanStatus = profiled.status().find((item) => item.id === "DE-FRA");
    assert.equal(germanStatus?.active, 1);
    assert.equal(germanStatus?.queued, 1);
  } finally {
    firstGate.resolve();
  }

  await Promise.all([first, second]);
  assert.deepEqual(german.webStarted, ["first", "second"]);
  await profiled.closeAll();
});

function stayResult(
  input: HotelSearchInput | VacationRentalSearchInput,
  propertyType: "hotels" | "vacation_rentals",
): StaySearchResult {
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
    errors: [],
  };
}
