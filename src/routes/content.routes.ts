import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { MarketContentExtractor } from "../content/market-content.extractor.js";
import { MARKET_PROFILE_IDS } from "../markets/market-profile.js";

const httpUrlSchema = z.url().refine(
  (value) => ["http:", "https:"].includes(new URL(value).protocol),
  { message: "Yalnız http/https URL kullanılabilir" },
);
const contentExtractionSchema = z.object({
  urls: z.array(httpUrlSchema).min(1).max(5).refine(
    (urls) => new Set(urls).size === urls.length,
    { message: "Aynı URL bir istekte yalnız bir kez gönderilebilir" },
  ),
  marketProfile: z.enum(MARKET_PROFILE_IDS),
  maxCharactersPerPage: z.number().int().min(1_000).max(50_000).default(30_000),
  renderMode: z.enum(["auto", "http", "browser"]).default("auto"),
});

export async function contentRoutes(
  app: FastifyInstance,
  contentExtractor: MarketContentExtractor,
): Promise<void> {
  app.post("/content/extract", async (request) => {
    const result = contentExtractionSchema.safeParse(request.body);
    if (!result.success) {
      const error = new Error("Geçersiz içerik çıkarma isteği");
      Object.assign(error, { statusCode: 400, details: z.flattenError(result.error) });
      throw error;
    }
    return contentExtractor.extract(result.data);
  });
}
