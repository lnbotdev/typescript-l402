export class L402Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "L402Error";
  }
}

export class L402BudgetExceededError extends L402Error {
  constructor(message: string) {
    super(message);
    this.name = "L402BudgetExceededError";
  }
}

export class L402PaymentFailedError extends L402Error {
  constructor(message: string) {
    super(message);
    this.name = "L402PaymentFailedError";
  }
}
