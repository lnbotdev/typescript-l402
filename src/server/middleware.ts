import type { Request, Response, NextFunction } from "express";
import type { LnBot } from "@lnbot/sdk";
import type { L402PaywallOptions } from "../types.js";
import { resolvePrice } from "./pricing.js";

/**
 * Express middleware factory that protects routes behind an L402 paywall.
 *
 * Two SDK calls:
 *  - `ln.l402.verify()` — check an incoming Authorization header
 *  - `ln.l402.createChallenge()` — mint a new invoice + macaroon challenge
 */
export function paywall(ln: LnBot, options: L402PaywallOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Step 1: Check for existing L402 Authorization header
    const authHeader = req.headers["authorization"];

    if (authHeader && authHeader.startsWith("L402 ")) {
      // Step 2: Verify via SDK (stateless — checks signature, preimage, caveats)
      try {
        const result = await ln.l402.verify({ authorization: authHeader });

        if (result.valid) {
          req.l402 = {
            paymentHash: result.paymentHash!,
            caveats: result.caveats,
          };
          return next();
        }
      } catch {
        // Verification failed or errored — fall through to issue new challenge
      }
    }

    // Step 3: No valid token — create a challenge via SDK
    const price = await resolvePrice(options.price, req);

    try {
      const challenge = await ln.l402.createChallenge({
        amount: price,
        description: options.description,
        expirySeconds: options.expirySeconds,
        caveats: options.caveats,
      });

      // Step 4: Return 402 with challenge
      res
        .status(402)
        .header("WWW-Authenticate", challenge.wwwAuthenticate)
        .json({
          type: "payment_required",
          title: "Payment Required",
          detail:
            "Pay the included Lightning invoice to access this resource.",
          invoice: challenge.invoice,
          macaroon: challenge.macaroon,
          price,
          unit: "satoshis",
          description: options.description,
        });
    } catch (err) {
      next(err);
    }
  };
}
