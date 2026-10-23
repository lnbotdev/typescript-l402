import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { LnBot } from "@lnbot/sdk";
import { l402 } from "../src/index.js";

// ── Mock SDK for the server side ──
// Like ln.bot, verify() returns the caveats the challenge was minted with.

const minted = new Map<string, string[] | null>();
let mintCount = 0;

const serverL402 = {
  createChallenge: vi.fn(async (req: { amount: number; caveats?: string[] | null }) => {
    const hash = `hash_${++mintCount}`;
    minted.set(hash, req.caveats ?? null);
    const invoice = `lnbc${req.amount * 10}n1p${"q".repeat(mintCount)}`;
    return {
      macaroon: `mac_${hash}`,
      invoice,
      paymentHash: hash,
      expiresAt: "2099-01-01T00:00:00Z",
      wwwAuthenticate: `L402 macaroon="mac_${hash}", invoice="${invoice}"`,
    };
  }),
  verify: vi.fn(async ({ authorization }: { authorization: string }) => {
    const hash = authorization.match(/^L402 mac_(hash_\d+):pre$/)?.[1];
    if (!hash || !minted.has(hash)) return { valid: false, paymentHash: null, caveats: null, error: "invalid token" };
    return { valid: true, paymentHash: hash, caveats: minted.get(hash) ?? null, error: null };
  }),
  pay: vi.fn(),
};
const serverLn = {
  wallet: vi.fn().mockReturnValue({ l402: serverL402 }),
} as unknown as LnBot;

// ── Mock SDK for the client side: paying yields "L402 <macaroon>:pre" ──

const clientL402 = {
  createChallenge: vi.fn(),
  verify: vi.fn(),
  pay: vi.fn(async ({ wwwAuthenticate }: { wwwAuthenticate: string }) => {
    const macaroon = wwwAuthenticate.match(/macaroon="([^"]+)"/)![1];
    return {
      authorization: `L402 ${macaroon}:pre`,
      paymentHash: macaroon.replace("mac_", ""),
      preimage: "pre",
      amount: 10,
      fee: 0,
      paymentNumber: 1,
      status: "settled",
    };
  }),
};
const clientLn = {
  wallet: vi.fn().mockReturnValue({ l402: clientL402 }),
} as unknown as LnBot;

// ── Express app ──

const app = express();
// Pay per request (the default)
app.use("/api/premium", l402.paywall(serverLn, { walletId: "wal_test", price: 10, description: "Premium API" }));
app.get("/api/premium/data", (req, res) => {
  res.json({ data: "premium content", paymentHash: req.l402?.paymentHash, price: req.l402?.price });
});
app.get("/api/premium/report", (_req, res) => {
  res.json({ data: "report" });
});
// A pass: one payment, any number of requests until it expires
app.use("/api/pass", l402.paywall(serverLn, { walletId: "wal_test", price: 10, reuse: true, expirySeconds: 600 }));
app.get("/api/pass/data", (_req, res) => {
  res.json({ data: "pass content" });
});
app.get("/api/free/health", (_req, res) => {
  res.json({ status: "ok" });
});

let server: http.Server;
let baseUrl: string;

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const port = (server.address() as AddressInfo).port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
);

beforeEach(() => {
  clientL402.pay.mockClear();
});

describe("integration: full L402 roundtrip", () => {
  it("free routes work without payment", async () => {
    const res = await fetch(`${baseUrl}/api/free/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("premium route returns 402 without auth, succeeds after payment", async () => {
    const res402 = await fetch(`${baseUrl}/api/premium/data`);
    expect(res402.status).toBe(402);
    const body402 = await res402.json();
    expect(body402).toMatchObject({ type: "payment_required", price: 10, reusable: false });
    expect(body402.invoice).toMatch(/^lnbc100n1/);

    const c = l402.client(clientLn, { walletId: "wal_test", maxPrice: 100 });
    const data = await c.get(`${baseUrl}/api/premium/data`);

    expect(data).toMatchObject({ data: "premium content", price: 10 });
    expect(clientL402.pay).toHaveBeenCalledTimes(1);
  });

  it("charges for every request, and a spent token is refused", async () => {
    const c = l402.client(clientLn, { walletId: "wal_test", maxPrice: 100 });

    await c.get(`${baseUrl}/api/premium/data`);
    await c.get(`${baseUrl}/api/premium/data`);
    expect(clientL402.pay).toHaveBeenCalledTimes(2);

    // Replaying the second payment's token gets a new challenge, not the data.
    const lastAuth = (await clientL402.pay.mock.results[1].value).authorization;
    const replay = await fetch(`${baseUrl}/api/premium/data`, { headers: { Authorization: lastAuth } });
    expect(replay.status).toBe(402);
  });

  it("a token paid for one route doesn't open another", async () => {
    const challenge = await fetch(`${baseUrl}/api/premium/data`);
    const macaroon = challenge.headers.get("www-authenticate")!.match(/macaroon="([^"]+)"/)![1];

    const elsewhere = await fetch(`${baseUrl}/api/premium/report`, { headers: { Authorization: `L402 ${macaroon}:pre` } });
    expect(elsewhere.status).toBe(402);

    const right = await fetch(`${baseUrl}/api/premium/data`, { headers: { Authorization: `L402 ${macaroon}:pre` } });
    expect(right.status).toBe(200);
  });

  it("a single-use token doesn't open the pass", async () => {
    const challenge = await fetch(`${baseUrl}/api/premium/data`);
    const macaroon = challenge.headers.get("www-authenticate")!.match(/macaroon="([^"]+)"/)![1];

    const pass = await fetch(`${baseUrl}/api/pass/data`, { headers: { Authorization: `L402 ${macaroon}:pre` } });
    expect(pass.status).toBe(402);
  });

  it("with reuse: true, the client pays once and reuses the token", async () => {
    const c = l402.client(clientLn, { walletId: "wal_test", maxPrice: 100 });

    expect(await c.get(`${baseUrl}/api/pass/data`)).toEqual({ data: "pass content" });
    expect(await c.get(`${baseUrl}/api/pass/data`)).toEqual({ data: "pass content" });
    expect(clientL402.pay).toHaveBeenCalledTimes(1);
  });
});
