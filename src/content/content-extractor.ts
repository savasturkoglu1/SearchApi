export type ContentRenderMode = "auto" | "http" | "browser";

export interface ContentExtractionInput {
  urls: string[];
  maxCharactersPerPage: number;
  renderMode: ContentRenderMode;
  locale: string;
}

export interface ContentChunk {
  id: string;
  heading?: string;
  text: string;
}

export interface ExtractedContentPage {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  description?: string;
  author?: string;
  publishedAt?: string;
  language?: string;
  text: string;
  chunks: ContentChunk[];
  contentLength: number;
  truncated: boolean;
  extractionMode: "http" | "browser";
  contentTrust: "external_untrusted";
  contentHash: string;
  retrievedAt: string;
}

export interface ContentExtractionError {
  requestedUrl: string;
  code:
    | "invalid_url"
    | "blocked_target"
    | "fetch_failed"
    | "unsupported_content"
    | "extraction_failed";
  message: string;
}

export interface ContentExtractionResult {
  pages: ExtractedContentPage[];
  errors: ContentExtractionError[];
}

export interface ContentExtractor {
  extract(input: ContentExtractionInput): Promise<ContentExtractionResult>;
}
