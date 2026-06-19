import { resolve, normalize, sep, join, relative, isAbsolute } from "node:path";
import { realpathSync, existsSync, mkdirSync } from "node:fs";

export interface AppConfig {
  root: string;
  port: number;
  host: string;
  maxUploadBytes: number;
}

export function loadConfig(configPath: string): AppConfig {
  // The config file is optional when every value is supplied via env vars
  // (the usual case in container deployments).
  let raw: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    raw = JSON.parse(require("node:fs").readFileSync(configPath, "utf8"));
  }

  const rootRaw = (process.env.PORTAL_ROOT ?? (raw.root as string) ?? "./files");
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

  return { root: realRoot, port, host, maxUploadBytes };
}

/**
 * Resolve a user-supplied relative path against the configured root, refusing
 * anything that escapes the root via traversal, absolute paths, or symlinks.
 *
 * `mustExist` controls whether the resolved target must already be present on
 * disk; pass false for upload destinations being newly created.
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
  return normalised;
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
