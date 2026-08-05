import Fastify, { type FastifyInstance } from "fastify";

import type { AppConfig } from "./config.js";
import { BrowserStateError, CapacityError, ResourceNotFoundError } from "./errors.js";
import { ApiCaptureManager } from "./managers/api-capture.manager.js";
import { BrowserManager, type BrowserPageProvider } from "./managers/browser.manager.js";
import { ContextManager, type ContextRegistry } from "./managers/context.manager.js";
import { createTokenAuthMiddleware } from "./middlewares/token-auth.middleware.js";
import { browserRoutes } from "./routes/browser.routes.js";
import { searchRoutes } from "./routes/search.routes.js";
import { BrowserRpcTransport } from "./travel/browser-rpc.transport.js";
import { GoogleTravelSearch } from "./travel/google-travel.search.js";
import type { TravelSearch } from "./travel/travel-search.js";

export interface AppDependencies {
  browserManager: BrowserPageProvider;
  contextManager: ContextRegistry;
  captureManager: ApiCaptureManager;
  travelSearch: TravelSearch;
}

export function createDependencies(
  config: AppConfig,
  logger?: { warn(details: unknown, message?: string): void },
): AppDependencies {
  const browserManager = new BrowserManager(config.browser);
  const captureManager = new ApiCaptureManager({
    ...config.capture,
    ...(logger ? { logger } : {}),
  });
  const contextManager = new ContextManager(
    browserManager,
    captureManager,
    config.browser.maxContexts,
  );
  const travelSearch = new GoogleTravelSearch(
    new BrowserRpcTransport(browserManager, captureManager),
    config.search.timeoutMs,
  );
  return { browserManager, contextManager, captureManager, travelSearch };
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
  }));

  app.register(
    async (protectedApp) => {
      protectedApp.addHook("onRequest", createTokenAuthMiddleware(config.apiToken));
      await browserRoutes(protectedApp, runtime);
      await searchRoutes(protectedApp, runtime.travelSearch);
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
    await runtime.travelSearch.closeAll();
    await runtime.contextManager.closeAll();
    await runtime.browserManager.stop();
  });

  return app;
}
