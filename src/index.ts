import { paywall } from "./server/middleware.js";
import {
  parseAuthorization,
  parseChallenge,
  formatAuthorization,
  formatChallenge,
} from "./server/headers.js";
import { client } from "./client/fetch.js";

export const l402 = {
  // Server
  paywall,

  // Client
  client,

  // Header utilities (for custom integrations)
  parseAuthorization,
  parseChallenge,
  formatAuthorization,
  formatChallenge,
};

export type {
  L402PaywallOptions,
  L402ClientOptions,
  L402Token,
  TokenStore,
  L402RequestData,
} from "./types.js";

export type { L402Client } from "./client/fetch.js";

export { L402Error, L402BudgetExceededError, L402PaymentFailedError } from "./errors.js";

export { LnBot } from "@lnbot/sdk";
