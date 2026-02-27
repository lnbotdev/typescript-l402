import type { LnBot } from "@lnbot/sdk";
import type { L402ClientOptions } from "../types.js";
import {
  L402Error,
  L402PaymentFailedError,
} from "../errors.js";
import { parseChallenge, parseAuthorization } from "../server/headers.js";
import { Budget } from "./budget.js";
import { resolveStore } from "./store.js";

/** An L402-aware HTTP client that transparently pays Lightning invoices on 402 responses. */
export interface L402Client {
  /** L402-aware fetch — pays 402 challenges automatically. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** GET + JSON parse with automatic L402 payment. */
  get(url: string, init?: RequestInit): Promise<unknown>;
  /** POST + JSON parse with automatic L402 payment. */
  post(url: string, init?: RequestInit): Promise<unknown>;
}

/**
 * Create an L402-aware HTTP client.
 *
 * One SDK call: `ln.l402.pay()` — pays the invoice and returns the Authorization token.
 */
export function client(ln: LnBot, options: L402ClientOptions = {}): L402Client {
  const store = resolveStore(options.store);
  const budget = new Budget(options);
  const maxPrice = options.maxPrice ?? 1000;

  async function l402Fetch(
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    // Step 1: Check token cache
    const cached = await store.get(url);
    if (cached) {
      const isExpired =
        cached.expiresAt && cached.expiresAt.getTime() <= Date.now();
      if (!isExpired) {
        const headers = new Headers(init?.headers);
        headers.set("Authorization", cached.authorization);
        const res = await globalThis.fetch(url, { ...init, headers });
        // If the cached token was rejected (expired server-side), fall through
        if (res.status !== 402) return res;
        await store.delete(url);
      } else {
        await store.delete(url);
      }
    }

    // Step 2: Make request without auth
    const res = await globalThis.fetch(url, init);
    if (res.status !== 402) return res;

    // Step 3: Parse the 402 challenge
    const wwwAuth = res.headers.get("www-authenticate");
    if (!wwwAuth)
      throw new L402Error("402 response missing WWW-Authenticate header");

    const challenge = parseChallenge(wwwAuth);
    if (!challenge) throw new L402Error("Could not parse L402 challenge");

    // Parse body for price info
    const body = await res.json().catch(() => null);
    const price: number = body?.price ?? 0;

    // Step 4: Budget checks
    if (price > maxPrice) {
      throw new L402Error(
        `Price ${price} sats exceeds maxPrice ${maxPrice}`,
      );
    }
    budget.check(price);

    // Step 5: Pay via SDK
    const payment = await ln.l402.pay({ wwwAuthenticate: wwwAuth });

    if (payment.status === "failed") {
      throw new L402PaymentFailedError("L402 payment failed");
    }
    if (!payment.authorization) {
      throw new L402PaymentFailedError(
        "Payment did not return authorization token",
      );
    }

    // Step 6: Cache the token
    const parsed = parseAuthorization(payment.authorization);
    await store.set(url, {
      macaroon: parsed?.macaroon ?? challenge.macaroon,
      preimage: payment.preimage ?? parsed?.preimage ?? "",
      authorization: payment.authorization,
      paidAt: new Date(),
      expiresAt: body?.expiresAt
        ? new Date(body.expiresAt)
        : undefined,
    });

    budget.record(price);

    // Step 7: Retry with L402 Authorization
    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set("Authorization", payment.authorization);
    return globalThis.fetch(url, { ...init, headers: retryHeaders });
  }

  return {
    fetch: l402Fetch,
    async get(url: string, init?: RequestInit) {
      const res = await l402Fetch(url, { ...init, method: "GET" });
      return res.json();
    },
    async post(url: string, init?: RequestInit) {
      const res = await l402Fetch(url, { ...init, method: "POST" });
      return res.json();
    },
  };
}
