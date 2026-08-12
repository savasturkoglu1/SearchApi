import { randomUUID } from "node:crypto";
import type { BrowserContext, Page, Response } from "playwright";

import { ExternalSearchError } from "../errors.js";
import type { ApiCaptureManager, CaptureController } from "../managers/api-capture.manager.js";
import type { BrowserPageProvider } from "../managers/browser.manager.js";
import type {
  DestinationPlace,
  PlacePageSearchRequest,
  PlacePageSearchResponse,
} from "../destination/destination-research.js";
import type {
  FlightLocationLookupRequest,
  FlightLocationLookupResult,
  InPageRpcRecipe,
  TravelRpcRequest,
  TravelRpcResponse,
  TravelRpcTransport,
  WebPageSearchRequest,
  WebPageSearchResponse,
  WebSearchItem,
} from "./travel-search.js";

interface RpcBrowserSession {
  contextId: string;
  page: Page;
  capture: CaptureController;
  bootstrapUrl: string;
  bootstrappedAt: number;
}

const RPC_SESSION_TTL_MS = 30 * 60_000;
const DIRECT_RPC_COOLDOWN_MS = 5 * 60_000;
const BLOCKED_RESOURCE_TYPES = new Set(["font", "image", "media"]);
const MAP_ACTION_WORDS = [
  "kapalı", "açık", "yol tarifi", "web sitesi", "telefon", "ziyaret edildi", "sponsorlu",
  "closed", "open", "directions", "website", "phone", "visited", "sponsored",
  "geschlossen", "geöffnet", "route", "webseite", "besucht", "gesponsert",
  "fermé", "ouvert", "itinéraire", "site web", "téléphone", "visité", "sponsorisé",
];
const MAP_HOURS_WORDS = [
  "kapalı", "açıl", "24 saat",
  "closed", "opens", "open 24 hours",
  "geschlossen", "öffnet", "24 stunden",
  "fermé", "ouvre", "24 heures",
];

export class BrowserRpcTransport implements TravelRpcTransport {
  private readonly activePages = new Set<Page>();
  private readonly rpcSessions = new Map<InPageRpcRecipe["sessionKey"], RpcBrowserSession>();
  private readonly directDisabledUntil = new Map<InPageRpcRecipe["sessionKey"], number>();
  private webSearchSession: {
    contextId: string;
    page: Page;
    capture: CaptureController;
  } | undefined;
  private placesSearchSession: {
    contextId: string;
    page: Page;
    capture: CaptureController;
  } | undefined;
  private persistentCapture: {
    context: BrowserContext;
    controller: CaptureController;
  } | undefined;
  private webSearchQueue: Promise<void> = Promise.resolve();
  private placesSearchQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly browserManager: BrowserPageProvider,
    private readonly captureManager: ApiCaptureManager,
  ) {}

  async searchWeb(request: WebPageSearchRequest): Promise<WebPageSearchResponse> {
    const operation = this.webSearchQueue.then(() => this.executeWebSearch(request));
    this.webSearchQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async searchPlaces(request: PlacePageSearchRequest): Promise<PlacePageSearchResponse> {
    const operation = this.placesSearchQueue.then(() => this.executePlaceSearch(request));
    this.placesSearchQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async executePlaceSearch(
    request: PlacePageSearchRequest,
  ): Promise<PlacePageSearchResponse> {
    const startedAt = Date.now();
    const session = await this.requirePlacesSearchSession();
    const { contextId, page } = session;

    try {
      await page.goto(request.sourceUrl, {
        waitUntil: "domcontentloaded",
        timeout: request.timeoutMs,
      });
      if (await isGoogleBlocked(page)) {
        throw new ExternalSearchError("Google Maps araması CAPTCHA veya trafik doğrulamasına takıldı");
      }
      await page.waitForSelector('a[href*="/maps/place/"], div[role="feed"]', {
        state: "attached",
        timeout: Math.min(request.timeoutMs, 20_000),
      });
      await loadMoreMapResults(page, request.limit);
      const places = await extractMapPlaces(page, request.limit);
      return {
        places,
        sourceUrl: page.url(),
        captureContextId: contextId,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (error instanceof ExternalSearchError) throw error;
      throw new ExternalSearchError(
        error instanceof Error
          ? `Google Maps araması başarısız: ${error.message}`
          : "Google Maps araması başarısız",
      );
    }
  }

  private async executeWebSearch(request: WebPageSearchRequest): Promise<WebPageSearchResponse> {
    const startedAt = Date.now();
    const session = await this.requireWebSearchSession();
    const { contextId, page } = session;

    try {
      await page.goto(request.sourceUrl, {
        waitUntil: "domcontentloaded",
        timeout: request.timeoutMs,
      });
      const blocked = await page.evaluate(() => {
        const text = document.body?.innerText.toLocaleLowerCase("tr") ?? "";
        return location.pathname.startsWith("/sorry/") ||
          text.includes("unusual traffic") ||
          text.includes("olağandışı trafik");
      });
      if (blocked) {
        throw new ExternalSearchError("Google web araması CAPTCHA veya trafik doğrulamasına takıldı");
      }
      await page.waitForSelector("#search", {
        state: "attached",
        timeout: Math.min(request.timeoutMs, 20_000),
      });
      const results = await extractOrganicResults(page, request.limit);
      return {
        results,
        sourceUrl: page.url(),
        captureContextId: contextId,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (error instanceof ExternalSearchError) throw error;
      throw new ExternalSearchError(
        error instanceof Error
          ? `Google web araması başarısız: ${error.message}`
          : "Google web araması başarısız",
      );
    }
  }

  private async requireWebSearchSession(): Promise<{
    contextId: string;
    page: Page;
    capture: CaptureController;
  }> {
    if (this.webSearchSession && !this.webSearchSession.page.isClosed()) {
      return this.webSearchSession;
    }
    if (this.webSearchSession) await this.closeWebSearchSession();

    const contextId = randomUUID();
    await this.browserManager.start();
    const page = await this.browserManager.newPage(contextId);
    this.activePages.add(page);
    try {
      const capture = await this.attachCapture(contextId, page);
      this.webSearchSession = { contextId: capture.contextId, page, capture };
      return this.webSearchSession;
    } catch (error) {
      this.activePages.delete(page);
      await this.browserManager.closePage(page).catch(() => undefined);
      throw error;
    }
  }

  private async closeWebSearchSession(): Promise<void> {
    const session = this.webSearchSession;
    this.webSearchSession = undefined;
    if (!session) return;
    await session.capture.stop().catch(() => undefined);
    this.activePages.delete(session.page);
    await this.browserManager.closePage(session.page).catch(() => undefined);
  }

  private async requirePlacesSearchSession(): Promise<{
    contextId: string;
    page: Page;
    capture: CaptureController;
  }> {
    if (this.placesSearchSession && !this.placesSearchSession.page.isClosed()) {
      return this.placesSearchSession;
    }
    if (this.placesSearchSession) await this.closePlacesSearchSession();

    const contextId = randomUUID();
    await this.browserManager.start();
    const page = await this.browserManager.newPage(contextId);
    this.activePages.add(page);
    try {
      const capture = await this.attachCapture(contextId, page);
      this.placesSearchSession = { contextId: capture.contextId, page, capture };
      return this.placesSearchSession;
    } catch (error) {
      this.activePages.delete(page);
      await this.browserManager.closePage(page).catch(() => undefined);
      throw error;
    }
  }

  private async closePlacesSearchSession(): Promise<void> {
    const session = this.placesSearchSession;
    this.placesSearchSession = undefined;
    if (!session) return;
    await session.capture.stop().catch(() => undefined);
    this.activePages.delete(session.page);
    await this.browserManager.closePage(session.page).catch(() => undefined);
  }

  async execute(request: TravelRpcRequest): Promise<TravelRpcResponse> {
    if (!request.inPage) return this.executeNavigation(request);
    // Flights Shopping/Booking RPC'leri sayfanın ürettiği kısa ömürlü opaque
    // context'i taşır. Elle kurulan f.req HTTP 200 içinde Google [13] hata
    // frame'i döndürür; navigation sayfanın geçerli RPC'yi üretmesini sağlar.
    if (request.inPage.sessionKey === "flights") {
      return this.executeSessionNavigation(request, request.inPage);
    }
    const directDisabledUntil = this.directDisabledUntil.get(request.inPage.sessionKey) ?? 0;
    if (directDisabledUntil > Date.now()) {
      return this.executeSessionNavigation(request, request.inPage);
    }

    let inPageError: unknown;
    try {
      const response = await this.executeInPage(request, request.inPage);
      this.directDisabledUntil.delete(request.inPage.sessionKey);
      return response;
    } catch (error) {
      inPageError = error;
      this.directDisabledUntil.set(
        request.inPage.sessionKey,
        Date.now() + DIRECT_RPC_COOLDOWN_MS,
      );
    }

    try {
      return await this.executeSessionNavigation(request, request.inPage);
    } catch (navigationError) {
      const inPageMessage = errorMessage(inPageError);
      const navigationMessage = errorMessage(navigationError);
      throw new ExternalSearchError(
        `Browser-backed RPC ve navigation fallback başarısız: ${inPageMessage}; ${navigationMessage}`,
      );
    }
  }

  private async executeInPage(
    request: TravelRpcRequest,
    recipe: InPageRpcRecipe,
  ): Promise<TravelRpcResponse> {
    const startedAt = Date.now();
    return this.withRpcSession(recipe.sessionKey, recipe.bootstrapUrl, async (session) => {
      const response = await session.page.evaluate(
        async ({ endpointPath, query, headers, body, timeoutMs }) => {
          const globalData = (globalThis as typeof globalThis & {
            WIZ_global_data?: Record<string, unknown>;
          }).WIZ_global_data;
          const url = new URL(endpointPath, location.origin);
          for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
          url.searchParams.set(
            "_reqid",
            String(Math.floor(Math.random() * 900_000) + 100_000),
          );
          if (!url.searchParams.has("f.sid") && typeof globalData?.FdrFJe === "string") {
            url.searchParams.set("f.sid", globalData.FdrFJe);
          }
          if (!url.searchParams.has("bl") && typeof globalData?.cfb2h === "string") {
            url.searchParams.set("bl", globalData.cfb2h);
          }

          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const response = await fetch(url, {
              method: "POST",
              credentials: "include",
              headers,
              body,
              signal: controller.signal,
            });
            const responseBody = await response.text();
            return {
              status: response.status,
              url: response.url,
              contentType: response.headers.get("content-type") ?? "",
              body: responseBody,
            };
          } finally {
            clearTimeout(timer);
          }
        },
        {
          endpointPath: recipe.endpointPath,
          query: recipe.query,
          headers: recipe.headers,
          body: recipe.body,
          timeoutMs: request.timeoutMs,
        },
      );

      const normalizedBody = response.body.trimStart().toLocaleLowerCase("en-US");
      if (
        response.status < 200 ||
        response.status >= 300 ||
        response.contentType.includes("text/html") ||
        normalizedBody.startsWith("<!doctype html") ||
        normalizedBody.includes("unusual traffic") ||
        normalizedBody.includes("olağandışı trafik") ||
        response.body.length < recipe.minimumResponseBytes
      ) {
        throw new ExternalSearchError(
          `In-page Google RPC geçersiz cevap döndürdü: HTTP ${response.status}`,
        );
      }
      if (!response.body) {
        throw new ExternalSearchError("In-page Google RPC boş cevap döndürdü");
      }

      return {
        body: response.body,
        sourceUrl: request.sourceUrl,
        responseUrl: response.url,
        captureContextId: session.contextId,
        elapsedMs: Date.now() - startedAt,
      };
    });
  }

  private async executeNavigation(request: TravelRpcRequest): Promise<TravelRpcResponse> {
    const startedAt = Date.now();
    const contextId = randomUUID();
    await this.browserManager.start();
    const page = await this.browserManager.newPage(contextId);
    this.activePages.add(page);
    let capture: CaptureController | undefined;

    try {
      capture = await this.attachCapture(contextId, page);
      const responsePromise = page.waitForResponse(
        (response) => response.url().includes(request.responseUrlIncludes),
        { timeout: request.timeoutMs },
      );
      await page.goto(request.sourceUrl, {
        waitUntil: "domcontentloaded",
        timeout: request.timeoutMs,
      });
      const response = await responsePromise;
      const body = await readCompletedBody(response);
      return {
        body,
        sourceUrl: page.url(),
        responseUrl: response.url(),
        captureContextId: capture.contextId,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (error instanceof ExternalSearchError) throw error;
      throw new ExternalSearchError(
        error instanceof Error ? `Browser araması başarısız: ${error.message}` : "Browser araması başarısız",
      );
    } finally {
      if (capture) await capture.stop().catch(() => undefined);
      this.activePages.delete(page);
      await this.browserManager.closePage(page).catch(() => undefined);
    }
  }

  private async executeSessionNavigation(
    request: TravelRpcRequest,
    recipe: InPageRpcRecipe,
  ): Promise<TravelRpcResponse> {
    const startedAt = Date.now();
    try {
      return await this.withRpcSession(recipe.sessionKey, recipe.bootstrapUrl, async (session) => {
        const responsePromise = session.page.waitForResponse(
          (response) =>
            response.url().includes(request.responseUrlIncludes) ||
            isGoogleBlockResponse(response),
          { timeout: Math.min(request.timeoutMs, 30_000) },
        );
        await session.page.goto(request.sourceUrl, {
          waitUntil: "domcontentloaded",
          timeout: request.timeoutMs,
        });
        const response = await responsePromise;
        if (isGoogleBlockResponse(response) || await isGoogleBlocked(session.page)) {
          throw new ExternalSearchError(
            "Google navigation CAPTCHA veya trafik doğrulamasına takıldı",
          );
        }
        const body = await readCompletedBody(response);
        return {
          body,
          sourceUrl: session.page.url(),
          responseUrl: response.url(),
          captureContextId: session.contextId,
          elapsedMs: Date.now() - startedAt,
        };
      }, recipe.sessionKey === "flights" ? 1 : 2);
    } catch (error) {
      if (error instanceof ExternalSearchError) throw error;
      throw new ExternalSearchError(
        `Google navigation RPC başarısız: ${errorMessage(error)}`,
      );
    }
  }

  async lookupFlightLocations(
    request: FlightLocationLookupRequest,
  ): Promise<FlightLocationLookupResult[]> {
    try {
      const landingUrl = new URL("https://www.google.com/travel/flights");
      landingUrl.searchParams.set("hl", request.language);
      landingUrl.searchParams.set("gl", request.country);
      landingUrl.searchParams.set("curr", request.currency);
      return await this.withRpcSession("flights", landingUrl.toString(), async (session) => {
        const results: FlightLocationLookupResult[] = [];
        for (const query of request.queries) {
          const body = await session.page.evaluate(
            async ({ query, language, country, currency, timeoutMs }) => {
              const globalData = (globalThis as typeof globalThis & {
                WIZ_global_data?: Record<string, unknown>;
              }).WIZ_global_data;
              const url = new URL("/_/FlightsFrontendUi/data/batchexecute", location.origin);
              url.searchParams.set("rpcids", "H028ib");
              url.searchParams.set("source-path", "/travel/flights");
              url.searchParams.set("hl", language);
              url.searchParams.set("soc-app", "162");
              url.searchParams.set("soc-platform", "1");
              url.searchParams.set("soc-device", "1");
              url.searchParams.set(
                "_reqid",
                String(Math.floor(Math.random() * 900_000) + 100_000),
              );
              url.searchParams.set("rt", "c");
              if (typeof globalData?.FdrFJe === "string") {
                url.searchParams.set("f.sid", globalData.FdrFJe);
              }
              if (typeof globalData?.cfb2h === "string") {
                url.searchParams.set("bl", globalData.cfb2h);
              }

              const inner = JSON.stringify([query, [1, 2, 3, 5, 4], null, [1, 1, 1], 1]);
              const rpc = JSON.stringify([[["H028ib", inner, null, "generic"]]]);
              const form = new URLSearchParams({ "f.req": rpc });
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), timeoutMs);
              try {
                const response = await fetch(url, {
                  method: "POST",
                  credentials: "include",
                  headers: {
                    "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
                    "x-same-domain": "1",
                    "x-goog-ext-259736195-jspb": JSON.stringify([
                      language,
                      country,
                      currency,
                      1,
                      null,
                      [-180],
                      null,
                      null,
                      1,
                      [],
                    ]),
                  },
                  body: form.toString(),
                  signal: controller.signal,
                });
                if (!response.ok) throw new Error(`Suggestion HTTP ${response.status}`);
                return response.text();
              } finally {
                clearTimeout(timer);
              }
            },
            {
              query,
              language: request.language,
              country: request.country,
              currency: request.currency,
              timeoutMs: request.timeoutMs,
            },
          );
          results.push({ query, body });
        }
        return results;
      });
    } catch (error) {
      throw new ExternalSearchError(
        error instanceof Error
          ? `Google Flights lokasyon araması başarısız: ${error.message}`
          : "Google Flights lokasyon araması başarısız",
      );
    }
  }

  private async withRpcSession<T>(
    sessionKey: InPageRpcRecipe["sessionKey"],
    bootstrapUrl: string,
    operation: (session: RpcBrowserSession) => Promise<T>,
    attempts = 2,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await this.closeRpcSession(sessionKey);
      try {
        const session = await this.requireRpcSession(sessionKey, bootstrapUrl);
        return await operation(session);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  private async requireRpcSession(
    sessionKey: InPageRpcRecipe["sessionKey"],
    bootstrapUrl: string,
  ): Promise<RpcBrowserSession> {
    const existing = this.rpcSessions.get(sessionKey);
    if (
      existing &&
      !existing.page.isClosed() &&
      existing.bootstrapUrl === bootstrapUrl &&
      existing.bootstrappedAt >= Date.now() - RPC_SESSION_TTL_MS
    ) {
      return existing;
    }
    if (existing) await this.closeRpcSession(sessionKey);

    const contextId = `rpc-${sessionKey}-${randomUUID()}`;
    await this.browserManager.start();
    const page = await this.browserManager.newPage(contextId);
    this.activePages.add(page);
    let capture: CaptureController | undefined;
    try {
      await page.route("**/*", async (route) => {
        if (BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) {
          await route.abort();
          return;
        }
        await route.continue();
      });
      capture = await this.attachCapture(contextId, page);
      await page.goto(bootstrapUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      if (await isGoogleBlocked(page)) {
        throw new ExternalSearchError("Google RPC bootstrap CAPTCHA veya trafik doğrulamasına takıldı");
      }
      const session = {
        contextId: capture.contextId,
        page,
        capture,
        bootstrapUrl,
        bootstrappedAt: Date.now(),
      };
      this.rpcSessions.set(sessionKey, session);
      return session;
    } catch (error) {
      if (capture) await capture.stop().catch(() => undefined);
      this.activePages.delete(page);
      await this.browserManager.closePage(page).catch(() => undefined);
      throw error;
    }
  }

  private async closeRpcSession(sessionKey: InPageRpcRecipe["sessionKey"]): Promise<void> {
    const session = this.rpcSessions.get(sessionKey);
    this.rpcSessions.delete(sessionKey);
    if (!session) return;
    await session.capture.stop().catch(() => undefined);
    this.activePages.delete(session.page);
    await this.browserManager.closePage(session.page).catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([this.webSearchQueue, this.placesSearchQueue]);
    await this.closeWebSearchSession();
    await this.closePlacesSearchSession();
    await Promise.all([...this.rpcSessions.keys()].map((key) => this.closeRpcSession(key)));
    await this.stopPersistentCapture();
    this.directDisabledUntil.clear();
    await Promise.allSettled(
      [...this.activePages].map((page) => this.browserManager.closePage(page)),
    );
    this.activePages.clear();
  }

  private async attachCapture(contextId: string, page: Page): Promise<CaptureController> {
    if (this.browserManager.status().sessionMode !== "persistent") {
      return this.captureManager.attach(contextId, page.context());
    }

    const context = page.context();
    if (this.persistentCapture && this.persistentCapture.context !== context) {
      await this.stopPersistentCapture();
    }
    if (!this.persistentCapture) {
      this.persistentCapture = {
        context,
        controller: await this.captureManager.attach(contextId, context),
      };
    }

    const controller = this.persistentCapture.controller;
    return {
      contextId: controller.contextId,
      directory: controller.directory,
      summary: () => controller.summary(),
      // Persistent browser'daki web/flights/stays sayfaları aynı context'i
      // paylaşır. Tek bir sayfa kapanınca ortak capture listener'ı durmamalı.
      stop: async () => controller.summary(),
    };
  }

  private async stopPersistentCapture(): Promise<void> {
    const capture = this.persistentCapture;
    this.persistentCapture = undefined;
    if (capture) await capture.controller.stop().catch(() => undefined);
  }
}

async function loadMoreMapResults(page: Page, limit: number): Promise<void> {
  await page.evaluate(async ({ requestedLimit }) => {
    const feed = document.querySelector<HTMLElement>('div[role="feed"]');
    if (!feed) return;
    let previousCount = document.querySelectorAll('a[href*="/maps/place/"]').length;
    for (let attempt = 0; attempt < 4 && previousCount < requestedLimit; attempt += 1) {
      feed.scrollTo({ top: feed.scrollHeight, behavior: "auto" });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const nextCount = document.querySelectorAll('a[href*="/maps/place/"]').length;
      if (nextCount === previousCount) break;
      previousCount = nextCount;
    }
  }, { requestedLimit: limit });
}

async function extractMapPlaces(page: Page, limit: number): Promise<DestinationPlace[]> {
  const candidates = await page.evaluate(() => {
    const results: Array<{
      name: string;
      detailLines: string[];
      ratingText?: string;
      reviewText?: string;
      imageUrl?: string;
      mapUrl: string;
    }> = [];
    const links = document.querySelectorAll<HTMLAnchorElement>(
      'a.hfpxzc[href*="/maps/place/"], a[href*="/maps/place/"][aria-label]',
    );
    for (const link of links) {
      const card = link.closest<HTMLElement>(".Nv2PK, [role='article']") ?? link.parentElement;
      const name = link.getAttribute("aria-label")?.trim() ||
        card?.querySelector<HTMLElement>(".qBF1Pd, .fontHeadlineSmall")?.innerText.trim();
      if (!name) continue;

      const mapUrl = link.href;
      const ratingText = card?.querySelector<HTMLElement>(".MW4etd")?.innerText.trim();
      const reviewText = card?.querySelector<HTMLElement>(".UY7F9")?.innerText.trim();
      const detailLines = (card?.innerText ?? "")
        .split("\n")
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      const imageUrl = card?.querySelector<HTMLImageElement>("img[src]")?.src;

      results.push({
        name,
        detailLines,
        ...(ratingText ? { ratingText } : {}),
        ...(reviewText ? { reviewText } : {}),
        ...(imageUrl ? { imageUrl } : {}),
        mapUrl,
      });
    }
    return results;
  });

  const seen = new Set<string>();
  const places: DestinationPlace[] = [];
  for (const candidate of candidates) {
    const sourcePlaceId = sourcePlaceIdFromMapUrl(candidate.mapUrl);
    const key = sourcePlaceId ?? candidate.mapUrl ?? candidate.name.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    const rating = localizedNumber(candidate.ratingText);
    const reviewCount = integerFromText(candidate.reviewText);
    const coordinates = coordinatesFromMapUrl(candidate.mapUrl);
    const categories = categoriesFromMapDetails(candidate.name, candidate.detailLines);
    const address = addressFromMapDetails(candidate.name, candidate.detailLines);
    const {
      ratingText: _ratingText,
      reviewText: _reviewText,
      detailLines: _detailLines,
      ...place
    } = candidate;
    places.push({
      source: "google_maps_browser",
      ...place,
      categories,
      ...(address ? { address } : {}),
      ...(sourcePlaceId ? { sourcePlaceId } : {}),
      ...(rating !== undefined ? { rating } : {}),
      ...(reviewCount !== undefined ? { reviewCount } : {}),
      ...(coordinates ? { coordinates } : {}),
    });
    if (places.length >= limit) break;
  }
  return places;
}

function localizedNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.replace(/\s/g, "").replace(",", ".").match(/\d+(?:\.\d+)?/)?.[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function integerFromText(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const digits = value.replace(/[^\d]/g, "");
  const parsed = Number(digits);
  return digits && Number.isFinite(parsed) ? parsed : undefined;
}

function categoriesFromMapDetails(name: string, lines: string[]): string[] {
  const category = lines.find((line) => {
    const normalized = line.toLocaleLowerCase("en-US");
    return line !== name &&
      line.length >= 3 &&
      line.length <= 80 &&
      !/\d/.test(line) &&
      !/[★$€£₺]/.test(line) &&
      !MAP_ACTION_WORDS.some((word) => normalized.includes(word));
  });
  return category ? [category.replace(/^·\s*/, "")] : [];
}

function addressFromMapDetails(name: string, lines: string[]): string | undefined {
  return lines.find((line) => {
    const normalized = line.toLocaleLowerCase("en-US");
    return line !== name &&
      line.length >= 4 &&
      line.length <= 120 &&
      /\d/.test(line) &&
      !/^\(?[\d.,]+\)?$/.test(line) &&
      !/^\d(?:[.,]\d)?\s*\([\d.,]+\)/.test(line) &&
      !/^\d{1,2}:\d{2}/.test(line) &&
      !/[★]/.test(line) &&
      !normalized.includes("yorum") &&
      !normalized.includes("review") &&
      !normalized.includes("bewertung") &&
      !normalized.includes("avis") &&
      !MAP_HOURS_WORDS.some((word) => normalized.includes(word));
  });
}

function coordinatesFromMapUrl(
  value: string,
): { latitude: number; longitude: number } | undefined {
  const dataMatch = value.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  const atMatch = value.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  const match = dataMatch ?? atMatch;
  if (!match?.[1] || !match[2]) return undefined;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    ? { latitude, longitude }
    : undefined;
}

function sourcePlaceIdFromMapUrl(value: string): string | undefined {
  const match = value.match(/!1s([^!]+)/);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

async function extractOrganicResults(page: Page, limit: number): Promise<WebSearchItem[]> {
  const candidates = await page.evaluate(() => {
    const extracted: Array<{
      title: string;
      url: string;
      displayUrl: string;
      description?: string;
    }> = [];
    for (const heading of document.querySelectorAll<HTMLHeadingElement>("#search h3")) {
      if (heading.closest("#tads, #tadsb, [data-text-ad]")) continue;
      const anchor = heading.closest<HTMLAnchorElement>("a");
      const title = heading.textContent?.trim();
      if (!anchor || !title) continue;

      let url: string | undefined;
      try {
        const parsed = new URL(anchor.href, location.origin);
        if (parsed.hostname.endsWith("google.com") && parsed.pathname === "/url") {
          const target = parsed.searchParams.get("q") ?? parsed.searchParams.get("url");
          if (target) url = new URL(target).toString();
        } else if (
          (parsed.protocol === "http:" || parsed.protocol === "https:") &&
          !(
            parsed.hostname.endsWith("google.com") &&
            ["/search", "/preferences", "/advanced_search"].includes(parsed.pathname)
          )
        ) {
          url = parsed.toString();
        }
      } catch {
        url = undefined;
      }
      if (!url) continue;

      const container = heading.closest<HTMLElement>(".MjjYud") ??
        heading.closest<HTMLElement>(".g") ??
        heading.closest<HTMLElement>("[data-hveid]") ??
        anchor?.parentElement?.parentElement;
      const description = container
        ?.querySelector<HTMLElement>(".VwiC3b, [data-sncf='1'], .IsZvec")
        ?.innerText.trim();
      const displayed = container?.querySelector<HTMLElement>("cite")?.innerText.trim();
      extracted.push({
        title,
        url,
        displayUrl: displayed || new URL(url).hostname,
        ...(description ? { description } : {}),
      });
    }
    return extracted;
  });

  const seen = new Set<string>();
  const results: WebSearchItem[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    results.push({ rank: results.length + 1, ...candidate });
    if (results.length >= limit) break;
  }
  return results;
}

async function readCompletedBody(response: Response): Promise<string> {
  const error = await response.finished();
  if (error) throw new ExternalSearchError(`Google response tamamlanamadı: ${error.message}`);
  try {
    return await response.text();
  } catch (error) {
    throw new ExternalSearchError(
      error instanceof Error ? `Google response body okunamadı: ${error.message}` : "Google response body okunamadı",
    );
  }
}

function isGoogleBlockResponse(response: Response): boolean {
  if (response.status() === 429) return true;
  try {
    return new URL(response.url()).pathname.startsWith("/sorry/");
  } catch {
    return false;
  }
}

async function isGoogleBlocked(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const text = document.body?.innerText.toLocaleLowerCase("tr") ?? "";
    return location.pathname.startsWith("/sorry/") ||
      text.includes("unusual traffic") ||
      text.includes("olağandışı trafik");
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "bilinmeyen hata";
}
