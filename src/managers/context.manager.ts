import { randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "playwright";

import { CapacityError, ResourceNotFoundError } from "../errors.js";
import type {
  ApiCaptureManager,
  CaptureController,
  CaptureSummary,
} from "./api-capture.manager.js";
import type { BrowserPageProvider } from "./browser.manager.js";

export interface CreateContextInput {
  url?: string;
}

export interface ContextSnapshot {
  id: string;
  createdAt: string;
  pages: string[];
  capture: CaptureSummary;
}

interface ManagedContext {
  id: string;
  createdAt: string;
  page: Page;
  context: BrowserContext;
  capture: CaptureController;
  closing: boolean;
}

export interface ContextRegistry {
  create(input: CreateContextInput): Promise<ContextSnapshot>;
  list(): ContextSnapshot[];
  get(id: string): ContextSnapshot;
  navigate(id: string, url: string): Promise<ContextSnapshot>;
  close(id: string): Promise<CaptureSummary>;
  closeAll(): Promise<void>;
}

export class ContextManager implements ContextRegistry {
  private readonly contexts = new Map<string, ManagedContext>();

  constructor(
    private readonly browserManager: BrowserPageProvider,
    private readonly captureManager: ApiCaptureManager,
    private readonly maxContexts: number,
  ) {}

  async create(input: CreateContextInput): Promise<ContextSnapshot> {
    if (this.contexts.size >= this.maxContexts) {
      throw new CapacityError(`En fazla ${this.maxContexts} context açılabilir`);
    }

    await this.browserManager.start();
    const id = randomUUID();
    const page = await this.browserManager.newPage(id);
    const context = page.context();

    try {
      const capture = await this.captureManager.attach(id, context);
      const managed: ManagedContext = {
        id,
        createdAt: new Date().toISOString(),
        page,
        context,
        capture,
        closing: false,
      };
      this.contexts.set(id, managed);

      context.once("close", () => {
        if (!managed.closing) void this.finalizeClosedContext(managed);
      });

      if (input.url) {
        await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      }
      return this.snapshot(managed);
    } catch (error) {
      await this.browserManager.closePage(page).catch(() => undefined);
      throw error;
    }
  }

  list(): ContextSnapshot[] {
    return [...this.contexts.values()].map((context) => this.snapshot(context));
  }

  get(id: string): ContextSnapshot {
    return this.snapshot(this.requireContext(id));
  }

  async navigate(id: string, url: string): Promise<ContextSnapshot> {
    const context = this.requireContext(id);
    await context.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    return this.snapshot(context);
  }

  async close(id: string): Promise<CaptureSummary> {
    const managed = this.requireContext(id);
    managed.closing = true;
    await managed.capture.stop();
    await this.browserManager.closePage(managed.page);
    this.contexts.delete(id);
    return managed.capture.summary();
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.contexts.keys()].map((id) => this.close(id)));
    this.contexts.clear();
  }

  private requireContext(id: string): ManagedContext {
    const context = this.contexts.get(id);
    if (!context) throw new ResourceNotFoundError(`Context bulunamadı: ${id}`);
    return context;
  }

  private snapshot(managed: ManagedContext): ContextSnapshot {
    return {
      id: managed.id,
      createdAt: managed.createdAt,
      pages: managed.context.pages().map((page) => page.url()),
      capture: managed.capture.summary(),
    };
  }

  private async finalizeClosedContext(managed: ManagedContext): Promise<void> {
    managed.closing = true;
    await managed.capture.stop().catch(() => undefined);
    this.contexts.delete(managed.id);
  }
}
