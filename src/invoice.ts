import { L402Error } from "./errors.js";

// Millisatoshis per unit of each BOLT11 amount multiplier.
const MSAT_PER_UNIT: Record<string, bigint> = {
  "": 100_000_000_000n, // whole bitcoin
  m: 100_000_000n,
  u: 100_000n,
  n: 100n,
};

/**
 * The amount a BOLT11 invoice asks for, in sats (rounded up), read from the
 * invoice's human-readable part. Returns `null` for an invoice without an
 * amount. Throws `L402Error` if the string isn't a BOLT11 invoice.
 *
 * The client checks prices with this, not with what a server says about
 * itself: the invoice is what gets paid.
 */
export function invoiceSats(invoice: string): number | null {
  const s = invoice.trim().toLowerCase().replace(/^lightning:/, "");
  // The data part's alphabet has no "1", so the last one is the separator.
  const hrp = s.slice(0, s.lastIndexOf("1"));
  const match = hrp.match(/^ln(?:bcrt|bc|tbs|tb|sb)(\d*)([munp]?)$/);
  if (!match) throw new L402Error("Not a BOLT11 invoice");

  const [, digits, unit] = match;
  if (!digits) return null;

  const amount = BigInt(digits);
  let msat: bigint;
  if (unit === "p") {
    // A pico-bitcoin is a tenth of a millisatoshi; BOLT11 requires whole millisatoshis.
    if (amount % 10n !== 0n) throw new L402Error("Invalid BOLT11 amount");
    msat = amount / 10n;
  } else {
    msat = amount * MSAT_PER_UNIT[unit];
  }

  return Number((msat + 999n) / 1000n);
}
