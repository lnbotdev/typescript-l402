import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import type { LnBot } from "@lnbot/sdk";
import { paywall } from "../src/server/middleware.js";

// ── Mock LnBot SDK ──

function createMockLn() {
  const l402 = {
    createChallenge: vi.fn(),
    verify: vi.fn(),
    pay: vi.fn(),
  };
  return {
    wallet: vi.fn().mockReturnValue({ l402 }),
    _l402: l402,
  } as unknown as LnBot & {
    wallet: ReturnType<typeof vi.fn>;
    _l402: {
      createChallenge: ReturnType<typeof vi.fn>;
      verify: ReturnType<typeof vi.fn>;
      pay: ReturnType<typeof vi.fn>;
    };
  };
}

// ── Mock Express req / res / next ──

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    path: "/test",
    ...overrides,
  } as unknown as Request;
}

function mockRes() {
  const res = {
    _status: 0,
    _headers: {} as Record<string, string>,
    _body: null as unknown,
    status(code: number) {
      res._status = code;
      return res;
    },
    header(key: string, value: string) {
      res._headers[key] = value;
      return res;
    },
    json(body: unknown) {
      res._body = body;
      return res;
    },
  };
  return res as unknown as Response & {
    _status: number;
    _headers: Record<string, string>;
    _body: unknown;
  };
}

describe("paywall middleware", () => {
  let ln: ReturnType<typeof createMockLn>;

  beforeEach(() => {
    ln = createMockLn();
  });

  it("returns 402 with challenge when no Authorization header is present", async () => {
    ln._l402.createChallenge.mockResolvedValue({
      macaroon: "mac_base64",
      invoice: "lnbc10n1...",
      paymentHash: "abc123",
      expiresAt: "2099-01-01T00:00:00Z",
      wwwAuthenticate: 'L402 macaroon="mac_base64", invoice="lnbc10n1..."',
    });

    const mw = paywall(ln, { walletId: "wal_test", price: 10, description: "Test API" });
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    await mw(req, res as unknown as Response, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(402);
    expect(res._headers["WWW-Authenticate"]).toBe(
      'L402 macaroon="mac_base64", invoice="lnbc10n1..."',
    );
    expect(res._body).toMatchObject({
      type: "payment_required",
      invoice: "lnbc10n1...",
      macaroon: "mac_base64",
      price: 10,
      unit: "satoshis",
      description: "Test API",
      reusable: false,
    });
    expect((res._body as { expiresAt: string }).expiresAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    // Single-use by default: an hour's expiry, and caveats binding the token to its route and price.
    expect(ln._l402.createChallenge).toHaveBeenCalledWith({
      amount: 10,
      description: "Test API",
      expirySeconds: 3600,
      caveats: ["lnbot_path=/test", "lnbot_price=10"],
    });
  });

  it("calls next() and populates req.l402 when valid L402 token is present", async () => {
    ln._l402.verify.mockResolvedValue({
      valid: true,
      paymentHash: "hash123",
      caveats: ["expiry=2099", "lnbot_path=/test", "lnbot_price=10"],
      error: null,
    });

    const mw = paywall(ln, { walletId: "wal_test", price: 10 });
    const req = mockReq({
      headers: { authorization: "L402 macaroon_data:preimage_hex" },
    });
    const res = mockRes();
    const next = vi.fn();

    await mw(req, res as unknown as Response, next as NextFunction);

    expect(next).toHaveBeenCalled();
    expect(req.l402).toEqual({
      paymentHash: "hash123",
      caveats: ["expiry=2099", "lnbot_path=/test", "lnbot_price=10"],
      price: 10,
    });
    expect(ln._l402.verify).toHaveBeenCalledWith({
      authorization: "L402 macaroon_data:preimage_hex",
    });
    expect(ln._l402.createChallenge).not.toHaveBeenCalled();
  });

  it("issues new challenge when verify returns valid: false", async () => {
    ln._l402.verify.mockResolvedValue({
      valid: false,
      paymentHash: null,
      caveats: null,
      error: "invalid preimage",
    });
    ln._l402.createChallenge.mockResolvedValue({
      macaroon: "new_mac",
      invoice: "lnbc20n1...",
      paymentHash: "xyz",
      expiresAt: "2099-01-01T00:00:00Z",
      wwwAuthenticate: 'L402 macaroon="new_mac", invoice="lnbc20n1..."',
    });

    const mw = paywall(ln, { walletId: "wal_test", price: 20 });
    const req = mockReq({
      headers: { authorization: "L402 bad_mac:bad_preimage" },
    });
    const res = mockRes();
    const next = vi.fn();

    await mw(req, res as unknown as Response, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(402);
    expect(ln._l402.verify).toHaveBeenCalled();
    expect(ln._l402.createChallenge).toHaveBeenCalled();
  });

  it("issues new challenge when verify throws", async () => {
    ln._l402.verify.mockRejectedValue(new Error("network error"));
    ln._l402.createChallenge.mockResolvedValue({
      macaroon: "mac",
      invoice: "inv",
      paymentHash: "ph",
      expiresAt: "2099-01-01T00:00:00Z",
      wwwAuthenticate: 'L402 macaroon="mac", invoice="inv"',
    });

    const mw = paywall(ln, { walletId: "wal_test", price: 5 });
    const req = mockReq({
      headers: { authorization: "L402 mac:pre" },
    });
    const res = mockRes();
    const next = vi.fn();

    await mw(req, res as unknown as Response, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(402);
  });

  it("supports dynamic pricing function", async () => {
    ln._l402.createChallenge.mockResolvedValue({
      macaroon: "mac",
      invoice: "inv",
      paymentHash: "ph",
      expiresAt: "2099-01-01T00:00:00Z",
      wwwAuthenticate: 'L402 macaroon="mac", invoice="inv"',
    });

    const priceFn = vi.fn().mockReturnValue(42);
    const mw = paywall(ln, { walletId: "wal_test", price: priceFn });
    const req = mockReq({ path: "/bulk" });
    const res = mockRes();
    const next = vi.fn();

    await mw(req, res as unknown as Response, next as NextFunction);

    expect(priceFn).toHaveBeenCalledWith(req);
    expect(ln._l402.createChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 42 }),
    );
  });

  it("supports async pricing function", async () => {
    ln._l402.createChallenge.mockResolvedValue({
      macaroon: "mac",
      invoice: "inv",
      paymentHash: "ph",
      expiresAt: "2099-01-01T00:00:00Z",
      wwwAuthenticate: 'L402 macaroon="mac", invoice="inv"',
    });

    const mw = paywall(ln, {
      walletId: "wal_test",
      price: async () => 99,
    });
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    await mw(req, res as unknown as Response, next as NextFunction);

    expect(ln._l402.createChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 99 }),
    );
  });

  it("skips non-L402 Authorization headers", async () => {
    ln._l402.createChallenge.mockResolvedValue({
      macaroon: "mac",
      invoice: "inv",
      paymentHash: "ph",
      expiresAt: "2099-01-01T00:00:00Z",
      wwwAuthenticate: 'L402 macaroon="mac", invoice="inv"',
    });

    const mw = paywall(ln, { walletId: "wal_test", price: 10 });
    const req = mockReq({
      headers: { authorization: "Bearer some_jwt_token" },
    });
    const res = mockRes();
    const next = vi.fn();

    await mw(req, res as unknown as Response, next as NextFunction);

    expect(ln._l402.verify).not.toHaveBeenCalled();
    expect(res._status).toBe(402);
  });

  it("calls next(err) when createChallenge throws", async () => {
    const error = new Error("SDK error");
    ln._l402.createChallenge.mockRejectedValue(error);

    const mw = paywall(ln, { walletId: "wal_test", price: 10 });
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    await mw(req, res as unknown as Response, next as NextFunction);

    expect(next).toHaveBeenCalledWith(error);
  });

  it("passes expirySeconds and caveats to createChallenge", async () => {
    ln._l402.createChallenge.mockResolvedValue({
      macaroon: "mac",
      invoice: "inv",
      paymentHash: "ph",
      expiresAt: "2099-01-01T00:00:00Z",
      wwwAuthenticate: 'L402 macaroon="mac", invoice="inv"',
    });

    const mw = paywall(ln, {
      walletId: "wal_test",
      price: 10,
      description: "desc",
      expirySeconds: 300,
      caveats: ["service=api"],
    });
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    await mw(req, res as unknown as Response, next as NextFunction);

    expect(ln._l402.createChallenge).toHaveBeenCalledWith({
      amount: 10,
      description: "desc",
      expirySeconds: 300,
      caveats: ["service=api", "lnbot_path=/test", "lnbot_price=10"],
    });
  });
});

describe("paywall middleware: one token, one request", () => {
  let ln: ReturnType<typeof createMockLn>;

  const challenge = {
    macaroon: "mac",
    invoice: "lnbc100n1pjtestdata",
    paymentHash: "ph",
    expiresAt: "2099-01-01T00:00:00Z",
    wwwAuthenticate: 'L402 macaroon="mac", invoice="lnbc100n1pjtestdata"',
  };

  function valid(caveats: string[] | null, paymentHash = "hash1") {
    ln._l402.verify.mockResolvedValue({ valid: true, paymentHash, caveats, error: null });
  }

  async function call(mw: ReturnType<typeof paywall>, overrides: Partial<Request> = {}) {
    const req = mockReq({ headers: { authorization: "L402 mac:pre" }, ...overrides });
    const res = mockRes();
    const next = vi.fn();
    await mw(req, res as unknown as Response, next as NextFunction);
    return { req, res, next };
  }

  beforeEach(() => {
    ln = createMockLn();
    ln._l402.createChallenge.mockResolvedValue(challenge);
  });

  it("accepts a token once, then asks for a new payment", async () => {
    valid(["lnbot_path=/test", "lnbot_price=10"]);
    const mw = paywall(ln, { walletId: "wal_test", price: 10 });

    const first = await call(mw);
    expect(first.next).toHaveBeenCalledWith();

    const second = await call(mw);
    expect(second.next).not.toHaveBeenCalled();
    expect(second.res._status).toBe(402);
  });

  it("rejects a token issued for another route", async () => {
    valid(["lnbot_path=/cheap", "lnbot_price=10"]);
    const { next, res } = await call(paywall(ln, { walletId: "wal_test", price: 10 }));

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(402);
  });

  it("rejects a token issued at a lower price", async () => {
    valid(["lnbot_path=/test", "lnbot_price=5"]);
    const { next, res } = await call(paywall(ln, { walletId: "wal_test", price: 10 }));

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(402);
  });

  it("rejects a valid token that carries no binding", async () => {
    valid(["expiry=2099"]);
    const a = await call(paywall(ln, { walletId: "wal_test", price: 10 }));
    expect(a.next).not.toHaveBeenCalled();

    valid(null, "hash2");
    const b = await call(paywall(ln, { walletId: "wal_test", price: 10 }));
    expect(b.next).not.toHaveBeenCalled();
    expect(b.res._status).toBe(402);
  });

  it("can't be widened by caveats a holder adds", async () => {
    // A holder can append caveats but not remove the issued ones, so every one must hold.
    valid(["lnbot_path=/test", "lnbot_price=5", "lnbot_price=1000"]);
    const cheap = await call(paywall(ln, { walletId: "wal_test", price: 10 }));
    expect(cheap.next).not.toHaveBeenCalled();

    valid(["lnbot_path=/test", "lnbot_path=/other", "lnbot_price=10"], "hash2");
    const elsewhere = await call(paywall(ln, { walletId: "wal_test", price: 10 }));
    expect(elsewhere.next).not.toHaveBeenCalled();

    valid(["lnbot_path=/test", "lnbot_price=10", "lnbot_price=1000"], "hash3");
    const narrowed = await call(paywall(ln, { walletId: "wal_test", price: 10 }));
    expect(narrowed.next).toHaveBeenCalledWith();
  });

  it("binds to the full path, without the query, when mounted under a prefix", async () => {
    const mw = paywall(ln, { walletId: "wal_test", price: 10 });
    await call(mw, {
      headers: {},
      originalUrl: "/api/premium/data?page=2",
      baseUrl: "/api/premium",
      path: "/data",
    });

    expect(ln._l402.createChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ caveats: ["lnbot_path=/api/premium/data", "lnbot_price=10"] }),
    );

    valid(["lnbot_path=/api/premium/data", "lnbot_price=10"]);
    const { next } = await call(mw, { originalUrl: "/api/premium/data?page=3", baseUrl: "/api/premium", path: "/data" });
    expect(next).toHaveBeenCalledWith();
  });

  it("checks a dynamic price against what the token paid", async () => {
    const mw = paywall(ln, { walletId: "wal_test", price: (req) => (req.query?.big ? 50 : 10) });
    valid(["lnbot_path=/test", "lnbot_price=10"]);

    const big = await call(mw, { query: { big: "1" } } as Partial<Request>);
    expect(big.next).not.toHaveBeenCalled();
    expect(ln._l402.createChallenge).toHaveBeenCalledWith(expect.objectContaining({ amount: 50 }));
  });

  it("remembers spent tokens in the store it is given", async () => {
    const claim = vi.fn().mockResolvedValue(true);
    valid(["lnbot_path=/test", "lnbot_price=10"]);
    const { next } = await call(paywall(ln, { walletId: "wal_test", price: 10, expirySeconds: 120, spentStore: { claim } }));

    expect(next).toHaveBeenCalledWith();
    expect(claim).toHaveBeenCalledWith("hash1", 120);
  });

  it("treats a store failure as a server error, not a reason to bill again", async () => {
    const error = new Error("redis down");
    valid(["lnbot_path=/test", "lnbot_price=10"]);
    const { next } = await call(paywall(ln, { walletId: "wal_test", price: 10, spentStore: { claim: vi.fn().mockRejectedValue(error) } }));

    expect(next).toHaveBeenCalledWith(error);
    expect(ln._l402.createChallenge).not.toHaveBeenCalled();
  });

  it("refuses more caveats than fit beside the binding", () => {
    const caveats = Array.from({ length: 9 }, (_, i) => `k${i}=v`);
    expect(() => paywall(ln, { walletId: "wal_test", price: 10, caveats })).toThrow("at most 8 caveats");
    expect(() => paywall(ln, { walletId: "wal_test", price: 10, caveats, reuse: true })).not.toThrow();
  });

  it("reuse: true lets a token work until it expires, as in 1.0", async () => {
    valid(["expiry=2099"]);
    const mw = paywall(ln, { walletId: "wal_test", price: 10, reuse: true });

    expect((await call(mw)).next).toHaveBeenCalledWith();
    expect((await call(mw)).next).toHaveBeenCalledWith();

    const { res } = await call(mw, { headers: {} });
    expect(res._status).toBe(402);
    expect(res._body).toMatchObject({ reusable: true });
    expect((res._body as Record<string, unknown>).expiresAt).toBeUndefined();
    expect(ln._l402.createChallenge).toHaveBeenCalledWith({
      amount: 10,
      description: undefined,
      expirySeconds: undefined,
      caveats: undefined,
    });
  });
});
