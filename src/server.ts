import { stat, readdir, mkdir, rm, rename, cp } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
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
  console.error("[portal] error:", err);
  const message = err instanceof Error ? err.message : "Internal error";
  return json({ error: message }, { status: 500 });
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
        "img-src 'self' data:",
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
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > limit) {
    throw new PathError("body too large", 413);
  }
  const text = await req.text();
  if (text.length > limit) {
    throw new PathError("body too large", 413);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new PathError("invalid JSON", 400);
  }
}

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
  const sink = createWriteStream(dest);
  const reader = req.body.getReader();
  let received = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > config.maxUploadBytes) {
        sink.destroy();
        return json({ error: "file too large" }, { status: 413 });
      }
      if (!sink.write(value)) {
        await new Promise<void>((res) => sink.once("drain", () => res()));
      }
    }
    await new Promise<void>((res, rej) => {
      sink.end((err?: Error | null) => (err ? rej(err) : res()));
    });
  } catch (err) {
    sink.destroy();
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

type ConflictPolicy = "fail" | "overwrite" | "skip";

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
  // dialog instead of dribbling one error per file.
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
  }
  const results: ResultEntry[] = [];

  for (const p of plans) {
    if (p.noop) {
      results.push({ name: p.name, status: "skipped" });
      continue;
    }
    try {
      let existed = false;
      try {
        await stat(p.dest);
        existed = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (existed) {
        if (onConflict === "skip") {
          results.push({ name: p.name, status: "skipped" });
          continue;
        }
        if (onConflict === "overwrite") {
          await rm(p.dest, { recursive: true, force: true });
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

      if (mode === "move") {
        try {
          await rename(p.src, p.dest);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "EXDEV") {
            // Different filesystem — fall back to copy + delete.
            await cp(p.src, p.dest, { recursive: true, errorOnExist: false });
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
        await cp(p.src, p.dest, { recursive: true, errorOnExist: false });
        results.push({
          name: p.name,
          status: existed ? "overwritten" : "copied",
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
  const { state, cookie } = buildOAuthState(authConfig, returnTo);
  const target = buildAuthorizeUrl(state, authConfig);
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
    const { email } = await exchangeCodeForEmail(code, authConfig);
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

Bun.serve({
  port: config.port,
  hostname: config.host,
  // Allow uploads up to the configured size cap.
  maxRequestBodySize: config.maxUploadBytes,
  async fetch(req) {
    const url = new URL(req.url);
    const cookies = parseCookies(req.headers.get("cookie"));
    try {
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
        return await serveStaticFile("login.html");
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

      // --- CSRF gate for state-changing API requests --------------------------
      if (
        authConfig.enabled &&
        url.pathname.startsWith("/api/") &&
        req.method !== "GET" &&
        req.method !== "HEAD"
      ) {
        if (!verifyCsrf(cookies[CSRF_COOKIE], req.headers.get("x-csrf-token"))) {
          return withSecurityHeaders(json({ error: "csrf" }, { status: 403 }));
        }
      }

      // --- API routes ---------------------------------------------------------
      if (url.pathname === "/api/me" && req.method === "GET") {
        return withSecurityHeaders(
          json({
            email: session ? session.email : null,
            authEnabled: authConfig.enabled,
          }),
        );
      }
      if (url.pathname === "/api/list" && req.method === "GET") {
        return withSecurityHeaders(await handleList(url));
      }
      if (url.pathname === "/api/download" && req.method === "GET") {
        return withSecurityHeaders(await handleDownload(url));
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
      if (url.pathname === "/api/delete" && req.method === "POST") {
        return withSecurityHeaders(await handleDelete(req));
      }
      if (url.pathname === "/api/rename" && req.method === "POST") {
        return withSecurityHeaders(await handleRename(req));
      }
      if (url.pathname === "/api/move" && req.method === "POST") {
        return withSecurityHeaders(await handleTransfer(req, "move"));
      }
      if (url.pathname === "/api/copy" && req.method === "POST") {
        return withSecurityHeaders(await handleTransfer(req, "copy"));
      }

      // --- Static client ------------------------------------------------------
      if (req.method === "GET" || req.method === "HEAD") {
        const rel =
          url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
        return await serveStaticFile(rel);
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
