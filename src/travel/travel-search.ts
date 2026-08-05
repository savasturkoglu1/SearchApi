export type CurrencyCode = string;
export type TravelLanguage = string;

export interface FlightSearchInput {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  adults: number;
  children: number;
  cabin: "economy" | "premium_economy" | "business" | "first";
  currency: CurrencyCode;
  language: TravelLanguage;
}

export interface FlightOfferSelectionInput {
  offerId: string;
}

// FlightScanner `src/adapters/types.ts` ile aynı public response sözleşmesi.
export interface PassengerCounts {
  adults: number;
  children: number;
  childrenAges?: number[];
  infantsInSeat: number;
  infantsOnLap: number;
}

export interface FlightSearchQuery {
  originAirports: string[];
  destinationAirports: string[];
  tripType: "one_way" | "round_trip";
  departureDate: string;
  returnDate?: string;
  passengers: PassengerCounts;
  cabinClass?: "economy" | "premium_economy" | "business" | "first";
  maxStops?: number;
  currency: CurrencyCode;
  locale?: string;
}

export interface FlightLocationSuggestion {
  entityId: string;
  label: string;
  name: string;
  description?: string;
  type: "city" | "airport";
  code?: string;
  parentEntityId?: string;
}

export interface GoogleFlightSegment {
  carrierCode: string;
  airline: string;
  flightNumber: string;
  origin: { code: string; name: string };
  destination: { code: string; name: string };
  departureLocal: string;
  arrivalLocal: string;
  durationMinutes: number;
  aircraft?: string;
}

export interface GoogleFlightLeg {
  origin: string;
  destination: string;
  departureLocal: string;
  arrivalLocal: string;
  durationMinutes: number;
  stops: number;
  airlines: string[];
  segments: GoogleFlightSegment[];
}

export interface GoogleFlightOffer {
  price: {
    amount: number;
    currency: CurrencyCode;
    display: string;
  };
  selectionToken: string;
  leg: GoogleFlightLeg;
}

export interface GoogleFlightBookingOption {
  optionId: string;
  seller: string;
  totalPrice: number;
  currency: CurrencyCode;
  bookingUrl?: string;
  bookingLinks?: FlightBookingLink[];
  baggageNotes?: string[];
}

export interface FlightBookingLink {
  seller: string;
  totalPrice: number;
  bookingUrl: string;
}

export interface FlightSegment {
  airlineName: string;
  flightNumber: string;
  departureAirport: string;
  departureTime: string;
  arrivalAirport: string;
  arrivalTime: string;
  durationMinutes: number;
  cabinClass?: string;
}

export interface Layover {
  airport: string;
  durationMinutes: number;
  overnight?: boolean;
}

export interface NormalizedOffer {
  source: string;
  sourceOfferId?: string;
  outboundSegments: FlightSegment[];
  returnSegments: FlightSegment[];
  layovers: Layover[];
  totalDurationMinutes: number;
  stops: number;
  totalPrice: number;
  currency: CurrencyCode;
  baggageNotes?: string[];
  notes?: string[];
  priceIsEstimated?: boolean;
  bookingUrl?: string;
  retrievedAt: string;
  raw?: unknown;
}

export interface PriceInsights {
  lowestPrice?: number;
  priceLevel?: string;
  typicalPriceRange?: [number, number];
}

export interface FlightBookingOption {
  sourceOptionId: string;
  seller: string;
  totalPrice: number;
  currency: CurrencyCode;
  bookingUrl?: string;
  bookingLinks?: FlightBookingLink[];
  baggageNotes?: string[];
}

export interface FlightBookingResult {
  offerId: string;
  bookingOptions: FlightBookingOption[];
  bookingUrl?: string;
  baggageNotes?: string[];
  priceIsEstimated: boolean;
  priceInsights?: PriceInsights;
  searchUrl?: string;
  errors: SourceError[];
}

export interface SourceError {
  source: string;
  code: "auth" | "quota" | "invalid_query" | "unavailable" | "unknown";
  message: string;
}

export interface AccommodationSearchInput {
  destination: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  rooms: number;
  children: number;
  currency: CurrencyCode;
  language: TravelLanguage;
}

export type HotelSearchInput = AccommodationSearchInput;
export type VacationRentalSearchInput = AccommodationSearchInput;

export interface GoogleStayOffer {
  propertyId: string;
  name: string;
  provider: string;
  propertyType: string;
  price: {
    nightlyAmount?: number;
    nightlyDisplay: string;
    totalAmount?: number;
    totalDisplay?: string;
    currency: CurrencyCode;
  };
  rating?: number;
  reviewCount?: number;
  stars?: number;
  coordinates?: { latitude: number; longitude: number };
  amenities?: string[];
  images: string[];
  bookingUrl?: string;
  stay?: { checkIn: string; checkOut: string; nights: number };
}

export type GoogleHotelOffer = GoogleStayOffer;

// FlightScanner `src/adapters/hotel-types.ts` ile aynı public response sözleşmesi.
export interface GuestCounts {
  adults: number;
  children: number;
  childrenAges?: number[];
}

export interface StaySearchQuery {
  location: string;
  checkInDate: string;
  checkOutDate: string;
  guests: GuestCounts;
  propertyType: "hotels" | "vacation_rentals";
  hotelClass?: number[];
  minRating?: 3.5 | 4 | 4.5;
  freeCancellation?: boolean;
  minPricePerNight?: number;
  maxPricePerNight?: number;
  sortBy?: "relevance" | "lowest_price" | "highest_rating" | "most_reviewed";
  currency: CurrencyCode;
  locale?: string;
}

export interface StayOtaPrice {
  seller: string;
  ratePerNight?: number;
}

export interface NormalizedStay {
  source: string;
  sourceStayId?: string;
  name: string;
  propertyType: string;
  hotelClass?: number;
  rating?: number;
  reviewCount?: number;
  locationRating?: number;
  gps?: { latitude: number; longitude: number };
  checkInTime?: string;
  checkOutTime?: string;
  ratePerNight?: number;
  totalPrice?: number;
  currency: CurrencyCode;
  otaPrices?: StayOtaPrice[];
  amenities?: string[];
  images?: string[];
  freeCancellation?: boolean;
  priceIsEstimated?: boolean;
  bookingUrl?: string;
  notes?: string[];
  retrievedAt: string;
  raw?: unknown;
}

export interface SearchResult {
  query: FlightSearchQuery;
  offers: NormalizedOffer[];
  priceInsights?: PriceInsights;
  searchUrl?: string;
  errors: SourceError[];
}

export type FlightSearchResult = SearchResult;

export interface StaySearchResult {
  query: StaySearchQuery;
  stays: NormalizedStay[];
  priceInsights?: PriceInsights;
  searchUrl?: string;
  errors: SourceError[];
}

export type HotelSearchResult = StaySearchResult;

export interface TravelSearch {
  searchFlights(input: FlightSearchInput): Promise<FlightSearchResult>;
  searchFlightReturns(input: FlightOfferSelectionInput): Promise<FlightSearchResult>;
  searchFlightBookings(input: FlightOfferSelectionInput): Promise<FlightBookingResult>;
  searchHotels(input: HotelSearchInput): Promise<StaySearchResult>;
  searchVacationRentals(input: VacationRentalSearchInput): Promise<StaySearchResult>;
  suggestFlightLocations(
    query: string,
    options: { currency: CurrencyCode; language: TravelLanguage },
  ): Promise<FlightLocationSuggestion[]>;
  closeAll(): Promise<void>;
}

export interface FlightLocationLookupRequest {
  queries: string[];
  currency: CurrencyCode;
  language: TravelLanguage;
  timeoutMs: number;
}

export interface FlightLocationLookupResult {
  query: string;
  body: string;
}

export interface TravelRpcRequest {
  sourceUrl: string;
  responseUrlIncludes: string;
  timeoutMs: number;
}

export interface TravelRpcResponse {
  body: string;
  sourceUrl: string;
  responseUrl: string;
  captureContextId: string;
  elapsedMs: number;
}

export interface TravelRpcTransport {
  execute(request: TravelRpcRequest): Promise<TravelRpcResponse>;
  lookupFlightLocations(request: FlightLocationLookupRequest): Promise<FlightLocationLookupResult[]>;
  closeAll(): Promise<void>;
}
