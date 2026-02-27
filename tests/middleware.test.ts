import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import type { LnBot } from "@lnbot/sdk";
import { paywall } from "../src/server/middleware.js";

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
    ln.l402.createChallenge.mockResolvedValue({
      macaroon: "mac_base64",
      invoice: "lnbc10n1...",
      paymentHash: "abc123",
      expiresAt: "2099-01-01T00:00:00Z",
      wwwAuthenticate: 'L402 macaroon="mac_base64", invoice="lnbc10n1..."',
    });

    const mw = paywall(ln, { price: 10, description: "Test API" });
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
    });
    expect(ln.l402.createChallenge).toHaveBeenCalledWith({
      amount: 10,
      description: "Test API",
      expirySeconds: undefined,
      caveats: undefined,
    });
  });

  it("calls next() and populates req.l402 when valid L402 token is present", async () => {
    ln.l402.verify.mockResolvedValue({
      valid: true,
      paymentHash: "hash123",
      caveats: ["expiry=2099"],
      error: null,
    });

    const mw = paywall(ln, { price: 10 });
    const req = mockReq({
      headers: { authorization: "L402 macaroon_data:preimage_hex" },
    });
    const res = mockRes();
    const next = vi.fn();

    await mw(req, res as unknown as Response, next as NextFunction);

    expect(next).toHaveBeenCalled();
    expect(req.l402).toEqual({
      paymentHash: "hash123",
      caveats: ["expiry=2099"],
    });
    expect(ln.l402.verify).toHaveBeenCalledWith({
      authorization: "L402 macaroon_data:preimage_hex",
    });
    expect(ln.l402.createChallenge).not.toHaveBeenCalled();
  });

  it("issues new challenge when verify returns valid: false", async () => {
    ln.l402.verify.mockResolvedValue({
      valid: false,
      paymentHash: null,
      caveats: null,
      error: "invalid preimage",
    });
    ln.l402.createChallenge.mockResolvedValue({
      macaroon: "new_mac",
      invoice: "lnbc20n1...",
      paymentHash: "xyz",
      expiresAt: "2099-01-01T00:00:00Z",
      wwwAuthenticate: 'L402 macaroon="new_mac", invoice="lnbc20n1..."',
    });

    const mw = paywall(ln, { price: 20 });
    const req = mockReq({
      headers: { authorization: "L402 bad_mac:bad_preimage" },
    });
    const res = mockRes();
    const next = vi.fn();

    await mw(req, res as unknown as Response, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(402);
    expect(ln.l402.verify).toHaveBeenCalled();
    expect(ln.l402.createChallenge).toHaveBeenCalled();
  });

  it("issues new challenge when verify throws", async () => {
    ln.l402.verify.mockRejectedValue(new Error("network error"));
    ln.l402.createChallenge.mockResolvedValue({
      macaroon: "mac",
      invoice: "inv",
      paymentHash: "ph",
      expiresAt: "2099-01-01T00:00:00Z",
      wwwAuthenticate: 'L402 macaroon="mac", invoice="inv"',
    });

    const mw = paywall(ln, { price: 5 });
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
    ln.l402.createChallenge.mockResolvedValue({
      macaroon: "mac",
      invoice: "inv",
      paymentHash: "ph",
      expiresAt: "2099-01-01T00:00:00Z",
      wwwAuthenticate: 'L402 macaroon="mac", invoice="inv"',
    });

    const priceFn = vi.fn().mockReturnValue(42);
    const mw = paywall(ln, { price: priceFn });
    const req = mockReq({ path: "/bulk" });
    const res = mockRes();
    const next = vi.fn();

    await mw(req, res as unknown as Response, next as NextFunction);

    expect(priceFn).toHaveBeenCalledWith(req);
    expect(ln.l402.createChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 42 }),
    );
  });

  it("supports async pricing function", async () => {
    ln.l402.createChallenge.mockResolvedValue({
      macaroon: "mac",
      invoice: "inv",
      paymentHash: "ph",
      expiresAt: "2099-01-01T00:00:00Z",
      wwwAuthenticate: 'L402 macaroon="mac", invoice="inv"',
    });

    const mw = paywall(ln, {
      price: async () => 99,
    });
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    await mw(req, res as unknown as Response, next as NextFunction);

    expect(ln.l402.createChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 99 }),
    );
  });

  it("skips non-L402 Authorization headers", async () => {
    ln.l402.createChallenge.mockResolvedValue({
      macaroon: "mac",
      invoice: "inv",
      paymentHash: "ph",
      expiresAt: "2099-01-01T00:00:00Z",
      wwwAuthenticate: 'L402 macaroon="mac", invoice="inv"',
    });

    const mw = paywall(ln, { price: 10 });
    const req = mockReq({
      headers: { authorization: "Bearer some_jwt_token" },
    });
    const res = mockRes();
    const next = vi.fn();

    await mw(req, res as unknown as Response, next as NextFunction);

    expect(ln.l402.verify).not.toHaveBeenCalled();
    expect(res._status).toBe(402);
  });

  it("calls next(err) when createChallenge throws", async () => {
    const error = new Error("SDK error");
    ln.l402.createChallenge.mockRejectedValue(error);

    const mw = paywall(ln, { price: 10 });
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    await mw(req, res as unknown as Response, next as NextFunction);

    expect(next).toHaveBeenCalledWith(error);
  });

  it("passes expirySeconds and caveats to createChallenge", async () => {
    ln.l402.createChallenge.mockResolvedValue({
      macaroon: "mac",
      invoice: "inv",
      paymentHash: "ph",
      expiresAt: "2099-01-01T00:00:00Z",
      wwwAuthenticate: 'L402 macaroon="mac", invoice="inv"',
    });

    const mw = paywall(ln, {
      price: 10,
      description: "desc",
      expirySeconds: 300,
      caveats: ["service=api"],
    });
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    await mw(req, res as unknown as Response, next as NextFunction);

    expect(ln.l402.createChallenge).toHaveBeenCalledWith({
      amount: 10,
      description: "desc",
      expirySeconds: 300,
      caveats: ["service=api"],
    });
  });
});
