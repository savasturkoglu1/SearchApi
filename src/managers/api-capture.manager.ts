import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Request, Response } from "playwright";

const CAPTURED_RESOURCE_TYPES = new Set(["xhr", "fetch"]);
const SENSITIVE_KEY = /(^|[-_])(authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|token|secret|password|passwd|session)([-_]|$)/i;
const TEXT_CONTENT_TYPE = /(json|text|javascript|xml|graphql|x-www-form-urlencoded|event-stream)/i;

type Headers = Record<string, string>;

export interface CaptureLogger {
  warn(details: unknown, message?: string): void;
}

export interface ApiCaptureOptions {
  directory: string;
  maxBodyBytes: number;
  includeSensitive: boolean;
  logger?: CaptureLogger;
}

export interface CapturedBody {
  encoding: "utf8" | "base64" | "json";
  value: unknown;
  originalBytes: number;
  capturedBytes: number;
  truncated: boolean;
}

export interface CaptureSummary {
  contextId: string;
  directory: string;
  startedAt: string;
  stoppedAt?: string;
  captured: number;
  failed: number;
  active: boolean;
}

export interface CaptureController {
  readonly contextId: string;
  readonly directory: string;
  stop(): Promise<CaptureSummary>;
  summary(): CaptureSummary;
}

interface PendingCapture {
  id: string;
  sequence: number;
  startedAt: string;
  startedAtMs: number;
  request: Request;
}

interface CaptureSessionState {
  contextId: string;
  directory: string;
  startedAt: string;
  stoppedAt?: string;
  captured: number;
  failed: number;
  active: boolean;
  sequence: number;
}

export class ApiCaptureManager {
  private readonly sessions = new Map<string, CaptureSessionState>();

  constructor(private readonly options: ApiCaptureOptions) {}

  async initialize(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true });
  }

  async attach(contextId: string, context: BrowserContext): Promise<CaptureController> {
    await this.initialize();
    const day = new Date().toISOString().slice(0, 10);
    const sessionDirectory = path.join(this.options.directory, day, contextId);
    await mkdir(path.join(sessionDirectory, "exchanges"), { recursive: true });

    const state: CaptureSessionState = {
      contextId,
      directory: sessionDirectory,
      startedAt: new Date().toISOString(),
      captured: 0,
      failed: 0,
      active: true,
      sequence: 0,
    };
    this.sessions.set(contextId, state);
    await this.writeSession(state);

    const pendingByRequest = new Map<Request, PendingCapture>();
    const responseByRequest = new Map<Request, Response>();
    const writes = new Set<Promise<void>>();

    const track = (operation: Promise<void>) => {
      writes.add(operation);
      void operation
        .catch((error) => {
          this.options.logger?.warn(
            { error, contextId },
            "API capture dosyası yazılamadı",
          );
        })
        .finally(() => writes.delete(operation));
    };

    const onRequest = (request: Request) => {
      if (!CAPTURED_RESOURCE_TYPES.has(request.resourceType())) return;
      state.sequence += 1;
      pendingByRequest.set(request, {
        id: randomUUID(),
        sequence: state.sequence,
        startedAt: new Date().toISOString(),
        startedAtMs: Date.now(),
        request,
      });
    };

    const onResponse = (response: Response) => {
      if (!pendingByRequest.has(response.request())) return;
      responseByRequest.set(response.request(), response);
    };

    const onRequestFinished = (request: Request) => {
      const pending = pendingByRequest.get(request);
      const response = responseByRequest.get(request);
      if (!pending || !response) return;
      pendingByRequest.delete(request);
      responseByRequest.delete(request);
      track(this.captureResponse(state, pending, response));
    };

    const onRequestFailed = (request: Request) => {
      const pending = pendingByRequest.get(request);
      if (!pending) return;
      pendingByRequest.delete(request);
      responseByRequest.delete(request);
      track(this.captureFailure(state, pending));
    };

    context.on("request", onRequest);
    context.on("response", onResponse);
    context.on("requestfinished", onRequestFinished);
    context.on("requestfailed", onRequestFailed);

    let stopped = false;
    const stop = async (): Promise<CaptureSummary> => {
      if (stopped) return this.toSummary(state);
      stopped = true;
      context.off("request", onRequest);
      context.off("response", onResponse);
      context.off("requestfinished", onRequestFinished);
      context.off("requestfailed", onRequestFailed);
      await Promise.allSettled([...writes]);
      state.active = false;
      state.stoppedAt = new Date().toISOString();
      await this.writeSession(state);
      return this.toSummary(state);
    };

    return {
      contextId,
      directory: sessionDirectory,
      stop,
      summary: () => this.toSummary(state),
    };
  }

  getSummary(contextId: string): CaptureSummary | undefined {
    const state = this.sessions.get(contextId);
    return state ? this.toSummary(state) : undefined;
  }

  private async captureResponse(
    state: CaptureSessionState,
    pending: PendingCapture,
    response: Response,
  ): Promise<void> {
    const responseHeaders = await response.allHeaders();
    let responseBody: CapturedBody | undefined;
    let bodyError: string | undefined;

    try {
      responseBody = this.formatBody(
        await response.body(),
        responseHeaders["content-type"] ?? "",
      );
    } catch (error) {
      bodyError = error instanceof Error ? error.message : String(error);
    }

    const record = {
      id: pending.id,
      contextId: state.contextId,
      startedAt: pending.startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - pending.startedAtMs,
      request: await this.serializeRequest(pending.request),
      response: {
        status: response.status(),
        statusText: response.statusText(),
        headers: this.redactHeaders(responseHeaders),
        ...(responseBody ? { body: responseBody } : {}),
        ...(bodyError ? { bodyError } : {}),
      },
    };

    await this.writeExchange(state, pending, record, response.status());
    state.captured += 1;
    await this.writeSession(state);
  }

  private async captureFailure(
    state: CaptureSessionState,
    pending: PendingCapture,
  ): Promise<void> {
    const record = {
      id: pending.id,
      contextId: state.contextId,
      startedAt: pending.startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - pending.startedAtMs,
      request: await this.serializeRequest(pending.request),
      failure: pending.request.failure()?.errorText ?? "request_failed",
    };

    await this.writeExchange(state, pending, record);
    state.failed += 1;
    await this.writeSession(state);
  }

  private async serializeRequest(request: Request) {
    const headers = await request.allHeaders();
    const postData = request.postDataBuffer();
    return {
      method: request.method(),
      url: this.redactUrl(request.url()),
      resourceType: request.resourceType(),
      headers: this.redactHeaders(headers),
      ...(postData
        ? { body: this.formatBody(postData, headers["content-type"] ?? "") }
        : {}),
    };
  }

  private formatBody(body: Buffer, contentType: string): CapturedBody {
    const originalBytes = body.byteLength;
    const captured = body.subarray(0, this.options.maxBodyBytes);
    const truncated = originalBytes > captured.byteLength;

    if (TEXT_CONTENT_TYPE.test(contentType)) {
      const text = captured.toString("utf8");
      if (/json/i.test(contentType)) {
        try {
          return {
            encoding: "json",
            value: this.redactJson(JSON.parse(text)),
            originalBytes,
            capturedBytes: captured.byteLength,
            truncated,
          };
        } catch {
          // Truncated or malformed JSON remains useful as UTF-8 capture.
        }
      }

      return {
        encoding: "utf8",
        value: this.options.includeSensitive ? text : this.redactFormBody(text, contentType),
        originalBytes,
        capturedBytes: captured.byteLength,
        truncated,
      };
    }

    return {
      encoding: "base64",
      value: captured.toString("base64"),
      originalBytes,
      capturedBytes: captured.byteLength,
      truncated,
    };
  }

  private redactHeaders(headers: Headers): Headers {
    if (this.options.includeSensitive) return headers;
    return Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : value,
      ]),
    );
  }

  private redactUrl(rawUrl: string): string {
    if (this.options.includeSensitive) return rawUrl;
    try {
      const url = new URL(rawUrl);
      for (const key of [...url.searchParams.keys()]) {
        if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, "[REDACTED]");
      }
      return url.toString();
    } catch {
      return rawUrl;
    }
  }

  private redactJson(value: unknown): unknown {
    if (this.options.includeSensitive) return value;
    if (Array.isArray(value)) return value.map((item) => this.redactJson(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          SENSITIVE_KEY.test(key) ? "[REDACTED]" : this.redactJson(child),
        ]),
      );
    }
    return value;
  }

  private redactFormBody(value: string, contentType: string): string {
    if (!/x-www-form-urlencoded/i.test(contentType)) return value;
    const params = new URLSearchParams(value);
    for (const key of [...params.keys()]) {
      if (SENSITIVE_KEY.test(key)) params.set(key, "[REDACTED]");
    }
    return params.toString();
  }

  private async writeExchange(
    state: CaptureSessionState,
    pending: PendingCapture,
    record: unknown,
    status?: number,
  ): Promise<void> {
    const filename = `${String(pending.sequence).padStart(6, "0")}-${pending.id}.json`;
    const relativePath = path.join("exchanges", filename);
    await this.atomicJsonWrite(path.join(state.directory, relativePath), record);
    await appendFile(
      path.join(state.directory, "index.ndjson"),
      `${JSON.stringify({
        id: pending.id,
        sequence: pending.sequence,
        method: pending.request.method(),
        url: this.redactUrl(pending.request.url()),
        ...(status !== undefined ? { status } : { failed: true }),
        path: relativePath,
      })}\n`,
      "utf8",
    );
  }

  private async writeSession(state: CaptureSessionState): Promise<void> {
    await this.atomicJsonWrite(
      path.join(state.directory, "session.json"),
      this.toSummary(state),
    );
  }

  private async atomicJsonWrite(filePath: string, value: unknown): Promise<void> {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryPath, filePath);
  }

  private toSummary(state: CaptureSessionState): CaptureSummary {
    return {
      contextId: state.contextId,
      directory: state.directory,
      startedAt: state.startedAt,
      ...(state.stoppedAt ? { stoppedAt: state.stoppedAt } : {}),
      captured: state.captured,
      failed: state.failed,
      active: state.active,
    };
  }
}
