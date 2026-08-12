import { BrowserPool, PlaywrightPlugin } from "@crawlee/browser-pool";
import { chromium as patchrightChromium } from "patchright";
import { chromium as playwrightChromium } from "playwright";
import type { BrowserContextOptions, BrowserType, Page } from "playwright";

import { BrowserStateError } from "../errors.js";

export interface BrowserManagerOptions {
  engine: "patchright" | "playwright";
  headless: boolean;
  channel?: string;
  maxContexts: number;
  sessionMode?: "isolated" | "persistent";
  userDataDir?: string;
  contextOptions?: Pick<
    BrowserContextOptions,
    "geolocation" | "locale" | "permissions" | "timezoneId"
  >;
}

export interface BrowserStatus {
  running: boolean;
  engine: BrowserManagerOptions["engine"];
  headless: boolean;
  channel: string | null;
  openPages: number;
  sessionMode: "isolated" | "persistent";
}

export interface BrowserPageProvider {
  start(): Promise<void>;
  stop(): Promise<void>;
  newPage(id: string): Promise<Page>;
  closePage(page: Page): Promise<void>;
  status(): BrowserStatus;
}

interface PlaywrightBrowserPool {
  newPage(options: {
    id: string;
    pageOptions?: BrowserContextOptions;
  }): Promise<Page>;
}

export class BrowserManager implements BrowserPageProvider {
  private pool: BrowserPool | undefined;

  constructor(private readonly options: BrowserManagerOptions) {}

  async start(): Promise<void> {
    if (this.pool) return;

    const browserType = (this.options.engine === "patchright"
      ? patchrightChromium
      : playwrightChromium) as unknown as BrowserType;

    const persistent = this.options.sessionMode === "persistent";
    const launchOptions = {
      headless: this.options.headless,
      ...(this.options.channel ? { channel: this.options.channel } : {}),
      ...(persistent && this.options.contextOptions ? this.options.contextOptions : {}),
    };

    const plugin = new PlaywrightPlugin(browserType, {
      launchOptions,
      useIncognitoPages: !persistent,
      ...(persistent && this.options.userDataDir
        ? { userDataDir: this.options.userDataDir }
        : {}),
    });

    this.pool = new BrowserPool({
      browserPlugins: [plugin],
      maxOpenPagesPerBrowser: this.options.maxContexts,
      retireBrowserAfterPageCount: 1_000,
      operationTimeoutSecs: 30,
      closeInactiveBrowserAfterSecs: 3_600,
      retireInactiveBrowserAfterSecs: 3_600,
      // Patchright kendi browser kimliğini yönetir. Manuel analizde iki motoru
      // karşılaştırılabilir tutmak için Crawlee fingerprint injection kapalıdır.
      useFingerprints: false,
    });
  }

  async stop(): Promise<void> {
    const pool = this.pool;
    this.pool = undefined;
    if (pool) await pool.destroy();
  }

  async newPage(id: string): Promise<Page> {
    if (!this.pool) {
      throw new BrowserStateError("BrowserManager çalışmıyor");
    }

    const pageOptions = this.options.sessionMode === "persistent"
      ? undefined
      : this.options.contextOptions
        ? { ...this.options.contextOptions }
        : undefined;
    // BrowserPool'un varsayılan generic'i Playwright context seçeneklerini
    // `never` olarak daraltıyor; çalışan Playwright adapter sözleşmesini burada
    // açıkça tanımlıyoruz.
    const pool = this.pool as unknown as PlaywrightBrowserPool;
    return pool.newPage({
      id,
      ...(pageOptions ? { pageOptions } : {}),
    });
  }

  async closePage(page: Page): Promise<void> {
    // Browser UI'ından veya browser crash'iyle kapanan bir Playwright page'i
    // BrowserPool registry'sinde kalabilir. Crawlee page.close() metodunu override
    // ederek bu kaydı temizlediği için isClosed() true olsa da çağrı yapılmalıdır.
    await page.close();
  }

  status(): BrowserStatus {
    return {
      running: Boolean(this.pool),
      engine: this.options.engine,
      headless: this.options.headless,
      channel: this.options.channel ?? null,
      openPages: this.pool?.pages.size ?? 0,
      sessionMode: this.options.sessionMode ?? "isolated",
    };
  }
}
