import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserContext, Page, Response, Route } from "playwright";

import type { ApiCaptureManager, CaptureController } from "../src/managers/api-capture.manager.js";
import type { BrowserPageProvider, BrowserStatus } from "../src/managers/browser.manager.js";
import { BrowserRpcTransport } from "../src/travel/browser-rpc.transport.js";
import type { InPageRpcRecipe, TravelRpcRequest } from "../src/travel/travel-search.js";

interface DirectResponse {
  status: number;
  url: string;
  contentType: string;
  body: string;
}

interface FakePageOptions {
  failNavigation?: boolean;
  navigationUrl?: string;
  navigationStatus?: number;
}

class FakePage {
  closed = false;
  gotoUrls: string[] = [];
  directCalls = 0;

  constructor(
    private readonly directResponse: DirectResponse,
    private readonly navigationBody = "navigation-body",
    private readonly browserContext = {} as BrowserContext,
    private readonly options: FakePageOptions = {},
  ) {}

  asPage(): Page {
    return {
      isClosed: () => this.closed,
      close: async () => {
        this.closed = true;
      },
      context: () => this.browserContext,
      route: async (_url: string, _handler: (route: Route) => Promise<void>) => {},
      goto: async (url: string) => {
        this.gotoUrls.push(url);
        return null;
      },
      evaluate: async (_callback: unknown, argument?: unknown) => {
        if (argument === undefined) return false;
        this.directCalls += 1;
        return this.directResponse;
      },
      waitForResponse: async (predicate: (response: Response) => boolean) => {
        if (this.options.failNavigation) throw new Error("navigation RPC oluşmadı");
        const response = {
          url: () => this.options.navigationUrl ??
            "https://www.google.com/FlightsFrontendService/GetShoppingResults",
          status: () => this.options.navigationStatus ?? 200,
          finished: async () => null,
          text: async () => this.navigationBody,
        } as unknown as Response;
        if (!predicate(response)) throw new Error("navigation RPC oluşmadı");
        return response;
      },
      url: () => this.gotoUrls.at(-1) ?? "about:blank",
    } as unknown as Page;
  }
}

class FakeBrowserManager implements BrowserPageProvider {
  readonly created: FakePage[] = [];
  running = false;
  private readonly browserContext = {} as BrowserContext;

  constructor(
    private readonly responses: DirectResponse[],
    private readonly pageOptions: FakePageOptions = {},
  ) {}

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async newPage(): Promise<Page> {
    const page = new FakePage(
      this.responses[this.created.length] ?? successfulDirectResponse(),
      "navigation-body",
      this.browserContext,
      this.pageOptions,
    );
    this.created.push(page);
    return page.asPage();
  }

  async closePage(page: Page): Promise<void> {
    await page.close();
  }

  status(): BrowserStatus {
    return {
      running: this.running,
      engine: "patchright",
      headless: true,
      channel: "chrome",
      openPages: this.created.filter((page) => !page.closed).length,
      sessionMode: "persistent",
    };
  }
}

test("aynı dikeydeki RPC'ler bootstrap edilmiş page'i yeniden kullanır", async () => {
  const browser = new FakeBrowserManager([successfulDirectResponse()]);
  const transport = new BrowserRpcTransport(browser, fakeCaptureManager());
  const request = stayRpcRequest();

  const first = await transport.execute(request);
  const second = await transport.execute(request);

  assert.equal(browser.created.length, 1);
  assert.deepEqual(browser.created[0]?.gotoUrls, [request.inPage?.bootstrapUrl]);
  assert.equal(browser.created[0]?.directCalls, 2);
  assert.equal(first.body, "direct-body");
  assert.equal(second.body, "direct-body");
  assert.equal(first.captureContextId, second.captureContextId);

  await transport.closeAll();
  assert.equal(browser.created[0]?.closed, true);
});

test("iki in-page denemesi başarısızsa navigation capture'a düşer", async () => {
  const failed = {
    status: 500,
    url: "https://www.google.com/rpc/failed",
    contentType: "application/json",
    body: "failed",
  };
  const browser = new FakeBrowserManager([failed, failed]);
  const transport = new BrowserRpcTransport(browser, fakeCaptureManager());
  const request = stayRpcRequest();

  const response = await transport.execute(request);

  assert.equal(browser.created.length, 2);
  assert.equal(browser.created[0]?.closed, true);
  assert.deepEqual(browser.created[1]?.gotoUrls, [request.inPage?.bootstrapUrl, request.sourceUrl]);
  assert.equal(browser.created[1]?.closed, false);
  assert.equal(response.body, "navigation-body");

  const second = await transport.execute(request);
  assert.equal(second.body, "navigation-body");
  assert.equal(browser.created.length, 2, "cooldown sırasında aynı fallback page kullanılmalı");
  assert.equal(browser.created[1]?.directCalls, 1, "reddedilen direct RPC tekrar denenmemeli");
  assert.deepEqual(browser.created[1]?.gotoUrls, [
    request.inPage?.bootstrapUrl,
    request.sourceUrl,
    request.sourceUrl,
  ]);

  await transport.closeAll();
  assert.equal(browser.created[1]?.closed, true);
});

test("uçuş araması opaque Google context'i için sayfanın kendi navigation RPC'sini kullanır", async () => {
  const browser = new FakeBrowserManager([googleRpcErrorResponse()]);
  const transport = new BrowserRpcTransport(browser, fakeCaptureManager());

  const response = await transport.execute({
    ...rpcRequest(),
    inPage: { ...recipe(), minimumResponseBytes: 512 },
  });

  assert.equal(response.body, "navigation-body");
  assert.equal(browser.created.length, 1);
  assert.equal(browser.created[0]?.directCalls, 0, "geçersiz handcrafted uçuş RPC'si atılmamalı");
  assert.deepEqual(browser.created[0]?.gotoUrls, [
    rpcRequest().inPage?.bootstrapUrl,
    rpcRequest().sourceUrl,
  ]);

  await transport.closeAll();
});

test("uçuş navigation 429 cevabında timeout beklemeden trafik doğrulama hatası verir", async () => {
  const browser = new FakeBrowserManager([successfulDirectResponse()], {
    navigationUrl: "https://www.google.com/sorry/index?continue=travel",
    navigationStatus: 429,
  });
  const transport = new BrowserRpcTransport(browser, fakeCaptureManager());

  await assert.rejects(
    transport.execute(rpcRequest()),
    /CAPTCHA veya trafik doğrulamasına takıldı/,
  );
  assert.equal(browser.created.length, 1, "bloklanmış navigation tekrar denenmemeli");

  await transport.closeAll();
});

test("persistent market context'inde capture listener'ı dikeyler arasında paylaşılır", async () => {
  const browser = new FakeBrowserManager([
    successfulDirectResponse(),
    successfulDirectResponse(),
  ]);
  let attached = 0;
  let stopped = 0;
  const transport = new BrowserRpcTransport(
    browser,
    fakeCaptureManager(
      () => { attached += 1; },
      () => { stopped += 1; },
    ),
  );

  await transport.execute(rpcRequest());
  await transport.execute({
    ...rpcRequest(),
    inPage: {
      ...recipe(),
      sessionKey: "stays",
      bootstrapUrl: "https://www.google.com/travel/search?hl=tr&gl=TR&curr=TRY",
    },
  });

  assert.equal(browser.created.length, 2);
  assert.equal(attached, 1);
  await transport.closeAll();
  assert.equal(stopped, 1);
});

function rpcRequest(): TravelRpcRequest {
  return {
    sourceUrl: "https://www.google.com/travel/flights/search?tfs=test",
    responseUrlIncludes: "FlightsFrontendService/GetShoppingResults",
    timeoutMs: 30_000,
    inPage: recipe(),
  };
}

function stayRpcRequest(): TravelRpcRequest {
  return {
    ...rpcRequest(),
    inPage: {
      ...recipe(),
      sessionKey: "stays",
      bootstrapUrl: "https://www.google.com/travel/search?hl=tr&gl=TR&curr=TRY",
    },
  };
}

function recipe(): InPageRpcRecipe {
  return {
    sessionKey: "flights",
    bootstrapUrl: "https://www.google.com/travel/flights?hl=tr&gl=TR&curr=TRY",
    endpointPath:
      "/_/FlightsFrontendUi/data/travel.frontend.flights.FlightsFrontendService/GetShoppingResults",
    query: { hl: "tr", rt: "c" },
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: "f.req=test",
    minimumResponseBytes: 1,
  };
}

function successfulDirectResponse(): DirectResponse {
  return {
    status: 200,
    url: "https://www.google.com/rpc/direct",
    contentType: "application/json; charset=utf-8",
    body: "direct-body",
  };
}

function googleRpcErrorResponse(): DirectResponse {
  return {
    status: 200,
    url: "https://www.google.com/rpc/direct",
    contentType: "application/json; charset=utf-8",
    body:
      ")]}'\n\n39\n[[\"wrb.fr\",null,null,null,null,[13]]]\n" +
      "56\n[[\"di\",37],[\"af.httprm\",37,\"-1369450465053266836\",49]]\n" +
      "25\n[[\"e\",4,null,null,132]]\n",
  };
}

function fakeCaptureManager(
  onAttach: () => void = () => undefined,
  onStop: () => void = () => undefined,
): ApiCaptureManager {
  return {
    attach: async (contextId: string) => {
      onAttach();
      const summary = {
        contextId,
        directory: "/tmp/browser-rpc-test",
        startedAt: "2026-08-05T00:00:00.000Z",
        captured: 0,
        failed: 0,
        active: true,
      };
      return {
        contextId,
        directory: summary.directory,
        summary: () => summary,
        stop: async () => {
          onStop();
          return { ...summary, active: false };
        },
      } satisfies CaptureController;
    },
  } as unknown as ApiCaptureManager;
}
