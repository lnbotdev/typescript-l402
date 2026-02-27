import type { Request } from "express";

export type PricingFn = (req: Request) => number | Promise<number>;

/** Resolve price from a fixed number or a per-request pricing function. */
export async function resolvePrice(
  price: number | PricingFn,
  req: Request,
): Promise<number> {
  return typeof price === "function" ? price(req) : price;
}
