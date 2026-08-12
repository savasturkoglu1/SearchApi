import type {
  DestinationArticle,
  DestinationEvidenceSource,
  DestinationResearch,
  DestinationResearchInput,
  DestinationResearchResult,
} from "./destination-research.js";

interface LocalizedSearchTerms {
  places: string;
  articles: string;
}

const SEARCH_TERMS: Record<string, LocalizedSearchTerms> = {
  tr: { places: "gezilecek yerler", articles: '"gezi rehberi" OR "gezilecek yerler"' },
  de: { places: "Sehenswürdigkeiten", articles: '"Reiseführer" OR "Sehenswürdigkeiten"' },
  fr: { places: "lieux à visiter", articles: '"guide de voyage" OR "lieux à visiter"' },
  en: { places: "tourist attractions", articles: '"travel guide" OR "things to do"' },
};

export class GoogleDestinationResearch implements DestinationResearch {
  constructor(
    private readonly source: DestinationEvidenceSource,
    private readonly timeoutMs: number,
  ) {}

  async research(input: DestinationResearchInput): Promise<DestinationResearchResult> {
    const terms = SEARCH_TERMS[input.language] ?? SEARCH_TERMS.en;
    if (!terms) throw new Error("Destination search terms bulunamadı");
    const interestText = input.interests.length > 0 ? ` ${input.interests.join(" ")}` : "";
    const placeQuery = `${input.destination} ${terms.places}${interestText}`.trim();
    const articleQuery = `${input.destination} (${terms.articles})${interestText}`.trim();
    const errors: DestinationResearchResult["errors"] = [];

    const [placeOutcome, articleOutcome] = await Promise.allSettled([
      this.source.searchPlaces({
        sourceUrl: buildGoogleMapsSearchUrl(placeQuery, input.language, input.country),
        limit: input.maxPlaces,
        timeoutMs: this.timeoutMs,
      }),
      this.source.searchWeb({
        sourceUrl: buildGoogleWebSearchUrl(
          articleQuery,
          input.language,
          input.country,
          input.maxArticles,
          input.safeSearch,
        ),
        limit: input.maxArticles,
        timeoutMs: this.timeoutMs,
      }),
    ]);

    const places = placeOutcome.status === "fulfilled"
      ? dedupePlaces(placeOutcome.value.places).slice(0, input.maxPlaces)
      : [];
    if (placeOutcome.status === "rejected") {
      errors.push(sourceError("google_maps_browser", placeOutcome.reason));
    }

    const articles: DestinationArticle[] = [];
    const articleSearchUrls: string[] = [];
    if (articleOutcome.status === "rejected") {
      errors.push(sourceError("google_web_browser", articleOutcome.reason));
    } else {
      articleSearchUrls.push(articleOutcome.value.sourceUrl);
      for (const result of articleOutcome.value.results) {
        articles.push({
          rank: articles.length + 1,
          title: result.title,
          url: canonicalArticleUrl(result.url),
          displayUrl: result.displayUrl,
          ...(result.description ? { description: result.description } : {}),
          matchedQuery: articleQuery,
        });
      }
    }

    return {
      destination: input.destination,
      query: {
        interests: [...input.interests],
        language: input.language,
        country: input.country,
      },
      places,
      articles: dedupeArticles(articles).slice(0, input.maxArticles),
      searchUrls: {
        ...(placeOutcome.status === "fulfilled"
          ? { places: placeOutcome.value.sourceUrl }
          : {}),
        articles: articleSearchUrls,
      },
      retrievedAt: new Date().toISOString(),
      errors,
    };
  }
}

function buildGoogleMapsSearchUrl(query: string, language: string, country: string): string {
  const url = new URL(`/maps/search/${encodeURIComponent(query)}`, "https://www.google.com");
  url.searchParams.set("hl", language);
  url.searchParams.set("gl", country);
  return url.toString();
}

function buildGoogleWebSearchUrl(
  query: string,
  language: string,
  country: string,
  limit: number,
  safeSearch: boolean,
): string {
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("hl", language);
  url.searchParams.set("gl", country);
  url.searchParams.set("num", String(limit));
  url.searchParams.set("safe", safeSearch ? "active" : "off");
  url.searchParams.set("filter", "1");
  url.searchParams.set("pws", "0");
  return url.toString();
}

function canonicalArticleUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLocaleLowerCase("en-US").startsWith("utm_") || key === "gclid") {
        url.searchParams.delete(key);
      }
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}

function dedupeArticles(articles: DestinationArticle[]): DestinationArticle[] {
  const seen = new Set<string>();
  const unique: DestinationArticle[] = [];
  for (const article of articles) {
    const key = canonicalArticleUrl(article.url);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ ...article, rank: unique.length + 1, url: key });
  }
  return unique;
}

function dedupePlaces<T extends { name: string; mapUrl: string }>(places: T[]): T[] {
  const seen = new Set<string>();
  return places.filter((place) => {
    const key = `${place.name.trim().toLocaleLowerCase("en-US")}|${place.mapUrl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceError(source: string, error: unknown): DestinationResearchResult["errors"][number] {
  return {
    source,
    code: "unavailable",
    message: error instanceof Error ? error.message : "Kaynak kullanılamıyor",
  };
}
