import { BrowserPool, PlaywrightPlugin } from "@crawlee/browser-pool";
import { chromium as patchrightChromium } from "patchright";
import { chromium as playwrightChromium } from "playwright";
import type { BrowserType, Page } from "playwright";

import { BrowserStateError } from "../errors.js";

export interface BrowserManagerOptions {
  engine: "patchright" | "playwright";
  headless: boolean;
  channel?: string;
  maxContexts: number;
}

export interface BrowserStatus {
  running: boolean;
  engine: BrowserManagerOptions["engine"];
  headless: boolean;
  channel: string | null;
  openPages: number;
}

export interface BrowserPageProvider {
  start(): Promise<void>;
  stop(): Promise<void>;
  newPage(id: string): Promise<Page>;
  closePage(page: Page): Promise<void>;
  status(): BrowserStatus;
}

export class BrowserManager implements BrowserPageProvider {
  private pool: BrowserPool | undefined;

  constructor(private readonly options: BrowserManagerOptions) {}

  async start(): Promise<void> {
    if (this.pool) return;

    const browserType = (this.options.engine === "patchright"
      ? patchrightChromium
      : playwrightChromium) as unknown as BrowserType;

    const launchOptions = {
      headless: this.options.headless,
      ...(this.options.channel ? { channel: this.options.channel } : {}),
    };

    const plugin = new PlaywrightPlugin(browserType, {
      launchOptions,
      useIncognitoPages: true,
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

    return (await this.pool.newPage({ id })) as unknown as Page;
  }

  async closePage(page: Page): Promise<void> {
    if (!page.isClosed()) await page.close();
  }

  status(): BrowserStatus {
    return {
      running: Boolean(this.pool),
      engine: this.options.engine,
      headless: this.options.headless,
      channel: this.options.channel ?? null,
      openPages: this.pool?.pages.size ?? 0,
    };
  }
}
