import type { Request, Response, NextFunction } from "express";
import type { LnBot } from "@lnbot/sdk";
import type { L402PaywallOptions } from "../types.js";
import { resolvePrice } from "./pricing.js";
import { MemorySpentStore } from "./spent.js";

/** Single-use tokens expire after an hour unless the paywall sets otherwise. */
const DEFAULT_EXPIRY_SECONDS = 3600;
/** How long a spent token is remembered when it never expires. */
const NO_EXPIRY_TTL_SECONDS = 30 * 24 * 3600;
/** The API takes up to 10 caveats; single-use tokens spend two on their binding. */
const MAX_CAVEATS = 10;
const PATH_CAVEAT = "lnbot_path=";
const PRICE_CAVEAT = "lnbot_price=";

/** The request's path without its query: what the client sends again after paying. */
function routeOf(req: Request): string {
  const url = req.originalUrl ?? req.url;
  if (url) return url.split("?")[0] || "/";
  return `${req.baseUrl ?? ""}${req.path ?? ""}` || "/";
}

/**
 * Whether a token was issued for this request. A holder can add caveats to a
 * macaroon but never remove them, so every binding caveat must hold: the
 * path must match, and every price must cover this request's price.
 */
function fits(caveats: string[] | null, path: string, price: number): boolean {
  if (!caveats) return false;
  const paths = caveats.filter((c) => c.startsWith(PATH_CAVEAT)).map((c) => c.slice(PATH_CAVEAT.length));
  const prices = caveats.filter((c) => c.startsWith(PRICE_CAVEAT)).map((c) => Number(c.slice(PRICE_CAVEAT.length)));
  return (
    paths.length > 0 &&
    prices.length > 0 &&
    paths.every((p) => p === path) &&
    prices.every((p) => Number.isFinite(p) && p >= price)
  );
}

/**
 * Express middleware factory that protects routes behind an L402 paywall.
 *
 * Two SDK calls:
 *  - `wallet.l402.verify()`: check an incoming Authorization header
 *  - `wallet.l402.createChallenge()`: mint a new invoice + macaroon challenge
 *
 * By default each token pays for one request: it carries caveats binding it
 * to the route and price it was issued for, and the paywall remembers it once
 * spent. `reuse: true` lets a token work until it expires instead.
 */
export function paywall(ln: LnBot, options: L402PaywallOptions) {
  const reuse = options.reuse ?? false;
  const expirySeconds = options.expirySeconds ?? (reuse ? undefined : DEFAULT_EXPIRY_SECONDS);
  const spentTtl = expirySeconds && expirySeconds > 0 ? expirySeconds : NO_EXPIRY_TTL_SECONDS;
  const spent = options.spentStore ?? new MemorySpentStore();

  if (!reuse && (options.caveats?.length ?? 0) > MAX_CAVEATS - 2) {
    throw new Error(
      `l402.paywall: at most ${MAX_CAVEATS - 2} caveats while tokens are single-use (two bind each token to its route and price)`,
    );
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    const wallet = ln.wallet(options.walletId);

    let price: number;
    try {
      price = await resolvePrice(options.price, req);
    } catch (err) {
      return next(err);
    }
    const path = routeOf(req);

    // Step 1: Check for an existing L402 Authorization header
    const authHeader = req.headers["authorization"];

    if (authHeader && authHeader.startsWith("L402 ")) {
      // Step 2: Verify via SDK (signature, preimage and expiry, checked by ln.bot)
      const result = await wallet.l402.verify({ authorization: authHeader }).catch(() => null);

      if (result?.valid && result.paymentHash) {
        let accepted = reuse;
        if (!reuse && fits(result.caveats, path, price)) {
          // Spend the token. A store failure is a server error, not a reason to bill again.
          try {
            accepted = await spent.claim(result.paymentHash, spentTtl);
          } catch (err) {
            return next(err);
          }
        }

        if (accepted) {
          req.l402 = { paymentHash: result.paymentHash, caveats: result.caveats, price };
          return next();
        }
      }
      // Invalid, spent, or issued for another route or price: fall through to a new challenge
    }

    // Step 3: No usable token: create a challenge via SDK
    try {
      const challenge = await wallet.l402.createChallenge({
        amount: price,
        description: options.description,
        expirySeconds,
        caveats: reuse ? options.caveats : [...(options.caveats ?? []), `${PATH_CAVEAT}${path}`, `${PRICE_CAVEAT}${price}`],
      });

      // Step 4: Return 402 with challenge
      res
        .status(402)
        .header("WWW-Authenticate", challenge.wwwAuthenticate)
        .json({
          type: "payment_required",
          title: "Payment Required",
          detail: "Pay the included Lightning invoice to access this resource.",
          invoice: challenge.invoice,
          macaroon: challenge.macaroon,
          price,
          unit: "satoshis",
          description: options.description,
          reusable: reuse,
          ...(expirySeconds && expirySeconds > 0 && { expiresAt: new Date(Date.now() + expirySeconds * 1000).toISOString() }),
        });
    } catch (err) {
      next(err);
    }
  };
}
