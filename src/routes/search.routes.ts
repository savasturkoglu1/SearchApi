import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { TravelSearch } from "../travel/travel-search.js";

const dateSchema = z.iso.date();
const currencySchema = z.string().trim().length(3).transform((value) => value.toUpperCase());
const languageSchema = z.string().trim().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/).default("tr");
const locationSuggestionSchema = z.object({
  q: z.string().trim().min(1).max(120),
  currency: currencySchema.default("TRY"),
  language: languageSchema,
});
const flightOfferSelectionSchema = z.object({
  offerId: z.string().trim().min(1).max(16_384),
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
    currency: currencySchema.default("TRY"),
    language: languageSchema,
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
    currency: currencySchema.default("TRY"),
    language: languageSchema,
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

export async function searchRoutes(app: FastifyInstance, travelSearch: TravelSearch): Promise<void> {
  app.get("/locations/flights", async (request) => {
    const query = parse(locationSuggestionSchema, request.query);
    return {
      suggestions: await travelSearch.suggestFlightLocations(query.q, {
        currency: query.currency,
        language: query.language,
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
      currency: input.currency,
      language: input.language,
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
    return travelSearch.searchHotels(input);
  });

  app.post("/search/vacation-rentals", async (request) => {
    const input = parse(accommodationSearchSchema, request.body);
    return travelSearch.searchVacationRentals(input);
  });
}
