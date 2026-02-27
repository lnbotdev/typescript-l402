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
const ln = new LnBot({ apiKey: "key_..." });

app.use("/api/premium", l402.paywall(ln, { price: 10 }));

app.get("/api/premium/data", (req, res) => {
  res.json({ data: "premium content" });
});
```

> This package is a thin glue layer. All L402 logic — macaroon creation, signature verification, preimage checking — lives in the [ln.bot API](https://ln.bot/docs) via [`@lnbot/sdk`](https://www.npmjs.com/package/@lnbot/sdk). Zero crypto dependencies.

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

The `l402.paywall()` middleware intercepts requests, verifies L402 tokens via the SDK, and issues new challenges when payment is needed. Two SDK calls, ~40 lines of glue code, zero crypto.

```typescript
import express from "express";
import { l402, LnBot } from "@lnbot/l402";

const app = express();
const ln = new LnBot({ apiKey: "key_..." });

// Paywall a route group — 10 sats per request
app.use("/api/premium", l402.paywall(ln, {
  price: 10,
  description: "API access",
}));

app.get("/api/premium/data", (req, res) => {
  // req.l402 is populated after successful payment verification
  res.json({
    data: "premium content",
    paymentHash: req.l402?.paymentHash,
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
2. If present, calls `ln.l402.verify()` — the SDK checks signature, preimage, and caveats server-side
3. If valid, populates `req.l402` and calls `next()`
4. If missing or invalid, calls `ln.l402.createChallenge()` and returns a `402` response with the invoice and macaroon

### Dynamic pricing

```typescript
// Fixed price per route
app.use("/api/cheap", l402.paywall(ln, { price: 1 }));
app.use("/api/expensive", l402.paywall(ln, { price: 100 }));

// Custom pricing function — receives the request, returns price in sats
app.use("/api/dynamic", l402.paywall(ln, {
  price: (req) => {
    if (req.path.includes("/bulk")) return 50;
    return 5;
  },
}));
```

### Paywall options

| Option | Type | Description |
| --- | --- | --- |
| `price` | `number \| (req) => number` | Price in satoshis — fixed or per-request |
| `description` | `string` | Invoice memo shown in wallets |
| `expirySeconds` | `number` | Challenge expiry in seconds |
| `caveats` | `string[]` | Macaroon caveats to attach |

---

## Client — Auto-Pay L402 APIs

The `l402.client()` wrapper makes L402 payment transparent. It detects `402` responses, pays the Lightning invoice via the SDK, caches the token, and retries — all in one `fetch` call.

```typescript
import { l402, LnBot } from "@lnbot/l402";

const ln = new LnBot({ apiKey: "key_..." });

const client = l402.client(ln, {
  maxPrice: 100,         // refuse to pay more than 100 sats per request
  budgetSats: 50000,     // spending limit for the period
  budgetPeriod: "day",   // reset period: "hour" | "day" | "week" | "month"
  store: "memory",       // token cache: "memory" (default) | "none" | custom TokenStore
});

// Use like fetch — L402 payment is transparent
const response = await client.fetch("https://api.example.com/premium/data");
const data = await response.json();

// Convenience methods
const json = await client.get("https://api.example.com/premium/data");
const result = await client.post("https://api.example.com/premium/submit", {
  body: JSON.stringify({ query: "test" }),
});
```

### How the client works

1. Checks the token cache for a valid credential
2. If cached, sends the request with the `Authorization` header
3. If no cache (or server rejects), makes a plain request
4. On `402`, parses the challenge and checks budget limits
5. Calls `ln.l402.pay()` — the SDK pays the invoice and returns a ready-to-use token
6. Caches the token and retries the request with authorization

### Client options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `maxPrice` | `number` | `1000` | Max sats to pay for a single request |
| `budgetSats` | `number` | unlimited | Total budget in sats for the period |
| `budgetPeriod` | `string` | — | Reset period: `"hour"`, `"day"`, `"week"`, `"month"` |
| `store` | `string \| TokenStore` | `"memory"` | Token cache: `"memory"`, `"none"`, or custom |

### Custom token store

Implement the `TokenStore` interface for Redis, file system, or any persistence layer:

```typescript
import { l402, LnBot } from "@lnbot/l402";
import type { TokenStore } from "@lnbot/l402";

const ln = new LnBot({ apiKey: "key_..." });

const redisStore: TokenStore = {
  async get(url) { /* read from Redis */ },
  async set(url, token) { /* write to Redis */ },
  async delete(url) { /* delete from Redis */ },
};

const client = l402.client(ln, { store: redisStore });
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
| `l402.paywall(ln, options)` | Express middleware factory — protects routes behind an L402 paywall |

### Client

| Export | Description |
| --- | --- |
| `l402.client(ln, options?)` | Creates an L402-aware HTTP client with automatic payment |

### Header Utilities

| Export | Description |
| --- | --- |
| `l402.parseAuthorization(header)` | Parse `Authorization: L402 ...` into `{ macaroon, preimage }` |
| `l402.parseChallenge(header)` | Parse `WWW-Authenticate: L402 ...` into `{ macaroon, invoice }` |
| `l402.formatAuthorization(macaroon, preimage)` | Format an `Authorization` header value |
| `l402.formatChallenge(macaroon, invoice)` | Format a `WWW-Authenticate` header value |

### Types

| Type | Description |
| --- | --- |
| `L402PaywallOptions` | Options for `l402.paywall()` |
| `L402ClientOptions` | Options for `l402.client()` |
| `L402Token` | Cached L402 credential (macaroon + preimage + metadata) |
| `TokenStore` | Interface for custom token caches |
| `L402RequestData` | Data attached to `req.l402` after verification |

### Errors

| Class | Description |
| --- | --- |
| `L402Error` | Base error for all L402 protocol errors |
| `L402BudgetExceededError` | Price or cumulative spend exceeds configured limits |
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
