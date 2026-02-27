import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LnBot } from "@lnbot/sdk";
import { client } from "../src/client/fetch.js";
import { L402Error, L402PaymentFailedError } from "../src/errors.js";
import { L402BudgetExceededError } from "../src/errors.js";

// ── Mock LnBot SDK ──

function createMockLn() {
  return {
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
}

// ── Helpers for mocking fetch ──

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

const URL_PREMIUM = "https://api.example.com/premium/data";

describe("L402 client", () => {
  let ln: ReturnType<typeof createMockLn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    ln = createMockLn();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("passes through non-402 responses without payment", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(200, { data: "free" }),
    );

    const c = client(ln);
    const res = await c.fetch(URL_PREMIUM);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: "free" });
    expect(ln.l402.pay).not.toHaveBeenCalled();
  });

  it("pays 402 challenge and retries with authorization", async () => {
    const wwwAuth = 'L402 macaroon="mac123", invoice="lnbc10n1..."';
    const mockFetch = vi.fn()
      // First call: 402
      .mockResolvedValueOnce(
        jsonResponse(402, { price: 10, type: "payment_required" }, {
          "www-authenticate": wwwAuth,
        }),
      )
      // Second call (retry with auth): 200
      .mockResolvedValueOnce(jsonResponse(200, { data: "premium" }));

    globalThis.fetch = mockFetch;

    ln.l402.pay.mockResolvedValue({
      authorization: "L402 mac123:preimage_hex",
      paymentHash: "hash123",
      preimage: "preimage_hex",
      amount: 10,
      fee: 0,
      paymentNumber: 1,
      status: "settled",
    });

    const c = client(ln);
    const res = await c.fetch(URL_PREMIUM);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: "premium" });
    expect(ln.l402.pay).toHaveBeenCalledWith({ wwwAuthenticate: wwwAuth });

    // Verify retry had Authorization header
    const retryCall = mockFetch.mock.calls[1];
    const retryHeaders = retryCall[1]?.headers as Headers;
    expect(retryHeaders.get("Authorization")).toBe("L402 mac123:preimage_hex");
  });

  it("uses cached token without paying again", async () => {
    const wwwAuth = 'L402 macaroon="mac", invoice="inv"';
    const mockFetch = vi.fn()
      // First request: 402
      .mockResolvedValueOnce(
        jsonResponse(402, { price: 5 }, { "www-authenticate": wwwAuth }),
      )
      // First retry: 200
      .mockResolvedValueOnce(jsonResponse(200, { data: "first" }))
      // Second request with cached token: 200
      .mockResolvedValueOnce(jsonResponse(200, { data: "second" }));

    globalThis.fetch = mockFetch;

    ln.l402.pay.mockResolvedValue({
      authorization: "L402 mac:pre",
      paymentHash: "hash",
      preimage: "pre",
      amount: 5,
      fee: 0,
      paymentNumber: 1,
      status: "settled",
    });

    const c = client(ln);

    // First fetch — pays
    await c.fetch(URL_PREMIUM);
    expect(ln.l402.pay).toHaveBeenCalledTimes(1);

    // Second fetch — uses cache, no new payment
    const res2 = await c.fetch(URL_PREMIUM);
    expect(ln.l402.pay).toHaveBeenCalledTimes(1); // Still 1
    expect(res2.status).toBe(200);

    // Cached token was sent
    const cachedCall = mockFetch.mock.calls[2];
    const headers = cachedCall[1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("L402 mac:pre");
  });

  it("re-pays when cached token is rejected (new 402)", async () => {
    const wwwAuth = 'L402 macaroon="mac", invoice="inv"';
    const mockFetch = vi.fn()
      // First request: 402
      .mockResolvedValueOnce(
        jsonResponse(402, { price: 5 }, { "www-authenticate": wwwAuth }),
      )
      // First retry: 200
      .mockResolvedValueOnce(jsonResponse(200, { data: "first" }))
      // Second request with expired cached token: 402 again
      .mockResolvedValueOnce(
        jsonResponse(402, { price: 5 }, { "www-authenticate": wwwAuth }),
      )
      // Unauthenticated retry: 402
      .mockResolvedValueOnce(
        jsonResponse(402, { price: 5 }, { "www-authenticate": wwwAuth }),
      )
      // Re-paid retry: 200
      .mockResolvedValueOnce(jsonResponse(200, { data: "repaid" }));

    globalThis.fetch = mockFetch;

    ln.l402.pay.mockResolvedValue({
      authorization: "L402 mac:pre",
      paymentHash: "hash",
      preimage: "pre",
      amount: 5,
      fee: 0,
      paymentNumber: 1,
      status: "settled",
    });

    const c = client(ln);

    // First fetch — pays
    await c.fetch(URL_PREMIUM);
    expect(ln.l402.pay).toHaveBeenCalledTimes(1);

    // Second fetch — cached token rejected, re-pays
    const res2 = await c.fetch(URL_PREMIUM);
    expect(ln.l402.pay).toHaveBeenCalledTimes(2);
    expect(res2.status).toBe(200);
  });

  it("throws L402Error when price exceeds maxPrice", async () => {
    const wwwAuth = 'L402 macaroon="mac", invoice="inv"';
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        jsonResponse(402, { price: 500 }, { "www-authenticate": wwwAuth }),
      ),
    );

    const c = client(ln, { maxPrice: 100 });

    await expect(c.fetch(URL_PREMIUM)).rejects.toThrow(L402Error);
    await expect(c.fetch(URL_PREMIUM)).rejects.toThrow("exceeds maxPrice");
    expect(ln.l402.pay).not.toHaveBeenCalled();
  });

  it("throws L402BudgetExceededError when budget is exhausted", async () => {
    const wwwAuth = 'L402 macaroon="mac", invoice="inv"';
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      // Odd calls: 402, even calls: 200 (retries)
      if (callCount % 2 === 1) {
        return Promise.resolve(
          jsonResponse(402, { price: 60 }, { "www-authenticate": wwwAuth }),
        );
      }
      return Promise.resolve(jsonResponse(200, { data: "ok" }));
    });

    ln.l402.pay.mockResolvedValue({
      authorization: "L402 mac:pre",
      paymentHash: "hash",
      preimage: "pre",
      amount: 60,
      fee: 0,
      paymentNumber: 1,
      status: "settled",
    });

    const c = client(ln, {
      budgetSats: 100,
      budgetPeriod: "day",
      store: "none", // Disable cache so each request pays
    });

    // First request: 60 sats — succeeds
    await c.fetch(URL_PREMIUM);

    // Second request: 60 sats — exceeds 100 budget
    await expect(c.fetch(URL_PREMIUM)).rejects.toThrow(L402BudgetExceededError);
  });

  it("throws L402Error when 402 response has no WWW-Authenticate", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(402, { error: "pay up" }),
    );

    const c = client(ln);

    await expect(c.fetch(URL_PREMIUM)).rejects.toThrow(
      "402 response missing WWW-Authenticate header",
    );
  });

  it("throws L402PaymentFailedError when payment fails", async () => {
    const wwwAuth = 'L402 macaroon="mac", invoice="inv"';
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(402, { price: 10 }, { "www-authenticate": wwwAuth }),
    );

    ln.l402.pay.mockResolvedValue({
      authorization: null,
      paymentHash: "hash",
      preimage: null,
      amount: 10,
      fee: null,
      paymentNumber: 0,
      status: "failed",
    });

    const c = client(ln);

    await expect(c.fetch(URL_PREMIUM)).rejects.toThrow(L402PaymentFailedError);
  });

  it("get() returns parsed JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(200, { result: 42 }),
    );

    const c = client(ln);
    const data = await c.get(URL_PREMIUM);

    expect(data).toEqual({ result: 42 });
  });

  it("post() sends POST method and returns parsed JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(200, { created: true }),
    );

    const c = client(ln);
    const data = await c.post(URL_PREMIUM, {
      body: JSON.stringify({ query: "test" }),
    });

    expect(data).toEqual({ created: true });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]?.method).toBe("POST");
  });

  it("defaults maxPrice to 1000 sats", async () => {
    const wwwAuth = 'L402 macaroon="mac", invoice="inv"';
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        jsonResponse(402, { price: 1001 }, { "www-authenticate": wwwAuth }),
      ),
    );

    const c = client(ln); // No maxPrice specified

    await expect(c.fetch(URL_PREMIUM)).rejects.toThrow("exceeds maxPrice 1000");
  });
});
