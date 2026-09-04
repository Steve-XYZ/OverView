const SESSION_COOKIE = "overview_session";
const SESSION_VERSION = "v1";
const SESSION_SECONDS = 30 * 24 * 60 * 60;

export const DASHBOARD_PASSWORD_ENV = "OVERVIEW_DASHBOARD_PASSWORD";
export const SESSION_SECRET_ENV = "OVERVIEW_SESSION_SECRET";
export const HOSTED_PUBLISH_TOKEN_ENV = "OVERVIEW_PUBLISH_TOKEN";

export async function createSessionCookie(
  secret: string,
  now: number = Date.now(),
): Promise<string> {
  requireRandomSecret(secret, SESSION_SECRET_ENV);
  const expires = Math.floor(now / 1000) + SESSION_SECONDS;
  const value = `${SESSION_VERSION}.${expires}`;
  const signature = await sign(value, secret);
  return `${SESSION_COOKIE}=${value}.${signature}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function hasValidSession(
  request: Request,
  secret: string,
  now: number = Date.now(),
): Promise<boolean> {
  if (secret.length < 32) return false;
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (token === null) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== SESSION_VERSION) return false;
  const expires = Number(parts[1]);
  if (!Number.isInteger(expires)) return false;
  const nowSeconds = Math.floor(now / 1000);
  if (expires <= nowSeconds || expires > nowSeconds + SESSION_SECONDS) return false;
  const value = `${parts[0]}.${parts[1]}`;
  return safeEqual(parts[2] ?? "", await sign(value, secret));
}

export async function validPublishAuthorization(
  request: Request,
  expectedToken: string,
): Promise<boolean> {
  if (expectedToken.length < 32) return false;
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return digestEqual(header.slice(prefix.length), expectedToken);
}

export async function validDashboardPassword(
  supplied: string,
  expected: string,
): Promise<boolean> {
  if (expected.length < 12) return false;
  return digestEqual(supplied, expected);
}

export function requiredSecret(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is not configured.`);
  return value;
}

function requireRandomSecret(value: string, name: string): void {
  if (value.length < 32) throw new Error(`${name} must be at least 32 characters.`);
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64Url(new Uint8Array(signature));
}

async function digestEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
  ]);
  return safeEqual(base64Url(new Uint8Array(leftDigest)), base64Url(new Uint8Array(rightDigest)));
}

function safeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}
