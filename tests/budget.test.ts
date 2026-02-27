import { describe, it, expect, vi, afterEach } from "vitest";
import { Budget } from "../src/client/budget.js";
import { L402BudgetExceededError } from "../src/errors.js";

describe("Budget", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows payments within budget", () => {
    const budget = new Budget({ budgetSats: 100, budgetPeriod: "day" });

    expect(() => budget.check(50)).not.toThrow();
    budget.record(50);
    expect(() => budget.check(50)).not.toThrow();
    budget.record(50);

    // Now at 100/100 — next payment would exceed
    expect(() => budget.check(1)).toThrow(L402BudgetExceededError);
  });

  it("throws when single payment exceeds remaining budget", () => {
    const budget = new Budget({ budgetSats: 100, budgetPeriod: "day" });
    budget.record(80);

    expect(() => budget.check(21)).toThrow(L402BudgetExceededError);
    expect(() => budget.check(20)).not.toThrow();
  });

  it("does nothing when no budget is configured", () => {
    const budget = new Budget({});

    expect(() => budget.check(999999)).not.toThrow();
    budget.record(999999);
    expect(() => budget.check(999999)).not.toThrow();
  });

  it("resets budget after period expires", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);

    const budget = new Budget({ budgetSats: 100, budgetPeriod: "hour" });
    budget.record(100);

    // At limit
    expect(() => budget.check(1)).toThrow(L402BudgetExceededError);

    // Advance time past 1 hour
    vi.spyOn(Date, "now").mockReturnValue(now + 60 * 60 * 1000 + 1);

    // Budget should reset
    expect(() => budget.check(50)).not.toThrow();
  });

  it("supports all period types", () => {
    for (const period of ["hour", "day", "week", "month"] as const) {
      const budget = new Budget({ budgetSats: 10, budgetPeriod: period });
      budget.record(10);
      expect(() => budget.check(1)).toThrow(L402BudgetExceededError);
    }
  });

  it("error message includes spent and total", () => {
    const budget = new Budget({ budgetSats: 100, budgetPeriod: "day" });
    budget.record(80);

    try {
      budget.check(30);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(L402BudgetExceededError);
      expect((err as Error).message).toContain("80");
      expect((err as Error).message).toContain("100");
      expect((err as Error).message).toContain("30");
    }
  });
});
