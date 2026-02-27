import type { Request } from "express";

/** Data attached to `req.l402` after successful L402 verification. */
export interface L402RequestData {
  paymentHash: string;
  caveats: string[] | null;
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
  /** Price in satoshis — fixed number or async function receiving the request. */
  price: number | ((req: Request) => number | Promise<number>);
  /** Invoice memo / description. */
  description?: string;
  /** Challenge expiry in seconds. */
  expirySeconds?: number;
  /** Macaroon caveats to attach. */
  caveats?: string[];
}

/** Options for the `l402.client()` factory. */
export interface L402ClientOptions {
  /** Max sats to pay for a single request (default: 1000). */
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
