import type { PublicUrlGuard } from "./public-url.guard.js";

export interface ContentHttpRequest {
  url: string;
  timeoutMs: number;
  maxBytes: number;
  acceptLanguage: string;
}

export interface ContentHttpResponse {
  html: string;
  finalUrl: string;
  contentType: string;
}

export interface ContentHttpClient {
  fetch(input: ContentHttpRequest): Promise<ContentHttpResponse>;
}

export class ContentHttpError extends Error {
  constructor(
    readonly code: "fetch_failed" | "unsupported_content",
    message: string,
  ) {
    super(message);
    this.name = "ContentHttpError";
  }
}

export class NativeContentHttpClient implements ContentHttpClient {
  constructor(private readonly urlGuard: PublicUrlGuard) {}

  async fetch(input: ContentHttpRequest): Promise<ContentHttpResponse> {
    let current = await this.urlGuard.assertAllowed(input.url);
    const deadline = Date.now() + input.timeoutMs;
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new ContentHttpError("fetch_failed", "İçerik isteği zaman aşımına uğradı");
      }
      let response: globalThis.Response;
      try {
        response = await fetch(current, {
          redirect: "manual",
          signal: AbortSignal.timeout(remainingMs),
          headers: {
            accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
            "accept-language": input.acceptLanguage,
            "user-agent": "Mozilla/5.0 (compatible; FlightScannerContent/1.0)",
          },
        });
      } catch (error) {
        throw new ContentHttpError(
          "fetch_failed",
          error instanceof Error ? `İçerik isteği başarısız: ${error.message}` : "İçerik isteği başarısız",
        );
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new ContentHttpError("fetch_failed", "Redirect hedefi bulunamadı");
        if (redirect === 5) throw new ContentHttpError("fetch_failed", "Redirect sınırı aşıldı");
        await response.body?.cancel().catch(() => undefined);
        current = await this.urlGuard.assertAllowed(new URL(location, current).toString());
        continue;
      }
      if (!response.ok) {
        throw new ContentHttpError("fetch_failed", `Kaynak HTTP ${response.status} döndürdü`);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!isSupportedContentType(contentType)) {
        throw new ContentHttpError(
          "unsupported_content",
          `Desteklenmeyen içerik tipi: ${contentType || "bilinmiyor"}`,
        );
      }
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (declaredLength > input.maxBytes) {
        throw new ContentHttpError("fetch_failed", "İçerik boyut sınırını aşıyor");
      }
      const bytes = await readLimitedBody(response, input.maxBytes);
      return {
        html: decodeBody(bytes, contentType),
        finalUrl: current.toString(),
        contentType,
      };
    }
    throw new ContentHttpError("fetch_failed", "İçerik alınamadı");
  }
}

function isSupportedContentType(value: string): boolean {
  const normalized = value.toLocaleLowerCase("en-US");
  return normalized.includes("text/html") ||
    normalized.includes("application/xhtml+xml") ||
    normalized.includes("text/plain");
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ContentHttpError("fetch_failed", "İçerik boyut sınırını aşıyor");
    }
    chunks.push(result.value);
  }
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function decodeBody(bytes: Uint8Array, contentType: string): string {
  const charset = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
