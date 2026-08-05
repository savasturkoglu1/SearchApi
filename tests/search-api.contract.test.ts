import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { searchRoutes } from "../src/routes/search.routes.js";
import { GoogleTravelSearch } from "../src/travel/google-travel.search.js";
import type {
  FlightLocationLookupRequest,
  FlightLocationLookupResult,
  TravelRpcRequest,
  TravelRpcResponse,
  TravelRpcTransport,
} from "../src/travel/travel-search.js";

class FixtureTransport implements TravelRpcTransport {
  readonly requests: TravelRpcRequest[] = [];

  constructor(private readonly bodies: string[]) {}

  async execute(request: TravelRpcRequest): Promise<TravelRpcResponse> {
    this.requests.push(request);
    const body = this.bodies.shift();
    assert.ok(body, `Fixture body eksik: ${request.responseUrlIncludes}`);
    return {
      body,
      sourceUrl: request.sourceUrl,
      responseUrl: `https://www.google.com/${request.responseUrlIncludes}`,
      captureContextId: "11111111-1111-4111-8111-111111111111",
      elapsedMs: 25,
    };
  }

  async lookupFlightLocations(
    request: FlightLocationLookupRequest,
  ): Promise<FlightLocationLookupResult[]> {
    return request.queries.map((query) => ({ query, body: suggestionBody(query) }));
  }

  async closeAll(): Promise<void> {}
}

test("uçuş araması canlı fiyat durumunu ve en düşük fiyat içgörüsünü döndürür", async () => {
  const app = Fastify();
  const travelSearch = new GoogleTravelSearch(
    new FixtureTransport([googleBody(null, [flightOffer()])]),
    90_000,
  );
  await app.register(async (v1) => searchRoutes(v1, travelSearch), { prefix: "/v1" });

  const response = await app.inject({
    method: "POST",
    url: "/v1/search/flights",
    payload: {
      origin: "IST",
      destination: "AMS",
      departureDate: "2026-09-15",
      returnDate: "2026-09-19",
      adults: 1,
      children: 0,
      cabin: "economy",
      currency: "TRY",
      language: "tr",
    },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json<{
    offers: Array<{ priceIsEstimated?: boolean }>;
    priceInsights?: { lowestPrice?: number };
  }>();
  assert.equal(body.offers[0]?.priceIsEstimated, false);
  assert.equal(body.priceInsights?.lowestPrice, 12_345);

  await app.close();
});

test("otel araması satın alma linkini ve canlı fiyat bilgisini döndürür", async () => {
  const app = Fastify();
  const travelSearch = new GoogleTravelSearch(
    new FixtureTransport([googleBody("AtySUc", [{ cards: [hotelOffer()] }])]),
    90_000,
  );
  await app.register(async (v1) => searchRoutes(v1, travelSearch), { prefix: "/v1" });

  const response = await app.inject({
    method: "POST",
    url: "/v1/search/hotels",
    payload: {
      destination: "Amsterdam",
      checkIn: "2026-09-17",
      checkOut: "2026-09-20",
      adults: 2,
      rooms: 1,
      children: 0,
      currency: "TRY",
      language: "tr",
    },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json<{
    stays: Array<{ bookingUrl?: string; priceIsEstimated?: boolean }>;
    priceInsights?: { lowestPrice?: number };
  }>();
  assert.equal(
    body.stays[0]?.bookingUrl,
    "https://www.google.com/aclk?sa=l&sig=hotel-booking",
  );
  assert.equal(body.stays[0]?.priceIsEstimated, false);
  assert.equal(body.priceInsights?.lowestPrice, 4070.25);

  await app.close();
});

test("kiralık yer araması satın alma linkini ve canlı fiyat bilgisini döndürür", async () => {
  const app = Fastify();
  const travelSearch = new GoogleTravelSearch(
    new FixtureTransport([googleBody("AtySUc", [{ cards: [vacationRentalOffer()] }])]),
    90_000,
  );
  await app.register(async (v1) => searchRoutes(v1, travelSearch), { prefix: "/v1" });

  const response = await app.inject({
    method: "POST",
    url: "/v1/search/vacation-rentals",
    payload: {
      destination: "Kalkan",
      checkIn: "2026-08-13",
      checkOut: "2026-08-20",
      adults: 2,
      rooms: 1,
      children: 0,
      currency: "TRY",
      language: "tr",
    },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json<{
    stays: Array<{ bookingUrl?: string; priceIsEstimated?: boolean }>;
    priceInsights?: { lowestPrice?: number };
  }>();
  assert.equal(
    body.stays[0]?.bookingUrl,
    "https://www.google.com/travel/lodging/clk?id=rental-booking",
  );
  assert.equal(body.stays[0]?.priceIsEstimated, false);
  assert.equal(body.priceInsights?.lowestPrice, 22_676.771);

  await app.close();
});

test("seçilen gidiş için dönüş seçeneklerini birleşik uçuşlar olarak döndürür", async () => {
  const app = Fastify();
  const transport = new FixtureTransport([
    googleBody(null, [flightOffer()]),
    googleBody(null, [returnFlightOffer()]),
  ]);
  const travelSearch = new GoogleTravelSearch(transport, 90_000);
  await app.register(async (v1) => searchRoutes(v1, travelSearch), { prefix: "/v1" });

  const initialResponse = await app.inject({
    method: "POST",
    url: "/v1/search/flights",
    payload: {
      origin: "IST",
      destination: "AMS",
      departureDate: "2026-09-15",
      returnDate: "2026-09-19",
      adults: 1,
      children: 0,
      cabin: "economy",
      currency: "TRY",
      language: "tr",
    },
  });
  const initial = initialResponse.json<{ offers: Array<{ sourceOfferId: string }> }>();

  const response = await app.inject({
    method: "POST",
    url: "/v1/search/flights/returns",
    payload: { offerId: initial.offers[0]?.sourceOfferId },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json<{
    offers: Array<{
      sourceOfferId?: string;
      outboundSegments: Array<{ flightNumber: string }>;
      returnSegments: Array<{ flightNumber: string }>;
      totalPrice: number;
      priceIsEstimated?: boolean;
    }>;
  }>();
  assert.equal(body.offers[0]?.sourceOfferId, "return-token");
  assert.equal(body.offers[0]?.outboundSegments[0]?.flightNumber, "TK 1951");
  assert.equal(body.offers[0]?.returnSegments[0]?.flightNumber, "TK 1952");
  assert.equal(body.offers[0]?.totalPrice, 13_250);
  assert.equal(body.offers[0]?.priceIsEstimated, false);
  assert.match(transport.requests[1]?.sourceUrl ?? "", /tfu=/);

  await app.close();
});

test("tam uçuş seçimi için satıcı linkini ve bagaj koşullarını döndürür", async () => {
  const app = Fastify();
  const transport = new FixtureTransport([
    googleBody(null, [flightOffer()]),
    googleBody(null, [returnFlightOffer()]),
    googleBody(null, [
      splitBookingGroup(),
      bookingOption(),
      [
        1,
        [null, 12_500],
        [null, 15_000],
        [null, 2_500],
        [null, 14_000],
        [null, 20_000],
        1,
      ],
      [
        "TK",
        "Turkish Airlines",
        "https://www.turkishairlines.com/tr-int/bilgi-edin/bagaj/",
      ],
    ]),
  ]);
  const travelSearch = new GoogleTravelSearch(transport, 90_000);
  await app.register(async (v1) => searchRoutes(v1, travelSearch), { prefix: "/v1" });

  const initial = await app.inject({
    method: "POST",
    url: "/v1/search/flights",
    payload: {
      origin: "IST",
      destination: "AMS",
      departureDate: "2026-09-15",
      returnDate: "2026-09-19",
      adults: 1,
      children: 0,
      cabin: "economy",
      currency: "TRY",
      language: "tr",
    },
  });
  const outboundId = initial.json<{ offers: Array<{ sourceOfferId: string }> }>()
    .offers[0]?.sourceOfferId;
  const returns = await app.inject({
    method: "POST",
    url: "/v1/search/flights/returns",
    payload: { offerId: outboundId },
  });
  const returnId = returns.json<{ offers: Array<{ sourceOfferId: string }> }>()
    .offers[0]?.sourceOfferId;

  const response = await app.inject({
    method: "POST",
    url: "/v1/search/flights/bookings",
    payload: { offerId: returnId },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json<{
    bookingOptions: Array<{
      seller: string;
      totalPrice: number;
      currency: string;
      bookingUrl?: string;
      bookingLinks?: Array<{ seller: string; totalPrice: number; bookingUrl: string }>;
      baggageNotes?: string[];
    }>;
    bookingUrl?: string;
    baggageNotes?: string[];
    priceIsEstimated?: boolean;
    priceInsights?: {
      lowestPrice?: number;
      priceLevel?: string;
      typicalPriceRange?: [number, number];
    };
  }>();
  assert.equal(body.bookingOptions[0]?.seller, "Pegasus + AJet");
  assert.equal(body.bookingOptions[0]?.totalPrice, 12_500);
  assert.equal(body.bookingOptions[0]?.bookingUrl, undefined);
  assert.deepEqual(body.bookingOptions[0]?.bookingLinks, [
    {
      seller: "Pegasus",
      totalPrice: 6_000,
      bookingUrl: "https://www.google.com/travel/clk/f?u=pegasus-click",
    },
    {
      seller: "AJet",
      totalPrice: 6_500,
      bookingUrl: "https://www.google.com/travel/clk/f?u=ajet-click",
    },
  ]);
  assert.equal(
    body.bookingUrl,
    "https://www.google.com/travel/clk/f?u=signed-click",
  );
  assert.deepEqual(body.baggageNotes, [
    "Turkish Airlines bagaj koşulları: https://www.turkishairlines.com/tr-int/bilgi-edin/bagaj/",
  ]);
  assert.equal(body.priceIsEstimated, false);
  assert.deepEqual(body.priceInsights, {
    lowestPrice: 12_500,
    priceLevel: "low",
    typicalPriceRange: [14_000, 20_000],
  });
  assert.match(transport.requests[2]?.sourceUrl ?? "", /\/travel\/flights\/booking/);

  await app.close();
});

function googleBody(rpcId: string | null, payload: unknown): string {
  const frame = JSON.stringify([["wrb.fr", rpcId, JSON.stringify(payload)]]);
  return `)]}'\n\n${frame.length}\n${frame}\n`;
}

function suggestionBody(query: string): string {
  const normalized = query.toUpperCase();
  if (normalized === "IST") {
    return googleBody("H028ib", [
      [
        [
          [3, "İstanbul, Türkiye", "İstanbul", "Türkiye'de bir şehir", "/m/istanbul"],
          [[[1, "İstanbul Havalimanı", "İstanbul", null, "/m/istanbul", "IST"]]],
        ],
      ],
    ]);
  }
  return googleBody("H028ib", [
    [
      [
        [3, "Amsterdam, Hollanda", "Amsterdam", "Hollanda'nın başkenti", "/m/amsterdam"],
        [
          [
            [1, "Amsterdam Schiphol Havalimanı", "Amsterdam", null, "/m/amsterdam", "AMS"],
          ],
        ],
      ],
    ],
  ]);
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
  return [leg, [[null, 12_345], "outbound-token"]];
}

function returnFlightOffer(): unknown[] {
  const segment = Array<unknown>(24).fill(null);
  segment[3] = "AMS";
  segment[4] = "Amsterdam Schiphol";
  segment[5] = "İstanbul Havalimanı";
  segment[6] = "IST";
  segment[8] = [12, 30];
  segment[10] = [17, 0];
  segment[11] = 210;
  segment[17] = "Airbus A321";
  segment[20] = [2026, 9, 19];
  segment[21] = [2026, 9, 19];
  segment[22] = ["TK", "1952", null, "Turkish Airlines"];

  const leg = [
    "TK",
    ["Turkish Airlines"],
    [segment],
    "AMS",
    [2026, 9, 19],
    [12, 30],
    "IST",
    [2026, 9, 19],
    [17, 0],
    210,
  ];
  return [leg, [[null, 13_250], "return-token"]];
}

function bookingOption(): unknown[] {
  const option = Array<unknown>(23).fill(null);
  option[0] = 0;
  option[1] = [["TK", "Turkish Airlines", null, true]];
  option[3] = [["TK", "1951"], ["TK", "1952"]];
  option[4] = false;
  option[5] = [
    "turkishairlines.com/...",
    null,
    ["https://www.google.com/travel/clk/f", [["u", "signed-click"]]],
  ];
  option[7] = [[null, 13_250], "booking-token"];
  return option;
}

function splitBookingGroup(): unknown[] {
  const pegasus = Array<unknown>(23).fill(null);
  pegasus[0] = 0;
  pegasus[1] = [["PC", "Pegasus", null, true]];
  pegasus[3] = [["PC", "5015"]];
  pegasus[5] = [
    "flypgs.com/...",
    null,
    ["https://www.google.com/travel/clk/f", [["u", "pegasus-click"]]],
  ];
  pegasus[7] = [[null, 6_000], "pegasus-option"];

  const ajet = Array<unknown>(23).fill(null);
  ajet[0] = 0;
  ajet[1] = [["VF", "AJet", null, true]];
  ajet[3] = [["VF", "4"]];
  ajet[5] = [
    "ajet.com/...",
    null,
    ["https://www.google.com/travel/clk/f", [["u", "ajet-click"]]],
  ];
  ajet[7] = [[null, 6_500], "ajet-option"];

  const group = Array<unknown>(28).fill(null);
  group[0] = 5;
  group[1] = [["PC", "Pegasus", null, true], ["VF", "AJet", null, true]];
  group[2] = [pegasus, ajet];
  group[3] = [["PC", "5015"], ["VF", "4"]];
  group[7] = [[null, 12_500], "split-option"];
  return group;
}

function hotelOffer(): unknown[] {
  const hotel = Array<unknown>(22).fill(null);
  hotel[0] = "Canal Hotel";
  hotel[1] = "/aclk?sa=l&sig=hotel-booking";
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
  return hotel;
}

function vacationRentalOffer(): unknown[] {
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
  pricing[21] = [
    [["Vrbo.com", 1, "/travel/lodging/clk?id=rental-booking"]],
  ];
  staySearch[2] = pricing;
  rental[6] = staySearch;
  rental[7] = [[4.9, 94]];

  const details = Array<unknown>(4).fill(null);
  details[1] = [null, [["Klima"], ["Balkon"]]];
  details[3] = [null, [["Villanın tamamı", true, null, null, null, null, "Villa"]]];
  rental[10] = details;
  rental[20] = "rental-token";
  rental[25] = "rental-property-1";
  return rental;
}
