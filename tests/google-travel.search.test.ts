import assert from "node:assert/strict";
import test from "node:test";

import { GoogleTravelSearch } from "../src/travel/google-travel.search.js";
import type {
  TravelRpcRequest,
  TravelRpcResponse,
  TravelRpcTransport,
} from "../src/travel/travel-search.js";

class FakeTransport implements TravelRpcTransport {
  lastRequest?: TravelRpcRequest;

  constructor(private readonly body: string) {}

  async execute(request: TravelRpcRequest): Promise<TravelRpcResponse> {
    this.lastRequest = request;
    return {
      body: this.body,
      sourceUrl: request.sourceUrl,
      responseUrl: `https://www.google.com/${request.responseUrlIncludes}`,
      captureContextId: "11111111-1111-4111-8111-111111111111",
      elapsedMs: 25,
    };
  }

  async lookupFlightLocations(request: Parameters<TravelRpcTransport["lookupFlightLocations"]>[0]) {
    return request.queries.map((query) => ({
      query,
      body: suggestionBody(query),
    }));
  }

  async closeAll(): Promise<void> {}
}

test("uçuş RPC cevabını normalize eder ve browser URL'sini üretir", async () => {
  const transport = new FakeTransport(googleBody(null, [flightOffer()]));
  const search = new GoogleTravelSearch(transport, 90_000);

  const result = await search.searchFlights({
    origin: "IST",
    destination: "AMS",
    departureDate: "2026-09-15",
    returnDate: "2026-09-19",
    adults: 1,
    children: 0,
    cabin: "economy",
    currency: "TRY",
    language: "tr",
  });

  assert.equal(result.offers.length, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(result.query.tripType, "round_trip");
  assert.deepEqual(result.query.passengers, {
    adults: 1,
    children: 0,
    infantsInSeat: 0,
    infantsOnLap: 0,
  });
  assert.equal(result.offers[0]?.source, "google_flights_browser");
  assert.equal(result.offers[0]?.sourceOfferId, "selection-token");
  assert.equal(result.offers[0]?.totalPrice, 12_345);
  assert.equal(result.offers[0]?.outboundSegments[0]?.flightNumber, "TK 1951");
  assert.equal(result.offers[0]?.outboundSegments[0]?.departureTime, "2026-09-15 08:30");
  assert.equal(result.offers[0]?.priceIsEstimated, false);
  assert.match(result.offers[0]?.notes?.[0] ?? "", /gidiş-dönüş toplamıdır/);
  const sourceUrl = new URL(transport.lastRequest?.sourceUrl ?? "https://invalid.test");
  assert.equal(sourceUrl.searchParams.has("q"), false, "q parametresi Flights formuna uygulanmıyor");
  assert.ok(sourceUrl.searchParams.has("tfs"), "uçuş form state'i tfs içinde taşınmalı");
  const flightState = Buffer.from(sourceUrl.searchParams.get("tfs") ?? "", "base64url").toString("utf8");
  assert.match(flightState, /\/m\/istanbul/);
  assert.match(flightState, /\/m\/amsterdam/);
  assert.match(flightState, /2026-09-15/);
  assert.match(flightState, /2026-09-19/);
  assert.equal(transport.lastRequest?.responseUrlIncludes, "FlightsFrontendService/GetShoppingResults");
});

test("uçuş state'ine yetişkin ve çocuk yolcuları ayrı tiplerle yazar", async () => {
  const transport = new FakeTransport(googleBody(null, [flightOffer()]));
  const search = new GoogleTravelSearch(transport, 90_000);

  await search.searchFlights({
    origin: "IST",
    destination: "AMS",
    departureDate: "2027-07-10",
    returnDate: "2027-07-15",
    adults: 3,
    children: 2,
    cabin: "economy",
    currency: "TRY",
    language: "tr",
  });

  const sourceUrl = new URL(transport.lastRequest?.sourceUrl ?? "https://invalid.test");
  const state = Buffer.from(sourceUrl.searchParams.get("tfs") ?? "", "base64url");
  assert.deepEqual(readVarintFields(state, 8), [1, 1, 1, 2, 2]);
});

test("otel RPC cevabını normalize eder", async () => {
  const hotel = Array<unknown>(22).fill(null);
  hotel[0] = "Canal Hotel";
  hotel[2] = "₺4.070";
  hotel[4] = 1766;
  hotel[5] = 4.1;
  hotel[6] = "Booking.com";
  hotel[10] = 4;
  hotel[13] = "hotel-token";
  hotel[16] = [52.37, 4.89];
  hotel[18] = ["₺4.070", "₺4.070", "₺12.210"];
  hotel[19] = ["2026-09-17", "2026-09-20", 3, null, null, null, null, null, null, null, "property-1"];
  hotel[20] = [184, false, null, 4070.25];
  hotel[21] = ["https://images.example/hotel.jpg"];
  const transport = new FakeTransport(googleBody("AtySUc", [{ cards: [hotel] }]));
  const search = new GoogleTravelSearch(transport, 90_000);

  const result = await search.searchHotels({
    destination: "Amsterdam",
    checkIn: "2026-09-17",
    checkOut: "2026-09-20",
    adults: 2,
    rooms: 1,
    children: 0,
    currency: "TRY",
    language: "tr",
  });

  assert.equal(result.stays.length, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(result.query.location, "Amsterdam");
  assert.equal(result.stays[0]?.source, "google_hotels_browser");
  assert.equal(result.stays[0]?.sourceStayId, "property-1");
  assert.equal(result.stays[0]?.ratePerNight, 4070.25);
  assert.equal(result.stays[0]?.totalPrice, 12_210);
  assert.deepEqual(result.stays[0]?.gps, { latitude: 52.37, longitude: 4.89 });
  assert.deepEqual(result.stays[0]?.otaPrices, [{ seller: "Booking.com", ratePerNight: 4070.25 }]);
  assert.equal(transport.lastRequest?.responseUrlIncludes, "rpcids=AtySUc");
});

test("kiralık yer RPC cevabını normalize eder ve vacation rental state'i üretir", async () => {
  const transport = new FakeTransport(googleBody("AtySUc", [{ cards: [vacationRental()] }]));
  const search = new GoogleTravelSearch(transport, 90_000);

  const result = await search.searchVacationRentals({
    destination: "Kalkan",
    checkIn: "2026-08-13",
    checkOut: "2026-08-20",
    adults: 2,
    rooms: 1,
    children: 0,
    currency: "TRY",
    language: "tr",
  });

  assert.equal(result.query.propertyType, "vacation_rentals");
  assert.equal(result.stays.length, 1);
  assert.equal(result.stays[0]?.source, "google_vacation_rentals_browser");
  assert.equal(result.stays[0]?.sourceStayId, "rental-property-1");
  assert.equal(result.stays[0]?.propertyType, "villa");
  assert.equal(result.stays[0]?.ratePerNight, 22_676.771);
  assert.equal(result.stays[0]?.totalPrice, 158_737);
  assert.equal(result.stays[0]?.rating, 4.9);
  assert.equal(result.stays[0]?.reviewCount, 94);
  assert.deepEqual(result.stays[0]?.gps, { latitude: 36.269619, longitude: 29.40629 });
  assert.deepEqual(result.stays[0]?.amenities, ["Klima", "Balkon", "Villanın tamamı", "6 kişilik"]);
  assert.deepEqual(result.stays[0]?.otaPrices, [{ seller: "Vrbo.com", ratePerNight: 22_676.771 }]);
  assert.equal(result.stays[0]?.bookingUrl, "https://www.google.com/travel/lodging/clk?id=1");
  assert.deepEqual(result.stays[0]?.images, ["https://images.example/villa.jpg"]);

  const sourceUrl = new URL(transport.lastRequest?.sourceUrl ?? "https://invalid.test");
  const state = Buffer.from(sourceUrl.searchParams.get("ts") ?? "", "base64url");
  assert.deepEqual(readVarintFields(state, 1), [2]);
});

function googleBody(rpcId: string | null, payload: unknown): string {
  const frame = JSON.stringify([["wrb.fr", rpcId, JSON.stringify(payload)]]);
  return `)]}'\n\n${frame.length}\n${frame}\n`;
}

function suggestionBody(query: string): string {
  const normalized = query.toUpperCase();
  if (normalized === "IST") {
    return googleBody("H028ib", [[[[3, "İstanbul, Türkiye", "İstanbul", "Türkiye'de bir şehir", "/m/istanbul"], [[[1, "İstanbul Havalimanı", "İstanbul", null, "/m/istanbul", "IST"]]]]]]);
  }
  return googleBody("H028ib", [[[[3, "Amsterdam, Hollanda", "Amsterdam", "Hollanda'nın başkenti", "/m/amsterdam"], [[[1, "Amsterdam Schiphol Havalimanı", "Amsterdam", null, "/m/amsterdam", "AMS"]]]]]]);
}

function flightOffer(): unknown[] {
  const segment = Array<unknown>(24).fill(null);
  segment[3] = "IST";
  segment[4] = "İstanbul Havalimanı";
  segment[5] = "Amsterdam Schiphol";
  segment[6] = "AMS";
  segment[8] = [8, 30];
  segment[10] = [10, 55];
  segment[11] = 205;
  segment[17] = "Airbus A321";
  segment[20] = [2026, 9, 15];
  segment[21] = [2026, 9, 15];
  segment[22] = ["TK", "1951", null, "Turkish Airlines"];

  const leg = [
    "TK",
    ["Turkish Airlines"],
    [segment],
    "IST",
    [2026, 9, 15],
    [8, 30],
    "AMS",
    [2026, 9, 15],
    [10, 55],
    205,
  ];
  return [leg, [[null, 12_345], "selection-token"]];
}

function vacationRental(): unknown[] {
  const rental = Array<unknown>(46).fill(null);
  rental[1] = "Kalkan Bay Heated Pool Villa";
  rental[2] = [[36.269619, 29.40629]];
  rental[5] = [null, [[null, ["https://images.example/villa.jpg", 192, 287]]]];

  const staySearch = Array<unknown>(3).fill(null);
  staySearch[1] = [null, null, null, "TRY", [[2026, 8, 13], [2026, 8, 20], 7, 1]];
  const pricing = Array<unknown>(22).fill(null);
  pricing[1] = ["₺22.677", null, 22_676.771];
  pricing[8] = [[2026, 8, 13], [2026, 8, 20], 7, 1];
  pricing[9] = ["₺158.737"];
  pricing[21] = [[["Vrbo.com", 1, "/travel/lodging/clk?id=1"]]];
  staySearch[2] = pricing;
  rental[6] = staySearch;
  rental[7] = [[4.9, 94]];

  const details = Array<unknown>(4).fill(null);
  details[1] = [null, [["Klima"], ["Balkon"]]];
  details[3] = [null, [
    ["Villanın tamamı", true, null, null, null, null, "Villa"],
    ["6 kişilik"],
  ]];
  rental[10] = details;
  rental[20] = "rental-token";
  rental[25] = "rental-property-1";
  return rental;
}

function readVarintFields(buffer: Buffer, wantedField: number): number[] {
  const values: number[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset);
    offset = tag.offset;
    const field = tag.value >> 3;
    const wireType = tag.value & 7;
    if (wireType === 0) {
      const value = readVarint(buffer, offset);
      offset = value.offset;
      if (field === wantedField) values.push(value.value);
    } else if (wireType === 2) {
      const length = readVarint(buffer, offset);
      offset = length.offset + length.value;
    } else {
      throw new Error(`Test decoder desteklenmeyen wire type gördü: ${wireType}`);
    }
  }
  return values;
}

function readVarint(buffer: Buffer, start: number): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (offset < buffer.length) {
    const byte = buffer[offset++] ?? 0;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7;
  }
  throw new Error("Eksik varint");
}
