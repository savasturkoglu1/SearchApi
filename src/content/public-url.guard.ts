import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type DnsResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export class PublicUrlError extends Error {
  constructor(
    readonly code: "invalid_url" | "blocked_target",
    message: string,
  ) {
    super(message);
    this.name = "PublicUrlError";
  }
}

export class PublicUrlGuard {
  private readonly cache = new Map<string, { expiresAt: number; addresses: readonly ResolvedAddress[] }>();

  constructor(
    private readonly resolve: DnsResolver = (hostname) => lookup(hostname, {
      all: true,
      verbatim: true,
    }),
  ) {}

  async assertAllowed(value: string): Promise<URL> {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new PublicUrlError("invalid_url", "Geçerli bir URL gerekli");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new PublicUrlError("invalid_url", "Yalnızca http ve https URL'leri desteklenir");
    }
    if (url.username || url.password) {
      throw new PublicUrlError("blocked_target", "URL içinde kullanıcı bilgisi kullanılamaz");
    }
    if (url.port && url.port !== "80" && url.port !== "443") {
      throw new PublicUrlError("blocked_target", "Yalnızca standart web portlarına izin verilir");
    }

    const hostname = url.hostname
      .replace(/\.$/, "")
      .replace(/^\[|\]$/g, "")
      .toLocaleLowerCase("en-US");
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".lan") ||
      hostname.endsWith(".home")
    ) {
      throw new PublicUrlError("blocked_target", "Local veya internal hostlara erişilemez");
    }

    const directFamily = isIP(hostname);
    const addresses = directFamily
      ? [{ address: hostname, family: directFamily }]
      : await this.resolveCached(hostname);
    if (addresses.length === 0) {
      throw new PublicUrlError("blocked_target", "Host için public IP çözümlenemedi");
    }
    if (addresses.some((entry) => !isPublicAddress(entry.address))) {
      throw new PublicUrlError("blocked_target", "Private veya özel ağ hedeflerine erişilemez");
    }
    return url;
  }

  private async resolveCached(hostname: string): Promise<readonly ResolvedAddress[]> {
    const cached = this.cache.get(hostname);
    if (cached && cached.expiresAt > Date.now()) return cached.addresses;
    let addresses: readonly ResolvedAddress[];
    try {
      addresses = await this.resolve(hostname);
    } catch {
      throw new PublicUrlError("blocked_target", "Host çözümlenemedi");
    }
    this.cache.set(hostname, { expiresAt: Date.now() + 60_000, addresses });
    return addresses;
  }
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;

  const normalized = address.toLocaleLowerCase("en-US").split("%")[0] ?? "";
  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  ) return false;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return mapped.includes(".") ? isPublicIpv4(mapped) : false;
  }
  return true;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  const first = parts[0];
  const second = parts[1];
  const third = parts[2];
  if (
    parts.length !== 4 ||
    first === undefined ||
    second === undefined ||
    third === undefined
  ) return false;
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}
