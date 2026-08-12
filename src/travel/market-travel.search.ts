import type { Page } from "playwright";

import type {
  DestinationResearch,
  DestinationResearchInput,
  DestinationResearchResult,
} from "../destination/destination-research.js";
import { BrowserStateError } from "../errors.js";
import type { MarketProfile, MarketProfileId } from "../markets/market-profile.js";
import type { BrowserPageProvider, BrowserStatus } from "../managers/browser.manager.js";
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
} from "./travel-search.js";

export interface MarketRequest {
  marketProfile: MarketProfileId;
}

export type MarketFlightSearchInput = Omit<
  FlightSearchInput,
  "country" | "currency" | "language"
> & MarketRequest;

export type MarketAccommodationSearchInput = Omit<
  HotelSearchInput,
  "country" | "currency" | "language"
> & MarketRequest;

export type MarketWebSearchInput = Omit<
  WebSearchInput,
  "country" | "language"
> & MarketRequest;

export type MarketFlightOfferSelectionInput = FlightOfferSelectionInput & MarketRequest;

export type MarketDestinationResearchInput = Omit<
  DestinationResearchInput,
  "language" | "country"
> & MarketRequest;

export interface MarketProfileStatus {
  id: MarketProfileId;
  locale: string;
  timezoneId: string;
  language: string;
  country: string;
  currency: string;
  ready: boolean;
  active: number;
  queued: number;
  browser: BrowserStatus;
}

export interface MarketTravelSearch {
  startAll(): Promise<void>;
  status(): MarketProfileStatus[];
  searchWeb(input: MarketWebSearchInput): Promise<WebSearchResult>;
  searchFlights(input: MarketFlightSearchInput): Promise<FlightSearchResult>;
  searchFlightReturns(input: MarketFlightOfferSelectionInput): Promise<FlightSearchResult>;
  searchFlightBookings(input: MarketFlightOfferSelectionInput): Promise<FlightBookingResult>;
  searchHotels(input: MarketAccommodationSearchInput): Promise<StaySearchResult>;
  searchVacationRentals(input: MarketAccommodationSearchInput): Promise<StaySearchResult>;
  researchDestination(input: MarketDestinationResearchInput): Promise<DestinationResearchResult>;
  suggestFlightLocations(
    query: string,
    options: MarketRequest,
  ): Promise<FlightLocationSuggestion[]>;
  closeAll(): Promise<void>;
}

export interface MarketRuntimeAdapter {
  browserManager: BrowserPageProvider;
  travelSearch: TravelSearch;
  destinationResearch: DestinationResearch;
}

interface MarketRuntime extends MarketRuntimeAdapter {
  profile: MarketProfile;
  queue: SerialTaskQueue;
  warmPage: Page | undefined;
  startPromise: Promise<void> | undefined;
}

export class ProfiledTravelSearch implements MarketTravelSearch {
  private readonly runtimes = new Map<MarketProfileId, MarketRuntime>();

  constructor(
    profiles: readonly MarketProfile[],
    createRuntime: (profile: MarketProfile) => MarketRuntimeAdapter,
  ) {
    for (const profile of profiles) {
      const adapter = createRuntime(profile);
      this.runtimes.set(profile.id, {
        ...adapter,
        profile,
        queue: new SerialTaskQueue(),
        warmPage: undefined,
        startPromise: undefined,
      });
    }
  }

  async startAll(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((runtime) => this.startRuntime(runtime)));
  }

  status(): MarketProfileStatus[] {
    return [...this.runtimes.values()].map((runtime) => ({
      id: runtime.profile.id,
      locale: runtime.profile.locale,
      timezoneId: runtime.profile.timezoneId,
      language: runtime.profile.language,
      country: runtime.profile.country,
      currency: runtime.profile.currency,
      ready: Boolean(runtime.warmPage && !runtime.warmPage.isClosed()),
      active: runtime.queue.active,
      queued: runtime.queue.queued,
      browser: runtime.browserManager.status(),
    }));
  }

  searchWeb(input: MarketWebSearchInput): Promise<WebSearchResult> {
    return this.run(input.marketProfile, (runtime) => runtime.travelSearch.searchWeb({
      query: input.query,
      limit: input.limit,
      safeSearch: input.safeSearch,
      language: runtime.profile.language,
      country: runtime.profile.country,
    }));
  }

  searchFlights(input: MarketFlightSearchInput): Promise<FlightSearchResult> {
    return this.run(input.marketProfile, (runtime) => runtime.travelSearch.searchFlights({
      origin: input.origin,
      destination: input.destination,
      departureDate: input.departureDate,
      adults: input.adults,
      children: input.children,
      cabin: input.cabin,
      language: runtime.profile.language,
      country: runtime.profile.country,
      currency: runtime.profile.currency,
      ...(input.returnDate ? { returnDate: input.returnDate } : {}),
    }));
  }

  searchFlightReturns(input: MarketFlightOfferSelectionInput): Promise<FlightSearchResult> {
    return this.run(input.marketProfile, (runtime) =>
      runtime.travelSearch.searchFlightReturns({ offerId: input.offerId })
    );
  }

  searchFlightBookings(input: MarketFlightOfferSelectionInput): Promise<FlightBookingResult> {
    return this.run(input.marketProfile, (runtime) =>
      runtime.travelSearch.searchFlightBookings({ offerId: input.offerId })
    );
  }

  searchHotels(input: MarketAccommodationSearchInput): Promise<StaySearchResult> {
    return this.run(input.marketProfile, (runtime) => runtime.travelSearch.searchHotels(
      this.toAccommodationInput(input, runtime.profile),
    ));
  }

  searchVacationRentals(input: MarketAccommodationSearchInput): Promise<StaySearchResult> {
    return this.run(input.marketProfile, (runtime) => runtime.travelSearch.searchVacationRentals(
      this.toAccommodationInput(input, runtime.profile),
    ));
  }

  researchDestination(input: MarketDestinationResearchInput): Promise<DestinationResearchResult> {
    return this.run(input.marketProfile, (runtime) => runtime.destinationResearch.research({
      destination: input.destination,
      interests: input.interests,
      maxPlaces: input.maxPlaces,
      maxArticles: input.maxArticles,
      safeSearch: input.safeSearch,
      language: runtime.profile.language,
      country: runtime.profile.country,
    }));
  }

  suggestFlightLocations(
    query: string,
    options: MarketRequest,
  ): Promise<FlightLocationSuggestion[]> {
    return this.run(options.marketProfile, (runtime) =>
      runtime.travelSearch.suggestFlightLocations(query, {
        language: runtime.profile.language,
        country: runtime.profile.country,
        currency: runtime.profile.currency,
      })
    );
  }

  async closeAll(): Promise<void> {
    const runtimes = [...this.runtimes.values()];
    await Promise.all(runtimes.map((runtime) => runtime.queue.onIdle()));
    await Promise.all(runtimes.map(async (runtime) => {
      await runtime.travelSearch.closeAll();
      if (runtime.warmPage) {
        await runtime.browserManager.closePage(runtime.warmPage).catch(() => undefined);
        runtime.warmPage = undefined;
      }
      await runtime.browserManager.stop();
      runtime.startPromise = undefined;
    }));
  }

  private run<T>(
    profileId: MarketProfileId,
    task: (runtime: MarketRuntime) => Promise<T>,
  ): Promise<T> {
    const runtime = this.requireRuntime(profileId);
    return runtime.queue.run(async () => {
      await this.startRuntime(runtime);
      return task(runtime);
    });
  }

  private requireRuntime(profileId: MarketProfileId): MarketRuntime {
    const runtime = this.runtimes.get(profileId);
    if (!runtime) throw new BrowserStateError(`Market profili hazır değil: ${profileId}`);
    return runtime;
  }

  private startRuntime(runtime: MarketRuntime): Promise<void> {
    if (runtime.warmPage && !runtime.warmPage.isClosed()) return Promise.resolve();
    if (runtime.startPromise) return runtime.startPromise;

    runtime.startPromise = (async () => {
      await runtime.browserManager.start();
      if (runtime.warmPage) {
        const staleWarmPage = runtime.warmPage;
        runtime.warmPage = undefined;
        await runtime.browserManager.closePage(staleWarmPage);
      }
      const page = await runtime.browserManager.newPage(`market-${runtime.profile.id}-warm`);
      const observed = await page.evaluate(() => ({
        locale: navigator.language,
        timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }));
      if (
        observed.locale !== runtime.profile.locale ||
        observed.timezoneId !== runtime.profile.timezoneId
      ) {
        await runtime.browserManager.closePage(page).catch(() => undefined);
        throw new BrowserStateError(
          `${runtime.profile.id} browser profili doğrulanamadı: ${observed.locale}/${observed.timezoneId}`,
        );
      }
      runtime.warmPage = page;
      runtime.startPromise = undefined;
    })().catch((error) => {
      runtime.startPromise = undefined;
      throw error;
    });
    return runtime.startPromise;
  }

  private toAccommodationInput(
    input: MarketAccommodationSearchInput,
    profile: MarketProfile,
  ): HotelSearchInput | VacationRentalSearchInput {
    return {
      destination: input.destination,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      adults: input.adults,
      rooms: input.rooms,
      children: input.children,
      language: profile.language,
      country: profile.country,
      currency: profile.currency,
    };
  }
}

class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();
  active = 0;
  queued = 0;

  run<T>(task: () => Promise<T>): Promise<T> {
    this.queued += 1;
    const operation = this.tail.then(async () => {
      this.queued -= 1;
      this.active += 1;
      try {
        return await task();
      } finally {
        this.active -= 1;
      }
    });
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async onIdle(): Promise<void> {
    await this.tail;
  }
}
