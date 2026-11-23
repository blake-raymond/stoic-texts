import {
  CHAT_MODEL,
  CHAT_TEMPERATURE,
  MAX_CHAT_CHARS,
  MAX_CHAT_MESSAGES,
  MAX_MESSAGE_CHARS,
  MAX_OUTPUT_TOKENS,
  OPENROUTER_PROVIDER,
} from "./config.ts";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface OpenRouterBody {
  model: string;
  temperature: number;
  max_tokens: number;
  stream: true;
  provider: {
    order: string[];
    only: string[];
    allow_fallbacks: false;
  };
  usage: { include: true };
  stream_options: { include_usage: true };
  messages: Array<
    | {
      role: "system";
      content: Array<{
        type: "text";
        text: string;
        cache_control: { type: "ephemeral"; ttl: "1h" };
      }>;
    }
    | ChatTurn
  >;
}

export function parseTurns(raw: unknown): { ok: true; turns: ChatTurn[] } | { ok: false } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
  const messages = (raw as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_CHAT_MESSAGES) return { ok: false };
  const turns: ChatTurn[] = [];
  let total = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || Array.isArray(message)) return { ok: false };
    const role = (message as { role?: unknown }).role;
    const content = (message as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") return { ok: false };
    if (typeof content !== "string") return { ok: false };
    const text = content.trim();
    if (!text || text.length > MAX_MESSAGE_CHARS) return { ok: false };
    if (/[\u0000]/.test(text)) return { ok: false };
    const expected = index % 2 === 0 ? "user" : "assistant";
    if (role !== expected) return { ok: false };
    total += text.length;
    if (total > MAX_CHAT_CHARS) return { ok: false };
    turns.push({ role, content: text });
  }
  if (turns[turns.length - 1]?.role !== "user") return { ok: false };
  return { ok: true, turns };
}

/**
 * The system block is the whole prompt from build_prompt.py: persona, corpus, reminder.
 * It is passed through unchanged. User turns come after it, so the cached prefix
 * is the same bytes for every person and every request.
 * The breakpoint is the system block only, with a 1-hour TTL. OpenRouter documents
 * that explicit ttl "1h" for Claude, including Claude Platform on AWS.
 */
export function buildChatRequest(systemPrompt: string, turns: ChatTurn[]): OpenRouterBody {
  return {
    model: CHAT_MODEL,
    temperature: CHAT_TEMPERATURE,
    max_tokens: MAX_OUTPUT_TOKENS,
    stream: true,
    provider: {
      order: [OPENROUTER_PROVIDER],
      only: [OPENROUTER_PROVIDER],
      allow_fallbacks: false,
    },
    usage: { include: true },
    stream_options: { include_usage: true },
    messages: [
      {
        role: "system",
        content: [
          {
            type: "text",
            text: systemPrompt,
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        ],
      },
      ...turns,
    ],
  };
}

let cachedHead: { prompt: string; json: string } | null = null;

/** JSON for OpenRouter. The system message is stringified once per isolate, then reused. */
export function chatRequestJson(systemPrompt: string, turns: ChatTurn[]): string {
  if (!cachedHead || cachedHead.prompt !== systemPrompt) {
    const body = buildChatRequest(systemPrompt, []);
    const { messages, ...rest } = body;
    const head = JSON.stringify(rest).slice(0, -1) + `,"messages":[${JSON.stringify(messages[0])}`;
    cachedHead = { prompt: systemPrompt, json: head };
  }
  const tail = turns.map((turn) => `,${JSON.stringify({ role: turn.role, content: turn.content })}`).join("");
  return `${cachedHead.json}${tail}]}`;
}

export function openRouterUrl(env: Env): string {
  const raw = env.OPENROUTER_API_BASE;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return "https://openrouter.ai/api/v1/chat/completions";
}

export interface StreamUsage {
  costMicro: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

export function scrub(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_\-]+/g, "[redacted]")
    .replace(/rk_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 200);
}

export async function consumeOpenRouterSse(
  stream: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void,
): Promise<{ text: string; usage: StreamUsage }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const usage: StreamUsage = {
    costMicro: null,
    promptTokens: null,
    completionTokens: null,
    cachedTokens: null,
    cacheWriteTokens: null,
  };
  const take = (chunk: string, flush: boolean) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = flush ? "" : lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;
      const record = parsed as {
        error?: { message?: unknown };
        choices?: Array<{ delta?: { content?: unknown } }>;
        usage?: {
          cost?: unknown;
          prompt_tokens?: unknown;
          completion_tokens?: unknown;
          cache_creation_input_tokens?: unknown;
          prompt_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown };
        };
      };
      if (record.error) {
        const message = typeof record.error.message === "string" ? record.error.message : "upstream error";
        throw new Error(scrub(message));
      }
      const piece = record.choices?.[0]?.delta?.content;
      if (typeof piece === "string" && piece) {
        text += piece;
        onDelta(piece);
      }
      if (record.usage) {
        const cost = numberOrNull(record.usage.cost);
        if (cost !== null && cost >= 0) usage.costMicro = Math.round(cost * 1_000_000);
        usage.promptTokens = numberOrNull(record.usage.prompt_tokens);
        usage.completionTokens = numberOrNull(record.usage.completion_tokens);
        const details = record.usage.prompt_tokens_details;
        usage.cachedTokens = numberOrNull(details?.cached_tokens);
        usage.cacheWriteTokens = numberOrNull(details?.cache_write_tokens)
          ?? numberOrNull(record.usage.cache_creation_input_tokens);
      }
    }
  };
  try {
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      take(decoder.decode(step.value, { stream: true }), false);
    }
    take(decoder.decode(), true);
  } finally {
    reader.releaseLock();
  }
  return { text, usage };
}
