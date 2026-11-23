/**
 * Live product settings. The chat model is this one value.
 * prompt/meta.json still records the eval that measured the prompt (Gemini, o200k tokens).
 * The Worker does not read that file.
 */
export { PAYMENT_LINK } from "./public-config.ts";

export const OFFER = "lifetime_49_preorder";

/** Switch models here. Caching below assumes an Anthropic model on OpenRouter. */
export const CHAT_MODEL = "anthropic/claude-sonnet-5.5";

export const CHAT_TEMPERATURE = 0.7;

/**
 * OpenRouter provider tag for "Claude Platform on AWS".
 * order + only + allow_fallbacks false, so cache hits stay on that backend.
 */
export const OPENROUTER_PROVIDER = "claude-on-aws";

/** Caps a reply near the persona's usual length and bounds output cost. */
export const MAX_OUTPUT_TOKENS = 1200;

/**
 * One free conversation, counted in assistant replies.
 * Eight is one sitting on a single trouble, not a free month.
 */
export const FREE_CONVERSATION_REPLIES = 8;

export const MONTHLY_REPLY_CAP = 200;

export const PRICE_CENTS = 4900;

/**
 * Planning figure for the system prompt on Claude's tokenizer.
 * Not remeasured in this repo. o200k size stays in prompt/meta.json.
 */
export const SYSTEM_PROMPT_CLAUDE_TOKENS = 308_000;

/**
 * A measured cached Sonnet reply cost about $0.044.
 * Cache reads on this model are listed at $0.10 / MTok, so ~308k cached tokens
 * are about $0.031 before the reply itself.
 */
export const CACHED_REPLY_MICRO_USD = 44_000;

/**
 * Held against the daily guard before OpenRouter answers, then replaced by the
 * real cost. A cold cache re-bills the whole prompt. Listed prices for
 * claude-sonnet-5.5 on Claude Platform on AWS (per token): input $0.000002,
 * cache write $0.0000025, output $0.00001.
 * 308_000 * $0.0000025 = $0.77 write, plus 1_200 output tokens = $0.012.
 * $0.90 covers that cold reply. The Anthropic cache expires after about 5
 * minutes idle, so a quiet hour is mostly cold writes, not $0.044 hits.
 */
export const COLD_REPLY_RESERVE_MICRO_USD = 900_000;

/** $50. Override with the DAILY_SPEND_LIMIT_USD var (dollars, not micro-USD). */
export const DAILY_SPEND_LIMIT_MICRO_USD = 50_000_000;

export const CHAT_RATE_WINDOW_MS = 60 * 60 * 1000;
export const CHAT_RATE_ANON_PER_HOUR = 30;
export const CHAT_RATE_IP_PER_HOUR = 60;

export const MAX_CHAT_MESSAGES = 40;
export const MAX_MESSAGE_CHARS = 8_000;
export const MAX_CHAT_CHARS = 32_000;
export const MAX_CHAT_BODY = 200_000;

export function dailySpendLimitMicro(raw: string | undefined): number {
  if (typeof raw !== "string" || !raw.trim()) return DAILY_SPEND_LIMIT_MICRO_USD;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100_000) return DAILY_SPEND_LIMIT_MICRO_USD;
  return Math.round(value * 1_000_000);
}

export function rateLimit(raw: string | undefined, fallback: number): number {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 10_000) return fallback;
  return value;
}
