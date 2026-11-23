/** Optional. Set with `wrangler secret put` or, locally, site/.dev.vars. */
interface Env {
  /** Unset means the webhook stores nothing. */
  STRIPE_WEBHOOK_SECRET?: string;
  /**
   * Restricted key (rk_live_ or rk_test_). Unset means /refund tells the buyer to email help@oldcounsel.com,
   * and checkout stays closed.
   * Also the pepper for hashed refund codes, and the key that reads Checkout Sessions on /thanks.
   * Read: Customers, Checkout Sessions, PaymentIntents, Charges.
   * Write: Refunds, Checkout Sessions, and Billing Portal sessions.
   */
  STRIPE_REFUND_KEY?: string;
  /** Stripe price id for the $19 monthly plan. Unset means that checkout stays closed. */
  STRIPE_PRICE_MONTHLY?: string;
  /** Stripe price id for the $180 yearly plan. Unset means that checkout stays closed. */
  STRIPE_PRICE_YEARLY?: string;
  /** Stripe price id for the $249 founding lifetime. Unset hides the offer. */
  STRIPE_PRICE_FOUNDING?: string;
  /** "1" after the Customer Portal is configured. Otherwise "Cancel any time" stays hidden. */
  STRIPE_PORTAL_ENABLED?: string;
  /** Optional Billing Portal configuration id (bpc_). */
  STRIPE_PORTAL_CONFIGURATION?: string;
  /** Unset means the chat route refuses to call a model. */
  OPENROUTER_API_KEY?: string;
  /**
   * Signs the anonymous and access cookies, and peppers access email hashes.
   * At least 16 characters. Unset means chat and purchase grants stay closed.
   */
  ACCESS_SIGNING_SECRET?: string;
  /** Defaults to OpenRouter. Set only to point local dev at a mock. */
  OPENROUTER_API_BASE?: string;
  /** Defaults to https://api.stripe.com. Set only to point local dev at a mock. */
  STRIPE_API_BASE?: string;
  /** Dollars. Overrides the daily spend guard in config.ts. */
  DAILY_SPEND_LIMIT_USD?: string;
  CHAT_RATE_ANON_PER_HOUR?: string;
  CHAT_RATE_IP_PER_HOUR?: string;
}
