/** Optional. Set with `wrangler secret put` or, locally, site/.dev.vars. */
interface Env {
  /** Unset means the webhook stores nothing. */
  STRIPE_WEBHOOK_SECRET?: string;
  /**
   * Restricted key (rk_live_ or rk_test_). Unset means /refund tells the buyer to email help@oldcounsel.com.
   * Also the pepper for hashed refund codes, and the key that reads Checkout Sessions on /thanks.
   * Read: Customers, Checkout Sessions, PaymentIntents, Charges.
   * Write: Refunds only.
   */
  STRIPE_REFUND_KEY?: string;
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
