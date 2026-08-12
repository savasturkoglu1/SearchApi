import path from "node:path";

import Fastify, {
  type FastifyInstance,
  type FastifyListenOptions,
} from "fastify";

import type { AppConfig } from "./config.js";
import { BrowserContentExtractor } from "./content/browser-content.extractor.js";
import { NativeContentHttpClient } from "./content/content-http.client.js";
import {
  ProfiledContentExtractor,
  type MarketContentExtractor,
} from "./content/market-content.extractor.js";
import { PublicUrlGuard } from "./content/public-url.guard.js";
import { GoogleDestinationResearch } from "./destination/google-destination.research.js";
import { BrowserStateError, CapacityError, ResourceNotFoundError } from "./errors.js";
import { DEFAULT_MARKET_PROFILES } from "./markets/market-profile.js";
import { ApiCaptureManager } from "./managers/api-capture.manager.js";
import { BrowserManager, type BrowserPageProvider } from "./managers/browser.manager.js";
import { ContextManager, type ContextRegistry } from "./managers/context.manager.js";
import { createTokenAuthMiddleware } from "./middlewares/token-auth.middleware.js";
import { browserRoutes } from "./routes/browser.routes.js";
import { contentRoutes } from "./routes/content.routes.js";
import { searchRoutes } from "./routes/search.routes.js";
import { BrowserRpcTransport } from "./travel/browser-rpc.transport.js";
import { GoogleTravelSearch } from "./travel/google-travel.search.js";
import {
  ProfiledTravelSearch,
  type MarketTravelSearch,
} from "./travel/market-travel.search.js";

export interface AppDependencies {
  browserManager: BrowserPageProvider;
  contextManager: ContextRegistry;
  captureManager: ApiCaptureManager;
  travelSearch: MarketTravelSearch;
  contentExtractor: MarketContentExtractor;
}

export function createDependencies(
  config: AppConfig,
  logger?: { warn(details: unknown, message?: string): void },
): AppDependencies {
  const { profileDirectory, ...browserOptions } = config.browser;
  const browserManager = new BrowserManager(browserOptions);
  const captureManager = new ApiCaptureManager({
    ...config.capture,
    ...(logger ? { logger } : {}),
  });
  const contextManager = new ContextManager(
    browserManager,
    captureManager,
    config.browser.maxContexts,
  );
  const travelSearch = new ProfiledTravelSearch(
    DEFAULT_MARKET_PROFILES,
    (profile) => {
      const profileBrowserManager = new BrowserManager({
        ...browserOptions,
        maxContexts: Math.max(2, config.browser.maxContexts),
        sessionMode: "persistent",
        userDataDir: path.join(profileDirectory, profile.id),
        contextOptions: {
          locale: profile.locale,
          timezoneId: profile.timezoneId,
          geolocation: { ...profile.geolocation },
          permissions: ["geolocation"],
        },
      });
      const transport = new BrowserRpcTransport(profileBrowserManager, captureManager);
      return {
        browserManager: profileBrowserManager,
        travelSearch: new GoogleTravelSearch(
          transport,
          config.search.timeoutMs,
        ),
        destinationResearch: new GoogleDestinationResearch(
          transport,
          config.search.timeoutMs,
        ),
      };
    },
  );
  const contentExtractor = new ProfiledContentExtractor(
    DEFAULT_MARKET_PROFILES,
    (profile) => {
      const contentBrowserManager = new BrowserManager({
        ...browserOptions,
        maxContexts: 1,
        sessionMode: "isolated",
        contextOptions: {
          locale: profile.locale,
          timezoneId: profile.timezoneId,
          geolocation: { ...profile.geolocation },
          permissions: ["geolocation"],
        },
      });
      const urlGuard = new PublicUrlGuard();
      return {
        browserManager: contentBrowserManager,
        extractor: new BrowserContentExtractor(
          {
            browserManager: contentBrowserManager,
            httpClient: new NativeContentHttpClient(urlGuard),
            urlGuard,
          },
          {
            timeoutMs: config.search.timeoutMs,
            maxResponseBytes: 2 * 1024 * 1024,
            minContentCharacters: 500,
          },
        ),
      };
    },
  );
  return { browserManager, contextManager, captureManager, travelSearch, contentExtractor };
}

export function buildApp(config: AppConfig, dependencies?: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: {
      level: "info",
      redact: [
        "req.headers.authorization",
        "req.headers.x-api-token",
        "res.headers.set-cookie",
      ],
    },
  });
  const runtime = dependencies ?? createDependencies(config, app.log);

  app.get("/health", async () => ({
    status: "ok",
    browser: runtime.browserManager.status(),
    marketProfiles: runtime.travelSearch.status(),
  }));

  app.register(
    async (protectedApp) => {
      protectedApp.addHook("onRequest", createTokenAuthMiddleware(config.apiToken));
      await browserRoutes(protectedApp, runtime);
      await searchRoutes(protectedApp, runtime.travelSearch);
      await contentRoutes(protectedApp, runtime.contentExtractor);
    },
    { prefix: "/v1" },
  );

  app.setErrorHandler(async (error, _request, reply) => {
    const withStatus = error as Error & { statusCode?: number; details?: unknown };
    const statusCode =
      withStatus.statusCode ??
      (error instanceof ResourceNotFoundError
        ? 404
        : error instanceof CapacityError || error instanceof BrowserStateError
          ? 409
          : 500);

    if (statusCode >= 500) app.log.error(error);
    await reply.code(statusCode).send({
      error: statusCode >= 500 ? "internal_error" : "request_error",
      message: withStatus.message,
      ...(withStatus.details ? { details: withStatus.details } : {}),
    });
  });

  app.addHook("onClose", async () => {
    await runtime.contentExtractor.closeAll();
    await runtime.travelSearch.closeAll();
    await runtime.contextManager.closeAll();
    await runtime.browserManager.stop();
  });

  return app;
}

export async function listenApp(
  app: FastifyInstance,
  runtime: AppDependencies,
  options: FastifyListenOptions,
): Promise<string> {
  const address = await app.listen(options);
  try {
    await runtime.travelSearch.startAll();
    app.log.info(
      { marketProfiles: runtime.travelSearch.status().map((profile) => profile.id) },
      "Market browser'ları hazır",
    );
    return address;
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}
