import { BrowserStateError } from "../errors.js";
import type { MarketProfile, MarketProfileId } from "../markets/market-profile.js";
import type { BrowserPageProvider } from "../managers/browser.manager.js";
import type {
  ContentExtractionInput,
  ContentExtractionResult,
  ContentExtractor,
} from "./content-extractor.js";

export type MarketContentExtractionInput = Omit<ContentExtractionInput, "locale"> & {
  marketProfile: MarketProfileId;
};

export interface MarketContentExtractor {
  extract(input: MarketContentExtractionInput): Promise<ContentExtractionResult>;
  closeAll(): Promise<void>;
}

export interface MarketContentRuntimeAdapter {
  browserManager: BrowserPageProvider;
  extractor: ContentExtractor;
}

interface MarketContentRuntime extends MarketContentRuntimeAdapter {
  profile: MarketProfile;
  queue: SerialTaskQueue;
}

export class ProfiledContentExtractor implements MarketContentExtractor {
  private readonly runtimes = new Map<MarketProfileId, MarketContentRuntime>();

  constructor(
    profiles: readonly MarketProfile[],
    createRuntime: (profile: MarketProfile) => MarketContentRuntimeAdapter,
  ) {
    for (const profile of profiles) {
      this.runtimes.set(profile.id, {
        ...createRuntime(profile),
        profile,
        queue: new SerialTaskQueue(),
      });
    }
  }

  extract(input: MarketContentExtractionInput): Promise<ContentExtractionResult> {
    const runtime = this.runtimes.get(input.marketProfile);
    if (!runtime) throw new BrowserStateError(`Market profili hazır değil: ${input.marketProfile}`);
    return runtime.queue.run(() => runtime.extractor.extract({
      urls: input.urls,
      maxCharactersPerPage: input.maxCharactersPerPage,
      renderMode: input.renderMode,
      locale: runtime.profile.locale,
    }));
  }

  async closeAll(): Promise<void> {
    const runtimes = [...this.runtimes.values()];
    await Promise.all(runtimes.map((runtime) => runtime.queue.onIdle()));
    await Promise.all(runtimes.map((runtime) => runtime.browserManager.stop()));
  }
}

class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(task);
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async onIdle(): Promise<void> {
    await this.tail;
  }
}
