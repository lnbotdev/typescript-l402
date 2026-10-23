import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { l402, LnBot } from "../src/index.js";

// Against the real ln.bot API. It moves ₿1 between two of your wallets (free
// between ln.bot wallets), so it only runs when both are configured:
//
//   LNBOT_SERVER_KEY=uk_... LNBOT_SERVER_WALLET=wal_...   the wallet that gets paid
//   LNBOT_CLIENT_KEY=uk_... LNBOT_CLIENT_WALLET=wal_...   a funded wallet that pays
//   npx vitest run tests/live.test.ts
const env = process.env;
const live = Boolean(env.LNBOT_SERVER_KEY && env.LNBOT_SERVER_WALLET && env.LNBOT_CLIENT_KEY && env.LNBOT_CLIENT_WALLET);

describe.skipIf(!live)("live: one token, one request, against api.ln.bot", () => {
  const serverLn = new LnBot({ apiKey: env.LNBOT_SERVER_KEY });
  const clientWallet = new LnBot({ apiKey: env.LNBOT_CLIENT_KEY }).wallet(env.LNBOT_CLIENT_WALLET!);

  const app = express();
  app.use("/paid", l402.paywall(serverLn, { walletId: env.LNBOT_SERVER_WALLET!, price: 1, description: "l402 live test" }));
  app.get("/paid/data", (req, res) => res.json({ ok: true, paymentHash: req.l402?.paymentHash }));
  app.get("/paid/other", (_req, res) => res.json({ ok: true }));

  let server: http.Server;
  let base: string;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        server = app.listen(0, () => {
          base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
          resolve();
        });
      }),
  );

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("binds, spends and refuses a replayed token", async () => {
    const challenge = await fetch(`${base}/paid/data`);
    expect(challenge.status).toBe(402);
    const body = await challenge.json();
    expect(body).toMatchObject({ price: 1, reusable: false });
    expect(l402.invoiceSats(body.invoice)).toBe(1);

    const payment = await clientWallet.l402.pay({ wwwAuthenticate: challenge.headers.get("www-authenticate")! });
    expect(payment.status).toBe("settled");
    const authorization = payment.authorization!;

    // The assumption the binding rests on: ln.bot accepts the paywall's custom
    // caveats and returns them from verify().
    const verified = await serverLn.wallet(env.LNBOT_SERVER_WALLET!).l402.verify({ authorization });
    expect(verified.valid).toBe(true);
    expect(verified.caveats).toEqual(expect.arrayContaining(["lnbot_path=/paid/data", "lnbot_price=1"]));

    // Another route refuses it, the right route accepts it once, then it's spent.
    expect((await fetch(`${base}/paid/other`, { headers: { Authorization: authorization } })).status).toBe(402);
    expect((await fetch(`${base}/paid/data`, { headers: { Authorization: authorization } })).status).toBe(200);
    expect((await fetch(`${base}/paid/data`, { headers: { Authorization: authorization } })).status).toBe(402);
  }, 90_000);
});
