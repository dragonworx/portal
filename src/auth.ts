import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";

/* -------------------------------------------------------------------------- */
/*  Config                                                                    */
/* -------------------------------------------------------------------------- */

export interface AuthConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  allowedEmails: Set<string>;
  allowedDomains: Set<string>;
  sessionSecret: Buffer;
  publicUrl: string;
  cookieSecure: boolean;
  sessionTtlSeconds: number;
}

const STATE_TTL_SECONDS = 600; // 10 minutes — covers a typical Google sign-in
const MIN_SECRET_LENGTH = 32;
const ALLOWED_SESSION_SECONDS_MAX = 30 * 24 * 3600;

export function loadAuthConfig(): AuthConfig {
  const env = process.env;

  const enabledExplicit = env.PORTAL_AUTH_ENABLED;
  const enabled =
    enabledExplicit != null &&
    (enabledExplicit === "1" || enabledExplicit.toLowerCase() === "true");

  const clientId = String(env.GOOGLE_CLIENT_ID ?? "");
  const clientSecret = String(env.GOOGLE_CLIENT_SECRET ?? "");
  const publicUrl = String(env.PORTAL_PUBLIC_URL ?? "").replace(/\/+$/, "");

  const allowedEmails = new Set(
    parseList(env.PORTAL_ALLOWED_EMAILS)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const allowedDomains = new Set(
    parseList(env.PORTAL_ALLOWED_DOMAINS)
      .map((s) => s.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean),
  );

  let sessionTtlSeconds = Number(env.PORTAL_SESSION_TTL ?? 7 * 24 * 3600);
  if (!Number.isFinite(sessionTtlSeconds) || sessionTtlSeconds <= 0) {
    sessionTtlSeconds = 7 * 24 * 3600;
  }
  sessionTtlSeconds = Math.min(sessionTtlSeconds, ALLOWED_SESSION_SECONDS_MAX);

  const cookieSecureEnv = env.PORTAL_COOKIE_SECURE;
  const cookieSecure =
    cookieSecureEnv != null
      ? cookieSecureEnv === "1" || cookieSecureEnv.toLowerCase() === "true"
      : true;

  const secretRaw = String(env.PORTAL_SESSION_SECRET ?? "");
  if (enabled) {
    if (!clientId || !clientSecret) {
      throw new Error(
        "PORTAL_AUTH_ENABLED is true but Google OAuth credentials are missing " +
          "(set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env)",
      );
    }
    if (!publicUrl) {
      throw new Error(
        "PORTAL_AUTH_ENABLED is true but PORTAL_PUBLIC_URL is missing " +
          "(e.g. PORTAL_PUBLIC_URL=https://portal.example.com)",
      );
    }
    if (!/^https?:\/\//.test(publicUrl)) {
      throw new Error("PORTAL_PUBLIC_URL must start with http:// or https://");
    }
    if (publicUrl.startsWith("http://") && cookieSecure) {
      throw new Error(
        "PORTAL_COOKIE_SECURE is true but PORTAL_PUBLIC_URL is http://; set " +
          "PORTAL_COOKIE_SECURE=false for plain-HTTP dev, or use https:// in production",
      );
    }
    if (secretRaw.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `PORTAL_SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters; ` +
          "generate one with: openssl rand -base64 48",
      );
    }
    if (allowedEmails.size === 0 && allowedDomains.size === 0) {
      throw new Error(
        "PORTAL_AUTH_ENABLED is true but no PORTAL_ALLOWED_EMAILS or " +
          "PORTAL_ALLOWED_DOMAINS are configured; this would leave the portal " +
          "accessible to anyone with a Google account",
      );
    }
  }

  return {
    enabled,
    clientId,
    clientSecret,
    allowedEmails,
    allowedDomains,
    sessionSecret: Buffer.from(secretRaw, "utf8"),
    publicUrl,
    cookieSecure,
    sessionTtlSeconds,
  };
}

function parseList(envVal: string | undefined): string[] {
  if (envVal && envVal.length > 0) return envVal.split(",");
  return [];
}

/* -------------------------------------------------------------------------- */
/*  Cookies                                                                   */
/* -------------------------------------------------------------------------- */

export const SESSION_COOKIE = "portal_session";
export const CSRF_COOKIE = "portal_csrf";
export const OAUTH_STATE_COOKIE = "portal_oauth_state";

export interface CookieOptions {
  maxAge?: number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  path?: string;
}

export function buildCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${value}`];
  parts.push(`Path=${opts.path ?? "/"}`);
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Signed-token helpers (HMAC-SHA256)                                        */
/* -------------------------------------------------------------------------- */

function b64urlEncode(buf: Buffer | string): string {
  return (typeof buf === "string" ? Buffer.from(buf) : buf).toString("base64url");
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function signToken(payload: object, secret: Buffer): string {
  const data = b64urlEncode(JSON.stringify(payload));
  const sig = b64urlEncode(createHmac("sha256", secret).update(data).digest());
  return `${data}.${sig}`;
}

function verifyToken<T = Record<string, unknown>>(
  token: string | undefined,
  secret: Buffer,
): T | null {
  if (typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(data).digest();
  let provided: Buffer;
  try {
    provided = b64urlDecode(sig);
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(b64urlDecode(data).toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const exp = (payload as { exp?: unknown }).exp;
  if (typeof exp === "number" && Date.now() / 1000 >= exp) return null;
  return payload as T;
}

/* -------------------------------------------------------------------------- */
/*  Session                                                                   */
/* -------------------------------------------------------------------------- */

export interface SessionPayload {
  email: string;
  exp: number;
  iat: number;
}

export interface SessionCookies {
  session: string;
  csrf: string;
  csrfToken: string;
}

export function createSessionCookies(email: string, config: AuthConfig): SessionCookies {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + config.sessionTtlSeconds;
  const token = signToken({ email: email.toLowerCase(), iat: now, exp }, config.sessionSecret);
  const session = buildCookie(SESSION_COOKIE, token, {
    maxAge: config.sessionTtlSeconds,
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "Lax",
  });
  const csrfToken = randomBytes(32).toString("base64url");
  const csrf = buildCookie(CSRF_COOKIE, csrfToken, {
    maxAge: config.sessionTtlSeconds,
    httpOnly: false, // must be readable by JS so it can be echoed in a header
    secure: config.cookieSecure,
    sameSite: "Lax",
  });
  return { session, csrf, csrfToken };
}

export function verifySession(
  cookieValue: string | undefined,
  config: AuthConfig,
): { email: string } | null {
  const payload = verifyToken<SessionPayload>(cookieValue, config.sessionSecret);
  if (!payload || typeof payload.email !== "string" || !payload.email) return null;
  return { email: payload.email };
}

export function clearAuthCookies(config: AuthConfig): string[] {
  const opts = { maxAge: 0, secure: config.cookieSecure, sameSite: "Lax" as const };
  return [
    buildCookie(SESSION_COOKIE, "", { ...opts, httpOnly: true }),
    buildCookie(CSRF_COOKIE, "", { ...opts, httpOnly: false }),
    buildCookie(OAUTH_STATE_COOKIE, "", { ...opts, httpOnly: true }),
  ];
}

/* -------------------------------------------------------------------------- */
/*  CSRF (double-submit)                                                      */
/* -------------------------------------------------------------------------- */

export function verifyCsrf(cookieVal: string | undefined, headerVal: string | null): boolean {
  if (!cookieVal || !headerVal) return false;
  const a = Buffer.from(cookieVal);
  const b = Buffer.from(headerVal);
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* -------------------------------------------------------------------------- */
/*  OAuth state                                                               */
/* -------------------------------------------------------------------------- */

export interface OAuthStatePayload {
  n: string;
  r: string;
  exp: number;
}

export function buildOAuthState(
  config: AuthConfig,
  returnTo: string | undefined,
): { state: string; cookie: string } {
  const payload: OAuthStatePayload = {
    n: randomBytes(16).toString("base64url"),
    r: sanitizeReturnTo(returnTo),
    exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
  };
  const state = signToken(payload, config.sessionSecret);
  const cookie = buildCookie(OAUTH_STATE_COOKIE, state, {
    maxAge: STATE_TTL_SECONDS,
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "Lax",
  });
  return { state, cookie };
}

export function consumeOAuthState(
  stateParam: string | null,
  cookieValue: string | undefined,
  config: AuthConfig,
): { returnTo: string } | null {
  if (!stateParam || !cookieValue) return null;
  const a = Buffer.from(stateParam);
  const b = Buffer.from(cookieValue);
  if (a.length === 0 || a.length !== b.length || !timingSafeEqual(a, b)) {
    return null;
  }
  const payload = verifyToken<OAuthStatePayload>(stateParam, config.sessionSecret);
  if (!payload) return null;
  return { returnTo: sanitizeReturnTo(payload.r) };
}

/**
 * Restricts post-login redirects to same-site, absolute paths. Anything else
 * collapses to "/" — protects against open-redirect attacks where a crafted
 * `returnTo` could bounce the user (with a freshly minted session cookie) to
 * a phishing page.
 */
function sanitizeReturnTo(s: string | undefined): string {
  if (typeof s !== "string" || s.length === 0) return "/";
  if (s.length > 512) return "/";
  // Must start with "/" but not "//" (protocol-relative) or "/\".
  if (s[0] !== "/" || s[1] === "/" || s[1] === "\\") return "/";
  if (s.includes("\\") || s.includes("\0")) return "/";
  return s;
}

/* -------------------------------------------------------------------------- */
/*  Whitelist                                                                 */
/* -------------------------------------------------------------------------- */

export function isEmailAllowed(email: string, config: AuthConfig): boolean {
  const lower = email.toLowerCase();
  if (config.allowedEmails.has(lower)) return true;
  const at = lower.lastIndexOf("@");
  if (at === -1) return false;
  const domain = lower.slice(at + 1);
  return config.allowedDomains.has(domain);
}

/* -------------------------------------------------------------------------- */
/*  Google OAuth                                                              */
/* -------------------------------------------------------------------------- */

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

export function redirectUri(config: AuthConfig): string {
  return `${config.publicUrl}/auth/callback`;
}

export function buildAuthorizeUrl(state: string, config: AuthConfig): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri(config),
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    include_granted_scopes: "true",
    prompt: "select_account",
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForEmail(
  code: string,
  config: AuthConfig,
): Promise<{ email: string }> {
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: redirectUri(config),
    grant_type: "authorization_code",
  });

  // 10s timeout — we don't want a slow Google response holding a request open.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  let res: Response;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: ctrl.signal,
    });
  } catch {
    throw new AuthError("Token endpoint unreachable", 502);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new AuthError("Token exchange failed", 502);
  }

  let data: { id_token?: unknown };
  try {
    data = (await res.json()) as { id_token?: unknown };
  } catch {
    throw new AuthError("Malformed token response", 502);
  }

  const idToken = data.id_token;
  if (typeof idToken !== "string") {
    throw new AuthError("Missing id_token in response", 502);
  }
  return validateIdToken(idToken, config);
}

/**
 * Parse and validate the id_token claims. Per Google's docs, when the token
 * is obtained directly from the token endpoint over TLS, signature
 * verification can be skipped — but we still validate the claims defensively.
 * See: https://developers.google.com/identity/openid-connect/openid-connect#validatinganidtoken
 */
function validateIdToken(idToken: string, config: AuthConfig): { email: string } {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new AuthError("Malformed id_token", 502);

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(b64urlDecode(parts[1] as string).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new AuthError("Malformed id_token payload", 502);
  }

  const iss = payload.iss;
  if (iss !== "https://accounts.google.com" && iss !== "accounts.google.com") {
    throw new AuthError("Invalid id_token issuer", 401);
  }
  if (payload.aud !== config.clientId) {
    throw new AuthError("Invalid id_token audience", 401);
  }
  const now = Math.floor(Date.now() / 1000);
  const exp = payload.exp;
  if (typeof exp !== "number" || exp < now) {
    throw new AuthError("id_token expired", 401);
  }
  const iat = payload.iat;
  if (typeof iat === "number" && iat > now + 60) {
    throw new AuthError("id_token issued in the future", 401);
  }
  const email = payload.email;
  if (typeof email !== "string" || email.length === 0) {
    throw new AuthError("id_token missing email", 401);
  }
  // Google returns email_verified as a boolean (or sometimes a string).
  const verified = payload.email_verified;
  if (verified !== true && verified !== "true") {
    throw new AuthError("Email not verified by Google", 403);
  }
  return { email };
}
