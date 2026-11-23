export type Plan = "monthly" | "yearly" | "founding";

/** True only after the Customer Portal is configured in Stripe. */
export function portalConfigured(env: Env): boolean {
  const raw = env.STRIPE_PORTAL_ENABLED;
  if (typeof raw !== "string") return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true";
}

/** A Stripe price id from the environment. Never a literal in this repo. */
export function stripePrice(env: Env, plan: Plan): string | undefined {
  const raw = plan === "monthly"
    ? env.STRIPE_PRICE_MONTHLY
    : plan === "yearly"
      ? env.STRIPE_PRICE_YEARLY
      : env.STRIPE_PRICE_FOUNDING;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!/^price_[A-Za-z0-9]+$/.test(trimmed)) return undefined;
  return trimmed;
}

export function portalConfiguration(env: Env): string | undefined {
  const raw = env.STRIPE_PORTAL_CONFIGURATION;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!/^bpc_[A-Za-z0-9]+$/.test(trimmed)) return undefined;
  return trimmed;
}
