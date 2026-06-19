import { resolve, normalize, sep, join, relative, isAbsolute } from "node:path";
import { realpathSync, existsSync, mkdirSync } from "node:fs";

export interface AppConfig {
  root: string;
  port: number;
  host: string;
  maxUploadBytes: number;
}

export function loadConfig(configPath: string): AppConfig {
  const file = Bun.file(configPath);
  if (!file.size) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const raw = JSON.parse(require("node:fs").readFileSync(configPath, "utf8"));
  const root = isAbsolute(raw.root)
    ? raw.root
    : resolve(process.cwd(), raw.root);
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }
  const realRoot = realpathSync(root);
  return {
    root: realRoot,
    port: raw.port ?? 4000,
    host: raw.host ?? "0.0.0.0",
    maxUploadBytes: raw.maxUploadBytes ?? 5 * 1024 * 1024 * 1024,
  };
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
