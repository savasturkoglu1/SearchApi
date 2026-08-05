export class ResourceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceNotFoundError";
  }
}

export class CapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapacityError";
  }
}

export class BrowserStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserStateError";
  }
}

export class ExternalSearchError extends Error {
  readonly statusCode = 502;

  constructor(message: string) {
    super(message);
    this.name = "ExternalSearchError";
  }
}
