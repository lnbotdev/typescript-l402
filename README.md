# @lnbot/l402

[![npm version](https://img.shields.io/npm/v/@lnbot/l402)](https://www.npmjs.com/package/@lnbot/l402)
[![npm downloads](https://img.shields.io/npm/dm/@lnbot/l402)](https://www.npmjs.com/package/@lnbot/l402)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@lnbot/l402)](https://bundlephobia.com/package/@lnbot/l402)
[![TypeScript](https://img.shields.io/badge/TypeScript-ready-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

**L402 payment middleware for Express.js** — paywall any API in one line. Built on [ln.bot](https://ln.bot).

Add Lightning-powered pay-per-request to any Express API. Protect premium routes with a paywall, or build clients that auto-pay L402-protected services — all without touching any cryptography.

```typescript
import express from "express";
import { l402, LnBot } from "@lnbot/l402";

const app = express();
const ln = new LnBot({ apiKey: "uk_..." });

app.use("/api/premium", l402.paywall(ln, { walletId: "wal_...", price: 10 }));

app.get("/api/premium/data", (req, res) => {
  res.json({ data: "premium content" });
});
```

> This package is a thin glue layer. All L402 logic — macaroon creation, signature verification, preimage checking — lives in the [ln.bot API](https://ln.bot/docs) via [`@lnbot/sdk`](https://www.npmjs.com/package/@lnbot/sdk). Zero crypto dependencies.

By default each payment buys one request: a token works once, on the route and at the price it was issued for. Set `reuse: true` for a pass that works until it expires.

---

## What is L402?

[L402](https://github.com/lightninglabs/L402) is a protocol built on HTTP `402 Payment Required`. It enables machine-to-machine micropayments over the Lightning Network:

1. **Client** requests a protected resource
2. **Server** returns `402` with a Lightning invoice and a macaroon token
3. **Client** pays the invoice, obtains the preimage as proof of payment
4. **Client** retries the request with `Authorization: L402 <macaroon>:<preimage>`
5. **Server** verifies the token and grants access

L402 is ideal for API monetization, AI agent tool access, pay-per-request data feeds, and any scenario where you want instant, permissionless, per-request payments without subscriptions or API key provisioning.

---

## Install

```bash
npm install @lnbot/l402
```

```bash
pnpm add @lnbot/l402
```

```bash
yarn add @lnbot/l402
```

`@lnbot/sdk` and `express` are peer dependencies and will be resolved automatically.

---

## Server — Protect Routes with L402

The `l402.paywall()` middleware intercepts requests, verifies L402 tokens via the SDK, and issues new challenges when payment is needed. Two SDK calls and no crypto of its own.

```typescript
import express from "express";
import { l402, LnBot } from "@lnbot/l402";

const app = express();
const ln = new LnBot({ apiKey: "uk_..." });

// Paywall a route group — 10 sats per request
app.use("/api/premium", l402.paywall(ln, {
  walletId: "wal_...",
  price: 10,
  description: "API access",
}));

app.get("/api/premium/data", (req, res) => {
  // req.l402 is populated after successful payment verification
  res.json({
    data: "premium content",
    paymentHash: req.l402?.paymentHash,
    paid: req.l402?.price,
  });
});

// Free routes still work normally
app.get("/api/free/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(3000);
```

### How the middleware works

1. Checks for an `Authorization: L402 ...` header
2. If present, calls `wallet.l402.verify()`: ln.bot checks the signature, the preimage and the expiry
3. Checks that the token was issued for this route and price, and that it hasn't been spent
4. If so, marks it spent, populates `req.l402` and calls `next()`
5. Otherwise calls `wallet.l402.createChallenge()` and returns a `402` response with the invoice and macaroon

### One token, one request

Each challenge carries two caveats, `lnbot_path=<path>` and `lnbot_price=<sats>`, so the token it produces only opens the route it was issued for, at that price or less. A holder can add caveats to a macaroon but never remove them, so a token can't be widened. Tokens expire after an hour unless you set `expirySeconds`, and a spent token is remembered until then.

Spent tokens are remembered in memory by default. If your API runs on more than one instance (several processes, containers or serverless functions), give every instance the same `spentStore`, or a token spent on one instance could be spent again on another:

```typescript
import { createClient } from "redis";
import type { SpentStore } from "@lnbot/l402";

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const spentStore: SpentStore = {
  // SET NX EX: true only for the first caller; the key outlives the token's expiry
  async claim(paymentHash, ttlSeconds) {
    return (await redis.set(`l402:spent:${paymentHash}`, "1", { NX: true, EX: ttlSeconds })) === "OK";
  },
};

app.use("/api/premium", l402.paywall(ln, { walletId: "wal_...", price: 10, spentStore }));
```

A token is spent when the request reaches your handler, even if the handler then fails.

### Passes: `reuse: true`

For "pay once, use for an hour", let tokens be reused until they expire. This is how 1.0 behaved, with no route or price binding:

```typescript
app.use("/api/pass", l402.paywall(ln, {
  walletId: "wal_...",
  price: 500,
  reuse: true,
  expirySeconds: 3600, // without it, a reusable token never expires
}));
```

### Dynamic pricing

```typescript
// Fixed price per route
app.use("/api/cheap", l402.paywall(ln, { walletId: "wal_...", price: 1 }));
app.use("/api/expensive", l402.paywall(ln, { walletId: "wal_...", price: 100 }));

// Custom pricing function — receives the request, returns price in sats
app.use("/api/dynamic", l402.paywall(ln, {
  walletId: "wal_...",
  price: (req) => {
    if (req.path.includes("/bulk")) return 50;
    return 5;
  },
}));
```

### Paywall options

| Option | Type | Description |
| --- | --- | --- |
| `walletId` | `string` | Wallet ID for L402 operations |
| `price` | `number \| (req) => number` | Price in satoshis — fixed or per-request |
| `description` | `string` | Invoice memo shown in wallets |
| `expirySeconds` | `number` | Token lifetime in seconds. Default `3600`; with `reuse: true`, no expiry unless set |
| `caveats` | `string[]` | Extra macaroon caveats (at most 8 while tokens are single-use) |
| `reuse` | `boolean` | `false` (default): one token, one request. `true`: a token works until it expires |
| `spentStore` | `SpentStore` | Where spent tokens are remembered. Default: in memory. Share one across instances |

---

## Client — Auto-Pay L402 APIs

The `l402.client()` wrapper makes L402 payment transparent. It detects `402` responses, pays the Lightning invoice via the SDK, and retries, all in one `fetch` call. Tokens the server marks reusable are cached and sent again.

```typescript
import { l402, LnBot } from "@lnbot/l402";

const ln = new LnBot({ apiKey: "uk_..." });

const client = l402.client(ln, {
  walletId: "wal_...",   // wallet for L402 payments
  maxPrice: 100,         // refuse invoices above 100 sats
  budgetSats: 50000,     // spending limit for the period
  budgetPeriod: "day",   // reset period: "hour" | "day" | "week" | "month"
  store: "memory",       // token cache: "memory" (default) | "none" | custom TokenStore
});

// Use like fetch — L402 payment is transparent
const response = await client.fetch("https://api.example.com/premium/data");
const data = await response.json();

// Convenience methods — all HTTP verbs
const json = await client.get("https://api.example.com/premium/data");
const result = await client.post("https://api.example.com/premium/submit", {
  body: JSON.stringify({ query: "test" }),
});
await client.put("https://api.example.com/premium/item/1", {
  body: JSON.stringify({ name: "updated" }),
});
await client.patch("https://api.example.com/premium/item/1", {
  body: JSON.stringify({ status: "active" }),
});
await client.delete("https://api.example.com/premium/item/1");
```

### How the client works

1. Checks the token cache for a valid credential
2. If cached, sends the request with the `Authorization` header
3. If no cache (or server rejects), makes a plain request
4. On `402`, parses the challenge and reads the amount from the invoice itself, then checks it against `maxPrice` and the budget. What the server says its price is doesn't count: the invoice is what gets paid, and an invoice without an amount is refused
5. Calls `wallet.l402.pay()`: the SDK pays the invoice and returns a ready-to-use token
6. Caches the token unless the server marked it single-use (`"reusable": false`), and retries the request with authorization

The budget is kept in memory, so it starts again from zero when the process restarts. To cap what an agent can spend in total, fund its wallet with only that much.

### Client options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `walletId` | `string` | — | Wallet ID for L402 operations |
| `maxPrice` | `number` | `1000` | Max sats to pay for a single request, read from the invoice |
| `budgetSats` | `number` | unlimited | Total budget in sats for the period |
| `budgetPeriod` | `string` | — | Reset period: `"hour"`, `"day"`, `"week"`, `"month"` |
| `store` | `string \| TokenStore` | `"memory"` | Token cache: `"memory"`, `"none"`, or custom |

### Custom token store

Implement the `TokenStore` interface for Redis, file system, or any persistence layer:

```typescript
import { l402, LnBot } from "@lnbot/l402";
import type { TokenStore } from "@lnbot/l402";

const ln = new LnBot({ apiKey: "uk_..." });

const redisStore: TokenStore = {
  async get(url) { /* read from Redis */ },
  async set(url, token) { /* write to Redis */ },
  async delete(url) { /* delete from Redis */ },
};

const client = l402.client(ln, { walletId: "wal_...", store: redisStore });
```

---

## Header Utilities

Parse and format L402 headers for custom integrations:

```typescript
import { l402 } from "@lnbot/l402";

// Parse Authorization: L402 <macaroon>:<preimage>
l402.parseAuthorization("L402 mac_base64:preimage_hex");
// → { macaroon: "mac_base64", preimage: "preimage_hex" }

// Parse WWW-Authenticate: L402 macaroon="...", invoice="..."
l402.parseChallenge('L402 macaroon="abc", invoice="lnbc1..."');
// → { macaroon: "abc", invoice: "lnbc1..." }

// Format headers
l402.formatAuthorization("mac_base64", "preimage_hex");
// → "L402 mac_base64:preimage_hex"

l402.formatChallenge("abc", "lnbc1...");
// → 'L402 macaroon="abc", invoice="lnbc1..."'

// Read the amount a BOLT11 invoice asks for, in sats (null if it names none)
l402.invoiceSats("lnbc100n1p...");
// → 10
```

---

## Error Handling

```typescript
import { L402Error, L402BudgetExceededError, L402PaymentFailedError } from "@lnbot/l402";

try {
  const data = await client.get("https://api.example.com/expensive");
} catch (err) {
  if (err instanceof L402BudgetExceededError) {
    // Price exceeds maxPrice or total budget exhausted
  } else if (err instanceof L402PaymentFailedError) {
    // Lightning payment failed or didn't settle
  } else if (err instanceof L402Error) {
    // Other L402 protocol error (missing header, parse failure)
  }
}
```

---

## API Reference

### Server

| Export | Description |
| --- | --- |
| `l402.paywall(ln, options)` | Express middleware factory — protects routes behind an L402 paywall. Options must include `walletId`. |
| `MemorySpentStore` | The default in-memory `SpentStore` |

### Client

| Export | Description |
| --- | --- |
| `l402.client(ln, options)` | Creates an L402-aware HTTP client with automatic payment. Options must include `walletId`. |
| `client.fetch(url, init?)` | L402-aware fetch — pays 402 challenges automatically |
| `client.get(url, init?)` | GET + JSON parse with automatic L402 payment |
| `client.post(url, init?)` | POST + JSON parse with automatic L402 payment |
| `client.put(url, init?)` | PUT + JSON parse with automatic L402 payment |
| `client.patch(url, init?)` | PATCH + JSON parse with automatic L402 payment |
| `client.delete(url, init?)` | DELETE + JSON parse with automatic L402 payment |

### Header Utilities

| Export | Description |
| --- | --- |
| `l402.parseAuthorization(header)` | Parse `Authorization: L402 ...` into `{ macaroon, preimage }` |
| `l402.parseChallenge(header)` | Parse `WWW-Authenticate: L402 ...` into `{ macaroon, invoice }` |
| `l402.formatAuthorization(macaroon, preimage)` | Format an `Authorization` header value |
| `l402.formatChallenge(macaroon, invoice)` | Format a `WWW-Authenticate` header value |
| `l402.invoiceSats(invoice)` | The amount a BOLT11 invoice asks for, in sats, or `null` |

### Types

| Type | Description |
| --- | --- |
| `L402PaywallOptions` | Options for `l402.paywall()` |
| `L402ClientOptions` | Options for `l402.client()` |
| `L402Token` | Cached L402 credential (macaroon + preimage + metadata) |
| `TokenStore` | Interface for custom token caches |
| `SpentStore` | Interface for a shared record of spent tokens |
| `L402RequestData` | Data attached to `req.l402` after verification |

### Errors

| Class | Description |
| --- | --- |
| `L402Error` | Base error for all L402 protocol errors |
| `L402BudgetExceededError` | The invoice's amount or cumulative spend exceeds configured limits |
| `L402PaymentFailedError` | Lightning payment failed or didn't return authorization |

---

## Requirements

- **Node.js 18+**, Bun, or Deno
- **Express 4+** (server middleware)
- An [ln.bot](https://ln.bot) API key — [create a wallet](https://ln.bot/docs) to get one

---

## Related packages

- [`@lnbot/sdk`](https://www.npmjs.com/package/@lnbot/sdk) — The TypeScript SDK this package is built on
- [Python SDK](https://github.com/lnbotdev/python-sdk) · [pypi](https://pypi.org/project/lnbot/)
- [Go SDK](https://github.com/lnbotdev/go-sdk) · [pkg.go.dev](https://pkg.go.dev/github.com/lnbotdev/go-sdk)
- [Rust SDK](https://github.com/lnbotdev/rust-sdk) · [crates.io](https://crates.io/crates/lnbot)

## Links

- [ln.bot](https://ln.bot) — website
- [Documentation](https://ln.bot/docs)
- [L402 specification](https://github.com/lightninglabs/L402)
- [GitHub](https://github.com/lnbotdev)
- [npm](https://www.npmjs.com/package/@lnbot/l402)

## License

MIT
