import path from "node:path";
import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const optionalString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().optional(),
);

const envSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3045),
  API_TOKEN: z.string().min(16, "API_TOKEN en az 16 karakter olmalı"),
  BROWSER_ENGINE: z.enum(["patchright", "playwright"]).default("patchright"),
  BROWSER_HEADLESS: booleanFromString,
  BROWSER_CHANNEL: optionalString.default("chrome"),
  MAX_CONTEXTS: z.coerce.number().int().min(1).max(50).default(5),
  CAPTURE_DIR: z.string().min(1).default(".api-capiture"),
  CAPTURE_MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(50 * 1_024 * 1_024)
    .default(2 * 1_024 * 1_024),
  CAPTURE_INCLUDE_SENSITIVE: booleanFromString,
  SEARCH_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(180_000).default(90_000),
});

export interface AppConfig {
  host: string;
  port: number;
  apiToken: string;
  browser: {
    engine: "patchright" | "playwright";
    headless: boolean;
    channel?: string;
    maxContexts: number;
  };
  capture: {
    directory: string;
    maxBodyBytes: number;
    includeSensitive: boolean;
  };
  search: {
    timeoutMs: number;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const browser = {
    engine: parsed.BROWSER_ENGINE,
    headless: parsed.BROWSER_HEADLESS,
    maxContexts: parsed.MAX_CONTEXTS,
    ...(parsed.BROWSER_CHANNEL ? { channel: parsed.BROWSER_CHANNEL } : {}),
  };

  return {
    host: parsed.HOST,
    port: parsed.PORT,
    apiToken: parsed.API_TOKEN,
    browser,
    capture: {
      directory: path.resolve(parsed.CAPTURE_DIR),
      maxBodyBytes: parsed.CAPTURE_MAX_BODY_BYTES,
      includeSensitive: parsed.CAPTURE_INCLUDE_SENSITIVE,
    },
    search: {
      timeoutMs: parsed.SEARCH_TIMEOUT_MS,
    },
  };
}
