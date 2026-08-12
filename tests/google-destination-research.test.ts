import assert from "node:assert/strict";
import test from "node:test";

import { GoogleDestinationResearch } from "../src/destination/google-destination.research.js";
import type {
  DestinationEvidenceSource,
  PlacePageSearchRequest,
  PlacePageSearchResponse,
} from "../src/destination/destination-research.js";
import type {
  WebPageSearchRequest,
  WebPageSearchResponse,
} from "../src/travel/travel-search.js";

class FakeEvidenceSource implements DestinationEvidenceSource {
  placeRequests: PlacePageSearchRequest[] = [];
  webRequests: WebPageSearchRequest[] = [];

  async searchPlaces(request: PlacePageSearchRequest): Promise<PlacePageSearchResponse> {
    this.placeRequests.push(request);
    return {
      places: [
        {
          source: "google_maps_browser",
          name: "Van Gogh Museum",
          categories: ["Müze"],
          rating: 4.6,
          reviewCount: 92_000,
          mapUrl: "https://www.google.com/maps/place/Van+Gogh+Museum",
        },
      ],
      sourceUrl: request.sourceUrl,
      captureContextId: "places-context",
      elapsedMs: 25,
    };
  }

  async searchWeb(request: WebPageSearchRequest): Promise<WebPageSearchResponse> {
    this.webRequests.push(request);
    return {
      results: [
        {
          rank: 1,
          title: "Amsterdam Gezi Rehberi",
          url: "https://travel.example/amsterdam?utm_source=google",
          displayUrl: "travel.example",
          description: "Amsterdam'da gezilecek yerler",
        },
        {
          rank: 2,
          title: "Amsterdam Gezi Rehberi",
          url: "https://travel.example/amsterdam#muzeler",
          displayUrl: "travel.example",
        },
      ],
      sourceUrl: request.sourceUrl,
      captureContextId: "web-context",
      elapsedMs: 20,
    };
  }
}

test("gezilecek yerleri ve Google gezi yazılarını tek kaynaklı pakette birleştirir", async () => {
  const source = new FakeEvidenceSource();
  const research = new GoogleDestinationResearch(source, 30_000);

  const result = await research.research({
    destination: "Amsterdam",
    interests: ["müzeler", "yerel yemek"],
    maxPlaces: 8,
    maxArticles: 6,
    safeSearch: true,
    language: "tr",
    country: "TR",
  });

  assert.equal(result.destination, "Amsterdam");
  assert.equal(result.places.length, 1);
  assert.equal(result.places[0]?.name, "Van Gogh Museum");
  assert.equal(result.articles.length, 1, "aynı canonical URL yalnız bir kez dönmeli");
  assert.equal(result.articles[0]?.url, "https://travel.example/amsterdam");
  assert.match(result.articles[0]?.matchedQuery ?? "", /Amsterdam/);
  assert.equal(result.errors.length, 0);
  assert.equal(source.placeRequests.length, 1);
  assert.match(source.placeRequests[0]?.sourceUrl ?? "", /google\.com\/maps\/search/);
  assert.equal(source.webRequests.length, 1, "gezi rehberi ve gezilecek yerler tek SERP'te aranmalı");
  assert.match(source.webRequests[0]?.sourceUrl ?? "", /OR/);
  assert.ok(source.webRequests.every((request) => request.limit === 6));
});

test("Maps kaynağı başarısız olsa da gezi yazılarını kısmi sonuç olarak döndürür", async () => {
  const source = new FakeEvidenceSource();
  source.searchPlaces = async () => {
    throw new Error("Maps geçici olarak kullanılamıyor");
  };
  const research = new GoogleDestinationResearch(source, 30_000);

  const result = await research.research({
    destination: "Berlin",
    interests: [],
    maxPlaces: 5,
    maxArticles: 5,
    safeSearch: true,
    language: "de",
    country: "DE",
  });

  assert.equal(result.places.length, 0);
  assert.equal(result.articles.length, 1);
  assert.equal(result.errors[0]?.source, "google_maps_browser");
});
