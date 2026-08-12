import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserContext, Page, Route } from "playwright";

import { BrowserContentExtractor } from "../src/content/browser-content.extractor.js";
import type {
  ContentHttpClient,
  ContentHttpResponse,
} from "../src/content/content-http.client.js";
import { PublicUrlGuard } from "../src/content/public-url.guard.js";
import type { BrowserPageProvider, BrowserStatus } from "../src/managers/browser.manager.js";

class FakeHttpClient implements ContentHttpClient {
  readonly urls: string[] = [];

  constructor(private readonly response: ContentHttpResponse) {}

  async fetch(input: { url: string }): Promise<ContentHttpResponse> {
    this.urls.push(input.url);
    return this.response;
  }
}

class FakeContentPage {
  readonly gotoUrls: string[] = [];
  readonly htmlDocuments: string[] = [];
  closed = false;
  private evaluationIndex = 0;

  constructor(private readonly documents: Array<Record<string, unknown>>) {}

  asPage(): Page {
    return {
      isClosed: () => this.closed,
      close: async () => { this.closed = true; },
      context: () => ({} as BrowserContext),
      route: async (_pattern: string, _handler: (route: Route) => Promise<void>) => {},
      setContent: async (html: string) => { this.htmlDocuments.push(html); },
      goto: async (url: string) => {
        this.gotoUrls.push(url);
        return null;
      },
      waitForLoadState: async () => {},
      evaluate: async () => this.documents[this.evaluationIndex++],
      url: () => this.gotoUrls.at(-1) ?? "about:blank",
    } as unknown as Page;
  }
}

class FakeBrowserManager implements BrowserPageProvider {
  readonly page: FakeContentPage;
  running = false;

  constructor(documents: Array<Record<string, unknown>>) {
    this.page = new FakeContentPage(documents);
  }

  async start(): Promise<void> { this.running = true; }
  async stop(): Promise<void> { this.running = false; }
  async newPage(): Promise<Page> { return this.page.asPage(); }
  async closePage(page: Page): Promise<void> { await page.close(); }
  status(): BrowserStatus {
    return {
      running: this.running,
      engine: "patchright",
      headless: true,
      channel: "chrome",
      openPages: this.page.closed ? 0 : 1,
      sessionMode: "isolated",
    };
  }
}

test("HTTP HTML'ini temiz metne çevirir, sınırlar ve kaynak bilgisini korur", async () => {
  const longText = `${"Amsterdam müze ve kanal rehberi. ".repeat(80)}Son.`;
  const browser = new FakeBrowserManager([]);
  const http = new FakeHttpClient({
    html: `<html lang="tr"><head><title>Amsterdam Gezi Rehberi</title></head><body><article><h1>Amsterdam Gezi Rehberi</h1><p>${longText}</p></article></body></html>`,
    finalUrl: "https://travel.example/amsterdam",
    contentType: "text/html; charset=utf-8",
  });
  const extractor = new BrowserContentExtractor(
    { browserManager: browser, httpClient: http, urlGuard: permissiveGuard() },
    { timeoutMs: 10_000, maxResponseBytes: 2_000_000, minContentCharacters: 200 },
  );

  const result = await extractor.extract({
    urls: ["https://travel.example/amsterdam?utm_source=google"],
    maxCharactersPerPage: 1_200,
    renderMode: "auto",
    locale: "tr-TR",
  });

  assert.equal(result.errors.length, 0);
  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0]?.finalUrl, "https://travel.example/amsterdam");
  assert.equal(result.pages[0]?.extractionMode, "http");
  assert.equal(result.pages[0]?.title, "Amsterdam Gezi Rehberi");
  assert.equal(result.pages[0]?.truncated, true);
  assert.equal(result.pages[0]?.text.length, 1_200);
  assert.ok((result.pages[0]?.chunks.length ?? 0) > 0);
  assert.match(result.pages[0]?.contentHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(browser.page.gotoUrls.length, 0, "yeterli HTTP içeriğinde site render edilmemeli");
  assert.equal(browser.running, false, "statik HTML için browser başlatılmamalı");
});

test("listeleme sayfasındaki anlamlı kart linklerini ana içeriğe dahil eder", async () => {
  const browser = new FakeBrowserManager([]);
  const http = new FakeHttpClient({
    html: `
      <html lang="tr">
        <head><title>Antalya Aktiviteleri</title></head>
        <body>
          <main>
            <h1>Antalya</h1>
            <p>Etkinlikler popülerlik ve değerlendirmelere göre sıralanır.</p>
            <a href="/antalya-suluada-turu">
              <div>Antalya: Suluada Adası Tekne Turu, Öğle Yemeği ve Otel Transferi</div>
              <div>7 - 12,5 saat · 4,4 (3.990) · Başlangıç fiyatı 720 TRY</div>
            </a>
          </main>
        </body>
      </html>
    `,
    finalUrl: "https://activities.example/antalya",
    contentType: "text/html; charset=utf-8",
  });
  const extractor = new BrowserContentExtractor(
    { browserManager: browser, httpClient: http, urlGuard: permissiveGuard() },
    { timeoutMs: 10_000, maxResponseBytes: 2_000_000, minContentCharacters: 200 },
  );

  const result = await extractor.extract({
    urls: ["https://activities.example/antalya"],
    maxCharactersPerPage: 5_000,
    renderMode: "http",
    locale: "tr-TR",
  });

  assert.equal(result.errors.length, 0);
  assert.match(result.pages[0]?.text ?? "", /Suluada Adası Tekne Turu/);
  assert.ok(
    result.pages[0]?.chunks.some((chunk) => chunk.text.includes("Başlangıç fiyatı 720 TRY")),
  );
});

test("HTTP içeriği yetersizse aynı URL'yi browser ile render eder", async () => {
  const browser = new FakeBrowserManager([
    documentFixture("JavaScript sonrasında oluşan kapsamlı gezi yazısı. ".repeat(30)),
  ]);
  const http = new FakeHttpClient({
    html: "<html><body><div id='app'></div></body></html>",
    finalUrl: "https://spa.example/guide",
    contentType: "text/html",
  });
  const extractor = new BrowserContentExtractor(
    { browserManager: browser, httpClient: http, urlGuard: permissiveGuard() },
    { timeoutMs: 10_000, maxResponseBytes: 2_000_000, minContentCharacters: 200 },
  );

  const result = await extractor.extract({
    urls: ["https://spa.example/guide"],
    maxCharactersPerPage: 5_000,
    renderMode: "auto",
    locale: "tr-TR",
  });

  assert.equal(result.errors.length, 0);
  assert.equal(result.pages[0]?.extractionMode, "browser");
  assert.deepEqual(browser.page.gotoUrls, ["https://spa.example/guide"]);
  assert.match(result.pages[0]?.text ?? "", /JavaScript sonrasında/);
  assert.equal(browser.running, false, "browser fallback batch sonunda tamamen durmalı");
});

test("localhost ve private network hedeflerini network isteğinden önce engeller", async () => {
  const browser = new FakeBrowserManager([]);
  const http = new FakeHttpClient({ html: "", finalUrl: "", contentType: "text/html" });
  const extractor = new BrowserContentExtractor(
    { browserManager: browser, httpClient: http, urlGuard: new PublicUrlGuard() },
    { timeoutMs: 10_000, maxResponseBytes: 2_000_000, minContentCharacters: 200 },
  );

  const result = await extractor.extract({
    urls: ["http://127.0.0.1:3045/health", "http://localhost/admin"],
    maxCharactersPerPage: 5_000,
    renderMode: "auto",
    locale: "tr-TR",
  });

  assert.equal(result.pages.length, 0);
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.every((error) => error.code === "blocked_target"));
  assert.equal(http.urls.length, 0);
});

test("public hostname private IP'ye çözülürse ve standart dışı port kullanırsa engeller", async () => {
  const privateDnsGuard = new PublicUrlGuard(async () => [
    { address: "10.0.0.8", family: 4 },
  ]);
  await assert.rejects(
    privateDnsGuard.assertAllowed("https://public-name.example/article"),
    (error: Error & { code?: string }) => error.code === "blocked_target",
  );

  const publicGuard = permissiveGuard();
  await assert.rejects(
    publicGuard.assertAllowed("https://example.com:8443/private"),
    (error: Error & { code?: string }) => error.code === "blocked_target",
  );
  assert.equal(
    (await publicGuard.assertAllowed("https://example.com/article")).hostname,
    "example.com",
  );
});

function documentFixture(text: string): Record<string, unknown> {
  return {
    title: "Amsterdam Gezi Rehberi",
    description: "Şehir için gezi önerileri",
    author: "Gezgin",
    publishedAt: "2026-06-10",
    language: "tr",
    text,
    sections: [{ heading: "Gezilecek Yerler", text }],
  };
}

function permissiveGuard(): PublicUrlGuard {
  return new PublicUrlGuard(async () => [{ address: "93.184.216.34", family: 4 }]);
}
