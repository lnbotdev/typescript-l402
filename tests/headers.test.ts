import { describe, it, expect } from "vitest";
import {
  parseAuthorization,
  parseChallenge,
  formatAuthorization,
  formatChallenge,
} from "../src/server/headers.js";

describe("parseAuthorization", () => {
  it("parses a valid L402 Authorization header", () => {
    const result = parseAuthorization("L402 abc123:def456");
    expect(result).toEqual({ macaroon: "abc123", preimage: "def456" });
  });

  it("handles colons in preimage (uses last colon)", () => {
    const result = parseAuthorization("L402 mac:with:colons:preimage");
    expect(result).toEqual({
      macaroon: "mac:with:colons",
      preimage: "preimage",
    });
  });

  it("handles base64 macaroon with padding", () => {
    const result = parseAuthorization("L402 YWJjMTIz==:abcdef01");
    expect(result).toEqual({
      macaroon: "YWJjMTIz==",
      preimage: "abcdef01",
    });
  });

  it("returns null for non-L402 header", () => {
    expect(parseAuthorization("Bearer token123")).toBeNull();
  });

  it("returns null for missing colon", () => {
    expect(parseAuthorization("L402 nocolonhere")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseAuthorization("")).toBeNull();
  });

  it("returns null for 'L402' without space", () => {
    expect(parseAuthorization("L402abc:def")).toBeNull();
  });
});

describe("parseChallenge", () => {
  it("parses a valid WWW-Authenticate L402 header", () => {
    const header = 'L402 macaroon="abc123", invoice="lnbc1..."';
    const result = parseChallenge(header);
    expect(result).toEqual({ macaroon: "abc123", invoice: "lnbc1..." });
  });

  it("handles extra whitespace between fields", () => {
    const header = 'L402 macaroon="mac123",  invoice="lnbc500"';
    const result = parseChallenge(header);
    expect(result).toEqual({ macaroon: "mac123", invoice: "lnbc500" });
  });

  it("returns null for non-L402 header", () => {
    expect(parseChallenge("Basic realm=test")).toBeNull();
  });

  it("returns null when macaroon is missing", () => {
    expect(parseChallenge('L402 invoice="lnbc1..."')).toBeNull();
  });

  it("returns null when invoice is missing", () => {
    expect(parseChallenge('L402 macaroon="abc123"')).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseChallenge("")).toBeNull();
  });
});

describe("formatAuthorization", () => {
  it("formats macaroon and preimage into Authorization value", () => {
    expect(formatAuthorization("abc123", "def456")).toBe("L402 abc123:def456");
  });
});

describe("formatChallenge", () => {
  it("formats macaroon and invoice into WWW-Authenticate value", () => {
    expect(formatChallenge("abc123", "lnbc1...")).toBe(
      'L402 macaroon="abc123", invoice="lnbc1..."',
    );
  });
});

describe("roundtrip", () => {
  it("formatAuthorization → parseAuthorization", () => {
    const formatted = formatAuthorization("macaroon_data", "preimage_hex");
    const parsed = parseAuthorization(formatted);
    expect(parsed).toEqual({
      macaroon: "macaroon_data",
      preimage: "preimage_hex",
    });
  });

  it("formatChallenge → parseChallenge", () => {
    const formatted = formatChallenge("mac_base64", "lnbc1pvjluez");
    const parsed = parseChallenge(formatted);
    expect(parsed).toEqual({
      macaroon: "mac_base64",
      invoice: "lnbc1pvjluez",
    });
  });
});
