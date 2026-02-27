# @lnbot/l402

L402 Lightning payment middleware for Express.js — paywall any API in one line.

## Install

```bash
npm install @lnbot/l402
```

## Server — Protect Routes with L402

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
  res.json({ data: "premium content", paymentHash: req.l402?.paymentHash });
});

app.listen(3000);
```

### Dynamic pricing

```typescript
// Fixed price per route
app.use("/api/cheap", l402.paywall(ln, { price: 1 }));
app.use("/api/expensive", l402.paywall(ln, { price: 100 }));

// Custom pricing function
app.use("/api/dynamic", l402.paywall(ln, {
  price: (req) => {
    if (req.path.includes("/bulk")) return 50;
    return 5;
  },
}));
```

## Client — Auto-Pay L402 APIs

```typescript
import { l402, LnBot } from "@lnbot/l402";

const ln = new LnBot({ apiKey: "key_..." });

const client = l402.client(ln, {
  maxPrice: 100,         // refuse to pay more than 100 sats per request
  budgetSats: 50000,     // daily spending limit
  budgetPeriod: "day",
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

## Header Utilities

```typescript
import { l402 } from "@lnbot/l402";

// Parse headers
l402.parseAuthorization("L402 mac:pre");
// → { macaroon: "mac", preimage: "pre" }

l402.parseChallenge('L402 macaroon="abc", invoice="lnbc1..."');
// → { macaroon: "abc", invoice: "lnbc1..." }

// Format headers
l402.formatAuthorization("mac", "pre");
// → "L402 mac:pre"

l402.formatChallenge("abc", "lnbc1...");
// → 'L402 macaroon="abc", invoice="lnbc1..."'
```

## Custom Token Store

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

## How It Works

This package is a thin glue layer. All L402 logic — macaroon creation, signature verification, preimage checking, caveat validation — lives in the [ln.bot](https://ln.bot) API via `@lnbot/sdk`.

**Server middleware** makes two SDK calls:
- `ln.l402.createChallenge()` — creates an invoice + macaroon when a client needs to pay
- `ln.l402.verify()` — verifies an L402 authorization token when a client presents one

**Client wrapper** makes one SDK call:
- `ln.l402.pay()` — pays a Lightning invoice and returns a ready-to-use Authorization header

## License

MIT
