import type {
  FlightLocationSuggestion,
  GoogleFlightBookingOption,
  GoogleFlightLeg,
  GoogleFlightOffer,
  GoogleFlightSegment,
  GoogleHotelOffer,
  GoogleStayOffer,
  PriceInsights,
} from "./travel-search.js";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface GoogleFrame {
  rpcId: string | null;
  payload: JsonValue;
}

export function decodeGoogleFrames(body: string): GoogleFrame[] {
  const frames: GoogleFrame[] = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("[")) continue;
    let rows: unknown;
    try {
      rows = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(rows)) continue;

    for (const row of rows) {
      if (!Array.isArray(row) || row[0] !== "wrb.fr" || typeof row[2] !== "string") {
        continue;
      }
      try {
        frames.push({
          rpcId: typeof row[1] === "string" ? row[1] : null,
          payload: JSON.parse(row[2]) as JsonValue,
        });
      } catch {
        // Google bazen JSON olmayan tanılama frame'leri gönderir.
      }
    }
  }
  return frames;
}

export function parseFlightOffers(body: string, currency: string): GoogleFlightOffer[] {
  const offers = new Map<string, GoogleFlightOffer>();
  for (const frame of decodeGoogleFrames(body)) {
    walkJson(frame.payload, (value) => {
      if (!isFlightOfferNode(value)) return;
      const legNode = value[0];
      const priceNode = value[1] as JsonValue[];
      const amountNode = Array.isArray(priceNode[0]) ? priceNode[0] : undefined;
      const price = amountNode?.[1];
      const selectionToken = priceNode[1];
      if (typeof price !== "number" || typeof selectionToken !== "string") return;

      const leg = parseFlightLeg(legNode);
      if (!leg) return;
      offers.set(selectionToken, {
        price: { amount: price, currency, display: `${price} ${currency}` },
        selectionToken,
        leg,
      });
    });
  }
  return [...offers.values()].sort((a, b) => a.price.amount - b.price.amount);
}

export function parseFlightBookingOptions(
  body: string,
  currency: string,
): GoogleFlightBookingOption[] {
  const baggagePolicies = new Map<string, { airline: string; url: string }>();
  const frames = decodeGoogleFrames(body);
  for (const frame of frames) {
    walkJson(frame.payload, (value) => {
      if (!isBaggagePolicyRow(value)) return;
      baggagePolicies.set(value[0], { airline: value[1], url: value[2] });
    });
  }

  const splitGroups: JsonValue[][] = [];
  const splitChildIds = new Set<string>();
  for (const frame of frames) {
    walkJson(frame.payload, (value) => {
      if (!isSplitBookingGroup(value)) return;
      splitGroups.push(value);
      for (const child of value[2] as JsonValue[]) {
        if (!Array.isArray(child) || !isFlightBookingOptionNode(child)) continue;
        const priceContainer = child[7] as JsonValue[];
        splitChildIds.add(priceContainer[1] as string);
      }
    });
  }

  const options = new Map<string, GoogleFlightBookingOption>();
  for (const group of splitGroups) {
    const priceContainer = group[7] as JsonValue[];
    const priceRow = priceContainer[0] as JsonValue[];
    const optionId = priceContainer[1] as string;
    const bookingLinks = (group[2] as JsonValue[])
      .map((child) =>
        Array.isArray(child) && isFlightBookingOptionNode(child)
          ? parseSingleBookingOption(child, currency, baggagePolicies)
          : undefined,
      )
      .filter((option): option is GoogleFlightBookingOption => Boolean(option?.bookingUrl))
      .map((option) => ({
        seller: option.seller,
        totalPrice: option.totalPrice,
        bookingUrl: option.bookingUrl as string,
      }));
    if (bookingLinks.length === 0) continue;
    const baggageNotes = baggageNotesForRows(group[3] as JsonValue[], baggagePolicies);
    options.set(`split:${optionId}`, {
      optionId,
      seller: sellerNames(group[1] as JsonValue[]).join(" + ") || "Ayrı biletler",
      totalPrice: priceRow[1] as number,
      currency,
      bookingLinks,
      ...(baggageNotes.length > 0 ? { baggageNotes } : {}),
    });
  }

  for (const frame of frames) {
    walkJson(frame.payload, (value) => {
      if (!isFlightBookingOptionNode(value)) return;
      const priceContainer = value[7] as JsonValue[];
      const optionId = priceContainer[1] as string;
      if (splitChildIds.has(optionId)) return;
      const option = parseSingleBookingOption(value, currency, baggagePolicies);
      if (!option?.bookingUrl || options.has(option.bookingUrl)) return;
      options.set(option.bookingUrl, option);
    });
  }
  return [...options.values()].sort((a, b) => a.totalPrice - b.totalPrice);
}

export function parseFlightPriceInsights(body: string): PriceInsights | undefined {
  let insight: PriceInsights | undefined;
  for (const frame of decodeGoogleFrames(body)) {
    walkJson(frame.payload, (value) => {
      if (insight || !isFlightPriceInsightNode(value)) return;
      const amount = (value[1] as JsonValue[])[1] as number;
      const typicalLow = (value[4] as JsonValue[])[1] as number;
      const typicalHigh = (value[5] as JsonValue[])[1] as number;
      const level = value[0] === 1 ? "low" : value[0] === 2 ? "typical" : "high";
      insight = {
        lowestPrice: amount,
        priceLevel: level,
        typicalPriceRange: [typicalLow, typicalHigh],
      };
    });
  }
  return insight;
}

function parseSingleBookingOption(
  value: JsonValue[],
  currency: string,
  baggagePolicies: Map<string, { airline: string; url: string }>,
): GoogleFlightBookingOption | undefined {
  const priceContainer = value[7] as JsonValue[];
  const linkContainer = value[5] as JsonValue[];
  const priceRow = priceContainer[0] as JsonValue[];
  const bookingUrl = buildParameterizedUrl(linkContainer[2] as JsonValue[]);
  if (!bookingUrl) return undefined;
  const baggageNotes = baggageNotesForRows(value[3] as JsonValue[], baggagePolicies);
  return {
    optionId: priceContainer[1] as string,
    seller: sellerNames(value[1] as JsonValue[]).join(" + ") || "Havayolu / seyahat acentesi",
    totalPrice: priceRow[1] as number,
    currency,
    bookingUrl,
    ...(baggageNotes.length > 0 ? { baggageNotes } : {}),
  };
}

function sellerNames(rows: JsonValue[]): string[] {
  return rows
    .map((row) => (Array.isArray(row) ? readString(row[1]) : undefined))
    .filter((seller): seller is string => Boolean(seller));
}

function baggageNotesForRows(
  rows: JsonValue[],
  baggagePolicies: Map<string, { airline: string; url: string }>,
): string[] {
  const carrierCodes = new Set(
    rows
      .map((row) => (Array.isArray(row) ? readString(row[0]) : undefined))
      .filter((code): code is string => Boolean(code)),
  );
  return [...new Set(
    [...carrierCodes]
      .map((code) => baggagePolicies.get(code))
      .filter((policy): policy is { airline: string; url: string } => Boolean(policy))
      .map((policy) => `${policy.airline} bagaj koşulları: ${policy.url}`),
  )];
}

export function parseHotelOffers(body: string, currency: string): GoogleHotelOffer[] {
  const hotels = new Map<string, GoogleHotelOffer>();
  for (const frame of decodeGoogleFrames(body)) {
    walkJson(frame.payload, (value) => {
      if (!isHotelNode(value)) return;
      const stayNode = Array.isArray(value[19]) ? value[19] : undefined;
      const propertyId = readString(stayNode?.[10]) ?? readString(value[13]) ?? value[0];
      if (hotels.has(propertyId)) return;

      const coordinates = isNumberPair(value[16])
        ? { latitude: value[16][0], longitude: value[16][1] }
        : undefined;
      const priceDetails = Array.isArray(value[20]) ? value[20] : undefined;
      const nightlyAmount = typeof priceDetails?.[3] === "number" ? priceDetails[3] : undefined;
      const priceLabels = stringArray(value[18]);
      const totalAmount = priceLabels[2] ? parseDisplayedPrice(priceLabels[2]) : undefined;
      const stay =
        typeof stayNode?.[0] === "string" &&
        typeof stayNode[1] === "string" &&
        typeof stayNode[2] === "number"
          ? { checkIn: stayNode[0], checkOut: stayNode[1], nights: stayNode[2] }
          : undefined;

      hotels.set(propertyId, {
        propertyId,
        name: value[0],
        provider: value[6],
        propertyType: "hotel",
        price: {
          nightlyDisplay: value[2],
          currency,
          ...(nightlyAmount !== undefined ? { nightlyAmount } : {}),
          ...(totalAmount !== undefined ? { totalAmount } : {}),
          ...(priceLabels[2] ? { totalDisplay: priceLabels[2] } : {}),
        },
        ...(typeof value[5] === "number" ? { rating: value[5] } : {}),
        ...(typeof value[4] === "number" ? { reviewCount: value[4] } : {}),
        ...(typeof value[10] === "number" ? { stars: value[10] } : {}),
        ...(coordinates ? { coordinates } : {}),
        images: stringArray(value[21]).filter((image) => image.startsWith("http")),
        ...(typeof value[1] === "string" && value[1].length > 0
          ? { bookingUrl: absoluteGoogleUrl(value[1]) }
          : {}),
        ...(stay ? { stay } : {}),
      });
    });
  }
  return [...hotels.values()];
}

export function parseVacationRentalOffers(body: string, currency: string): GoogleStayOffer[] {
  const rentals = new Map<string, GoogleStayOffer>();
  for (const frame of decodeGoogleFrames(body)) {
    if (frame.rpcId !== "AtySUc") continue;
    walkJson(frame.payload, (value) => {
      if (!isVacationRentalNode(value)) return;

      const location = value[2] as JsonValue[];
      const coordinates = location[0] as [number, number];
      const searchData = value[6] as JsonValue[];
      const pricing = searchData[2] as JsonValue[];
      const nightly = pricing[1] as JsonValue[];
      const stayNode = pricing[8] as JsonValue[];
      const providerRows = Array.isArray(pricing[21]) ? pricing[21] : [];
      const firstProviderRow = Array.isArray(providerRows[0]) ? providerRows[0] : undefined;
      const providerData = Array.isArray(firstProviderRow?.[0]) ? firstProviderRow[0] : undefined;
      const provider = readString(providerData?.[0]) ?? "Google Vacation Rentals";
      const propertyId = readString(value[25]) ?? readString(value[20]);
      if (!propertyId || rentals.has(propertyId)) return;

      const totalLabels = stringArray(pricing[9]);
      const totalDisplay = totalLabels[0];
      const nightlyAmount = typeof nightly[2] === "number" ? nightly[2] : undefined;
      const totalAmount = totalDisplay ? parseDisplayedPrice(totalDisplay) : undefined;
      const reviewSummary = Array.isArray(value[7]) && Array.isArray(value[7][0])
        ? value[7][0]
        : undefined;
      const propertyType = readVacationRentalPropertyType(value[10]);
      const bookingPath = readString(providerData?.[2]);
      const amenities = readVacationRentalAmenities(value[10]);
      const images = collectHttpStrings(value[5]).slice(0, 12);

      rentals.set(propertyId, {
        propertyId,
        name: value[1],
        provider,
        propertyType,
        price: {
          nightlyDisplay: nightly[0] as string,
          currency,
          ...(nightlyAmount !== undefined ? { nightlyAmount } : {}),
          ...(totalAmount !== undefined ? { totalAmount } : {}),
          ...(totalDisplay ? { totalDisplay } : {}),
        },
        ...(typeof reviewSummary?.[0] === "number" ? { rating: reviewSummary[0] } : {}),
        ...(typeof reviewSummary?.[1] === "number" ? { reviewCount: reviewSummary[1] } : {}),
        coordinates: { latitude: coordinates[0], longitude: coordinates[1] },
        ...(amenities.length > 0 ? { amenities } : {}),
        images,
        ...(bookingPath ? { bookingUrl: absoluteGoogleUrl(bookingPath) } : {}),
        stay: {
          checkIn: dateTupleToIso(stayNode[0] as JsonValue[]),
          checkOut: dateTupleToIso(stayNode[1] as JsonValue[]),
          nights: stayNode[2] as number,
        },
      });
    });
  }
  return [...rentals.values()];
}

export function parseFlightLocationSuggestions(body: string): FlightLocationSuggestion[] {
  const suggestions = new Map<string, FlightLocationSuggestion>();
  for (const frame of decodeGoogleFrames(body)) {
    if (frame.rpcId !== "H028ib") continue;
    walkJson(frame.payload, (value) => {
      if (isCitySuggestion(value)) {
        suggestions.set(`city:${value[4]}`, {
          entityId: value[4],
          label: value[1],
          name: value[2],
          type: "city",
          ...(typeof value[3] === "string" ? { description: value[3] } : {}),
        });
        return;
      }
      if (isAirportSuggestion(value)) {
        suggestions.set(`airport:${value[5]}`, {
          entityId: value[5],
          label: value[1],
          name: value[1],
          type: "airport",
          code: value[5],
          ...(typeof value[4] === "string" ? { parentEntityId: value[4] } : {}),
          ...(typeof value[2] === "string" ? { description: value[2] } : {}),
        });
      }
    });
  }
  return [...suggestions.values()];
}

function isFlightOfferNode(value: JsonValue[]): value is [JsonValue[], JsonValue[], ...JsonValue[]] {
  if (!Array.isArray(value[0]) || !isFlightLegNode(value[0]) || !Array.isArray(value[1])) {
    return false;
  }
  const price = value[1][0];
  return Array.isArray(price) && typeof price[1] === "number" && typeof value[1][1] === "string";
}

function isFlightBookingOptionNode(value: JsonValue[]): boolean {
  const priceContainer = Array.isArray(value[7]) ? value[7] : undefined;
  const price = Array.isArray(priceContainer?.[0]) ? priceContainer[0] : undefined;
  const link = Array.isArray(value[5]) && Array.isArray(value[5][2]) ? value[5][2] : undefined;
  return (
    typeof value[0] === "number" &&
    Array.isArray(value[1]) &&
    Array.isArray(value[3]) &&
    Array.isArray(link) &&
    typeof link[0] === "string" &&
    link[0].startsWith("http") &&
    Array.isArray(price) &&
    typeof price[1] === "number" &&
    typeof priceContainer?.[1] === "string"
  );
}

function isSplitBookingGroup(value: JsonValue[]): boolean {
  const priceContainer = Array.isArray(value[7]) ? value[7] : undefined;
  const price = Array.isArray(priceContainer?.[0]) ? priceContainer[0] : undefined;
  return (
    value[0] === 5 &&
    Array.isArray(value[1]) &&
    Array.isArray(value[2]) &&
    value[2].length > 1 &&
    value[2].every((child) => Array.isArray(child) && isFlightBookingOptionNode(child)) &&
    Array.isArray(value[3]) &&
    Array.isArray(price) &&
    typeof price[1] === "number" &&
    typeof priceContainer?.[1] === "string"
  );
}

function isFlightPriceInsightNode(value: JsonValue[]): boolean {
  return (
    (value[0] === 1 || value[0] === 2 || value[0] === 3) &&
    [1, 2, 3, 4, 5].every(
      (index) => Array.isArray(value[index]) && typeof value[index]?.[1] === "number",
    ) &&
    ((value[4] as JsonValue[])[1] as number) <= ((value[5] as JsonValue[])[1] as number)
  );
}

function isBaggagePolicyRow(value: JsonValue[]): value is [string, string, string] {
  return (
    value.length === 3 &&
    typeof value[0] === "string" &&
    /^[A-Z0-9]{2,3}$/.test(value[0]) &&
    typeof value[1] === "string" &&
    typeof value[2] === "string" &&
    /^https?:\/\//.test(value[2]) &&
    /bag|bagaj|luggage|bagage|genel-kurallar|general-rules/i.test(value[2])
  );
}

function buildParameterizedUrl(value: JsonValue[]): string | undefined {
  if (typeof value[0] !== "string") return undefined;
  try {
    const url = new URL(value[0]);
    if (Array.isArray(value[1])) {
      for (const row of value[1]) {
        if (!Array.isArray(row) || typeof row[0] !== "string" || typeof row[1] !== "string") {
          continue;
        }
        url.searchParams.set(row[0], row[1]);
      }
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function isFlightLegNode(value: JsonValue[]): boolean {
  return (
    typeof value[0] === "string" &&
    Array.isArray(value[1]) &&
    Array.isArray(value[2]) &&
    typeof value[3] === "string" &&
    isDateTuple(value[4]) &&
    isTimeTuple(value[5]) &&
    typeof value[6] === "string" &&
    isDateTuple(value[7]) &&
    isTimeTuple(value[8]) &&
    typeof value[9] === "number"
  );
}

function parseFlightLeg(value: JsonValue[]): GoogleFlightLeg | undefined {
  if (!isFlightLegNode(value)) return undefined;
  const segments = (value[2] as JsonValue[])
    .map((segment) => (Array.isArray(segment) ? parseFlightSegment(segment) : undefined))
    .filter((segment): segment is GoogleFlightSegment => Boolean(segment));
  if (segments.length === 0) return undefined;

  return {
    origin: value[3] as string,
    destination: value[6] as string,
    departureLocal: toLocalDateTime(value[4] as JsonValue[], value[5] as JsonValue[]),
    arrivalLocal: toLocalDateTime(value[7] as JsonValue[], value[8] as JsonValue[]),
    durationMinutes: value[9] as number,
    stops: Math.max(0, segments.length - 1),
    airlines: stringArray(value[1]),
    segments,
  };
}

function parseFlightSegment(value: JsonValue[]): GoogleFlightSegment | undefined {
  const flight = value[22];
  if (
    typeof value[3] !== "string" ||
    typeof value[4] !== "string" ||
    typeof value[5] !== "string" ||
    typeof value[6] !== "string" ||
    !isTimeTuple(value[8]) ||
    !isTimeTuple(value[10]) ||
    typeof value[11] !== "number" ||
    !isDateTuple(value[20]) ||
    !isDateTuple(value[21]) ||
    !Array.isArray(flight) ||
    typeof flight[0] !== "string" ||
    typeof flight[1] !== "string"
  ) {
    return undefined;
  }
  return {
    carrierCode: flight[0],
    airline: typeof flight[3] === "string" ? flight[3] : flight[0],
    flightNumber: `${flight[0]}${flight[1]}`,
    origin: { code: value[3], name: value[4] },
    destination: { code: value[6], name: value[5] },
    departureLocal: toLocalDateTime(value[20], value[8]),
    arrivalLocal: toLocalDateTime(value[21], value[10]),
    durationMinutes: value[11],
    ...(typeof value[17] === "string" ? { aircraft: value[17] } : {}),
  };
}

function isHotelNode(value: JsonValue[]): value is JsonValue[] & {
  0: string;
  2: string;
  6: string;
} {
  return (
    typeof value[0] === "string" &&
    typeof value[2] === "string" &&
    /\d/.test(value[2]) &&
    typeof value[5] === "number" &&
    value[5] >= 0 &&
    value[5] <= 5 &&
    typeof value[6] === "string"
  );
}

function isVacationRentalNode(value: JsonValue[]): value is JsonValue[] & {
  1: string;
  2: JsonValue[];
  6: JsonValue[];
  20: string;
} {
  if (
    typeof value[1] !== "string" ||
    !Array.isArray(value[2]) ||
    !isNumberPair(value[2][0]) ||
    !Array.isArray(value[6]) ||
    typeof value[20] !== "string"
  ) {
    return false;
  }
  const pricing = value[6][2];
  if (!Array.isArray(pricing) || !Array.isArray(pricing[1]) || !Array.isArray(pricing[8])) {
    return false;
  }
  return (
    typeof pricing[1][0] === "string" &&
    typeof pricing[1][2] === "number" &&
    isDateTuple(pricing[8][0]) &&
    isDateTuple(pricing[8][1]) &&
    typeof pricing[8][2] === "number"
  );
}

function isCitySuggestion(value: JsonValue[]): value is JsonValue[] & {
  1: string;
  2: string;
  4: string;
} {
  return (
    value[0] === 3 &&
    typeof value[1] === "string" &&
    typeof value[2] === "string" &&
    typeof value[4] === "string" &&
    value[4].startsWith("/m/")
  );
}

function isAirportSuggestion(value: JsonValue[]): value is JsonValue[] & {
  1: string;
  5: string;
} {
  return (
    value[0] === 1 &&
    typeof value[1] === "string" &&
    typeof value[5] === "string" &&
    /^[A-Z0-9]{3}$/.test(value[5])
  );
}

function walkJson(value: JsonValue, visitor: (array: JsonValue[]) => void): void {
  if (Array.isArray(value)) {
    visitor(value);
    for (const child of value) walkJson(child, visitor);
    return;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) walkJson(child, visitor);
  }
}

function isDateTuple(value: JsonValue | undefined): value is JsonValue[] {
  return (
    Array.isArray(value) &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    typeof value[2] === "number"
  );
}

function isTimeTuple(value: JsonValue | undefined): value is JsonValue[] {
  return Array.isArray(value) && typeof value[0] === "number";
}

function isNumberPair(value: JsonValue | undefined): value is [number, number] {
  return Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "number";
}

function toLocalDateTime(date: JsonValue[], time: JsonValue[]): string {
  const year = date[0] as number;
  const month = date[1] as number;
  const day = date[2] as number;
  const hour = time[0] as number;
  const minute = typeof time[1] === "number" ? time[1] : 0;
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function dateTupleToIso(value: JsonValue[]): string {
  return `${value[0]}-${pad(value[1] as number)}-${pad(value[2] as number)}`;
}

function readVacationRentalPropertyType(value: JsonValue | undefined): string {
  if (!Array.isArray(value)) return "vacation_rental";
  const details = value[3];
  const rows = Array.isArray(details) && Array.isArray(details[1]) ? details[1] : undefined;
  const firstRow = Array.isArray(rows?.[0]) ? rows[0] : undefined;
  return normalizeVacationRentalPropertyType(readString(firstRow?.[6]));
}

function normalizeVacationRentalPropertyType(value: string | undefined): string {
  if (!value) return "vacation_rental";
  const normalized = value.toLocaleLowerCase("tr-TR");
  if (normalized.includes("villa")) return "villa";
  if (normalized.includes("apart") || normalized.includes("daire")) return "apartment";
  if (normalized === "ev" || normalized.includes("house") || normalized.includes("home")) return "house";
  if (normalized.includes("kabin") || normalized.includes("cabin")) return "cabin";
  if (normalized.includes("kır evi") || normalized.includes("cottage")) return "cottage";
  return "vacation_rental";
}

function readVacationRentalAmenities(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const labels = new Set<string>();
  const addRows = (candidate: JsonValue | undefined) => {
    if (!Array.isArray(candidate)) return;
    for (const row of candidate) {
      if (Array.isArray(row) && typeof row[0] === "string") labels.add(row[0]);
    }
  };
  const amenities = value[1];
  if (Array.isArray(amenities)) addRows(amenities[1]);
  const details = value[3];
  if (Array.isArray(details)) addRows(details[1]);
  return [...labels];
}

function collectHttpStrings(value: JsonValue | undefined): string[] {
  const urls = new Set<string>();
  const visit = (entry: JsonValue | undefined) => {
    if (typeof entry === "string" && (entry.startsWith("https://") || entry.startsWith("//"))) {
      urls.add(entry.startsWith("//") ? `https:${entry}` : entry);
      return;
    }
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child);
      return;
    }
    if (entry && typeof entry === "object") {
      for (const child of Object.values(entry)) visit(child);
    }
  };
  visit(value);
  return [...urls];
}

function absoluteGoogleUrl(value: string): string {
  try {
    return new URL(value, "https://www.google.com").toString();
  } catch {
    return value;
  }
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function readString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseDisplayedPrice(value: string): number | undefined {
  const numeric = value.replace(/[^0-9.,-]/g, "");
  if (!numeric) return undefined;
  const dot = numeric.lastIndexOf(".");
  const comma = numeric.lastIndexOf(",");
  let normalized = numeric;
  if (dot >= 0 && comma >= 0) {
    const decimal = dot > comma ? "." : ",";
    normalized = numeric
      .replace(decimal === "." ? /,/g : /\./g, "")
      .replace(decimal, ".");
  } else if (comma >= 0) {
    normalized = /,\d{1,2}$/.test(numeric) ? numeric.replace(",", ".") : numeric.replace(/,/g, "");
  } else if (dot >= 0) {
    normalized = /\.\d{3}$/.test(numeric) ? numeric.replace(/\./g, "") : numeric;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}
