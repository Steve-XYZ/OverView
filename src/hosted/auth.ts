/**
 * Hosted credentials. Two independent kinds, neither of which can stand in for the
 * other: a signed session cookie that names one user, and a collector token that
 * authorizes one user's publisher. The cookie cannot publish; the token cannot open
 * a dashboard. Both are verified here and nowhere else.
 */

const SESSION_COOKIE = "overview_session";
const SESSION_VERSION = "v2";
const SESSION_SECONDS = 30 * 24 * 60 * 60;

const OAUTH_STATE_COOKIE = "overview_oauth_state";
const OAUTH_STATE_SECONDS = 10 * 60;

/** Recognizable in a shell history or a log so a leaked value can be identified. */
const TOKEN_PREFIX = "ovp_";
const TOKEN_BYTES = 32;

export const SESSION_SECRET_ENV = "OVERVIEW_SESSION_SECRET";
export const GITHUB_CLIENT_ID_ENV = "OVERVIEW_GITHUB_CLIENT_ID";
export const GITHUB_CLIENT_SECRET_ENV = "OVERVIEW_GITHUB_CLIENT_SECRET";
export const ALLOWED_LOGINS_ENV = "OVERVIEW_ALLOWED_GITHUB_LOGINS";

export interface Session {
  readonly userId: string;
}

export async function createSessionCookie(
  userId: string,
  secret: string,
  now: number = Date.now(),
): Promise<string> {
  requireRandomSecret(secret, SESSION_SECRET_ENV);
  if (userId.length === 0 || userId.includes(".")) {
    throw new Error("A session user id must be non-empty and free of separators.");
  }
  const expires = Math.floor(now / 1000) + SESSION_SECONDS;
  const value = `${SESSION_VERSION}.${userId}.${expires}`;
  return `${SESSION_COOKIE}=${value}.${await sign(value, secret)}` +
    `; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/**
 * The single reader of the session cookie. Returns the user the cookie names, so a
 * caller cannot accidentally treat "someone is signed in" as "this row is theirs".
 */
export async function readSession(
  request: Request,
  secret: string,
  now: number = Date.now(),
): Promise<Session | null> {
  if (secret.length < 32) return null;
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (token === null) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== SESSION_VERSION) return null;
  const userId = parts[1] ?? "";
  if (userId.length === 0) return null;
  const expires = Number(parts[2]);
  if (!Number.isInteger(expires)) return null;
  const nowSeconds = Math.floor(now / 1000);
  if (expires <= nowSeconds || expires > nowSeconds + SESSION_SECONDS) return null;
  const value = `${parts[0]}.${userId}.${parts[2]}`;
  if (!safeEqual(parts[3] ?? "", await sign(value, secret))) return null;
  return { userId };
}

export function createOauthStateCookie(state: string): string {
  return `${OAUTH_STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${OAUTH_STATE_SECONDS}`;
}

export function clearOauthStateCookie(): string {
  return `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readOauthStateCookie(request: Request): string | null {
  return readCookie(request.headers.get("cookie"), OAUTH_STATE_COOKIE);
}

export function randomState(): string {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

/** The plaintext returned here is the only time it exists; only its hash is stored. */
export async function createCollectorToken(): Promise<{
  readonly token: string;
  readonly hash: string;
  readonly prefix: string;
}> {
  const token = TOKEN_PREFIX + base64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
  return { token, hash: await hashCollectorToken(token), prefix: collectorTokenPrefix(token) };
}

/**
 * SHA-256 with no salt or stretching, deliberately. The token is 32 random bytes
 * rather than a chosen password, so there is nothing to brute force, and a
 * deterministic digest is what lets the publisher be identified by one indexed
 * lookup instead of a scan over every stored hash.
 */
export async function hashCollectorToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return hex(new Uint8Array(digest));
}

/** Enough to tell two of your own tokens apart in the UI, useless as a credential. */
export function collectorTokenPrefix(token: string): string {
  return token.slice(0, TOKEN_PREFIX.length + 6);
}

/** Extracts the presented bearer token without deciding whose it is. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return null;
  const token = header.slice(prefix.length).trim();
  return token.length === 0 ? null : token;
}

export function requiredSecret(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is not configured.`);
  return value;
}

/**
 * Unset means sign-in is open. Set means only these logins may hold an account,
 * which is how one named collaborator is admitted without opening the deployment.
 */
export function loginAllowed(
  login: string,
  raw: string | undefined = process.env[ALLOWED_LOGINS_ENV],
): boolean {
  if (raw === undefined || raw.trim().length === 0) return true;
  const allowed = raw.split(",").map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0);
  return allowed.length === 0 || allowed.includes(login.toLowerCase());
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

export function safeEqual(left: string, right: string): boolean {
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

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}
