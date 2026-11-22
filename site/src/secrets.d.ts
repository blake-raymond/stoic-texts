/** Optional. Set with `wrangler secret put` or, locally, site/.dev.vars. Unset means the webhook stores nothing. */
interface Env {
  STRIPE_WEBHOOK_SECRET?: string;
}
