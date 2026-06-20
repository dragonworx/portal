import { resolve, normalize, sep, join, relative, isAbsolute, dirname, basename } from "node:path";
import { realpathSync, existsSync, mkdirSync, readFileSync, lstatSync } from "node:fs";

import { loadAuthConfig, type AuthConfig } from "./auth.ts";

export interface AppConfig {
  root: string;
  port: number;
  host: string;
  maxUploadBytes: number;
  /** Cap on file size for the in-browser text editor. Large files are
   *  refused (with a clear error) to avoid hanging the browser tab. */
  maxEditBytes: number;
}

export interface FullConfig {
  app: AppConfig;
  auth: AuthConfig;
}

export function loadConfig(configPath: string): FullConfig {
  // The config file is optional when every value is supplied via env vars
  // (the usual case in container deployments).
  let raw: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  }

  const rootRaw = (process.env.PORTAL_ROOT ?? (raw.root as string) ?? "./data");
  const root = isAbsolute(rootRaw) ? rootRaw : resolve(process.cwd(), rootRaw);
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }
  const realRoot = realpathSync(root);

  const port = Number(process.env.PORTAL_PORT ?? raw.port ?? 4000);
  const host = String(process.env.PORTAL_HOST ?? raw.host ?? "0.0.0.0");
  const maxUploadBytes = Number(
    process.env.PORTAL_MAX_UPLOAD_BYTES ?? raw.maxUploadBytes ?? 5 * 1024 * 1024 * 1024,
  );
  const maxEditBytes = Number(
    process.env.PORTAL_MAX_EDIT_BYTES ?? raw.maxEditBytes ?? 10 * 1024 * 1024,
  );

  return {
    app: { root: realRoot, port, host, maxUploadBytes, maxEditBytes },
    auth: loadAuthConfig(),
  };
}

/**
 * Resolve a user-supplied relative path against the configured root, refusing
 * anything that escapes the root via traversal, absolute paths, or symlinks.
 *
 * `mustExist` controls whether the resolved target must already be present on
 * disk; pass false for upload destinations being newly created. Even when
 * `mustExist` is false, the parent directory is realpath-resolved so a
 * symlinked parent cannot redirect writes outside the root, and an existing
 * symlink at the leaf is rejected so a write would not be silently followed.
 */
export function safeResolve(
  root: string,
  userPath: string,
  mustExist = true,
): string {
  const cleaned = normalize(userPath || "").replace(/^([/\\.])+/g, "");
  const joined = join(root, cleaned);
  const normalised = normalize(joined);
  if (!normalised.startsWith(root + sep) && normalised !== root) {
    throw new PathError("Path escapes root");
  }
  if (mustExist) {
    if (!existsSync(normalised)) {
      throw new PathError("Not found", 404);
    }
    const real = realpathSync(normalised);
    if (!real.startsWith(root + sep) && real !== root) {
      throw new PathError("Symlink escapes root");
    }
    return real;
  }
  // mustExist=false: resolve the parent (which must already exist) and
  // reassert containment so a symlinked parent can't redirect the write.
  const parent = dirname(normalised);
  if (!existsSync(parent)) {
    throw new PathError("Parent directory not found", 404);
  }
  const realParent = realpathSync(parent);
  if (!realParent.startsWith(root + sep) && realParent !== root) {
    throw new PathError("Symlink escapes root");
  }
  const resolved = join(realParent, basename(normalised));
  // If the leaf already exists as a symlink, refuse — writing/renaming on
  // top of it would silently follow the link to wherever it points.
  try {
    const lst = lstatSync(resolved);
    if (lst.isSymbolicLink()) {
      throw new PathError("Destination is a symlink");
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      if (e instanceof PathError) throw e;
      // Any other lstat failure (EACCES, etc.) — surface as a 403 rather
      // than leaking the underlying errno to the client.
      throw new PathError("Permission denied", 403);
    }
  }
  return resolved;
}

export function toRelative(root: string, absolute: string): string {
  const rel = relative(root, absolute);
  return rel.split(sep).join("/");
}

export class PathError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
