import type { Request } from "express";

/** Data attached to `req.l402` after successful L402 verification. */
export interface L402RequestData {
  paymentHash: string;
  caveats: string[] | null;
  /** The price of this request, in sats. */
  price: number;
}

declare global {
  namespace Express {
    interface Request {
      l402?: L402RequestData;
    }
  }
}

/** Options for the `l402.paywall()` middleware. */
export interface L402PaywallOptions {
  /** The wallet ID to use for L402 operations. */
  walletId: string;
  /** Price in satoshis — fixed number or async function receiving the request. */
  price: number | ((req: Request) => number | Promise<number>);
  /** Invoice memo / description. */
  description?: string;
  /**
   * Token lifetime in seconds. Defaults to 3600 while tokens are single-use;
   * with `reuse: true` a token has no expiry unless you set one.
   */
  expirySeconds?: number;
  /** Macaroon caveats to attach (at most 8 while tokens are single-use). */
  caveats?: string[];
  /**
   * `false` (the default): a token pays for one request. It works once, on
   * the route and at the price it was issued for.
   * `true`: a token keeps working until it expires, on any route this
   * paywall guards (a time-boxed pass; the 1.0 behaviour).
   */
  reuse?: boolean;
  /**
   * Where used tokens are remembered (default: this process's memory).
   * When the API runs on several instances, pass a store they share, so a
   * token spent on one can't be spent again on another.
   */
  spentStore?: SpentStore;
}

/** Remembers which tokens have been used, so a single-use token works once. */
export interface SpentStore {
  /**
   * Mark the token with this payment hash as used, for `ttlSeconds` (after
   * which it has expired anyway). Resolves `true` if this call claimed it,
   * `false` if it was already used. Must be atomic across callers.
   */
  claim(paymentHash: string, ttlSeconds: number): Promise<boolean>;
}

/** Options for the `l402.client()` factory. */
export interface L402ClientOptions {
  /** The wallet ID to use for L402 operations. */
  walletId: string;
  /** Max sats to pay for a single request, checked against the invoice itself (default: 1000). */
  maxPrice?: number;
  /** Total budget in sats for the period. */
  budgetSats?: number;
  /** Budget reset period. */
  budgetPeriod?: "hour" | "day" | "week" | "month";
  /** Token cache strategy (default: "memory"). */
  store?: "memory" | "none" | TokenStore;
}

/** Pluggable token cache. */
export interface TokenStore {
  get(url: string): Promise<L402Token | null>;
  set(url: string, token: L402Token): Promise<void>;
  delete(url: string): Promise<void>;
}

/** A cached L402 credential. */
export interface L402Token {
  macaroon: string;
  preimage: string;
  authorization: string;
  paidAt: Date;
  expiresAt?: Date;
}
