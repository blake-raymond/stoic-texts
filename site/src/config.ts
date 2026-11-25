/**
 * Live product settings. The chat model is this one value.
 * prompt/meta.json still records the eval that measured the prompt (Gemini, o200k tokens).
 * The Worker does not read that file.
 */
export { FOUNDING_CENTS, MONTHLY_CENTS, YEARLY_CENTS } from "./public-config.ts";

/** Analytics offer for the subscription. Founding checkouts record founding_249. */
export const OFFER = "subscription";

/** Paid founding lifetimes, then the offer is retired. */
export const FOUNDING_BUYER_CAP = 100;

/** Switch models here. Caching below assumes an Anthropic model on OpenRouter. */
export const CHAT_MODEL = "anthropic/claude-sonnet-5.5";

export const CHAT_TEMPERATURE = 0.7;

/**
 * OpenRouter provider tag for "Claude Platform on AWS".
 * order + only + allow_fallbacks false, so cache hits stay on that backend.
 */
export const OPENROUTER_PROVIDER = "claude-on-aws";

/**
 * Bounds output cost. On Sonnet this budget covers the model's thinking AND the
 * visible reply: a measured 434-word reply used 1,310 tokens (592 of them
 * thinking), so a 1,200 cap cut replies off mid-sentence. The persona asks
 * for 250 to 450 words; 4,000 leaves room for thinking plus a long reply.
 */
export const MAX_OUTPUT_TOKENS = 4000;

/**
 * One free conversation, counted in assistant replies.
 * Eight is one sitting on a single trouble, not a free month.
 */
export const FREE_CONVERSATION_REPLIES = 8;

/** One cap for the subscription and the founding lifetime. UTC calendar month. */
export const MONTHLY_REPLY_CAP = 100;

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
 * claude-sonnet-5.5 (per token): input $0.000002, 1-hour cache write $0.000004
 * (2x input), cache read $0.0000001, output $0.00001.
 * 308_000 * $0.000004 = $1.232 write, plus 4_000 output tokens = $0.04.
 * $1.40 covers that cold reply. The breakpoint asks for a 1-hour TTL.
 */
export const COLD_REPLY_RESERVE_MICRO_USD = 1_400_000;

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
