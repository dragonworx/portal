import { stat, readdir, mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { basename, dirname, join } from "node:path";
import archiver from "archiver";

import { loadConfig, safeResolve, toRelative, PathError } from "./config.ts";

const CONFIG_PATH = process.env.PORTAL_CONFIG ?? "./config.json";
const config = loadConfig(CONFIG_PATH);

console.log(`[portal] root        = ${config.root}`);
console.log(`[portal] listening   = http://${config.host}:${config.port}`);

const CLIENT_DIR = new URL("../public/", import.meta.url).pathname;

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
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

function contentDisposition(filename: string): string {
  // RFC 5987 encoded filename* for unicode safety, plus ASCII fallback.
  const ascii = filename.replace(/[^\x20-\x7e]+/g, "_").replace(/"/g, "");
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/* -------------------------------------------------------------------------- */
/*  Route handlers                                                            */
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
  return new Response(file, {
    headers: {
      "content-type": file.type || "application/octet-stream",
      "content-length": String(st.size),
      "content-disposition": contentDisposition(basename(target)),
    },
  });
}

async function handleZip(req: Request): Promise<Response> {
  const body = (await req.json()) as { paths?: unknown; name?: unknown };
  if (!Array.isArray(body.paths) || body.paths.length === 0) {
    return json({ error: "paths required" }, { status: 400 });
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

  const downloadName =
    typeof body.name === "string" && body.name.trim().length > 0
      ? body.name.trim().replace(/[/\\]/g, "_")
      : `portal-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;

  return new Response(webStream, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": contentDisposition(downloadName),
      "cache-control": "no-store",
    },
  });
}

async function handleUpload(req: Request, url: URL): Promise<Response> {
  const dirParam = url.searchParams.get("path") ?? "";
  const name = url.searchParams.get("name");
  if (!name || name.includes("/") || name.includes("\\") || name === ".." || name === ".") {
    return json({ error: "invalid name" }, { status: 400 });
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
  const body = (await req.json()) as { path?: unknown; name?: unknown };
  if (typeof body.path !== "string" || typeof body.name !== "string") {
    return json({ error: "path and name required" }, { status: 400 });
  }
  if (
    body.name.includes("/") ||
    body.name.includes("\\") ||
    body.name === ".." ||
    body.name === "."
  ) {
    return json({ error: "invalid name" }, { status: 400 });
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

/* -------------------------------------------------------------------------- */
/*  Static client                                                             */
/* -------------------------------------------------------------------------- */

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  // Prevent escape from the client directory.
  if (rel.includes("..")) return new Response("Not found", { status: 404 });
  const file = Bun.file(join(CLIENT_DIR, rel));
  if (!(await file.exists())) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(file);
}

/* -------------------------------------------------------------------------- */
/*  Server                                                                    */
/* -------------------------------------------------------------------------- */

Bun.serve({
  port: config.port,
  hostname: config.host,
  // Allow uploads up to the configured size cap.
  maxRequestBodySize: config.maxUploadBytes,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/api/ping") {
        return json({ ok: true, time: Date.now() });
      }
      if (url.pathname === "/api/list" && req.method === "GET") {
        return await handleList(url);
      }
      if (url.pathname === "/api/download" && req.method === "GET") {
        return await handleDownload(url);
      }
      if (url.pathname === "/api/zip" && req.method === "POST") {
        return await handleZip(req);
      }
      if (url.pathname === "/api/upload" && req.method === "POST") {
        return await handleUpload(req, url);
      }
      if (url.pathname === "/api/mkdir" && req.method === "POST") {
        return await handleMkdir(req);
      }
      if (req.method === "GET") {
        return await serveStatic(url.pathname);
      }
      return new Response("Method not allowed", { status: 405 });
    } catch (err) {
      return errorResponse(err);
    }
  },
  error(err) {
    console.error("[portal] fatal:", err);
    return new Response("Internal error", { status: 500 });
  },
});
