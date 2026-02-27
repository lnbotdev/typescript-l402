import type { TokenStore, L402Token } from "../types.js";

/** Strip query params, hash, and trailing slashes for consistent cache keys. */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return url;
  }
}

/** Default in-memory token cache backed by a Map. */
export class MemoryStore implements TokenStore {
  private tokens = new Map<string, L402Token>();

  async get(url: string): Promise<L402Token | null> {
    return this.tokens.get(normalizeUrl(url)) ?? null;
  }

  async set(url: string, token: L402Token): Promise<void> {
    this.tokens.set(normalizeUrl(url), token);
  }

  async delete(url: string): Promise<void> {
    this.tokens.delete(normalizeUrl(url));
  }
}

/** No-op store — never caches, every request pays fresh. */
export class NoStore implements TokenStore {
  async get(): Promise<null> {
    return null;
  }
  async set(): Promise<void> {}
  async delete(): Promise<void> {}
}

/** Resolve the `store` option into a concrete TokenStore. */
export function resolveStore(
  store?: "memory" | "none" | TokenStore,
): TokenStore {
  if (!store || store === "memory") return new MemoryStore();
  if (store === "none") return new NoStore();
  return store;
}
