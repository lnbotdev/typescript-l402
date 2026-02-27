import type { L402ClientOptions } from "../types.js";
import { L402BudgetExceededError } from "../errors.js";

const PERIOD_MS: Record<string, number> = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

/** In-memory budget tracker with periodic resets. */
export class Budget {
  private spent = 0;
  private periodStart = Date.now();
  private readonly totalSats: number | undefined;
  private readonly periodMs: number | undefined;

  constructor(options: L402ClientOptions) {
    this.totalSats = options.budgetSats;
    if (options.budgetPeriod) {
      this.periodMs = PERIOD_MS[options.budgetPeriod];
    }
  }

  private maybeReset(): void {
    if (this.periodMs && Date.now() - this.periodStart >= this.periodMs) {
      this.spent = 0;
      this.periodStart = Date.now();
    }
  }

  /** Throws L402BudgetExceededError if spending `price` would exceed the budget. */
  check(price: number): void {
    if (this.totalSats === undefined) return;
    this.maybeReset();
    if (this.spent + price > this.totalSats) {
      throw new L402BudgetExceededError(
        `Payment of ${price} sats would exceed budget (${this.spent}/${this.totalSats} sats spent)`,
      );
    }
  }

  /** Record a successful payment. */
  record(price: number): void {
    this.maybeReset();
    this.spent += price;
  }
}
