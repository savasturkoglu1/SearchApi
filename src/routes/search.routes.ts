import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { MARKET_PROFILE_IDS } from "../markets/market-profile.js";
import type { MarketTravelSearch } from "../travel/market-travel.search.js";
import type { StaySearchResult } from "../travel/travel-search.js";

const dateSchema = z.iso.date();
const marketProfileSchema = z.enum(MARKET_PROFILE_IDS);
const locationSuggestionSchema = z.object({
  q: z.string().trim().min(1).max(120),
  marketProfile: marketProfileSchema,
});
const flightOfferSelectionSchema = z.object({
  offerId: z.string().trim().min(1).max(16_384),
  marketProfile: marketProfileSchema,
});
const webSearchSchema = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(20).default(10),
  safeSearch: z.boolean().default(true),
  marketProfile: marketProfileSchema,
});
const destinationResearchSchema = z.object({
  destination: z.string().trim().min(2).max(160),
  interests: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
  maxPlaces: z.number().int().min(1).max(20).default(10),
  maxArticles: z.number().int().min(1).max(20).default(10),
  safeSearch: z.boolean().default(true),
  marketProfile: marketProfileSchema,
});

const flightSearchSchema = z
  .object({
    origin: z.string().trim().min(2).max(120),
    destination: z.string().trim().min(2).max(120),
    departureDate: dateSchema,
    returnDate: dateSchema.optional(),
    adults: z.number().int().min(1).max(9).default(1),
    children: z.number().int().min(0).max(9).default(0),
    cabin: z.enum(["economy", "premium_economy", "business", "first"]).default("economy"),
    marketProfile: marketProfileSchema,
  })
  .refine((value) => !value.returnDate || value.returnDate >= value.departureDate, {
    message: "returnDate departureDate'ten önce olamaz",
    path: ["returnDate"],
  })
  .refine((value) => value.adults + value.children <= 9, {
    message: "Toplam uçuş yolcusu 9'u geçemez",
    path: ["children"],
  })
  .refine((value) => value.cabin === "economy", {
    message: "MVP şu anda yalnızca economy kabinini destekliyor",
    path: ["cabin"],
  });

const accommodationSearchSchema = z
  .object({
    destination: z.string().trim().min(2).max(160),
    checkIn: dateSchema,
    checkOut: dateSchema,
    adults: z.number().int().min(1).max(30).default(2),
    rooms: z.number().int().min(1).max(10).default(1),
    children: z.number().int().min(0).max(20).default(0),
    includeImages: z.boolean().default(false),
    marketProfile: marketProfileSchema,
  })
  .refine((value) => value.checkOut > value.checkIn, {
    message: "checkOut checkIn'den sonra olmalı",
    path: ["checkOut"],
  });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const error = new Error("Geçersiz arama isteği");
    Object.assign(error, { statusCode: 400, details: z.flattenError(result.error) });
    throw error;
  }
  return result.data;
}

export async function searchRoutes(
  app: FastifyInstance,
  travelSearch: MarketTravelSearch,
): Promise<void> {
  app.get("/market-profiles", async () => ({ profiles: travelSearch.status() }));

  app.post("/search/web", async (request) => {
    const input = parse(webSearchSchema, request.body);
    return travelSearch.searchWeb(input);
  });

  app.post("/research/destinations", async (request) => {
    const input = parse(destinationResearchSchema, request.body);
    return travelSearch.researchDestination(input);
  });

  app.get("/locations/flights", async (request) => {
    const query = parse(locationSuggestionSchema, request.query);
    return {
      suggestions: await travelSearch.suggestFlightLocations(query.q, {
        marketProfile: query.marketProfile,
      }),
    };
  });

  app.post("/search/flights", async (request) => {
    const input = parse(flightSearchSchema, request.body);
    return travelSearch.searchFlights({
      origin: input.origin,
      destination: input.destination,
      departureDate: input.departureDate,
      adults: input.adults,
      children: input.children,
      cabin: input.cabin,
      marketProfile: input.marketProfile,
      ...(input.returnDate ? { returnDate: input.returnDate } : {}),
    });
  });

  app.post("/search/flights/returns", async (request) => {
    const input = parse(flightOfferSelectionSchema, request.body);
    return travelSearch.searchFlightReturns(input);
  });

  app.post("/search/flights/bookings", async (request) => {
    const input = parse(flightOfferSelectionSchema, request.body);
    return travelSearch.searchFlightBookings(input);
  });

  app.post("/search/hotels", async (request) => {
    const input = parse(accommodationSearchSchema, request.body);
    return projectAccommodationImages(
      await travelSearch.searchHotels(input),
      input.includeImages,
    );
  });

  app.post("/search/vacation-rentals", async (request) => {
    const input = parse(accommodationSearchSchema, request.body);
    return projectAccommodationImages(
      await travelSearch.searchVacationRentals(input),
      input.includeImages,
    );
  });
}

function projectAccommodationImages(
  result: StaySearchResult,
  includeImages: boolean,
): StaySearchResult {
  if (includeImages) return result;
  return {
    ...result,
    stays: result.stays.map((stay) => {
      const projected = { ...stay };
      delete projected.images;
      return projected;
    }),
  };
}
