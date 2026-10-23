import { describe, it, expect, vi, afterEach } from "vitest";
import { invoiceSats } from "../src/invoice.js";
import { MemorySpentStore } from "../src/server/spent.js";
import { L402Error } from "../src/errors.js";

describe("invoiceSats", () => {
  it("reads each BOLT11 multiplier", () => {
    expect(invoiceSats("lnbc1m1pjtestdata")).toBe(100_000); // 1 mBTC
    expect(invoiceSats("lnbc2500u1pjtestdata")).toBe(250_000);
    expect(invoiceSats("lnbc10u1pjtestdata")).toBe(1_000);
    expect(invoiceSats("lnbc100n1pjtestdata")).toBe(10);
    expect(invoiceSats("lnbc20m1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq")).toBe(2_000_000);
  });

  it("reads whole-bitcoin amounts", () => {
    expect(invoiceSats("lnbc11pjtestdata")).toBe(100_000_000);
  });

  it("rounds a millisatoshi remainder up", () => {
    expect(invoiceSats("lnbc10p1pjtestdata")).toBe(1); // 1 msat
    expect(invoiceSats("lnbc15n1pjtestdata")).toBe(2); // 1.5 sats
  });

  it("returns null for an invoice without an amount", () => {
    expect(invoiceSats("lnbc1pjtestdata")).toBeNull();
  });

  it("accepts testnet, signet and regtest prefixes, any case, and a lightning: scheme", () => {
    expect(invoiceSats("lntb100n1pjtestdata")).toBe(10);
    expect(invoiceSats("lntbs100n1pjtestdata")).toBe(10);
    expect(invoiceSats("lnbcrt100n1pjtestdata")).toBe(10);
    expect(invoiceSats("LNBC100N1PJTESTDATA")).toBe(10);
    expect(invoiceSats("lightning:lnbc100n1pjtestdata")).toBe(10);
  });

  it("rejects what isn't a BOLT11 invoice", () => {
    expect(() => invoiceSats("not-an-invoice")).toThrow(L402Error);
    expect(() => invoiceSats("lnurl1dp68gurn8ghj7")).toThrow(L402Error);
    expect(() => invoiceSats("lnbc1x1pjtestdata")).toThrow(L402Error);
  });

  it("rejects a pico amount that isn't whole millisatoshis", () => {
    expect(() => invoiceSats("lnbc15p1pjtestdata")).toThrow("Invalid BOLT11 amount");
  });
});

describe("MemorySpentStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("claims a payment hash once", async () => {
    const store = new MemorySpentStore();
    expect(await store.claim("h", 60)).toBe(true);
    expect(await store.claim("h", 60)).toBe(false);
    expect(await store.claim("other", 60)).toBe(true);
  });

  it("forgets a hash after its token has expired", async () => {
    vi.useFakeTimers();
    const store = new MemorySpentStore();
    expect(await store.claim("h", 60)).toBe(true);

    vi.advanceTimersByTime(59_000);
    expect(await store.claim("h", 60)).toBe(false);

    vi.advanceTimersByTime(2_000);
    expect(await store.claim("h", 60)).toBe(true);
  });
});
