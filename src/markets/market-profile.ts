export const MARKET_PROFILE_IDS = [
  "TR-IST",
  "DE-FRA",
  "FR-PAR",
  "GB-LON",
  "US-NYC",
  "US-SFO",
] as const;

export type MarketProfileId = (typeof MARKET_PROFILE_IDS)[number];

export interface MarketProfile {
  id: MarketProfileId;
  locale: string;
  timezoneId: string;
  language: string;
  country: string;
  currency: string;
  geolocation: {
    latitude: number;
    longitude: number;
    accuracy: number;
  };
}

export const MARKET_PROFILES: Readonly<Record<MarketProfileId, MarketProfile>> = {
  "TR-IST": {
    id: "TR-IST",
    locale: "tr-TR",
    timezoneId: "Europe/Istanbul",
    language: "tr",
    country: "TR",
    currency: "TRY",
    geolocation: { latitude: 41.0082, longitude: 28.9784, accuracy: 50 },
  },
  "DE-FRA": {
    id: "DE-FRA",
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    language: "de",
    country: "DE",
    currency: "EUR",
    geolocation: { latitude: 50.1109, longitude: 8.6821, accuracy: 50 },
  },
  "FR-PAR": {
    id: "FR-PAR",
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
    language: "fr",
    country: "FR",
    currency: "EUR",
    geolocation: { latitude: 48.8566, longitude: 2.3522, accuracy: 50 },
  },
  "GB-LON": {
    id: "GB-LON",
    locale: "en-GB",
    timezoneId: "Europe/London",
    language: "en",
    country: "GB",
    currency: "GBP",
    geolocation: { latitude: 51.5074, longitude: -0.1278, accuracy: 50 },
  },
  "US-NYC": {
    id: "US-NYC",
    locale: "en-US",
    timezoneId: "America/New_York",
    language: "en",
    country: "US",
    currency: "USD",
    geolocation: { latitude: 40.7128, longitude: -74.006, accuracy: 50 },
  },
  "US-SFO": {
    id: "US-SFO",
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    language: "en",
    country: "US",
    currency: "USD",
    geolocation: { latitude: 37.7749, longitude: -122.4194, accuracy: 50 },
  },
};

export const DEFAULT_MARKET_PROFILES = MARKET_PROFILE_IDS.map(
  (id) => MARKET_PROFILES[id],
);
