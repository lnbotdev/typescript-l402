import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { LnBot } from "@lnbot/sdk";
import { l402 } from "../src/index.js";

// ── Mock SDK for server side ──

const serverLn = {
  l402: {
    createChallenge: vi.fn(),
    verify: vi.fn(),
    pay: vi.fn(),
  },
} as unknown as LnBot & {
  l402: {
    createChallenge: ReturnType<typeof vi.fn>;
    verify: ReturnType<typeof vi.fn>;
  };
};

// ── Mock SDK for client side ──

const clientLn = {
  l402: {
    createChallenge: vi.fn(),
    verify: vi.fn(),
    pay: vi.fn(),
  },
} as unknown as LnBot & {
  l402: {
    pay: ReturnType<typeof vi.fn>;
  };
};

// ── Express app ──

const app = express();
app.use(
  "/api/premium",
  l402.paywall(serverLn, { price: 10, description: "Premium API" }),
);
app.get("/api/premium/data", (req, res) => {
  res.json({ data: "premium content", paymentHash: req.l402?.paymentHash });
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

describe("integration: full L402 roundtrip", () => {
  it("free routes work without payment", async () => {
    const res = await fetch(`${baseUrl}/api/free/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("premium route returns 402 without auth, succeeds after payment", async () => {
    // Set up server mocks
    const wwwAuth = 'L402 macaroon="test_mac", invoice="lnbc10n1test"';
    (serverLn.l402.createChallenge as ReturnType<typeof vi.fn>).mockResolvedValue({
      macaroon: "test_mac",
      invoice: "lnbc10n1test",
      paymentHash: "test_hash",
      expiresAt: "2099-01-01T00:00:00Z",
      wwwAuthenticate: wwwAuth,
    });
    (serverLn.l402.verify as ReturnType<typeof vi.fn>).mockResolvedValue({
      valid: true,
      paymentHash: "test_hash",
      caveats: null,
      error: null,
    });

    // Set up client mocks
    clientLn.l402.pay.mockResolvedValue({
      authorization: "L402 test_mac:test_preimage",
      paymentHash: "test_hash",
      preimage: "test_preimage",
      amount: 10,
      fee: 0,
      paymentNumber: 1,
      status: "settled",
    });

    // Step 1: Direct fetch without auth — should get 402
    const res402 = await fetch(`${baseUrl}/api/premium/data`);
    expect(res402.status).toBe(402);
    const body402 = await res402.json();
    expect(body402.type).toBe("payment_required");
    expect(body402.price).toBe(10);
    expect(body402.invoice).toBe("lnbc10n1test");

    // Step 2: Use L402 client — should pay and succeed
    const c = l402.client(clientLn, { maxPrice: 100 });
    const data = await c.get(`${baseUrl}/api/premium/data`);

    expect(data).toMatchObject({
      data: "premium content",
      paymentHash: "test_hash",
    });

    // Verify client called pay
    expect(clientLn.l402.pay).toHaveBeenCalledWith({
      wwwAuthenticate: wwwAuth,
    });
  });

  it("L402 client caches token and reuses it", async () => {
    const wwwAuth = 'L402 macaroon="cache_mac", invoice="lnbc1cache"';
    (serverLn.l402.createChallenge as ReturnType<typeof vi.fn>).mockResolvedValue({
      macaroon: "cache_mac",
      invoice: "lnbc1cache",
      paymentHash: "cache_hash",
      expiresAt: "2099-01-01T00:00:00Z",
      wwwAuthenticate: wwwAuth,
    });
    (serverLn.l402.verify as ReturnType<typeof vi.fn>).mockResolvedValue({
      valid: true,
      paymentHash: "cache_hash",
      caveats: null,
      error: null,
    });

    clientLn.l402.pay.mockClear();
    clientLn.l402.pay.mockResolvedValue({
      authorization: "L402 cache_mac:cache_pre",
      paymentHash: "cache_hash",
      preimage: "cache_pre",
      amount: 10,
      fee: 0,
      paymentNumber: 1,
      status: "settled",
    });

    const c = l402.client(clientLn, { maxPrice: 100 });

    // First request — pays
    await c.get(`${baseUrl}/api/premium/data`);
    expect(clientLn.l402.pay).toHaveBeenCalledTimes(1);

    // Second request — uses cached token, no new payment
    await c.get(`${baseUrl}/api/premium/data`);
    expect(clientLn.l402.pay).toHaveBeenCalledTimes(1);
  });
});
