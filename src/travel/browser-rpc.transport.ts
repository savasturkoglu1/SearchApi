import { randomUUID } from "node:crypto";
import type { Page, Response } from "playwright";

import { ExternalSearchError } from "../errors.js";
import type { ApiCaptureManager, CaptureController } from "../managers/api-capture.manager.js";
import type { BrowserPageProvider } from "../managers/browser.manager.js";
import type {
  FlightLocationLookupRequest,
  FlightLocationLookupResult,
  TravelRpcRequest,
  TravelRpcResponse,
  TravelRpcTransport,
} from "./travel-search.js";

export class BrowserRpcTransport implements TravelRpcTransport {
  private readonly activePages = new Set<Page>();

  constructor(
    private readonly browserManager: BrowserPageProvider,
    private readonly captureManager: ApiCaptureManager,
  ) {}

  async execute(request: TravelRpcRequest): Promise<TravelRpcResponse> {
    const startedAt = Date.now();
    const contextId = randomUUID();
    await this.browserManager.start();
    const page = await this.browserManager.newPage(contextId);
    this.activePages.add(page);
    let capture: CaptureController | undefined;

    try {
      capture = await this.captureManager.attach(contextId, page.context());
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
        captureContextId: contextId,
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

  async lookupFlightLocations(
    request: FlightLocationLookupRequest,
  ): Promise<FlightLocationLookupResult[]> {
    const contextId = randomUUID();
    await this.browserManager.start();
    const page = await this.browserManager.newPage(contextId);
    this.activePages.add(page);
    let capture: CaptureController | undefined;

    try {
      capture = await this.captureManager.attach(contextId, page.context());
      const landingUrl = new URL("https://www.google.com/travel/flights");
      landingUrl.searchParams.set("hl", request.language);
      landingUrl.searchParams.set("curr", request.currency);
      await page.goto(landingUrl.toString(), {
        waitUntil: "domcontentloaded",
        timeout: request.timeoutMs,
      });

      const results: FlightLocationLookupResult[] = [];
      for (const query of request.queries) {
        const body = await page.evaluate(
          async ({ query, language, currency, timeoutMs }) => {
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
            url.searchParams.set("_reqid", String(Math.floor(Math.random() * 900_000) + 100_000));
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
                    "TR",
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
            currency: request.currency,
            timeoutMs: request.timeoutMs,
          },
        );
        results.push({ query, body });
      }
      return results;
    } catch (error) {
      throw new ExternalSearchError(
        error instanceof Error
          ? `Google Flights lokasyon araması başarısız: ${error.message}`
          : "Google Flights lokasyon araması başarısız",
      );
    } finally {
      if (capture) await capture.stop().catch(() => undefined);
      this.activePages.delete(page);
      await this.browserManager.closePage(page).catch(() => undefined);
    }
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled(
      [...this.activePages].map((page) => this.browserManager.closePage(page)),
    );
    this.activePages.clear();
  }
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
