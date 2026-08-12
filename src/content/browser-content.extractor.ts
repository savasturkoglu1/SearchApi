import { createHash, randomUUID } from "node:crypto";
import { load } from "cheerio";
import type { Page } from "playwright";

import type { BrowserPageProvider } from "../managers/browser.manager.js";
import {
  ContentHttpError,
  type ContentHttpClient,
  type ContentHttpResponse,
} from "./content-http.client.js";
import type {
  ContentChunk,
  ContentExtractionError,
  ContentExtractionInput,
  ContentExtractionResult,
  ContentExtractor,
  ExtractedContentPage,
} from "./content-extractor.js";
import { PublicUrlError, type PublicUrlGuard } from "./public-url.guard.js";

interface BrowserContentExtractorDependencies {
  browserManager: BrowserPageProvider;
  httpClient: ContentHttpClient;
  urlGuard: PublicUrlGuard;
}

interface BrowserContentExtractorOptions {
  timeoutMs: number;
  maxResponseBytes: number;
  minContentCharacters: number;
}

interface ExtractedDocument {
  title: string;
  description?: string;
  author?: string;
  publishedAt?: string;
  language?: string;
  text: string;
  sections: Array<{ heading?: string; text: string }>;
}

const BLOCKED_RESOURCE_TYPES = new Set(["image", "font", "media", "stylesheet"]);
const CHUNK_CHARACTERS = 2_000;

export class BrowserContentExtractor implements ContentExtractor {
  constructor(
    private readonly dependencies: BrowserContentExtractorDependencies,
    private readonly options: BrowserContentExtractorOptions,
  ) {}

  async extract(input: ContentExtractionInput): Promise<ContentExtractionResult> {
    const pages: ExtractedContentPage[] = [];
    const errors: ContentExtractionError[] = [];
    let page: Page | undefined;
    let browserStarted = false;
    let allowBrowserNetwork = false;

    const requirePage = async (): Promise<Page> => {
      if (page && !page.isClosed()) return page;
      await this.dependencies.browserManager.start();
      browserStarted = true;
      page = await this.dependencies.browserManager.newPage(`content-${randomUUID()}`);
      await page.route("**/*", async (route) => {
        const request = route.request();
        if (!allowBrowserNetwork || BLOCKED_RESOURCE_TYPES.has(request.resourceType())) {
          await route.abort();
          return;
        }
        try {
          await this.dependencies.urlGuard.assertAllowed(request.url());
          await route.continue();
        } catch {
          await route.abort();
        }
      });
      return page;
    };

    try {
      for (const requestedUrl of input.urls) {
        try {
          await this.dependencies.urlGuard.assertAllowed(requestedUrl);
          const extracted = await this.extractOne(
            requestedUrl,
            input,
            requirePage,
            (value) => { allowBrowserNetwork = value; },
          );
          pages.push(toContentPage(
            extracted.document,
            requestedUrl,
            extracted.finalUrl,
            extracted.mode,
            input.maxCharactersPerPage,
            pages.length,
          ));
        } catch (error) {
          errors.push(toExtractionError(requestedUrl, error));
        }
      }
    } finally {
      allowBrowserNetwork = false;
      if (page) await this.dependencies.browserManager.closePage(page).catch(() => undefined);
      if (browserStarted) await this.dependencies.browserManager.stop().catch(() => undefined);
    }

    return { pages, errors };
  }

  private async extractOne(
    requestedUrl: string,
    input: ContentExtractionInput,
    requirePage: () => Promise<Page>,
    setBrowserNetwork: (value: boolean) => void,
  ): Promise<{
    document: ExtractedDocument;
    finalUrl: string;
    mode: "http" | "browser";
  }> {
    if (input.renderMode === "browser") {
      return this.extractWithBrowser(await requirePage(), requestedUrl, setBrowserNetwork);
    }

    let httpResponse: ContentHttpResponse | undefined;
    try {
      httpResponse = await this.dependencies.httpClient.fetch({
        url: requestedUrl,
        timeoutMs: this.options.timeoutMs,
        maxBytes: this.options.maxResponseBytes,
        acceptLanguage: input.locale,
      });
      await this.dependencies.urlGuard.assertAllowed(httpResponse.finalUrl);
      const document = extractHtmlDocument(httpResponse);
      if (
        input.renderMode === "http" ||
        normalizeText(document.text).length >= this.options.minContentCharacters
      ) {
        if (!normalizeText(document.text)) {
          throw new ExtractionFailure("Sayfada okunabilir metin bulunamadı");
        }
        return { document, finalUrl: httpResponse.finalUrl, mode: "http" };
      }
    } catch (error) {
      if (input.renderMode === "http" || error instanceof PublicUrlError) throw error;
      if (error instanceof ContentHttpError && error.code === "unsupported_content") throw error;
    }

    return this.extractWithBrowser(
      await requirePage(),
      httpResponse?.finalUrl ?? requestedUrl,
      setBrowserNetwork,
    );
  }

  private async extractWithBrowser(
    page: Page,
    url: string,
    setBrowserNetwork: (value: boolean) => void,
  ): Promise<{ document: ExtractedDocument; finalUrl: string; mode: "browser" }> {
    setBrowserNetwork(true);
    try {
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: this.options.timeoutMs,
      });
      if (response && response.status() >= 400) {
        throw new ExtractionFailure(`Render edilen kaynak HTTP ${response.status()} döndürdü`);
      }
      await page.waitForLoadState("networkidle", {
        timeout: Math.min(this.options.timeoutMs, 5_000),
      }).catch(() => undefined);
      const finalUrl = page.url();
      await this.dependencies.urlGuard.assertAllowed(finalUrl);
      const document = await extractDocument(page);
      if (!normalizeText(document.text)) {
        throw new ExtractionFailure("Render edilen sayfada okunabilir metin bulunamadı");
      }
      if (isChallengeDocument(document)) {
        throw new ExtractionFailure("Sayfa CAPTCHA veya bot doğrulamasına takıldı");
      }
      return { document, finalUrl, mode: "browser" };
    } finally {
      setBrowserNetwork(false);
    }
  }
}

class ExtractionFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionFailure";
  }
}

async function extractDocument(page: Page): Promise<ExtractedDocument> {
  return page.evaluate(() => {
    const candidates = document.querySelectorAll<HTMLElement>(
      "article, main, [role='main'], .post-content, .entry-content, .article-content",
    );
    let root: HTMLElement = document.body;
    let bestScore = -1;
    for (const candidate of candidates) {
      const score = (candidate.innerText?.length ?? 0) + candidate.querySelectorAll("p").length * 120;
      if (score > bestScore) {
        root = candidate;
        bestScore = score;
      }
    }

    const clone = root.cloneNode(true) as HTMLElement;
    const noise = clone.querySelectorAll(
      "script, style, noscript, nav, footer, aside, form, iframe, object, embed, svg, canvas, dialog, [role='navigation'], [role='dialog'], [role='banner'], [aria-hidden='true'], .site-header, .advertisement, .ads, .cookie, .comments, .share",
    );
    for (const element of noise) element.remove();

    const sections: Array<{ heading?: string; text: string }> = [];
    let heading: string | undefined;
    const textParts: string[] = [];
    const blocks = clone.querySelectorAll<HTMLElement>(
      "h1, h2, h3, h4, p, li, blockquote, pre, a[href]",
    );
    for (const block of blocks) {
      const value = block.textContent?.replace(/\s+/g, " ").trim();
      if (!value) continue;
      if (/^H[1-4]$/.test(block.tagName)) {
        heading = value;
        textParts.push(value);
        continue;
      }
      if (["LI", "BLOCKQUOTE"].includes(block.tagName) && block.querySelector("p, li")) {
        continue;
      }
      if (block.tagName === "A") {
        // Ürün/aktivite listeleme kartları çoğunlukla yalnız div/span içeren tek
        // bir linktir. Anlamlı kart metnini koru; klasik makale linklerini ve
        // semantic block saran anchor'ları tekrar etme.
        if (value.length < 20 || block.querySelector("h1, h2, h3, h4, p, li, blockquote, pre")) {
          continue;
        }
      }
      textParts.push(value);
      sections.push({ ...(heading ? { heading } : {}), text: value });
    }
    const fallbackText = clone.textContent?.replace(/\s+/g, " ").trim() ?? "";

    const title = document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content.trim() ||
      document.querySelector<HTMLHeadingElement>("h1")?.innerText.trim() ||
      document.title.trim();
    const description = document.querySelector<HTMLMetaElement>(
      'meta[name="description"], meta[property="og:description"]',
    )?.content.trim();
    const author = document.querySelector<HTMLMetaElement>(
      'meta[name="author"], meta[property="article:author"]',
    )?.content.trim();
    const publishedAt = document.querySelector<HTMLMetaElement>(
      'meta[property="article:published_time"], meta[name="date"], meta[name="datePublished"]',
    )?.content.trim() || document.querySelector<HTMLTimeElement>("time[datetime]")?.dateTime.trim();
    const language = document.documentElement.lang?.trim();

    return {
      title,
      ...(description ? { description } : {}),
      ...(author ? { author } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(language ? { language } : {}),
      text: textParts.length > 0 ? textParts.join("\n\n") : fallbackText,
      sections,
    };
  });
}

function extractHtmlDocument(response: ContentHttpResponse): ExtractedDocument {
  if (response.contentType.toLocaleLowerCase("en-US").includes("text/plain")) {
    return {
      title: hostnameOf(response.finalUrl),
      text: response.html,
      sections: [{ text: response.html }],
    };
  }
  const $ = load(response.html);
  $(
    "script, style, noscript, nav, footer, aside, form, iframe, object, embed, svg, canvas, dialog, [role='navigation'], [role='dialog'], [role='banner'], [aria-hidden='true'], .site-header, .advertisement, .ads, .cookie, .comments, .share",
  ).remove();

  let root = $("body").first();
  let bestScore = -1;
  $("article, main, [role='main'], .post-content, .entry-content, .article-content").each(
    (_index, element) => {
      const candidate = $(element);
      const score = candidate.text().length + candidate.find("p").length * 120;
      if (score > bestScore) {
        root = candidate;
        bestScore = score;
      }
    },
  );

  const sections: Array<{ heading?: string; text: string }> = [];
  const textParts: string[] = [];
  let heading: string | undefined;
  root.find("h1, h2, h3, h4, p, li, blockquote, pre, a[href]").each((_index, element) => {
    const value = $(element).text().replace(/\s+/g, " ").trim();
    if (!value) return;
    if (/^h[1-4]$/i.test(element.tagName)) {
      heading = value;
      textParts.push(value);
      return;
    }
    if (/^(li|blockquote)$/i.test(element.tagName) && $(element).find("p, li").length > 0) {
      return;
    }
    if (
      /^a$/i.test(element.tagName) &&
      (value.length < 20 || $(element).find("h1, h2, h3, h4, p, li, blockquote, pre").length > 0)
    ) {
      return;
    }
    textParts.push(value);
    sections.push({ ...(heading ? { heading } : {}), text: value });
  });

  const title = $('meta[property="og:title"]').attr("content")?.trim() ||
    $("h1").first().text().trim() ||
    $("title").text().trim();
  const description = $('meta[name="description"], meta[property="og:description"]')
    .first().attr("content")?.trim();
  const author = $('meta[name="author"], meta[property="article:author"]')
    .first().attr("content")?.trim();
  const publishedAt = $(
    'meta[property="article:published_time"], meta[name="date"], meta[name="datePublished"]',
  ).first().attr("content")?.trim() || $("time[datetime]").first().attr("datetime")?.trim();
  const language = $("html").attr("lang")?.trim();

  return {
    title,
    ...(description ? { description } : {}),
    ...(author ? { author } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(language ? { language } : {}),
    text: textParts.length > 0 ? textParts.join("\n\n") : root.text(),
    sections,
  };
}

function toContentPage(
  document: ExtractedDocument,
  requestedUrl: string,
  finalUrl: string,
  extractionMode: "http" | "browser",
  maxCharacters: number,
  pageIndex: number,
): ExtractedContentPage {
  const fullText = normalizeText(document.text);
  const text = fullText.slice(0, maxCharacters);
  const chunks = buildChunks(text, document.sections, pageIndex);
  const hostname = hostnameOf(finalUrl);
  return {
    requestedUrl,
    finalUrl,
    title: normalizeText(document.title) || hostname,
    ...(document.description ? { description: normalizeText(document.description) } : {}),
    ...(document.author ? { author: normalizeText(document.author) } : {}),
    ...(document.publishedAt ? { publishedAt: document.publishedAt } : {}),
    ...(document.language ? { language: document.language } : {}),
    text,
    chunks,
    contentLength: fullText.length,
    truncated: fullText.length > maxCharacters,
    extractionMode,
    contentTrust: "external_untrusted",
    contentHash: createHash("sha256").update(fullText).digest("hex"),
    retrievedAt: new Date().toISOString(),
  };
}

function hostnameOf(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}

function buildChunks(
  text: string,
  sections: Array<{ heading?: string; text: string }>,
  pageIndex: number,
): ContentChunk[] {
  const chunks: ContentChunk[] = [];
  let remaining = text.length;
  for (const section of sections) {
    if (remaining <= 0) break;
    const normalized = normalizeText(section.text).slice(0, remaining);
    for (let offset = 0; offset < normalized.length; offset += CHUNK_CHARACTERS) {
      const value = normalized.slice(offset, offset + CHUNK_CHARACTERS).trim();
      if (!value) continue;
      chunks.push({
        id: `page-${pageIndex + 1}-chunk-${chunks.length + 1}`,
        ...(section.heading ? { heading: normalizeText(section.heading) } : {}),
        text: value,
      });
      remaining -= value.length;
      if (remaining <= 0) break;
    }
  }
  if (chunks.length === 0 && text) {
    for (let offset = 0; offset < text.length; offset += CHUNK_CHARACTERS) {
      chunks.push({
        id: `page-${pageIndex + 1}-chunk-${chunks.length + 1}`,
        text: text.slice(offset, offset + CHUNK_CHARACTERS),
      });
    }
  }
  return chunks;
}

function normalizeText(value: string): string {
  const lines = value
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const unique: string[] = [];
  for (const line of lines) {
    if (unique.at(-1) !== line) unique.push(line);
  }
  return unique.join("\n\n");
}

function isChallengeDocument(document: ExtractedDocument): boolean {
  const sample = `${document.title}\n${document.text.slice(0, 1_500)}`
    .toLocaleLowerCase("en-US");
  return sample.includes("just a moment") ||
    sample.includes("verify you are human") ||
    sample.includes("are you a robot") ||
    sample.includes("captcha") ||
    sample.includes("olağandışı trafik") ||
    sample.includes("unusual traffic");
}

function toExtractionError(requestedUrl: string, error: unknown): ContentExtractionError {
  if (error instanceof PublicUrlError) {
    return { requestedUrl, code: error.code, message: error.message };
  }
  if (error instanceof ContentHttpError) {
    return { requestedUrl, code: error.code, message: error.message };
  }
  return {
    requestedUrl,
    code: "extraction_failed",
    message: error instanceof Error ? error.message : "İçerik çıkarılamadı",
  };
}
