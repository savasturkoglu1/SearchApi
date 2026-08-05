import { ExternalSearchError } from "../errors.js";
import {
  parseFlightBookingOptions,
  parseFlightLocationSuggestions,
  parseFlightOffers,
  parseFlightPriceInsights,
  parseHotelOffers,
  parseVacationRentalOffers,
} from "./google-travel.parser.js";
import type {
  AccommodationSearchInput,
  FlightLocationSuggestion,
  FlightBookingResult,
  FlightOfferSelectionInput,
  FlightSearchQuery,
  FlightSearchInput,
  FlightSearchResult,
  GoogleFlightOffer,
  GoogleHotelOffer,
  HotelSearchInput,
  Layover,
  NormalizedOffer,
  NormalizedStay,
  StaySearchQuery,
  StaySearchResult,
  TravelRpcTransport,
  TravelSearch,
  VacationRentalSearchInput,
} from "./travel-search.js";

type AccommodationMode = "hotels" | "vacation_rentals";

interface FlightSelectionContext {
  input: FlightSearchInput;
  origin: FlightLocationSuggestion;
  destination: FlightLocationSuggestion;
  outbound: GoogleFlightOffer;
  inbound?: GoogleFlightOffer;
  createdAt: number;
}

const FLIGHT_SOURCE = "google_flights_browser";
const HOTEL_SOURCE = "google_hotels_browser";
const VACATION_RENTAL_SOURCE = "google_vacation_rentals_browser";

export class GoogleTravelSearch implements TravelSearch {
  private readonly flightSelections = new Map<string, FlightSelectionContext>();

  constructor(
    private readonly transport: TravelRpcTransport,
    private readonly timeoutMs: number,
  ) {}

  async searchFlights(input: FlightSearchInput): Promise<FlightSearchResult> {
    const [origin, destination] = await this.resolveLocations(
      [input.origin, input.destination],
      input.currency,
      input.language,
    );
    if (!origin || !destination) {
      throw new ExternalSearchError("Kalkış veya varış lokasyonu çözülemedi");
    }
    const response = await this.transport.execute({
      sourceUrl: buildFlightSearchUrl(input, origin, destination),
      responseUrlIncludes: "FlightsFrontendService/GetShoppingResults",
      timeoutMs: this.timeoutMs,
    });
    const googleOffers = parseFlightOffers(response.body, input.currency);
    if (googleOffers.length === 0) {
      throw new ExternalSearchError("Google Flights cevabında normalize edilebilir sonuç bulunamadı");
    }
    const retrievedAt = new Date().toISOString();
    const lowestPrice = Math.min(...googleOffers.map((offer) => offer.price.amount));
    for (const offer of googleOffers) {
      this.rememberFlightSelection(offer.selectionToken, {
        input,
        origin,
        destination,
        outbound: offer,
        createdAt: Date.now(),
      });
    }
    return {
      query: toFlightSearchQuery(input),
      offers: googleOffers.map((offer) => normalizeFlightOffer(offer, input, retrievedAt)),
      priceInsights: { lowestPrice },
      searchUrl: response.sourceUrl,
      errors: [],
    };
  }

  async searchFlightReturns(input: FlightOfferSelectionInput): Promise<FlightSearchResult> {
    const selected = this.requireFlightSelection(input.offerId);
    if (!selected.input.returnDate || selected.inbound) {
      throw new ExternalSearchError("Bu uçuş seçimi için dönüş araması yapılamaz");
    }
    const response = await this.transport.execute({
      sourceUrl: buildFlightReturnSearchUrl(selected),
      responseUrlIncludes: "FlightsFrontendService/GetShoppingResults",
      timeoutMs: this.timeoutMs,
    });
    const returnOffers = parseFlightOffers(response.body, selected.input.currency);
    if (returnOffers.length === 0) {
      throw new ExternalSearchError(
        "Google Flights dönüş cevabında normalize edilebilir sonuç bulunamadı",
      );
    }
    const retrievedAt = new Date().toISOString();
    for (const inbound of returnOffers) {
      this.rememberFlightSelection(inbound.selectionToken, {
        ...selected,
        inbound,
        createdAt: Date.now(),
      });
    }
    return {
      query: toFlightSearchQuery(selected.input),
      offers: returnOffers.map((inbound) =>
        normalizeRoundTripOffer(selected.outbound, inbound, selected.input, retrievedAt),
      ),
      priceInsights: {
        lowestPrice: Math.min(...returnOffers.map((offer) => offer.price.amount)),
      },
      searchUrl: response.sourceUrl,
      errors: [],
    };
  }

  async searchFlightBookings(input: FlightOfferSelectionInput): Promise<FlightBookingResult> {
    const selected = this.requireFlightSelection(input.offerId);
    if (selected.input.returnDate && !selected.inbound) {
      throw new ExternalSearchError("Booking seçenekleri için önce dönüş uçuşu seçilmelidir");
    }
    const response = await this.transport.execute({
      sourceUrl: buildFlightBookingUrl(selected),
      responseUrlIncludes: "FlightsFrontendService/GetBookingResults",
      timeoutMs: this.timeoutMs,
    });
    const googleOptions = parseFlightBookingOptions(response.body, selected.input.currency);
    const priceInsights = parseFlightPriceInsights(response.body);
    if (googleOptions.length === 0) {
      throw new ExternalSearchError(
        "Google Flights booking cevabında normalize edilebilir satıcı bulunamadı",
      );
    }
    const bookingOptions = googleOptions.map((option) => ({
      sourceOptionId: option.optionId,
      seller: option.seller,
      totalPrice: option.totalPrice,
      currency: option.currency,
      ...(option.bookingUrl ? { bookingUrl: option.bookingUrl } : {}),
      ...(option.bookingLinks ? { bookingLinks: option.bookingLinks } : {}),
      ...(option.baggageNotes ? { baggageNotes: option.baggageNotes } : {}),
    }));
    const preferred = bookingOptions.find((option) => option.bookingUrl);
    return {
      offerId: input.offerId,
      bookingOptions,
      ...(preferred ? { bookingUrl: preferred.bookingUrl } : {}),
      ...(preferred?.baggageNotes ? { baggageNotes: preferred.baggageNotes } : {}),
      priceIsEstimated: false,
      ...(priceInsights ? { priceInsights } : {}),
      searchUrl: response.sourceUrl,
      errors: [],
    };
  }

  async searchHotels(input: HotelSearchInput): Promise<StaySearchResult> {
    return this.searchAccommodation(input, "hotels");
  }

  async searchVacationRentals(input: VacationRentalSearchInput): Promise<StaySearchResult> {
    return this.searchAccommodation(input, "vacation_rentals");
  }

  private async searchAccommodation(
    input: AccommodationSearchInput,
    mode: AccommodationMode,
  ): Promise<StaySearchResult> {
    const destination = await this.resolveStayLocation(input);
    const response = await this.transport.execute({
      sourceUrl: buildAccommodationSearchUrl(input, destination, mode),
      responseUrlIncludes: "rpcids=AtySUc",
      timeoutMs: this.timeoutMs,
    });
    const offers = mode === "hotels"
      ? parseHotelOffers(response.body, input.currency)
      : parseVacationRentalOffers(response.body, input.currency);
    if (offers.length === 0) {
      throw new ExternalSearchError(
        `Google ${mode === "hotels" ? "Hotels" : "Vacation Rentals"} cevabında normalize edilebilir sonuç bulunamadı`,
      );
    }
    const retrievedAt = new Date().toISOString();
    const nightlyPrices = offers
      .map((offer) => offer.price.nightlyAmount)
      .filter((price): price is number => price !== undefined);
    return {
      query: toStaySearchQuery(input, mode),
      stays: offers.map((offer) => normalizeStay(offer, retrievedAt)),
      ...(nightlyPrices.length > 0
        ? { priceInsights: { lowestPrice: Math.min(...nightlyPrices) } }
        : {}),
      searchUrl: response.sourceUrl,
      errors: [],
    };
  }

  async suggestFlightLocations(
    query: string,
    options: { currency: string; language: string },
  ): Promise<FlightLocationSuggestion[]> {
    const [lookup] = await this.transport.lookupFlightLocations({
      queries: [query],
      currency: options.currency,
      language: options.language,
      timeoutMs: this.timeoutMs,
    });
    return lookup ? parseFlightLocationSuggestions(lookup.body) : [];
  }

  async closeAll(): Promise<void> {
    await this.transport.closeAll();
  }

  private rememberFlightSelection(id: string, context: FlightSelectionContext): void {
    const expiry = Date.now() - 30 * 60_000;
    for (const [key, value] of this.flightSelections) {
      if (value.createdAt < expiry) this.flightSelections.delete(key);
    }
    while (this.flightSelections.size >= 1_000) {
      const oldest = this.flightSelections.keys().next().value as string | undefined;
      if (!oldest) break;
      this.flightSelections.delete(oldest);
    }
    this.flightSelections.set(id, context);
  }

  private requireFlightSelection(id: string): FlightSelectionContext {
    const selected = this.flightSelections.get(id);
    if (!selected || selected.createdAt < Date.now() - 30 * 60_000) {
      this.flightSelections.delete(id);
      throw new ExternalSearchError("Uçuş seçim token'ı bulunamadı veya süresi doldu");
    }
    return selected;
  }

  private async resolveLocations(
    queries: string[],
    currency: string,
    language: string,
  ): Promise<FlightLocationSuggestion[]> {
    const resolved = new Map<string, FlightLocationSuggestion>();
    const unresolved = queries.filter((query) => {
      if (query.startsWith("/m/")) {
        resolved.set(query, {
          entityId: query,
          label: query,
          name: query,
          type: "city",
        });
        return false;
      }
      return true;
    });

    if (unresolved.length > 0) {
      const lookups = await this.transport.lookupFlightLocations({
        queries: [...new Set(unresolved)],
        currency,
        language,
        timeoutMs: this.timeoutMs,
      });
      for (const lookup of lookups) {
        const suggestions = parseFlightLocationSuggestions(lookup.body);
        const selected = selectLocation(lookup.query, suggestions);
        if (selected) resolved.set(lookup.query, selected);
      }
    }

    return queries.map((query) => {
      const location = resolved.get(query);
      if (!location) throw new ExternalSearchError(`Lokasyon bulunamadı: ${query}`);
      return location;
    });
  }

  private async resolveStayLocation(input: AccommodationSearchInput): Promise<FlightLocationSuggestion> {
    if (input.destination.startsWith("/m/")) {
      return {
        entityId: input.destination,
        label: input.destination,
        name: input.destination,
        type: "city",
      };
    }
    try {
      const [lookup] = await this.transport.lookupFlightLocations({
        queries: [input.destination],
        currency: input.currency,
        language: input.language,
        timeoutMs: this.timeoutMs,
      });
      if (lookup) {
        const exact = selectExactLocation(input.destination, parseFlightLocationSuggestions(lookup.body));
        if (exact) return exact;
      }
    } catch {
      // Stay araması `q` parametresiyle ham lokasyon adını da çözebilir.
    }
    return {
      entityId: "",
      label: input.destination,
      name: input.destination,
      type: "city",
    };
  }
}

function toFlightSearchQuery(input: FlightSearchInput): FlightSearchQuery {
  return {
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
  };
}

function normalizeFlightOffer(
  offer: GoogleFlightOffer,
  input: FlightSearchInput,
  retrievedAt: string,
): NormalizedOffer {
  return {
    source: FLIGHT_SOURCE,
    sourceOfferId: offer.selectionToken,
    outboundSegments: normalizeFlightSegments(offer, input),
    returnSegments: [],
    layovers: normalizeLayovers(offer),
    totalDurationMinutes: offer.leg.durationMinutes,
    stops: offer.leg.stops,
    totalPrice: offer.price.amount,
    currency: offer.price.currency,
    priceIsEstimated: false,
    ...(input.returnDate
      ? {
          notes: [
            "Fiyat, bu gidiş seçeneğiyle uyumlu bir dönüş dahil Google'ın gösterdiği gidiş-dönüş toplamıdır; dönüş uçuşu detayları henüz genişletilmedi",
          ],
        }
      : {}),
    retrievedAt,
  };
}

function normalizeRoundTripOffer(
  outbound: GoogleFlightOffer,
  inbound: GoogleFlightOffer,
  input: FlightSearchInput,
  retrievedAt: string,
): NormalizedOffer {
  return {
    source: FLIGHT_SOURCE,
    sourceOfferId: inbound.selectionToken,
    outboundSegments: normalizeFlightSegments(outbound, input),
    returnSegments: normalizeFlightSegments(inbound, input),
    layovers: [...normalizeLayovers(outbound), ...normalizeLayovers(inbound)],
    totalDurationMinutes: outbound.leg.durationMinutes + inbound.leg.durationMinutes,
    stops: outbound.leg.stops + inbound.leg.stops,
    totalPrice: inbound.price.amount,
    currency: inbound.price.currency,
    priceIsEstimated: false,
    retrievedAt,
  };
}

function normalizeFlightSegments(offer: GoogleFlightOffer, input: FlightSearchInput) {
  return offer.leg.segments.map((segment) => ({
    airlineName: segment.airline,
    flightNumber: formatFlightNumber(segment.carrierCode, segment.flightNumber),
    departureAirport: segment.origin.code,
    departureTime: formatAdapterDateTime(segment.departureLocal),
    arrivalAirport: segment.destination.code,
    arrivalTime: formatAdapterDateTime(segment.arrivalLocal),
    durationMinutes: segment.durationMinutes,
    cabinClass: input.cabin,
  }));
}

function normalizeLayovers(offer: GoogleFlightOffer): Layover[] {
  const segments = offer.leg.segments;
  if (segments.length < 2) return [];
  const totalLayoverMinutes = Math.max(
    0,
    offer.leg.durationMinutes - segments.reduce((total, segment) => total + segment.durationMinutes, 0),
  );
  const rawDurations = segments.slice(0, -1).map((segment, index) => {
    const next = segments[index + 1];
    if (!next) return 0;
    const arrival = Date.parse(segment.arrivalLocal);
    const departure = Date.parse(next.departureLocal);
    return Number.isFinite(arrival) && Number.isFinite(departure)
      ? Math.max(0, Math.round((departure - arrival) / 60_000))
      : 0;
  });
  const rawTotal = rawDurations.reduce((total, duration) => total + duration, 0);

  return segments.slice(0, -1).map((segment, index) => {
    const next = segments[index + 1];
    const durationMinutes =
      rawTotal > 0
        ? Math.round(((rawDurations[index] ?? 0) / rawTotal) * totalLayoverMinutes)
        : Math.round(totalLayoverMinutes / (segments.length - 1));
    return {
      airport: segment.destination.code,
      durationMinutes,
      ...(next && segment.arrivalLocal.slice(0, 10) !== next.departureLocal.slice(0, 10)
        ? { overnight: true }
        : {}),
    };
  });
}

function toStaySearchQuery(
  input: AccommodationSearchInput,
  mode: AccommodationMode,
): StaySearchQuery {
  return {
    location: input.destination,
    checkInDate: input.checkIn,
    checkOutDate: input.checkOut,
    guests: { adults: input.adults, children: input.children },
    propertyType: mode,
    currency: input.currency,
    locale: input.language,
  };
}

function normalizeStay(
  hotel: GoogleHotelOffer,
  retrievedAt: string,
): NormalizedStay {
  const ratePerNight = hotel.price.nightlyAmount;
  const totalPrice =
    hotel.price.totalAmount ??
    (ratePerNight !== undefined && hotel.stay ? ratePerNight * hotel.stay.nights : undefined);
  return {
    source: hotel.propertyType === "hotel" ? HOTEL_SOURCE : VACATION_RENTAL_SOURCE,
    sourceStayId: hotel.propertyId,
    name: hotel.name,
    propertyType: hotel.propertyType,
    currency: hotel.price.currency,
    priceIsEstimated: false,
    retrievedAt,
    ...(hotel.stars !== undefined ? { hotelClass: hotel.stars } : {}),
    ...(hotel.rating !== undefined ? { rating: hotel.rating } : {}),
    ...(hotel.reviewCount !== undefined ? { reviewCount: hotel.reviewCount } : {}),
    ...(hotel.coordinates ? { gps: hotel.coordinates } : {}),
    ...(ratePerNight !== undefined ? { ratePerNight } : {}),
    ...(totalPrice !== undefined ? { totalPrice } : {}),
    ...(hotel.provider
      ? {
          otaPrices: [
            {
              seller: hotel.provider,
              ...(ratePerNight !== undefined ? { ratePerNight } : {}),
            },
          ],
        }
      : {}),
    ...(hotel.images.length > 0 ? { images: hotel.images } : {}),
    ...(hotel.amenities?.length ? { amenities: hotel.amenities } : {}),
    ...(hotel.bookingUrl ? { bookingUrl: hotel.bookingUrl } : {}),
    ...(!ratePerNight && totalPrice === undefined
      ? { notes: ["Bu misafir sayısı ve tarihler için sayısal fiyat ayrıştırılamadı"] }
      : {}),
  };
}

function formatAdapterDateTime(value: string): string {
  return value.replace("T", " ");
}

function formatFlightNumber(carrierCode: string, value: string): string {
  const number = value.startsWith(carrierCode)
    ? value.slice(carrierCode.length).trim()
    : value.trim();
  return `${carrierCode} ${number}`.trim();
}

export function buildFlightSearchUrl(
  input: FlightSearchInput,
  origin: FlightLocationSuggestion,
  destination: FlightLocationSuggestion,
): string {
  const url = new URL("https://www.google.com/travel/flights/search");
  url.searchParams.set("tfs", encodeFlightState(input, origin, destination));
  url.searchParams.set("tfu", "EgYIABAAGAA");
  url.searchParams.set("curr", input.currency);
  url.searchParams.set("hl", input.language);
  return url.toString();
}

function buildFlightReturnSearchUrl(selection: FlightSelectionContext): string {
  const url = new URL("https://www.google.com/travel/flights/search");
  url.searchParams.set("tfs", encodeSelectedFlightState(selection, false));
  url.searchParams.set("tfu", encodeFlightSelectionToken(selection.outbound.selectionToken));
  url.searchParams.set("curr", selection.input.currency);
  url.searchParams.set("hl", selection.input.language);
  return url.toString();
}

function buildFlightBookingUrl(selection: FlightSelectionContext): string {
  const finalSelection = selection.inbound ?? selection.outbound;
  const url = new URL("https://www.google.com/travel/flights/booking");
  url.searchParams.set("tfs", encodeSelectedFlightState(selection, true));
  url.searchParams.set("tfu", encodeFlightSelectionToken(finalSelection.selectionToken));
  url.searchParams.set("curr", selection.input.currency);
  url.searchParams.set("hl", selection.input.language);
  return url.toString();
}

function buildAccommodationSearchUrl(
  input: AccommodationSearchInput,
  destination: FlightLocationSuggestion,
  mode: AccommodationMode,
): string {
  const url = new URL("https://www.google.com/travel/search");
  url.searchParams.set("q", destination.name);
  url.searchParams.set("ts", encodeAccommodationState(input, destination, mode));
  url.searchParams.set("gsas", "1");
  url.searchParams.set("curr", input.currency);
  url.searchParams.set("hl", input.language);
  return url.toString();
}

export function buildHotelSearchUrl(
  input: HotelSearchInput,
  destination: FlightLocationSuggestion,
): string {
  return buildAccommodationSearchUrl(input, destination, "hotels");
}

export function buildVacationRentalSearchUrl(
  input: VacationRentalSearchInput,
  destination: FlightLocationSuggestion,
): string {
  return buildAccommodationSearchUrl(input, destination, "vacation_rentals");
}

function selectLocation(
  query: string,
  suggestions: FlightLocationSuggestion[],
): FlightLocationSuggestion | undefined {
  const normalized = query.trim().toLocaleLowerCase("en-US");
  const exactAirport = suggestions.find(
    (item) => item.type === "airport" && item.code?.toLowerCase() === normalized,
  );
  if (exactAirport?.parentEntityId) {
    return (
      suggestions.find(
        (item) => item.type === "city" && item.entityId === exactAirport.parentEntityId,
      ) ?? {
        ...exactAirport,
        entityId: exactAirport.parentEntityId,
        type: "city",
      }
    );
  }
  return (
    suggestions.find(
      (item) =>
        item.type === "city" &&
        (item.name.toLocaleLowerCase("en-US") === normalized ||
          item.label.toLocaleLowerCase("en-US") === normalized),
    ) ?? suggestions.find((item) => item.type === "city")
  );
}

function selectExactLocation(
  query: string,
  suggestions: FlightLocationSuggestion[],
): FlightLocationSuggestion | undefined {
  const normalized = query.trim().toLocaleLowerCase("en-US");
  return suggestions.find((item) =>
    item.code?.toLocaleLowerCase("en-US") === normalized ||
    item.name.toLocaleLowerCase("en-US") === normalized ||
    item.label.toLocaleLowerCase("en-US") === normalized
  );
}

function encodeFlightState(
  input: FlightSearchInput,
  origin: FlightLocationSuggestion,
  destination: FlightLocationSuggestion,
): string {
  const output: number[] = [];
  writeVarintField(output, 1, 28n);
  writeVarintField(output, 2, input.returnDate ? 2n : 1n);
  writeMessageField(output, 3, flightSlice(input.departureDate, origin.entityId, destination.entityId));
  if (input.returnDate) {
    writeMessageField(output, 3, flightSlice(input.returnDate, destination.entityId, origin.entityId));
  }
  for (let index = 0; index < input.adults; index += 1) {
    writeVarintField(output, 8, 1n);
  }
  for (let index = 0; index < input.children; index += 1) {
    writeVarintField(output, 8, 2n);
  }
  writeVarintField(output, 9, 1n);
  writeVarintField(output, 14, 1n);
  const filter: number[] = [];
  writeVarintField(filter, 1, 0xffffffffffffffffn);
  writeMessageField(output, 16, filter);
  writeVarintField(output, 19, 1n);
  return Buffer.from(output).toString("base64url");
}

function encodeSelectedFlightState(
  selection: FlightSelectionContext,
  includeInbound: boolean,
): string {
  const { input, origin, destination, outbound, inbound } = selection;
  const output: number[] = [];
  writeVarintField(output, 1, 28n);
  writeVarintField(output, 2, input.returnDate ? 2n : 1n);
  writeMessageField(
    output,
    3,
    selectedFlightSlice(input.departureDate, origin.entityId, destination.entityId, outbound),
  );
  if (input.returnDate) {
    writeMessageField(
      output,
      3,
      includeInbound && inbound
        ? selectedFlightSlice(input.returnDate, destination.entityId, origin.entityId, inbound)
        : flightSlice(input.returnDate, destination.entityId, origin.entityId),
    );
  }
  for (let index = 0; index < input.adults; index += 1) writeVarintField(output, 8, 1n);
  for (let index = 0; index < input.children; index += 1) writeVarintField(output, 8, 2n);
  writeVarintField(output, 9, 1n);
  writeVarintField(output, 14, 1n);
  const filter: number[] = [];
  writeVarintField(filter, 1, 0xffffffffffffffffn);
  writeMessageField(output, 16, filter);
  writeVarintField(output, 19, 1n);
  return Buffer.from(output).toString("base64url");
}

function selectedFlightSlice(
  date: string,
  originId: string,
  destinationId: string,
  offer: GoogleFlightOffer,
): number[] {
  const slice = flightSlice(date, originId, destinationId);
  for (const segment of offer.leg.segments) {
    const flight = [] as number[];
    writeStringField(flight, 1, segment.origin.code);
    writeStringField(flight, 2, segment.departureLocal.slice(0, 10));
    writeStringField(flight, 3, segment.destination.code);
    writeStringField(flight, 5, segment.carrierCode);
    writeStringField(
      flight,
      6,
      segment.flightNumber.startsWith(segment.carrierCode)
        ? segment.flightNumber.slice(segment.carrierCode.length)
        : segment.flightNumber,
    );
    writeMessageField(slice, 4, flight);
  }
  return slice;
}

function encodeFlightSelectionToken(selectionToken: string): string {
  const output: number[] = [];
  writeStringField(output, 1, selectionToken);
  const state: number[] = [];
  writeVarintField(state, 1, 0n);
  writeMessageField(output, 2, state);
  writeMessageField(output, 4, []);
  return Buffer.from(output).toString("base64url");
}

function flightSlice(date: string, originId: string, destinationId: string): number[] {
  const slice: number[] = [];
  writeStringField(slice, 2, date);
  writeMessageField(slice, 13, locationMessage(originId));
  writeMessageField(slice, 14, locationMessage(destinationId));
  return slice;
}

function locationMessage(entityId: string): number[] {
  const location: number[] = [];
  writeVarintField(location, 1, 2n);
  writeStringField(location, 2, entityId);
  return location;
}

function encodeAccommodationState(
  input: AccommodationSearchInput,
  destination: FlightLocationSuggestion,
  mode: AccommodationMode,
): string {
  const output: number[] = [];
  writeVarintField(output, 1, mode === "vacation_rentals" ? 2n : 1n);

  const occupancy: number[] = [];
  for (let index = 0; index < input.adults; index += 1) {
    const guest: number[] = [];
    writeVarintField(guest, 1, 3n);
    writeMessageField(occupancy, 1, guest);
  }
  writeVarintField(occupancy, 2, BigInt(input.children));
  writeMessageField(output, 2, occupancy);

  const state: number[] = [];
  if (destination.entityId) {
    const destinationValue: number[] = [];
    const destinationEntity: number[] = [];
    writeStringField(destinationEntity, 1, destination.entityId);
    writeStringField(destinationEntity, 7, destination.name);
    writeMessageField(destinationValue, 2, destinationEntity);
    writeMessageField(state, 1, destinationValue);
  }

  const datesValue: number[] = [];
  const dates: number[] = [];
  writeMessageField(dates, 1, dateMessage(input.checkIn));
  writeMessageField(dates, 2, dateMessage(input.checkOut));
  writeVarintField(dates, 3, BigInt(daysBetween(input.checkIn, input.checkOut)));
  writeMessageField(datesValue, 2, dates);
  const rooms: number[] = [];
  writeVarintField(rooms, 1, BigInt(input.rooms));
  writeMessageField(datesValue, 6, rooms);
  writeMessageField(state, 2, datesValue);
  writeMessageField(output, 3, state);
  return Buffer.from(output).toString("base64url");
}

function dateMessage(date: string): number[] {
  const [year, month, day] = date.split("-").map(Number);
  const output: number[] = [];
  writeVarintField(output, 1, BigInt(year ?? 0));
  writeVarintField(output, 2, BigInt(month ?? 0));
  writeVarintField(output, 3, BigInt(day ?? 0));
  return output;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function writeStringField(output: number[], field: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  writeTag(output, field, 2);
  writeVarint(output, BigInt(bytes.length));
  output.push(...bytes);
}

function writeMessageField(output: number[], field: number, value: number[]): void {
  writeTag(output, field, 2);
  writeVarint(output, BigInt(value.length));
  output.push(...value);
}

function writeVarintField(output: number[], field: number, value: bigint): void {
  writeTag(output, field, 0);
  writeVarint(output, value);
}

function writeTag(output: number[], field: number, wireType: number): void {
  writeVarint(output, BigInt((field << 3) | wireType));
}

function writeVarint(output: number[], value: bigint): void {
  let remaining = value;
  while (remaining >= 0x80n) {
    output.push(Number((remaining & 0x7fn) | 0x80n));
    remaining >>= 7n;
  }
  output.push(Number(remaining));
}
