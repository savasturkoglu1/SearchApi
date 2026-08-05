import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { ApiCaptureManager } from "../managers/api-capture.manager.js";
import type { BrowserPageProvider } from "../managers/browser.manager.js";
import type { ContextRegistry } from "../managers/context.manager.js";

const contextParamsSchema = z.object({ id: z.uuid() });
const createContextSchema = z.object({
  url: z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
    message: "Yalnız http/https URL kullanılabilir",
  }).optional(),
});
const navigateSchema = z.object({
  url: z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
    message: "Yalnız http/https URL kullanılabilir",
  }),
});

export interface BrowserRouteDependencies {
  browserManager: BrowserPageProvider;
  contextManager: ContextRegistry;
  captureManager: ApiCaptureManager;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const error = new Error("Geçersiz istek");
    Object.assign(error, { statusCode: 400, details: z.flattenError(result.error) });
    throw error;
  }
  return result.data;
}

export async function browserRoutes(
  app: FastifyInstance,
  dependencies: BrowserRouteDependencies,
): Promise<void> {
  const { browserManager, contextManager, captureManager } = dependencies;

  app.get("/browser", async () => browserManager.status());

  app.post("/browser/start", async (_request, reply) => {
    await browserManager.start();
    return reply.code(200).send(browserManager.status());
  });

  app.post("/browser/stop", async (_request, reply) => {
    await contextManager.closeAll();
    await browserManager.stop();
    return reply.code(200).send(browserManager.status());
  });

  app.get("/contexts", async () => ({ contexts: contextManager.list() }));

  app.post("/contexts", async (request, reply) => {
    const body = parse(createContextSchema, request.body ?? {});
    const context = await contextManager.create(body.url ? { url: body.url } : {});
    return reply.code(201).send(context);
  });

  app.get("/contexts/:id", async (request) => {
    const { id } = parse(contextParamsSchema, request.params);
    return contextManager.get(id);
  });

  app.post("/contexts/:id/navigate", async (request) => {
    const { id } = parse(contextParamsSchema, request.params);
    const { url } = parse(navigateSchema, request.body);
    return contextManager.navigate(id, url);
  });

  app.delete("/contexts/:id", async (request) => {
    const { id } = parse(contextParamsSchema, request.params);
    return contextManager.close(id);
  });

  app.get("/captures/:id", async (request) => {
    const { id } = parse(contextParamsSchema, request.params);
    const summary = captureManager.getSummary(id);
    if (!summary) {
      const error = new Error(`Capture bulunamadı: ${id}`);
      Object.assign(error, { statusCode: 404 });
      throw error;
    }
    return summary;
  });
}
