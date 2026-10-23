import type { SpentStore } from "../types.js";

const SWEEP_MS = 60_000;

/**
 * Default spent-token store: a Map in this process's memory. Each entry lives
 * until its token has expired, so the map holds at most an expiry window of
 * paid requests. It forgets everything on restart and isn't shared between
 * instances; pass a shared store to `paywall()` when either matters.
 */
export class MemorySpentStore implements SpentStore {
  private spent = new Map<string, number>();
  private lastSweep = Date.now();

  async claim(paymentHash: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now();
    this.sweep(now);

    const until = this.spent.get(paymentHash);
    if (until !== undefined && until > now) return false;

    this.spent.set(paymentHash, now + ttlSeconds * 1000);
    return true;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < SWEEP_MS) return;
    this.lastSweep = now;
    for (const [hash, until] of this.spent) {
      if (until <= now) this.spent.delete(hash);
    }
  }
}
