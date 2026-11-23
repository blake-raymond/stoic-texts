const ANON_COOKIE = "oc_anon";
const ACCESS_COOKIE = "oc_access";
const MAX_AGE = 400 * 24 * 60 * 60;

interface CookiePayload {
  v: 1;
  id: string;
  exp: number;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function timingSafeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return bytesToBase64Url(mac);
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return null;
}

async function encode(id: string, secret: string, now: number): Promise<string> {
  const payload: CookiePayload = { v: 1, id, exp: now + MAX_AGE * 1000 };
  const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${body}.${await sign(body, secret)}`;
}

async function decode(token: string, secret: string, now: number): Promise<string | null> {
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!body || !mac) return null;
  const expected = await sign(body, secret);
  if (!timingSafeEqual(mac, expected)) return null;
  const raw = base64UrlToBytes(body);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const payload = parsed as Partial<CookiePayload>;
  if (payload.v !== 1 || typeof payload.id !== "string" || typeof payload.exp !== "number") return null;
  if (!/^[A-Za-z0-9-]{16,80}$/.test(payload.id)) return null;
  if (payload.exp < now) return null;
  return payload.id;
}

export function cookieHeader(name: string, value: string, secure: boolean, maxAge = MAX_AGE): string {
  const parts = [`${name}=${value}`, "HttpOnly", "Path=/", `Max-Age=${maxAge}`, "SameSite=Lax"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(name: string, secure: boolean): string {
  return cookieHeader(name, "", secure, 0);
}

export async function anonCookie(id: string, secret: string, now: number, secure: boolean): Promise<string> {
  return cookieHeader(ANON_COOKIE, await encode(id, secret, now), secure);
}

export async function accessCookie(id: string, secret: string, now: number, secure: boolean): Promise<string> {
  return cookieHeader(ACCESS_COOKIE, await encode(id, secret, now), secure);
}

export async function anonIdFrom(request: Request, secret: string, now: number): Promise<string | null> {
  const token = readCookie(request.headers.get("cookie"), ANON_COOKIE);
  if (!token) return null;
  return decode(token, secret, now);
}

export async function accessIdFrom(request: Request, secret: string, now: number): Promise<string | null> {
  const token = readCookie(request.headers.get("cookie"), ACCESS_COOKIE);
  if (!token) return null;
  return decode(token, secret, now);
}

export function requestIsSecure(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

export function newId(): string {
  return crypto.randomUUID();
}
