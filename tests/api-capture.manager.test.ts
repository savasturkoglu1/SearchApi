import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { BrowserContext, Request, Response } from "playwright";

import { ApiCaptureManager } from "../src/managers/api-capture.manager.js";

class FakeContext extends EventEmitter {}

test("XHR/fetch exchange dosyasını yazar ve hassas değerleri maskeler", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "api-capiture-test-"));
  const manager = new ApiCaptureManager({
    directory,
    maxBodyBytes: 1024,
    includeSensitive: false,
  });
  const context = new FakeContext();
  const controller = await manager.attach("11111111-1111-4111-8111-111111111111", context as unknown as BrowserContext);

  const request = {
    resourceType: () => "fetch",
    method: () => "POST",
    url: () => "https://example.test/api/search?api_key=top-secret&lang=tr",
    allHeaders: async () => ({
      authorization: "Bearer top-secret",
      "content-type": "application/json",
    }),
    postDataBuffer: () => Buffer.from(JSON.stringify({ query: "IST", token: "secret" })),
    failure: () => null,
  } as unknown as Request;
  const response = {
    request: () => request,
    allHeaders: async () => ({
      "content-type": "application/json",
      "set-cookie": "session=secret",
    }),
    body: async () => Buffer.from(JSON.stringify({ ok: true, access_token: "secret" })),
    status: () => 200,
    statusText: () => "OK",
  } as unknown as Response;

  context.emit("request", request);
  context.emit("response", response);
  context.emit("requestfinished", request);
  const summary = await controller.stop();

  assert.equal(summary.captured, 1);
  assert.equal(summary.failed, 0);
  const files = await readdir(path.join(summary.directory, "exchanges"));
  assert.equal(files.length, 1);

  const exchange = JSON.parse(
    await readFile(path.join(summary.directory, "exchanges", files[0]!), "utf8"),
  );
  assert.equal(exchange.request.headers.authorization, "[REDACTED]");
  assert.match(exchange.request.url, /api_key=%5BREDACTED%5D/);
  assert.equal(exchange.request.body.value.token, "[REDACTED]");
  assert.equal(exchange.response.headers["set-cookie"], "[REDACTED]");
  assert.equal(exchange.response.body.value.access_token, "[REDACTED]");

  await rm(directory, { recursive: true, force: true });
});

test("document ve image isteklerini kaydetmez", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "api-capiture-test-"));
  const manager = new ApiCaptureManager({
    directory,
    maxBodyBytes: 1024,
    includeSensitive: false,
  });
  const context = new FakeContext();
  const controller = await manager.attach("22222222-2222-4222-8222-222222222222", context as unknown as BrowserContext);
  const request = { resourceType: () => "document" } as unknown as Request;

  context.emit("request", request);
  const summary = await controller.stop();
  assert.equal(summary.captured, 0);

  await rm(directory, { recursive: true, force: true });
});
