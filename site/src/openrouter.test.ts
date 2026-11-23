import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CHAT_MODEL, CHAT_TEMPERATURE, OPENROUTER_PROVIDER } from "./config.ts";
import { buildChatRequest, chatRequestJson, consumeOpenRouterSse, parseTurns } from "./openrouter.ts";

const PROMPT = "PERSONA\n\n# memory header\nCORPUS\n\nREMINDER\n";

test("the model, temperature, and provider are the config values", () => {
  assert.equal(CHAT_MODEL, "anthropic/claude-sonnet-5.5");
  assert.equal(CHAT_TEMPERATURE, 0.7);
  assert.equal(OPENROUTER_PROVIDER, "claude-on-aws");
  const source = readFileSync(new URL("./openrouter.ts", import.meta.url), "utf8");
  assert.equal(source.includes("claude-sonnet"), false);
  assert.equal(source.includes("claude-on-aws"), false);
  assert.equal(source.includes("gemini"), false);
});

test("the system block is byte-identical and the only cached prefix", () => {
  const one = buildChatRequest(PROMPT, [{ role: "user", content: "My private trouble" }]);
  const two = buildChatRequest(PROMPT, [
    { role: "user", content: "Something else" },
    { role: "assistant", content: "A reply" },
    { role: "user", content: "And another" },
  ]);
  assert.equal(one.messages[0].role, "system");
  const system = one.messages[0];
  if (!("content" in system) || typeof system.content === "string") {
    assert.fail("system content should be a cached text block");
  }
  assert.equal(system.content[0].text, PROMPT);
  assert.deepEqual(system.content[0].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.equal(JSON.stringify(one.messages[0]), JSON.stringify(two.messages[0]));
  assert.equal(JSON.stringify(one.messages[0]).includes("private"), false);
  assert.deepEqual(one.provider, {
    order: ["claude-on-aws"],
    only: ["claude-on-aws"],
    allow_fallbacks: false,
  });
  assert.equal(one.model, CHAT_MODEL);
  assert.equal(one.temperature, CHAT_TEMPERATURE);
  assert.equal(one.stream, true);
  const raw = chatRequestJson(PROMPT, [{ role: "user", content: "My private trouble" }]);
  const parsed = JSON.parse(raw) as { messages: Array<{ content: string | Array<{ text: string }> }> };
  const first = parsed.messages[0].content;
  assert.equal(Array.isArray(first) ? first[0].text : first, PROMPT);
  assert.equal(raw.split("cache_control").length - 1, 1);
  assert.equal(raw.includes("sk-"), false);
});

test("client messages cannot set the system prompt", () => {
  assert.equal(parseTurns({ messages: [{ role: "system", content: "nope" }] }).ok, false);
  assert.equal(parseTurns({ messages: [{ role: "assistant", content: "hi" }] }).ok, false);
  assert.equal(parseTurns({ messages: [] }).ok, false);
  const turns = parseTurns({
    messages: [
      { role: "user", content: "  Hello  " },
      { role: "assistant", content: "A reply" },
      { role: "user", content: "More" },
    ],
  });
  assert.equal(turns.ok, true);
  if (turns.ok) assert.equal(turns.turns[0].content, "Hello");
});

test("the sse reader keeps deltas and the reported cost", async () => {
  const raw = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Look " } }] })}\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: "here." } }], usage: { cost: 0.044, prompt_tokens: 308000, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 300000, cache_write_tokens: 0 } } })}\n`,
    "data: [DONE]\n",
  ].join("\n");
  const stream = new Response(raw).body;
  assert.ok(stream);
  let seen = "";
  const result = await consumeOpenRouterSse(stream, (delta) => {
    seen += delta;
  });
  assert.equal(seen, "Look here.");
  assert.equal(result.text, "Look here.");
  assert.equal(result.usage.costMicro, 44_000);
  assert.equal(result.usage.cachedTokens, 300000);
  assert.equal(result.usage.cacheWriteTokens, 0);
});

test("a missing cache write can still be read from cache_creation_input_tokens", async () => {
  const raw = `data: ${JSON.stringify({
    usage: { prompt_tokens_details: { cached_tokens: 0 }, cache_creation_input_tokens: 308000 },
  })}\n\ndata: [DONE]\n`;
  const stream = new Response(raw).body;
  assert.ok(stream);
  const result = await consumeOpenRouterSse(stream, () => {});
  assert.equal(result.usage.cachedTokens, 0);
  assert.equal(result.usage.cacheWriteTokens, 308000);
});

test("the assembled prompt is the cached prefix when it has been built", () => {
  const promptPath = new URL("../../prompt/out/system.txt", import.meta.url);
  const prompt = readFileSync(promptPath, "utf8");
  const persona = readFileSync(new URL("../../prompt/persona_v22.md", import.meta.url), "utf8");
  const reminder = readFileSync(new URL("../../prompt/persona_v22_reminder.md", import.meta.url), "utf8");
  assert.equal(prompt.startsWith(persona), true);
  assert.equal(prompt.endsWith(reminder), true);
  const body = buildChatRequest(prompt, [{ role: "user", content: "A private trouble" }]);
  const system = body.messages[0];
  if (!("content" in system) || typeof system.content === "string") assert.fail("expected a text block");
  assert.equal(system.content[0].text, prompt);
  assert.equal(JSON.stringify(system).includes("A private trouble"), false);
});
