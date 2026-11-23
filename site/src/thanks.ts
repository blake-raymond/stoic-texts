import { signingSecret } from "./access.ts";
import { accessCookie, requestIsSecure } from "./cookies.ts";
import { grantAccess, retrievePaidSession } from "./checkout.ts";

export async function thanksDecision(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch,
  now: number,
): Promise<{ state: "granted" | "unconfirmed"; kind: string; cookies: string[] }> {
  const sessionId = new URL(request.url).searchParams.get("session_id") ?? "";
  const secret = signingSecret(env);
  if (!secret || !sessionId) return { state: "unconfirmed", kind: "", cookies: [] };
  const paid = await retrievePaidSession(env, sessionId, fetchImpl);
  if (!paid.ok) return { state: "unconfirmed", kind: "", cookies: [] };
  try {
    const grantId = await grantAccess(env.DB, secret, paid.session, now);
    const cookie = await accessCookie(grantId, secret, now, requestIsSecure(request));
    return { state: "granted", kind: paid.session.kind, cookies: [cookie] };
  } catch (error) {
    console.error(JSON.stringify({
      message: "thanks grant failed",
      error: error instanceof Error ? error.message : "grant failed",
    }));
    return { state: "unconfirmed", kind: "", cookies: [] };
  }
}
