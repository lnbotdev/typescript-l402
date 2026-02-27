/** Parse an L402 Authorization header into { macaroon, preimage }. */
export function parseAuthorization(
  header: string,
): { macaroon: string; preimage: string } | null {
  if (!header.startsWith("L402 ")) return null;
  const token = header.slice(5);
  const colonIndex = token.lastIndexOf(":");
  if (colonIndex === -1) return null;
  return {
    macaroon: token.slice(0, colonIndex),
    preimage: token.slice(colonIndex + 1),
  };
}

/** Parse a WWW-Authenticate: L402 header into { macaroon, invoice }. */
export function parseChallenge(
  header: string,
): { macaroon: string; invoice: string } | null {
  if (!header.startsWith("L402 ")) return null;
  const macaroonMatch = header.match(/macaroon="([^"]+)"/);
  const invoiceMatch = header.match(/invoice="([^"]+)"/);
  if (!macaroonMatch || !invoiceMatch) return null;
  return { macaroon: macaroonMatch[1], invoice: invoiceMatch[1] };
}

/** Format an Authorization header value. */
export function formatAuthorization(
  macaroon: string,
  preimage: string,
): string {
  return `L402 ${macaroon}:${preimage}`;
}

/** Format a WWW-Authenticate header value. */
export function formatChallenge(
  macaroon: string,
  invoice: string,
): string {
  return `L402 macaroon="${macaroon}", invoice="${invoice}"`;
}
