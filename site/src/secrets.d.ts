/** Optional. Set with `wrangler secret put` or, locally, site/.dev.vars. */
interface Env {
  /** Unset means the webhook stores nothing. */
  STRIPE_WEBHOOK_SECRET?: string;
  /**
   * Restricted key (rk_live_ or rk_test_). Unset means /refund tells the buyer to email help@oldcounsel.com.
   * Also the pepper for hashed refund codes. Read: Customers, Checkout Sessions, PaymentIntents, Charges.
   * Write: Refunds only.
   */
  STRIPE_REFUND_KEY?: string;
}
