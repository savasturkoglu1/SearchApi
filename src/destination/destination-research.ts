import type {
  SourceError,
  WebPageSearchRequest,
  WebPageSearchResponse,
} from "../travel/travel-search.js";

export interface DestinationResearchInput {
  destination: string;
  interests: string[];
  maxPlaces: number;
  maxArticles: number;
  safeSearch: boolean;
  language: string;
  country: string;
}

export interface DestinationPlace {
  source: "google_maps_browser";
  sourcePlaceId?: string;
  name: string;
  categories: string[];
  address?: string;
  rating?: number;
  reviewCount?: number;
  coordinates?: { latitude: number; longitude: number };
  imageUrl?: string;
  mapUrl: string;
}

export interface DestinationArticle {
  rank: number;
  title: string;
  url: string;
  displayUrl: string;
  description?: string;
  matchedQuery: string;
}

export interface DestinationResearchResult {
  destination: string;
  query: {
    interests: string[];
    language: string;
    country: string;
  };
  places: DestinationPlace[];
  articles: DestinationArticle[];
  searchUrls: {
    places?: string;
    articles: string[];
  };
  retrievedAt: string;
  errors: SourceError[];
}

export interface PlacePageSearchRequest {
  sourceUrl: string;
  limit: number;
  timeoutMs: number;
}

export interface PlacePageSearchResponse {
  places: DestinationPlace[];
  sourceUrl: string;
  captureContextId: string;
  elapsedMs: number;
}

export interface DestinationEvidenceSource {
  searchPlaces(request: PlacePageSearchRequest): Promise<PlacePageSearchResponse>;
  searchWeb(request: WebPageSearchRequest): Promise<WebPageSearchResponse>;
}

export interface DestinationResearch {
  research(input: DestinationResearchInput): Promise<DestinationResearchResult>;
}
