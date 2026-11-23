import {
  accessView,
  adjustSpend,
  chatRateLimited,
  clientIp,
  hashIp,
  openRouterKey,
  readActor,
  releaseReply,
  reserveSpend,
  signingSecret,
  spendLimit,
  sweepChat,
  takeReply,
} from "./access.ts";
import {
  BAD_REQUEST_MESSAGE,
  FREE_LIMIT_MESSAGE,
  MONTHLY_CAP_MESSAGE,
  RATE_LIMIT_MESSAGE,
  SPEND_GUARD_MESSAGE,
  UNAVAILABLE_MESSAGE,
  UPSTREAM_MESSAGE,
} from "./chat-copy.ts";
import { CHAT_MODEL, COLD_REPLY_RESERVE_MICRO_USD, MAX_CHAT_BODY, OPENROUTER_PROVIDER } from "./config.ts";
import { accessCookie, anonCookie, clearCookie, requestIsSecure } from "./cookies.ts";
import { json, readJson } from "./http.ts";
import { chatRequestJson, consumeOpenRouterSse, openRouterUrl, parseTurns, scrub } from "./openrouter.ts";

export interface HandlerDeps {
  fetchImpl: typeof fetch;
  now: () => number;
  systemPrompt: string;
}

async function actorHeaders(request: Request, env: Env, secret: string, now: number, actor: Awaited<ReturnType<typeof readActor>>): Promise<Headers> {
  const headers = new Headers();
  const secure = requestIsSecure(request);
  if (actor.anonIsNew) headers.append("set-cookie", await anonCookie(actor.anonId, secret, now, secure));
  if (actor.clearAccess) headers.append("set-cookie", clearCookie("oc_access", secure));
  if (actor.grant) headers.append("set-cookie", await accessCookie(actor.grant.id, secret, now, secure));
  return headers;
}

export async function handleAccess(request: Request, env: Env, now: number): Promise<Response> {
  const secret = signingSecret(env);
  if (!secret) return json({ ok: false, code: "unconfigured", message: UNAVAILABLE_MESSAGE }, 503);
  await sweepChat(env.DB, now);
  const actor = await readActor(env.DB, request, secret, now);
  const view = await accessView(env.DB, actor, env, now);
  return json(view, 200, await actorHeaders(request, env, secret, now, actor));
}

export async function handleChat(request: Request, env: Env, deps: HandlerDeps): Promise<Response> {
  const now = deps.now();
  const secret = signingSecret(env);
  const key = openRouterKey(env);
  if (!secret || !key) {
    console.error(JSON.stringify({
      message: "chat unconfigured",
      access_secret: Boolean(secret),
      openrouter: Boolean(key),
    }));
    return json({ ok: false, code: "unconfigured", message: UNAVAILABLE_MESSAGE }, 503);
  }

  const raw = await readJson(request, MAX_CHAT_BODY);
  if (raw === null) return json({ ok: false, code: "bad_request", message: BAD_REQUEST_MESSAGE }, 400);
  const parsed = parseTurns(raw);
  if (!parsed.ok) return json({ ok: false, code: "bad_request", message: BAD_REQUEST_MESSAGE }, 400);

  await sweepChat(env.DB, now);
  const actor = await readActor(env.DB, request, secret, now);
  const headers = await actorHeaders(request, env, secret, now, actor);
  const ipHash = await hashIp(secret, clientIp(request));
  if (await chatRateLimited(env.DB, env, actor.anonId, ipHash, now)) {
    return json({ ok: false, code: "rate_limit", message: RATE_LIMIT_MESSAGE }, 429, headers);
  }

  const taken = await takeReply(env.DB, actor, now);
  if (!taken.ok) {
    const message = taken.code === "free_limit" ? FREE_LIMIT_MESSAGE : MONTHLY_CAP_MESSAGE;
    return json({ ok: false, code: taken.code, message }, taken.code === "free_limit" ? 402 : 429, headers);
  }

  const limit = spendLimit(env);
  if (!await reserveSpend(env.DB, now, limit)) {
    await releaseReply(env.DB, taken.subject, taken.period);
    return json({ ok: false, code: "spend_guard", message: SPEND_GUARD_MESSAGE }, 503, headers);
  }

  const abort = new AbortController();
  const onAbort = () => abort.abort();
  request.signal.addEventListener("abort", onAbort);
  let upstream: Response;
  try {
    upstream = await deps.fetchImpl(openRouterUrl(env), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "HTTP-Referer": "https://oldcounsel.com",
        "X-Title": "Old Counsel",
      },
      body: chatRequestJson(deps.systemPrompt, parsed.turns),
      signal: abort.signal,
    });
  } catch (error) {
    request.signal.removeEventListener("abort", onAbort);
    await releaseReply(env.DB, taken.subject, taken.period);
    await adjustSpend(env.DB, now, -COLD_REPLY_RESERVE_MICRO_USD);
    if (abort.signal.aborted) return new Response(null, { status: 499, headers });
    console.error(JSON.stringify({
      message: "openrouter fetch failed",
      error: scrub(error instanceof Error ? error.message : "fetch failed"),
    }));
    return json({ ok: false, code: "upstream", message: UPSTREAM_MESSAGE }, 502, headers);
  }

  if (!upstream.ok || !upstream.body) {
    request.signal.removeEventListener("abort", onAbort);
    await releaseReply(env.DB, taken.subject, taken.period);
    await adjustSpend(env.DB, now, -COLD_REPLY_RESERVE_MICRO_USD);
    console.error(JSON.stringify({ message: "openrouter status", status: upstream.status }));
    return json({ ok: false, code: "upstream", message: UPSTREAM_MESSAGE }, 502, headers);
  }

  const encoder = new TextEncoder();
  const upstreamBody = upstream.body;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (value: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      };
      let produced = "";
      try {
        const result = await consumeOpenRouterSse(upstreamBody, (delta) => {
          produced += delta;
          send({ delta });
        });
        const cost = result.usage.costMicro;
        if (!produced) {
          await releaseReply(env.DB, taken.subject, taken.period);
          await adjustSpend(env.DB, now, -COLD_REPLY_RESERVE_MICRO_USD);
        } else {
          await adjustSpend(env.DB, now, (cost ?? COLD_REPLY_RESERVE_MICRO_USD) - COLD_REPLY_RESERVE_MICRO_USD);
        }
        console.log(JSON.stringify({
          message: "chat",
          model: CHAT_MODEL,
          provider: OPENROUTER_PROVIDER,
          tier: actor.grant ? "paid" : "free",
          prompt_tokens: result.usage.promptTokens,
          cached_tokens: result.usage.cachedTokens,
          completion_tokens: result.usage.completionTokens,
          cost_micro: cost,
        }));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        if (!produced) {
          await releaseReply(env.DB, taken.subject, taken.period);
          await adjustSpend(env.DB, now, -COLD_REPLY_RESERVE_MICRO_USD);
        }
        console.error(JSON.stringify({
          message: "openrouter stream failed",
          error: scrub(error instanceof Error ? error.message : "stream failed"),
        }));
        try {
          send({ error: UPSTREAM_MESSAGE });
          controller.close();
        } catch {
          // The client already went away.
        }
      } finally {
        request.signal.removeEventListener("abort", onAbort);
      }
    },
    cancel() {
      abort.abort();
    },
  });

  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-accel-buffering", "no");
  return new Response(stream, { status: 200, headers });
}
