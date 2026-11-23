/** Call the global fetch with its own `this`. A detached `fetch` throws in Workers. */
export const boundFetch: typeof fetch = (input, init) => fetch(input, init);

export function json(body: unknown, status = 200, headers?: Headers): Response {
  const next = headers ?? new Headers();
  next.set("content-type", "application/json; charset=utf-8");
  next.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: next });
}

export async function readJson(request: Request, max: number): Promise<unknown | null> {
  const declared = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > max) return null;
  const text = await request.text();
  if (text.length > max) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
