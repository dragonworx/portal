import { stat, readdir, mkdir, rm, rename, cp, writeFile } from "node:fs/promises";
import { createWriteStream, constants as fsConstants, openSync } from "node:fs";
import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import archiver from "archiver";

import { loadConfig, safeResolve, toRelative, PathError } from "./config.ts";
import {
  AuthError,
  buildAuthorizeUrl,
  buildCookie,
  buildOAuthState,
  clearAuthCookies,
  consumeOAuthState,
  createSessionCookies,
  CSRF_COOKIE,
  exchangeCodeForEmail,
  isEmailAllowed,
  OAUTH_STATE_COOKIE,
  parseCookies,
  SESSION_COOKIE,
  verifyCsrf,
  verifySession,
  type AuthConfig,
} from "./auth.ts";

const CONFIG_PATH = process.env.PORTAL_CONFIG ?? "./config.json";
const { app: config, auth: authConfig } = loadConfig(CONFIG_PATH);

console.log(`[portal] root        = ${config.root}`);
console.log(`[portal] listening   = http://${config.host}:${config.port}`);
if (authConfig.enabled) {
  console.log(
    `[portal] auth        = google oauth (${authConfig.allowedEmails.size} email${
      authConfig.allowedEmails.size === 1 ? "" : "s"
    }, ${authConfig.allowedDomains.size} domain${
      authConfig.allowedDomains.size === 1 ? "" : "s"
    })`,
  );
  console.log(`[portal] public url  = ${authConfig.publicUrl}`);
} else {
  console.warn(
    "[portal] auth        = DISABLED — anyone with network access can browse, " +
      "upload, and download files. Set auth.enabled=true in config.json.",
  );
}

const CLIENT_DIR = new URL("../public/", import.meta.url).pathname;
/** Vendored third-party assets — currently just the CodeMirror 5 editor that
 *  powers the in-browser file editor. We serve a tight whitelist of files
 *  out of node_modules instead of bundling/copying them. */
const CODEMIRROR_DIR = new URL("../node_modules/codemirror/", import.meta.url).pathname;

/** Hard cap for small JSON request bodies (/api/zip, /api/mkdir). */
const JSON_BODY_LIMIT = 1 * 1024 * 1024; // 1 MB
/** Defensive cap on the number of entries a single zip request can ask for. */
const MAX_ZIP_PATHS = 10_000;

/** Paths that never require authentication. */
const PUBLIC_EXACT = new Set<string>([
  "/login",
  "/login.html",
  "/login.js",
  "/styles.css",
  "/favicon.ico",
  "/api/ping", // kept public so the container HEALTHCHECK works
]);
const PUBLIC_PREFIX = ["/auth/"];

function isPublic(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  return PUBLIC_PREFIX.some((p) => pathname.startsWith(p));
}

/* -------------------------------------------------------------------------- */
/*  Generic response helpers                                                  */
/* -------------------------------------------------------------------------- */

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

function errorResponse(err: unknown): Response {
  if (err instanceof PathError) {
    return json({ error: err.message }, { status: err.status });
  }
  // Don't leak raw error.message to the client: Node fs errors include
  // absolute paths and other internal detail. Log it server-side and return
  // an opaque envelope with a short correlation id so operators can find it
  // in the logs without us shipping the underlying string to the caller.
  const ref = randomBytes(6).toString("base64url");
  console.error(`[portal] error ref=${ref}:`, err);
  return json({ error: "Internal error", ref }, { status: 500 });
}

function redirect(location: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("location", location);
  return new Response(null, { ...init, status: init.status ?? 302, headers });
}

/**
 * Apply baseline security headers to every response. Strict CSP is reserved
 * for HTML responses so it doesn't pollute downloads/JSON.
 */
function withSecurityHeaders(res: Response, isHtml = false): Response {
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "no-referrer");
  res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  res.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  res.headers.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  if (isHtml) {
    res.headers.set(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        // CodeMirror sets inline `style` attributes (cursor / gutter sizing)
        // — allow inline style attrs while still blocking inline <style>.
        "style-src-attr 'unsafe-inline'",
        // blob: is needed for image previews, which are rendered from
        // object URLs built client-side after an authenticated fetch.
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "connect-src 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "object-src 'none'",
      ].join("; "),
    );
  }
  return res;
}

function contentDisposition(filename: string): string {
  // RFC 5987 encoded filename* for unicode safety, plus ASCII fallback.
  const ascii = filename.replace(/[^\x20-\x7e]+/g, "_").replace(/"/g, "");
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Validates a single path segment (file or folder name). */
function invalidBaseName(name: string): string | null {
  if (!name) return "name required";
  if (name.length > 255) return "name too long";
  if (name === "." || name === "..") return "invalid name";
  if (name.includes("/") || name.includes("\\")) return "invalid name";
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    // Reject NULs and other control characters that could confuse the
    // filesystem or downstream tooling.
    if (c < 0x20 || c === 0x7f) return "invalid name";
  }
  return null;
}

async function readJsonLimited(req: Request, limit: number): Promise<unknown> {
  const buf = await readBodyLimited(req, limit);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new PathError("invalid JSON", 400);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new PathError("invalid JSON", 400);
  }
}

/**
 * Stream-read a request body and refuse anything larger than `limit`.
 * Crucially this never trusts Content-Length: a missing or lying header
 * cannot trick us into buffering more than `limit` bytes (the global
 * `maxRequestBodySize` is sized for large uploads, so the cheap JSON
 * endpoints have to enforce their own ceiling).
 */
async function readBodyLimited(req: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) {
    throw new PathError("body too large", 413);
  }
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > limit) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new PathError("body too large", 413);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  CSRF token issuance for anonymous + authenticated sessions                */
/* -------------------------------------------------------------------------- */

/**
 * Ensure the caller has a CSRF cookie. Returns the existing token if one is
 * present, otherwise mints a fresh one and includes a Set-Cookie header so
 * the next state-changing request from the same client can echo it. This
 * runs whether auth is enabled or not: CSRF protection should not depend on
 * the operator having flipped a config flag.
 */
function ensureCsrfCookie(
  cookies: Record<string, string>,
): { token: string; setCookie: string | null } {
  const existing = cookies[CSRF_COOKIE];
  if (existing && existing.length >= 16 && existing.length <= 128) {
    return { token: existing, setCookie: null };
  }
  const token = randomBytes(32).toString("base64url");
  const setCookie = buildCookie(CSRF_COOKIE, token, {
    // Long lifetime — the cookie is just an anti-CSRF nonce, not a credential.
    maxAge: 7 * 24 * 3600,
    httpOnly: false,
    secure: authConfig.cookieSecure,
    sameSite: "Lax",
  });
  return { token, setCookie };
}

function appendSetCookie(res: Response, cookie: string | null): Response {
  if (!cookie) return res;
  res.headers.append("set-cookie", cookie);
  return res;
}

/* -------------------------------------------------------------------------- */
/*  Per-IP rate limiting                                                      */
/* -------------------------------------------------------------------------- */

interface Bucket {
  tokens: number;
  lastRefill: number;
}

/** Hard cap on tracked buckets so an attacker can't grow the map unbounded
 *  by rotating source IPs. When we hit the cap we drop the oldest entries. */
const RATE_LIMIT_MAX_BUCKETS = 10_000;

const apiBuckets = new Map<string, Bucket>();
const authBuckets = new Map<string, Bucket>();

/**
 * Token bucket. `capacity` is the burst size; `refillPerSec` is the
 * steady-state rate. Returns true if the request is allowed.
 */
function consumeToken(
  map: Map<string, Bucket>,
  key: string,
  capacity: number,
  refillPerSec: number,
): boolean {
  const now = Date.now();
  let b = map.get(key);
  if (!b) {
    if (map.size >= RATE_LIMIT_MAX_BUCKETS) {
      // Drop the oldest entry (insertion-ordered Map iteration).
      const firstKey = map.keys().next().value;
      if (firstKey !== undefined) map.delete(firstKey);
    }
    b = { tokens: capacity, lastRefill: now };
    map.set(key, b);
  }
  const elapsed = (now - b.lastRefill) / 1000;
  if (elapsed > 0) {
    b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerSec);
    b.lastRefill = now;
  }
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function rateLimitResponse(): Response {
  return json({ error: "rate limited" }, {
    status: 429,
    headers: { "retry-after": "30" },
  });
}

/** Periodically drop idle buckets so the maps don't grow over time. */
const RATE_LIMIT_GC_INTERVAL_MS = 5 * 60 * 1000;
const RATE_LIMIT_IDLE_MS = 30 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_IDLE_MS;
  for (const map of [apiBuckets, authBuckets]) {
    for (const [k, v] of map) {
      if (v.lastRefill < cutoff) map.delete(k);
    }
  }
}, RATE_LIMIT_GC_INTERVAL_MS).unref?.();

/* -------------------------------------------------------------------------- */
/*  File-API handlers                                                         */
/* -------------------------------------------------------------------------- */

async function handleList(url: URL): Promise<Response> {
  const requested = url.searchParams.get("path") ?? "";
  const target = safeResolve(config.root, requested, true);
  const st = await stat(target);
  if (!st.isDirectory()) {
    throw new PathError("Not a directory", 400);
  }

  const dirents = await readdir(target, { withFileTypes: true });
  const entries = await Promise.all(
    dirents.map(async (d) => {
      const abs = join(target, d.name);
      let size = 0;
      let mtime = 0;
      try {
        const s = await stat(abs);
        size = s.size;
        mtime = s.mtimeMs;
      } catch {
        /* ignore unreadable */
      }
      return {
        name: d.name,
        type: d.isDirectory() ? ("dir" as const) : ("file" as const),
        size,
        mtime,
      };
    }),
  );

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  return json({
    path: toRelative(config.root, target),
    entries,
  });
}

async function handleDownload(url: URL): Promise<Response> {
  const requested = url.searchParams.get("path") ?? "";
  const target = safeResolve(config.root, requested, true);
  const st = await stat(target);
  if (st.isDirectory()) {
    throw new PathError("Use /api/zip for directories", 400);
  }
  const file = Bun.file(target);
  // Force application/octet-stream so the browser will not render uploaded
  // .html / .svg / .pdf inline — that would let an authenticated user plant
  // content that executes in our origin and steals other users' sessions.
  // Combined with Content-Disposition: attachment and
  // X-Content-Type-Options: nosniff this prevents drive-by XSS via file
  // previews entirely.
  return new Response(file, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(st.size),
      "content-disposition": contentDisposition(basename(target)),
      "cache-control": "private, no-store",
    },
  });
}

/** MIME allowlist for /api/stream. Keeping this tight means the endpoint can
 *  only ever serve inert media types (never HTML/SVG/JS), so — unlike
 *  /api/download — inline playback carries no XSS risk. Must stay in sync
 *  with VIDEO_EXTS / AUDIO_EXTS in public/app.js. */
const STREAM_MEDIA_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogv: "video/ogg",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  weba: "audio/webm",
};

function extOfName(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : "";
}

/**
 * Stream an audio/video file for inline playback in the preview modal. Unlike
 * /api/download this serves the real media MIME type and answers Range
 * requests (206) — players issue partial requests for the initial metadata
 * and for every seek, so without range support the browser has to buffer
 * the whole file before playback can start (fatal on mobile).
 */
async function handleStream(url: URL, req: Request): Promise<Response> {
  const requested = url.searchParams.get("path") ?? "";
  const target = safeResolve(config.root, requested, true);
  const st = await stat(target);
  if (st.isDirectory()) {
    throw new PathError("Not a file", 400);
  }
  const mime = STREAM_MEDIA_MIME[extOfName(basename(target))];
  if (!mime) {
    throw new PathError("Unsupported media type", 415);
  }
  const file = Bun.file(target);
  const headers: Record<string, string> = {
    "content-type": mime,
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
  };

  const range = req.headers.get("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m && (m[1] !== "" || m[2] !== "")) {
      const start =
        m[1] === "" ? Math.max(0, st.size - Number(m[2])) : Number(m[1]);
      const end =
        m[1] !== "" && m[2] !== ""
          ? Math.min(Number(m[2]), st.size - 1)
          : st.size - 1;
      if (start >= st.size || start > end) {
        return new Response(null, {
          status: 416,
          headers: { "content-range": `bytes */${st.size}` },
        });
      }
      return new Response(file.slice(start, end + 1), {
        status: 206,
        headers: {
          ...headers,
          "content-range": `bytes ${start}-${end}/${st.size}`,
          "content-length": String(end - start + 1),
        },
      });
    }
  }
  return new Response(file, {
    headers: { ...headers, "content-length": String(st.size) },
  });
}

async function handleZip(req: Request): Promise<Response> {
  const body = (await readJsonLimited(req, JSON_BODY_LIMIT)) as {
    paths?: unknown;
    name?: unknown;
  };
  if (!Array.isArray(body.paths) || body.paths.length === 0) {
    return json({ error: "paths required" }, { status: 400 });
  }
  if (body.paths.length > MAX_ZIP_PATHS) {
    return json({ error: "too many paths" }, { status: 400 });
  }

  const resolved = body.paths.map((p) => {
    if (typeof p !== "string") throw new PathError("Invalid path entry");
    return safeResolve(config.root, p, true);
  });

  const archive = archiver("zip", { zlib: { level: 6 } });

  for (const abs of resolved) {
    const st = await stat(abs);
    const name = basename(abs);
    if (st.isDirectory()) {
      archive.directory(abs, name);
    } else {
      archive.file(abs, { name });
    }
  }

  // Kick off archive finalisation in the background; the stream will end when
  // archiver flushes its final bytes.
  archive.finalize().catch((err) => {
    console.error("[portal] archive finalize:", err);
    archive.destroy(err as Error);
  });

  const webStream = Readable.toWeb(archive) as unknown as ReadableStream<Uint8Array>;

  const rawName = typeof body.name === "string" ? body.name.trim() : "";
  const safeName =
    rawName.length > 0 && rawName.length <= 255
      ? rawName.replace(/[/\\\0]/g, "_")
      : `portal-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;

  return new Response(webStream, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": contentDisposition(safeName),
      "cache-control": "no-store",
    },
  });
}

async function handleUpload(req: Request, url: URL): Promise<Response> {
  const dirParam = url.searchParams.get("path") ?? "";
  const name = url.searchParams.get("name") ?? "";
  const nameErr = invalidBaseName(name);
  if (nameErr) {
    return json({ error: nameErr }, { status: 400 });
  }

  const targetDir = safeResolve(config.root, dirParam, true);
  const dirStat = await stat(targetDir);
  if (!dirStat.isDirectory()) {
    return json({ error: "target is not a directory" }, { status: 400 });
  }

  // Resolve the final destination without requiring it to exist yet, then
  // double-check it lives inside the configured root.
  const dest = safeResolve(
    config.root,
    join(toRelative(config.root, targetDir), name),
    false,
  );
  if (dirname(dest) !== targetDir) {
    return json({ error: "invalid destination" }, { status: 400 });
  }

  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > config.maxUploadBytes) {
    return json({ error: "file too large" }, { status: 413 });
  }

  if (!req.body) {
    return json({ error: "empty body" }, { status: 400 });
  }

  // Stream the request body to disk so we never buffer the whole file.
  // O_NOFOLLOW: if the destination already exists as a symlink (placed in
  // /data out-of-band) the open(2) call will fail with ELOOP rather than
  // silently writing through the link to its target. We open the fd
  // ourselves (rather than letting createWriteStream do it) so we can pass
  // a numeric flags mask — the StreamOptions.flags type only accepts
  // strings, which can't express O_NOFOLLOW.
  let fd: number;
  try {
    fd = openSync(
      dest,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_TRUNC |
        fsConstants.O_NOFOLLOW,
      0o644,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new PathError("Destination is a symlink", 400);
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new PathError("Permission denied", 403);
    }
    if (code === "EISDIR") {
      throw new PathError("Destination is a directory", 400);
    }
    throw err;
  }
  const sink = createWriteStream("", { fd, autoClose: true });
  // Surface stream-open errors (ELOOP from O_NOFOLLOW, EACCES, etc.) as a
  // proper PathError instead of letting them bubble up as unhandled
  // 'error' events on the WriteStream.
  const sinkErrored: Promise<never> = new Promise((_, rej) => {
    sink.once("error", (err) => rej(err));
  });
  const reader = req.body.getReader();
  let received = 0;
  try {
    await Promise.race([
      sinkErrored,
      (async () => {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > config.maxUploadBytes) {
            sink.destroy();
            throw new PathError("file too large", 413);
          }
          if (!sink.write(value)) {
            await new Promise<void>((res) => sink.once("drain", () => res()));
          }
        }
        await new Promise<void>((res, rej) => {
          sink.end((err?: Error | null) => (err ? rej(err) : res()));
        });
      })(),
    ]);
  } catch (err) {
    sink.destroy();
    if (err instanceof PathError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new PathError("Destination is a symlink", 400);
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new PathError("Permission denied", 403);
    }
    throw err;
  }

  return json({ ok: true, size: received, name });
}

async function handleMkdir(req: Request): Promise<Response> {
  const body = (await readJsonLimited(req, JSON_BODY_LIMIT)) as {
    path?: unknown;
    name?: unknown;
  };
  if (typeof body.path !== "string" || typeof body.name !== "string") {
    return json({ error: "path and name required" }, { status: 400 });
  }
  const nameErr = invalidBaseName(body.name);
  if (nameErr) {
    return json({ error: nameErr }, { status: 400 });
  }
  const parent = safeResolve(config.root, body.path, true);
  const target = safeResolve(
    config.root,
    join(toRelative(config.root, parent), body.name),
    false,
  );
  await mkdir(target, { recursive: false });
  return json({ ok: true });
}

/**
 * POST /api/touch
 * Body: { path, name }
 * Creates a new empty file in `path` named `name`. Refuses to clobber an
 * existing entry (`flag: "wx"`) so we don't silently truncate the user's
 * data when they typo a name.
 */
async function handleTouch(req: Request): Promise<Response> {
  const body = (await readJsonLimited(req, JSON_BODY_LIMIT)) as {
    path?: unknown;
    name?: unknown;
  };
  if (typeof body.path !== "string" || typeof body.name !== "string") {
    return json({ error: "path and name required" }, { status: 400 });
  }
  const name = body.name.trim();
  const nameErr = invalidBaseName(name);
  if (nameErr) {
    return json({ error: nameErr }, { status: 400 });
  }
  const parent = safeResolve(config.root, body.path, true);
  const target = safeResolve(
    config.root,
    join(toRelative(config.root, parent), name),
    false,
  );
  if (dirname(target) !== parent) {
    return json({ error: "invalid destination" }, { status: 400 });
  }
  try {
    // `wx` = O_CREAT | O_EXCL | O_WRONLY — atomic "create if not exists".
    await writeFile(target, "", { flag: "wx" });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      return json({ error: "name already exists" }, { status: 409 });
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new PathError("Permission denied", 403);
    }
    throw e;
  }
  return json({ ok: true, name });
}

async function handleDelete(req: Request): Promise<Response> {
  const body = (await readJsonLimited(req, JSON_BODY_LIMIT)) as {
    path?: unknown;
  };
  if (typeof body.path !== "string" || body.path.length === 0) {
    return json({ error: "path required" }, { status: 400 });
  }
  const target = safeResolve(config.root, body.path, true);
  if (target === config.root) {
    return json({ error: "cannot delete root" }, { status: 400 });
  }
  // recursive: covers non-empty directories; force: tolerate races where the
  // entry vanished between listing and confirmation.
  await rm(target, { recursive: true, force: true });
  return json({ ok: true });
}

async function handleRename(req: Request): Promise<Response> {
  const body = (await readJsonLimited(req, JSON_BODY_LIMIT)) as {
    path?: unknown;
    newName?: unknown;
  };
  if (typeof body.path !== "string" || body.path.length === 0) {
    return json({ error: "path required" }, { status: 400 });
  }
  if (typeof body.newName !== "string") {
    return json({ error: "newName required" }, { status: 400 });
  }
  const newName = body.newName.trim();
  const nameErr = invalidBaseName(newName);
  if (nameErr) {
    return json({ error: nameErr }, { status: 400 });
  }

  const source = safeResolve(config.root, body.path, true);
  if (source === config.root) {
    return json({ error: "cannot rename root" }, { status: 400 });
  }
  if (basename(source) === newName) {
    return json({ ok: true, name: newName });
  }

  const parentRel = toRelative(config.root, dirname(source));
  const dest = safeResolve(
    config.root,
    parentRel ? `${parentRel}/${newName}` : newName,
    false,
  );
  if (dirname(dest) !== dirname(source)) {
    return json({ error: "invalid destination" }, { status: 400 });
  }

  // Refuse to clobber an existing entry — rename(2) would silently replace
  // files on POSIX and we'd rather surface the conflict to the user.
  try {
    await stat(dest);
    return json({ error: "name already exists" }, { status: 409 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  try {
    await rename(source, dest);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new PathError("Not found", 404);
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new PathError("Permission denied", 403);
    }
    if (code === "EXDEV") {
      throw new PathError("Cross-device rename not supported", 400);
    }
    throw e;
  }
  return json({ ok: true, name: newName });
}

/** Defensive cap on the number of entries a single move/copy can ask for. */
const MAX_TRANSFER_PATHS = 10_000;

// "rename" = auto-dedupe with smart indexing ("file.txt" -> "file 1.txt"),
// used by copy-into-same-folder (duplicate). Only meaningful for copies.
type ConflictPolicy = "fail" | "overwrite" | "skip" | "rename";

/* -------------------------------------------------------------------------- */
/*  Inline file editor — read raw bytes, save back atomically                 */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/file?path=…
 * Returns the file's raw bytes (with `X-Portal-Size` / `X-Portal-Mtime`
 * metadata headers so the client can detect concurrent edits if it wants).
 * Refuses anything larger than `maxEditBytes` to keep the browser tab
 * responsive — the user should download those instead.
 */
async function handleGetFile(url: URL): Promise<Response> {
  const requested = url.searchParams.get("path") ?? "";
  const target = safeResolve(config.root, requested, true);
  const st = await stat(target);
  if (st.isDirectory()) {
    throw new PathError("Not a file", 400);
  }
  if (st.size > config.maxEditBytes) {
    return json(
      { error: "file too large to edit", size: st.size, max: config.maxEditBytes },
      { status: 413 },
    );
  }
  const file = Bun.file(target);
  // Force octet-stream + no-store so the browser never tries to render the
  // bytes inline (same XSS hardening as /api/download).
  return new Response(file, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(st.size),
      "cache-control": "private, no-store",
      "x-portal-size": String(st.size),
      "x-portal-mtime": String(Math.round(st.mtimeMs)),
    },
  });
}

/**
 * PUT /api/file?path=…   body: raw file bytes
 * Replaces the file contents atomically (temp file + rename). Refuses to
 * create new files — uploads go through `/api/upload`.
 */
async function handlePutFile(req: Request, url: URL): Promise<Response> {
  const requested = url.searchParams.get("path") ?? "";
  const target = safeResolve(config.root, requested, true);
  const st = await stat(target);
  if (st.isDirectory()) {
    throw new PathError("Not a file", 400);
  }

  // Stream-bounded read. The global maxRequestBodySize is sized for large
  // uploads, so a 10 MB editor cap needs to be enforced per-handler — a
  // malicious client could otherwise omit Content-Length and buffer
  // gigabytes before we noticed.
  const bytes = await readBodyLimited(req, config.maxEditBytes);

  // Atomic replace: write to a sibling tempfile then rename(2) on top. Keeps
  // the original intact if the write fails partway through.
  const tmp = join(
    dirname(target),
    "." + basename(target) + ".tmp." + Date.now() + "." +
      Math.random().toString(36).slice(2, 10),
  );
  try {
    await Bun.write(tmp, bytes);
    await rename(tmp, target);
  } catch (e) {
    // Best-effort cleanup; ignore errors from the cleanup itself.
    try {
      await rm(tmp, { force: true });
    } catch {
      /* ignore */
    }
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new PathError("Permission denied", 403);
    }
    if (code === "ENOSPC") {
      throw new PathError("No space left on device", 507);
    }
    throw e;
  }

  const after = await stat(target);
  return json({ ok: true, size: after.size, mtime: Math.round(after.mtimeMs) });
}



/**
 * Smart-indexed duplicate naming: "file.txt" -> "file 1.txt"; if that exists,
 * "file 2.txt", and so on. Copying an already-indexed name continues its
 * sequence ("file 1.txt" -> "file 2.txt"). Dotfiles like ".gitignore" count
 * as extension-less. `taken` reserves names claimed earlier in the same batch
 * so two entries can't dedupe onto each other before hitting the disk.
 */
async function dedupeDestName(
  dir: string,
  name: string,
  taken: Set<string>,
): Promise<string> {
  const dot = name.lastIndexOf(".");
  const hasExt = dot > 0; // a leading dot is a dotfile, not an extension
  const rawBase = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : "";
  // Split off a trailing " N" index so we continue that sequence.
  const m = /^(.*) (\d+)$/.exec(rawBase);
  const stem = m ? m[1] : rawBase;
  let n = m ? parseInt(m[2], 10) + 1 : 1;
  let candidate = `${stem} ${n}${ext}`;
  for (;;) {
    if (!taken.has(candidate)) {
      try {
        await stat(join(dir, candidate));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return candidate;
        throw e;
      }
    }
    n += 1;
    candidate = `${stem} ${n}${ext}`;
  }
}

/**
 * Shared core for /api/move and /api/copy. Validates a batch of source paths
 * against a target directory, surfaces conflicts up-front when the caller
 * opts in, and reports per-entry results so the client can show partial
 * outcomes precisely.
 */
async function handleTransfer(
  req: Request,
  mode: "move" | "copy",
): Promise<Response> {
  const body = (await readJsonLimited(req, JSON_BODY_LIMIT)) as {
    from?: unknown;
    to?: unknown;
    onConflict?: unknown;
  };
  if (!Array.isArray(body.from) || body.from.length === 0) {
    return json({ error: "from required" }, { status: 400 });
  }
  if (body.from.length > MAX_TRANSFER_PATHS) {
    return json({ error: "too many entries" }, { status: 400 });
  }
  if (typeof body.to !== "string") {
    return json({ error: "to required" }, { status: 400 });
  }
  const onConflict: ConflictPolicy =
    body.onConflict === "overwrite"
      ? "overwrite"
      : body.onConflict === "skip"
        ? "skip"
        : body.onConflict === "rename" && mode === "copy"
          ? "rename"
          : "fail";

  const toAbs = safeResolve(config.root, body.to, true);
  const toStat = await stat(toAbs);
  if (!toStat.isDirectory()) {
    return json({ error: "destination is not a directory" }, { status: 400 });
  }

  // Resolve and validate every source path first so we either accept the
  // whole batch or reject it; no partial side-effects from validation errors.
  interface Plan {
    src: string;
    dest: string;
    name: string;
    noop: boolean;
  }
  const plans: Plan[] = [];
  for (const raw of body.from) {
    if (typeof raw !== "string") {
      return json({ error: "invalid source" }, { status: 400 });
    }
    const src = safeResolve(config.root, raw, true);
    if (src === config.root) {
      return json({ error: `cannot ${mode} root` }, { status: 400 });
    }
    const name = basename(src);
    const dest = join(toAbs, name);
    // basename has no separators so dest cannot escape toAbs, but double-check.
    if (dest !== config.root && !dest.startsWith(config.root + "/")) {
      return json({ error: "invalid destination" }, { status: 400 });
    }
    // Refuse to put a folder into itself or any of its descendants.
    if (toAbs === src || toAbs.startsWith(src + "/")) {
      return json(
        { error: `cannot ${mode} "${name}" into itself` },
        { status: 400 },
      );
    }
    plans.push({ src, dest, name, noop: src === dest });
  }

  // Up-front conflict probe — lets the client show a single Overwrite/Skip
  // dialog instead of dribbling one error per file. "rename" never prompts:
  // conflicts are exactly what it resolves.
  if (onConflict === "fail") {
    const conflicts: string[] = [];
    for (const p of plans) {
      if (p.noop) continue;
      try {
        await stat(p.dest);
        conflicts.push(p.name);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    if (conflicts.length > 0) {
      return json({ error: "conflict", conflicts }, { status: 409 });
    }
  }

  interface ResultEntry {
    name: string;
    status: "moved" | "copied" | "skipped" | "overwritten" | "error";
    error?: string;
    /** Present when the entry landed under a deduped name ("rename" policy). */
    as?: string;
  }
  const results: ResultEntry[] = [];
  // Names claimed by earlier entries in this batch, so dedupe doesn't hand
  // the same destination to two plans before either hits the disk.
  const taken = new Set<string>();

  for (const p of plans) {
    // A move into the same folder is a no-op; a copy is a duplicate, which
    // the "rename" policy handles below (src === dest always "exists").
    if (p.noop && onConflict !== "rename") {
      results.push({ name: p.name, status: "skipped" });
      continue;
    }
    try {
      let dest = p.dest;
      let destName = p.name;
      let existed = false;
      try {
        await stat(dest);
        existed = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (existed) {
        if (onConflict === "rename") {
          destName = await dedupeDestName(toAbs, p.name, taken);
          dest = join(toAbs, destName);
          existed = false;
        } else if (onConflict === "skip") {
          results.push({ name: p.name, status: "skipped" });
          continue;
        } else if (onConflict === "overwrite") {
          await rm(dest, { recursive: true, force: true });
        }
        // onConflict === 'fail' here would have short-circuited above, but a
        // race could have created the file in the meantime. Treat it as a
        // per-entry error rather than aborting the whole batch.
        else {
          results.push({
            name: p.name,
            status: "error",
            error: "already exists",
          });
          continue;
        }
      }
      taken.add(destName);

      if (mode === "move") {
        try {
          await rename(p.src, dest);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "EXDEV") {
            // Different filesystem — fall back to copy + delete.
            await cp(p.src, dest, { recursive: true, errorOnExist: false });
            await rm(p.src, { recursive: true, force: true });
          } else if (code === "EACCES" || code === "EPERM") {
            throw new PathError("Permission denied", 403);
          } else {
            throw e;
          }
        }
        results.push({
          name: p.name,
          status: existed ? "overwritten" : "moved",
        });
      } else {
        await cp(p.src, dest, { recursive: true, errorOnExist: false });
        results.push({
          name: p.name,
          status: existed ? "overwritten" : "copied",
          ...(destName !== p.name ? { as: destName } : {}),
        });
      }
    } catch (e) {
      if (e instanceof PathError) throw e;
      const msg = e instanceof Error ? e.message : "error";
      results.push({ name: p.name, status: "error", error: msg });
    }
  }

  const anyError = results.some((r) => r.status === "error");
  return json({ ok: !anyError, results });
}

/* -------------------------------------------------------------------------- */
/*  Auth handlers                                                             */
/* -------------------------------------------------------------------------- */

function handleAuthLogin(url: URL): Response {
  if (!authConfig.enabled) {
    return json({ error: "auth disabled" }, { status: 404 });
  }
  const returnTo = url.searchParams.get("returnTo") ?? "/";
  const { state, nonce, cookie } = buildOAuthState(authConfig, returnTo);
  const target = buildAuthorizeUrl(state, nonce, authConfig);
  const headers = new Headers();
  headers.append("set-cookie", cookie);
  headers.set("location", target);
  return new Response(null, { status: 302, headers });
}

async function handleAuthCallback(
  url: URL,
  cookies: Record<string, string>,
): Promise<Response> {
  if (!authConfig.enabled) {
    return json({ error: "auth disabled" }, { status: 404 });
  }

  const oauthErr = url.searchParams.get("error");
  if (oauthErr) {
    return loginRedirectError(`Google sign-in failed: ${oauthErr}`);
  }

  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const consumed = consumeOAuthState(stateParam, cookies[OAUTH_STATE_COOKIE], authConfig);
  if (!code || !consumed) {
    return loginRedirectError("Invalid OAuth state");
  }

  try {
    const { email } = await exchangeCodeForEmail(code, consumed.nonce, authConfig);
    if (!isEmailAllowed(email, authConfig)) {
      console.warn(`[portal] denied sign-in: ${email}`);
      return loginRedirectError("Your account is not authorised for this portal.");
    }
    console.log(`[portal] sign-in: ${email}`);
    const { session, csrf } = createSessionCookies(email, authConfig);
    const stateClear = buildCookie(OAUTH_STATE_COOKIE, "", {
      maxAge: 0,
      httpOnly: true,
      secure: authConfig.cookieSecure,
      sameSite: "Lax",
    });
    const headers = new Headers();
    headers.append("set-cookie", session);
    headers.append("set-cookie", csrf);
    headers.append("set-cookie", stateClear);
    headers.set("location", consumed.returnTo);
    return new Response(null, { status: 302, headers });
  } catch (e) {
    if (e instanceof AuthError) {
      return loginRedirectError(e.message);
    }
    console.error("[portal] auth callback error:", e);
    return loginRedirectError("Authentication error");
  }
}

function handleAuthLogout(): Response {
  const headers = new Headers();
  for (const c of clearAuthCookies(authConfig)) {
    headers.append("set-cookie", c);
  }
  headers.set("location", authConfig.enabled ? "/login" : "/");
  return new Response(null, { status: 302, headers });
}

function loginRedirectError(msg: string): Response {
  const safe = msg.slice(0, 200);
  return redirect(`/login?error=${encodeURIComponent(safe)}`);
}

/* -------------------------------------------------------------------------- */
/*  Static client                                                             */
/* -------------------------------------------------------------------------- */

async function serveStaticFile(filename: string): Promise<Response> {
  // Block any path that tries to escape /public.
  if (filename.includes("..") || filename.includes("\0")) {
    return new Response("Not found", { status: 404 });
  }
  const file = Bun.file(join(CLIENT_DIR, filename));
  if (!(await file.exists())) {
    return new Response("Not found", { status: 404 });
  }
  const res = new Response(file);
  const isHtml = filename.endsWith(".html");
  return withSecurityHeaders(res, isHtml);
}

/**
 * Serve a whitelisted set of files out of `node_modules/codemirror/`. The
 * editor lazy-loads modes from `/vendor/codemirror/mode/<x>/<x>.js`, so we
 * proxy to the installed package rather than copying files into /public.
 *
 * Only `.js` and `.css` under lib/, mode/, addon/, theme/, or keymap/ are
 * served — anything else returns 404 so we can't be tricked into exposing
 * package metadata or source maps.
 */
async function serveCodemirrorFile(rel: string): Promise<Response> {
  if (
    rel.includes("..") ||
    rel.includes("\0") ||
    rel.startsWith("/") ||
    !/^(lib|mode|addon|theme|keymap)\//.test(rel) ||
    !/\.(js|css)$/.test(rel)
  ) {
    return new Response("Not found", { status: 404 });
  }
  const abs = join(CODEMIRROR_DIR, rel);
  if (!abs.startsWith(CODEMIRROR_DIR)) {
    return new Response("Not found", { status: 404 });
  }
  const file = Bun.file(abs);
  if (!(await file.exists())) {
    return new Response("Not found", { status: 404 });
  }
  const isCss = rel.endsWith(".css");
  const res = new Response(file, {
    headers: {
      "content-type": isCss
        ? "text/css; charset=utf-8"
        : "application/javascript; charset=utf-8",
      // Vendor assets are immutable per package version — let the browser
      // cache them aggressively to keep editor open snappy.
      "cache-control": "public, max-age=86400",
    },
  });
  return withSecurityHeaders(res);
}

/* -------------------------------------------------------------------------- */
/*  Server                                                                    */
/* -------------------------------------------------------------------------- */

interface Session {
  email: string;
}

function resolveSession(cookies: Record<string, string>, auth: AuthConfig): Session | null {
  if (!auth.enabled) return { email: "anonymous" };
  return verifySession(cookies[SESSION_COOKIE], auth);
}

/**
 * Defence-in-depth same-origin gate. Browsers reliably send
 * `Sec-Fetch-Site` on every cross-origin fetch from a real page — when it
 * isn't `same-origin`/`same-site`/`none` we refuse. Combined with the
 * double-submit CSRF token this makes cross-origin POSTs require an
 * attacker who can both forge `Sec-Fetch-Site` *and* read our cookies.
 */
function isCrossSiteRequest(req: Request): boolean {
  const sfs = req.headers.get("sec-fetch-site");
  if (sfs) {
    // `none` = top-level user-initiated navigation (address bar / bookmark).
    return sfs !== "same-origin" && sfs !== "same-site" && sfs !== "none";
  }
  return false;
}

/** Endpoints whose method is state-changing and that must pass CSRF/origin checks. */
function isStateChanging(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

Bun.serve({
  port: config.port,
  hostname: config.host,
  // Allow uploads up to the configured size cap. Other routes enforce
  // their own (much smaller) per-handler limits via readBodyLimited /
  // readJsonLimited so a missing Content-Length can't be used to balloon
  // memory on JSON endpoints.
  maxRequestBodySize: config.maxUploadBytes,
  async fetch(req, server) {
    const url = new URL(req.url);
    const cookies = parseCookies(req.headers.get("cookie"));
    const remote = server.requestIP(req);
    const ip = remote?.address ?? "unknown";

    try {
      // --- Rate limiting (applied before any expensive work) ------------------
      // Tight bucket on auth endpoints — these are the highest-value targets
      // for brute-force / OAuth-state grinding.
      if (url.pathname.startsWith("/auth/") || url.pathname === "/login") {
        if (!consumeToken(authBuckets, ip, 10, 0.5)) {
          return withSecurityHeaders(rateLimitResponse());
        }
      }
      // Broader bucket on the API surface — generous enough not to bother
      // legitimate clients (the UI does dozens of requests per minute) but
      // closes the door on naive abuse.
      if (url.pathname.startsWith("/api/") && url.pathname !== "/api/ping") {
        if (!consumeToken(apiBuckets, ip, 120, 20)) {
          return withSecurityHeaders(rateLimitResponse());
        }
      }

      // --- Public endpoints ---------------------------------------------------
      if (url.pathname === "/auth/login" && req.method === "GET") {
        return withSecurityHeaders(handleAuthLogin(url));
      }
      if (url.pathname === "/auth/callback" && req.method === "GET") {
        return withSecurityHeaders(await handleAuthCallback(url, cookies));
      }
      if (
        url.pathname === "/auth/logout" &&
        (req.method === "GET" || req.method === "POST")
      ) {
        return withSecurityHeaders(handleAuthLogout());
      }
      if (url.pathname === "/api/ping" && (req.method === "GET" || req.method === "HEAD")) {
        return withSecurityHeaders(json({ ok: true, time: Date.now() }));
      }

      const session = resolveSession(cookies, authConfig);

      // /login (and /login.html) — public, but bounce already-signed-in users home.
      if (url.pathname === "/login" || url.pathname === "/login.html") {
        if (session) return withSecurityHeaders(redirect("/"));
        const csrf = ensureCsrfCookie(cookies);
        return appendSetCookie(await serveStaticFile("login.html"), csrf.setCookie);
      }

      // --- Authentication gate ------------------------------------------------
      if (!session && !isPublic(url.pathname)) {
        if (url.pathname.startsWith("/api/")) {
          return withSecurityHeaders(
            json({ error: "unauthorized" }, { status: 401 }),
          );
        }
        const returnTo =
          url.pathname === "/" ? "/" : url.pathname + (url.search || "");
        return withSecurityHeaders(
          redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`),
        );
      }

      // --- CSRF + same-origin gate for state-changing API requests ------------
      // Enforced unconditionally (i.e. even when auth is disabled) — otherwise
      // a malicious page in another tab could drive the API of an unauth'd
      // deployment via the user's browser.
      if (url.pathname.startsWith("/api/") && isStateChanging(req.method)) {
        if (isCrossSiteRequest(req)) {
          return withSecurityHeaders(json({ error: "cross-site" }, { status: 403 }));
        }
        if (!verifyCsrf(cookies[CSRF_COOKIE], req.headers.get("x-csrf-token"))) {
          return withSecurityHeaders(json({ error: "csrf" }, { status: 403 }));
        }
      }

      // --- API routes ---------------------------------------------------------
      if (url.pathname === "/api/me" && req.method === "GET") {
        // /api/me is called on every page load — convenient point to mint a
        // CSRF cookie for anonymous (auth-disabled) sessions.
        const csrf = ensureCsrfCookie(cookies);
        const res = json({
          email: session ? session.email : null,
          authEnabled: authConfig.enabled,
        });
        return withSecurityHeaders(appendSetCookie(res, csrf.setCookie));
      }
      if (url.pathname === "/api/list" && req.method === "GET") {
        return withSecurityHeaders(await handleList(url));
      }
      if (url.pathname === "/api/download" && req.method === "GET") {
        return withSecurityHeaders(await handleDownload(url));
      }
      if (url.pathname === "/api/stream" && req.method === "GET") {
        return withSecurityHeaders(await handleStream(url, req));
      }
      if (url.pathname === "/api/zip" && req.method === "POST") {
        return withSecurityHeaders(await handleZip(req));
      }
      if (url.pathname === "/api/upload" && req.method === "POST") {
        return withSecurityHeaders(await handleUpload(req, url));
      }
      if (url.pathname === "/api/mkdir" && req.method === "POST") {
        return withSecurityHeaders(await handleMkdir(req));
      }
      if (url.pathname === "/api/touch" && req.method === "POST") {
        return withSecurityHeaders(await handleTouch(req));
      }
      if (url.pathname === "/api/delete" && req.method === "POST") {
        return withSecurityHeaders(await handleDelete(req));
      }
      if (url.pathname === "/api/rename" && req.method === "POST") {
        return withSecurityHeaders(await handleRename(req));
      }
      if (url.pathname === "/api/file" && req.method === "GET") {
        return withSecurityHeaders(await handleGetFile(url));
      }
      if (url.pathname === "/api/file" && req.method === "PUT") {
        return withSecurityHeaders(await handlePutFile(req, url));
      }
      if (url.pathname === "/api/move" && req.method === "POST") {
        return withSecurityHeaders(await handleTransfer(req, "move"));
      }
      if (url.pathname === "/api/copy" && req.method === "POST") {
        return withSecurityHeaders(await handleTransfer(req, "copy"));
      }

      // --- Static client ------------------------------------------------------
      if (req.method === "GET" || req.method === "HEAD") {
        if (url.pathname.startsWith("/vendor/codemirror/")) {
          return await serveCodemirrorFile(
            url.pathname.slice("/vendor/codemirror/".length),
          );
        }
        const rel =
          url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
        const res = await serveStaticFile(rel);
        if (rel === "index.html" || rel.endsWith(".html")) {
          const csrf = ensureCsrfCookie(cookies);
          return appendSetCookie(res, csrf.setCookie);
        }
        return res;
      }
      return new Response("Method not allowed", { status: 405 });
    } catch (err) {
      return withSecurityHeaders(errorResponse(err));
    }
  },
  error(err) {
    console.error("[portal] fatal:", err);
    return new Response("Internal error", { status: 500 });
  },
});
