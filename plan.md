# rclone-backed storage providers for Portal

## Context

Portal today serves exactly one local directory. `config.root` is a single string, and 14 of the 16 `/api` routes in `src/server.ts` (13 handler functions — `/api/move` and `/api/copy` share one) call `node:fs` directly against it — there is no storage abstraction. The goal is to let Portal browse and manage cloud storage (Drive, S3, Dropbox, …) alongside local files, using rclone as the backend adapter so we inherit its ~70 provider implementations instead of writing them.

Decisions already made:

1. **Mechanism** — `rclone rcd` as a sidecar container. Portal calls the rc JSON API for metadata/mutations and streams bytes through `--rc-serve`. Not FUSE (needs privileges we don't have in rootless Docker, and `fs.watch` wouldn't see remote changes). Not WebDAV (same refactor cost plus an XML parser).
2. **UX** — virtual root. Path `""` lists providers; the first path segment selects one. The wire format stays a single `path` string, so hash routing `#/gdrive/Photos/2024` round-trips unchanged.
3. **Credentials** — `rclone.conf` bind-mounted read-only into the sidecar. Portal discovers remotes via `config/listremotes` and never touches credential-bearing endpoints.
4. **Scope** — full parity. Every operation works on remotes, including cross-provider move/copy.

Two rclone API facts verified against <https://rclone.org/rc/>, both load-bearing:

- `operations/uploadfile` takes `remote` as a **destination directory**; the object name comes from the multipart part's `filename`. Params go in the query string, so the body can be a pure stream — **streaming upload without buffering is possible.**
- `--rc-serve` object URL syntax is `http://host:5572/[remote:path]/path/to/object`. Docs: *"Unless the rc server has authentication configured … only remotes already present in the config file may be served this way. Inline remotes … connection string parameters and bare local paths are rejected."* Our `portal_local:` is an **alias remote defined in the config file**, so this restriction does not bite — auth is defence-in-depth, not a functional requirement.

---

## Shape of the change

New `src/providers/`:

| File | Purpose |
|---|---|
| `types.ts` | `Provider`, `EntryInfo`, `Capabilities`, `TransferRef`, `ReadResult` |
| `path.ts` | `resolvePortalPath`, `lexicalRelative`, `joinFs` |
| `local.ts` | `LocalProvider` — today's `node:fs` code, moved verbatim |
| `rc.ts` | `RcClient` — transport, endpoint allowlist, error mapping, concurrency limiter |
| `rclone.ts` | `RcloneProvider` — implements `Provider` over `RcClient` |
| `registry.ts` | boot discovery, `getProvider(id)`, `rootListing()` |
| `transfer.ts` | `transferOne()` — same-provider and cross-provider move/copy |
| `watch.ts` | generalised refcounted subscription registry (fs.watch + poller) |

`src/server.ts` keeps its router, security middleware, Range parsing, `STREAM_MEDIA_MIME` allowlist, and all header construction. Every `node:fs` call and every `config.root` reference moves behind a provider.

**Mechanical completion check:** no `import … from "node:fs"` / `"node:fs/promises"` remains in `server.ts`, and `grep -n 'config\.root' src/server.ts` returns only the startup log line. (Today: 28 hits at lines 37, 349, 383, 505, 578, 636, 697, 744, 753-754, 858, 860-861, 888, 890-891, 920-921, 947-948, 955, 957, 1012, 1044, 1157, 1176-1177, 1183.)

---

## A. Provider interface — `src/providers/types.ts`

```ts
export interface EntryInfo { name: string; type: "dir" | "file"; size: number; mtime: number; }
/** Synthetic-root row — what `rootListing()` returns, not a bare EntryInfo. */
export interface RootEntry extends EntryInfo { kind: "provider"; }
export interface StatInfo { type: "dir" | "file"; size: number; mtime: number; }

export interface ReadResult {
  body: ReadableStream<Uint8Array>;
  length: number;   // bytes in body
  total: number;    // full object size, for Content-Range
  /** True only if the requested range was actually honoured. When a range was
   *  asked for and this is false, the handler MUST answer 200, never 206. */
  ranged: boolean;
}

export interface Capabilities {
  id: string; label: string; kind: "local" | "rclone";
  writable: boolean; canMkdir: boolean; canDelete: boolean;
  canMove: boolean;          // Features.Move || Features.DirMove
  canCopy: boolean;          // rclone always has a stream-through fallback ⇒ true
  emptyDirs: boolean;        // Features.CanHaveEmptyDirectories — false on S3/GCS
  caseInsensitive: boolean;  // Features.CaseInsensitive
  duplicateNames: boolean;   // Features.DuplicateFiles — true on Drive; makes
                             // "already exists" an unsound predicate
  watchIntervalMs: number;   // 0 ⇒ event-driven (local)
}

/** Opaque handle for the transfer engine. `fs` always comes from validated
 *  config, `remote` always from lexicalRelative — never raw user input. */
export interface TransferRef {
  providerId: string; isLocal: boolean;
  fs: string;      // "gdrive:" — exactly one colon, trailing
  remote: string;  // no leading/trailing slash, no ".."
}

export interface Provider {
  readonly id: string;
  capabilities(): Capabilities;

  // read
  list(rel: string): Promise<EntryInfo[]>;
  /** Names only, ONE round trip. Replaces N stat() probes in transfer
   *  planning and dedupeDestName. */
  listNames(rel: string): Promise<Set<string>>;
  stat(rel: string): Promise<StatInfo>;               // throws PathError(404)
  statOrNull(rel: string): Promise<StatInfo | null>;
  read(rel: string, range: { start: number; end: number } | null): Promise<ReadResult>;
  /** Lazy recursive file walk for zip. Caller may abandon the iterator. */
  walkFiles(rel: string): AsyncIterable<{ path: string; size: number }>;

  // write
  writeStream(dirRel: string, name: string, body: ReadableStream<Uint8Array>,
              opts: { maxBytes: number; declaredLength: number | null }): Promise<{ size: number }>;
  writeBytes(rel: string, bytes: Uint8Array): Promise<{ size: number; mtime: number }>;
  mkdir(dirRel: string, name: string): Promise<void>;          // PathError(409) if taken
  createEmptyFile(dirRel: string, name: string): Promise<void>; // PathError(409) if taken
  remove(rel: string): Promise<void>;                           // recursive, ENOENT-tolerant
  renameInPlace(rel: string, newName: string): Promise<void>;

  transferRef(rel: string): TransferRef;
  makeWatcher(rel: string, onDirty: () => void): { stop(): void; poke(): void };

  /** LocalProvider only. Lets handleZip keep archiver's native directory()/file()
   *  fast path so local zips stay byte-identical to today. */
  localAbsolutePath?(rel: string, mustExist?: boolean): string;
}
```

Cross-provider transfer is expressible because `transferRef()` yields a uniform `(fs, remote)` pair for **both** kinds — `LocalProvider` returns `{ fs: "portal_local:", remote: rel, isLocal: true }`.

---

## B. `src/providers/local.ts` — zero behaviour change

Constructed with `config.root`; every method calls `safeResolve(this.root, rel, mustExist)` first. **`safeResolve`, `toRelative` and `PathError` in `src/config.ts` are not modified.** The realpath / `existsSync` / `lstatSync` hardening, symlinked-parent reassertion and leaf-symlink rejection all stay exactly as written.

Bodies lifted verbatim from the current handlers:

| Method | Source |
|---|---|
| `list` | `readdir(withFileTypes)` + per-entry `stat` (server.ts:355-375), same comparator |
| `listNames` | `new Set(await readdir(abs))` — **new**, replaces N `stat` calls |
| `read` | `Bun.file(abs)` / `.slice(start, end+1)`, `ranged: true` |
| `writeStream` | server.ts:777-841 verbatim — `openSync(O_WRONLY\|O_CREAT\|O_TRUNC\|O_NOFOLLOW, 0o644)` → `createWriteStream("", {fd})` → reader loop with `drain` backpressure + mid-stream cap |
| `writeBytes` | server.ts:1058-1081 verbatim — sibling tmp → `Bun.write` → `rename` |
| `mkdir` / `createEmptyFile` | `mkdir(recursive:false)` / `writeFile("", {flag:"wx"})`; EEXIST → 409 |
| `remove` | `rm(abs, {recursive:true, force:true})` |
| `renameInPlace` | `stat(dest)` probe → `rename()` |
| `makeWatcher` | `fs.watch(absDir,{persistent:false})` + the existing 150 ms debounce / 1000 ms ceiling / error→wake-and-close logic (server.ts:460-490). `poke()` is a no-op |

The inline containment checks the old code did *outside* `safeResolve` — `dirname(dest) !== targetDir` (:757, :894, :961) and `dest.startsWith(config.root + "/")` (:1183) — become assertions inside `LocalProvider`, where dest is always `join(safeResolve(dir), invalidBaseName-validated name)`. Retained, not dropped.

Root-operand guards (`abs === config.root` at :921, :948, :1177) become `rel === ""`, which is provider-agnostic.

---

## C. Path routing — `src/providers/path.ts`

```ts
export type Resolved =
  | { kind: "root" }
  | { kind: "entry"; provider: Provider; rel: string; portalPath: string };

export function resolvePortalPath(userPath: string): Resolved {
  const raw = typeof userPath === "string" ? userPath : "";
  if (raw.includes("\0")) throw new PathError("invalid path");
  const segs = raw.split("/").filter((s) => s !== "" && s !== ".");
  if (segs.length === 0) {
    return virtualRootEnabled()
      ? { kind: "root" }
      : { kind: "entry", provider: localProvider, rel: "", portalPath: "" };
  }
  const [head, ...rest] = segs;
  const provider = getProvider(head);        // exact match, no normalisation
  if (!provider) throw new PathError("Not found", 404);
  const rel = lexicalRelative(rest.join("/"));
  return { kind: "entry", provider, rel, portalPath: [head, rel].filter(Boolean).join("/") };
}
```

### Local guarantees are preserved, not re-implemented

`resolvePortalPath` performs **no** filesystem containment for local. It strips the provider segment and hands `rel` to `LocalProvider`, whose every method runs the unmodified `safeResolve` — including its own `normalize().replace(/^([/\\.])+/g,"")` and `startsWith(root+sep)` check. That is a *strictly narrower* input than today's, so the local path cannot be weakened by this change.

### Remote: the lexical equivalent

Remotes have no symlinks and no realpath, so containment must be lexical. We **reject** `..` rather than normalising it — the client never emits one, and refusing eliminates any chance of a normalise-then-reinterpret mismatch with rclone's own path handling.

```ts
export function lexicalRelative(userPath: string): string {
  const out: string[] = [];
  for (const seg of (userPath || "").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw new PathError("Path escapes root");
    if (seg.length > 255) throw new PathError("name too long");
    for (let i = 0; i < seg.length; i++) {
      const c = seg.charCodeAt(i);
      if (c < 0x20 || c === 0x7f) throw new PathError("invalid path");
    }
    out.push(seg);
  }
  const rel = out.join("/");
  if (rel.length > 4096) throw new PathError("path too long");
  return rel;
}
```

Excluding NUL/CR/LF is what stops anything smuggling a header into the rc HTTP request or a second parameter into an `fs` string. Every *name* written to a remote additionally passes the existing `invalidBaseName()` (server.ts:159).

### Synthetic root

`registry.rootListing()` returns one `RootEntry` per provider (`EntryInfo` plus `kind: "provider"`), sorted case-insensitively, so the client renders it distinctly.

Gate it on `PORTAL_VIRTUAL_ROOT` = `auto` | `always` | `never`, default **`auto`** = synthetic root only when ≥1 remote is configured. With zero remotes the virtual root is a pure regression — an extra click, and every existing `#/Photos` bookmark 404s. `auto` makes this change a no-op for deployments that don't opt in.

---

## D. rc client — `src/providers/rc.ts`

### Endpoint allowlist

```ts
/** Every rc method Portal may call. Deliberately excludes all config/* except
 *  listremotes, all options/*, core/command, debug/*, job/stop: config/dump and
 *  options/get return live credentials; core/command runs arbitrary rclone. */
const RC_ALLOW = new Set([
  "config/listremotes", "operations/fsinfo",
  "operations/list", "operations/stat",
  "operations/mkdir", "operations/purge", "operations/rmdir", "operations/deletefile",
  "operations/copyfile", "operations/movefile", "operations/uploadfile",
  "sync/copy", "sync/move",
  "job/status", "core/stats", "core/version",
]);

export function rcCall<T>(path: string, params: object, opt?: RcOpt): Promise<T> {
  if (!RC_ALLOW.has(path)) throw new Error(`rc endpoint not allowed: ${path}`);
  // …
}
```

Two invariants, both worth a comment and both grep-checkable in review:
- `path` is **never** interpolated from user input — every call site passes a string literal (`grep -nE 'rcCall\(\s*[^"]'` must be empty).
- `config/listremotes` is the only `config/*` member; it returns names, never secrets.

Be honest in the docs: **rclone has no server-side method filter.** This is a client-side control. Actual containment is (a) the rc port is unpublished on an `internal: true` network, (b) `rclone.conf` is mounted `:ro`, (c) the sidecar mounts nothing but `/data`, `/config/rclone.conf:ro` and a cache volume.

### Transport

- `POST ${url}/${path}`, JSON body, `Authorization: Basic …` built once at startup.
- `AbortSignal.timeout(30_000)` default. Byte-streaming GETs get no total timeout but wire `req.signal` through, so a client disconnect tears down the upstream instead of leaving rclone pulling from Drive.
- **Per-provider concurrency semaphore** (`PORTAL_RCLONE_MAX_CONCURRENCY`, default 8) so a big zip can't fan out into a provider rate-limit ban.
- **Listing micro-cache**, `Map<providerId+"\0"+rel, {at, promise}>`, `PORTAL_RCLONE_LIST_CACHE_MS` default 1500. Collapses `loadPath` + SSE poll + transfer planning hitting one directory. Invalidated by `poke()`.

### Error mapping

rclone answers failures with an HTTP error status and `{"error": "...", "input": {...}, "status": …, "path": …}`.

```ts
function mapRcError(httpStatus: number, body: { error?: string }, ref: string): PathError {
  const e = (body.error ?? "").toLowerCase();
  const m = (re: RegExp) => re.test(e);
  if (m(/object not found|directory not found|not found|doesn't exist/))  return new PathError("Not found", 404);
  if (m(/already exists|file exists/))                                     return new PathError("Name already exists", 409);
  if (m(/permission denied|forbidden|unauthoriz|access denied|insufficient permissions/))
                                                                          return new PathError("Permission denied", 403);
  if (m(/rate ?limit|too many requests|userratelimitexceeded|quota.*exceed|slow ?down|throttl/))
                                                                          return new PathError("Storage provider is rate limiting; retry shortly", 429);
  if (m(/quota|storage.*full|no space|insufficient storage/))              return new PathError("Storage full", 507);
  if (m(/context deadline exceeded|timeout|i\/o timeout|deadline/))        return new PathError("Storage backend timed out", 504);
  if (m(/didn't find section in config file|unknown remote|failed to create file system/))
                                                                          return new PathError("Unknown remote", 404);
  if (m(/can't (copy|move)|not supported|unsupported/))                    return new PathError("Operation not supported by this provider", 501);
  return new PathError(`Storage backend error (ref ${ref})`, 502);
}
```

**Never forward `body.error` or `body.input` to the client** — they carry bucket names, object IDs and an echo of our own parameters. Log the raw JSON server-side under the same `randomBytes(6).toString("base64url")` correlation-ref scheme `errorResponse()` already uses; return only the ref. This preserves the existing "don't leak fs error strings" policy. Transport failures (`ECONNREFUSED`, abort) → 503. 429 responses set `retry-after: 5`.

### Deriving `fs` / `remote`

For every `operations/*` call, `fs` and `remote` are **separate JSON parameters, never concatenated**. `fs` is `"<name>:"` where `name` came from `config/listremotes` and passed `^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$` at boot. `remote` is `lexicalRelative()` output.

`sync/copy` / `sync/move` force concatenation because `srcFs`/`dstFs` carry the path:

```ts
export function joinFs(fsBase: string, rel: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}:$/.test(fsBase)) throw new Error("bad fs base");
  if (/[\r\n\0]/.test(rel)) throw new PathError("invalid path");
  return rel ? fsBase + rel : fsBase;
}
```

### Backend names are untrusted input

`lexicalRelative` validates what the *client* sends; nothing validates what the *backend* sends back. Object-store keys created out-of-band can literally be `../evil`, contain CR/LF or NUL, or start with `/`. Left alone they flow into `/api/list` JSON, into zip entry names via `walkFiles` (a `..` segment is zip-slip for whoever extracts the archive), and toward `content-disposition` on download. So `RcloneProvider` filters on the way out: `list`/`listNames` drop entries whose `Name` is `.`/`..` or contains a control char; `walkFiles` drops any `item.Path` with a `..` segment, a leading `/`, a backslash, or a control char. Every drop is logged with a correlation ref — silent acceptance is how these become extraction bugs. Local cannot produce such names (the filesystem forbids `/` and NUL inside a component), so this filter is rclone-side only.

### `--rc-serve` byte URL

```ts
function serveUrl(remoteName: string, rel: string): string {
  const segs = rel ? rel.split("/").map(encodeURIComponent).join("/") : "";
  return `${cfg.url}/[${remoteName}:]/${segs}`;
}
```
`encodeURIComponent` escapes `[`, `]`, `%`, `#`, `?` inside segments, so only the literal delimiters survive.

### `_async` policy

| Call | Mode |
|---|---|
| `list`, `stat`, `fsinfo`, `mkdir`, `deletefile`, `rmdir` | sync, 30 s |
| `uploadfile` | sync, no total timeout — needs the live request for the multipart body; `_async` is unusable |
| `copyfile`, `movefile` | sync, 120 s |
| `purge` | `_async` when the target is a directory |
| `sync/copy`, `sync/move` | **always `_async`** |

Async wait: `{jobid}` → poll `job/status` at 500 ms backing off to 2 s, until `finished` or `PORTAL_TRANSFER_SYNC_DEADLINE_MS` (120 s). `core/stats?group=…` is logged at completion.

### `operations/fsinfo` → `Capabilities`

Probed per remote at boot, refreshed every 10 min. `Features.CanHaveEmptyDirectories` → `emptyDirs`, `Features.Move || Features.DirMove` → `canMove`, `Features.CaseInsensitive`, `Features.DuplicateFiles`. `canCopy` is unconditionally true (rclone always has a stream-through fallback). `watchIntervalMs` = 15 s when `Features.SlowModTime`, else `cfg.pollIntervalMs`.

---

## E. Per-handler migration

Common preamble replacing `safeResolve(config.root, requested, true)`:
```ts
const r = resolvePortalPath(url.searchParams.get("path") ?? "");
```

### `handleList` (:347)
`kind === "root"` → `{ path:"", root:true, caps:ROOT_CAPS, entries:rootListing() }`. Otherwise `provider.stat` (400 if not a dir) then `provider.list`. `toRelative(config.root, target)` is gone — `portalPath` *is* the wire path. Sorting moves into each provider with an identical comparator.

rclone mapping: `operations/list` with `opt: { noMimeType: true }` — **always suppress MIME**, since some backends issue an extra request per object to determine it and we never use backend MIME anyway (security). Map `Name`/`IsDir`/`Math.max(0,Size)`/`Date.parse(ModTime)||0`, after the backend-name filter from §D.

**New `caps` field on `/api/list`** — how the client learns capabilities with no extra round trip, refreshed on every navigation.

### `subscribeToDir` / `handleEvents` (:454 / :503) → `watch.ts`
`watchedDirs` becomes keyed by `providerId + "\0" + rel` (was: realpath'd absolute dir). `MAX_WATCHED_DIRS = 256` and its 503 stay, now covering local + remote combined. `WatchEntry.watcher: FSWatcher` becomes `handle: { stop(); poke() }` from `provider.makeWatcher`. **The 150 ms debounce / 1000 ms ceiling / fan-out / unsubscribe-guard logic (:468-500) is untouched** — it sits above the handle, so it coalesces poller ticks exactly as it coalesced inotify events.

`RcloneProvider.makeWatcher` polls one uncached `operations/list`, hashing `(name, isDir, size, modTime)`. Cloud backends do not update a parent directory's mtime, so stat-the-dir is not a usable signal. Adaptive interval: floor 5 s on change, ×1.5 backoff when quiet up to 60 s, ×2 on error. `unref()` the timer.

`poke(providerId, dirRel)` resets the fingerprint and fires immediately; called at the end of `handleUpload`, `handleMkdir`, `handleTouch`, `handleDelete`, `handleRename`, `handlePutFile` and `handleTransfer` (both source and destination dirs, plus the background job completion callback). This is what makes 10 s polling acceptable UX — it mainly benefits *other* users' tabs, which is exactly where polling is weakest.

`kind === "root"` → a valid SSE stream with `retry:`, `event: ready` and heartbeats only; the provider set doesn't change at runtime.

**The client is completely unchanged here** — one `EventSource` per displayed folder, bare `event: dirty`, re-list.

### `handleDownload` (:576)
`provider.stat` → 400 on dir; `provider.read(rel, null)`; headers constructed by the handler exactly as today. **No upstream header is ever copied** — in particular not rclone's `Content-Type`. `--rc-serve` uses Go's `http.ServeContent`, which sniffs and would happily label an uploaded file `text/html`. The forced `application/octet-stream` + `attachment` + `nosniff` triple must stay intact for remote content.

### `handleStream` (:634)
The `STREAM_MEDIA_MIME` extension allowlist check runs **before** any provider call, on the portal path's basename. Range regex, the 416 branch and header construction stay in the handler verbatim; only the byte source changes to `provider.read(rel, {start,end})`.

```ts
const rr = await r.provider.read(r.rel, { start, end });
if (!rr.ranged) {
  // Backend ignored the Range. Serving these bytes as 206 would corrupt
  // playback, so degrade to a full 200 rather than lie about the range.
  return new Response(rr.body, { headers: { ...headers, "content-length": String(rr.total) } });
}
return new Response(rr.body, { status: 206, headers: { ...headers,
  "content-range": `bytes ${start}-${end}/${st.size}`,
  "content-length": String(end - start + 1) } });
```

`RcloneProvider.read` sets `ranged = (res.status === 206)` and parses `total` from the upstream `content-range`, falling back to the stat size.

### `handleZip` (:683)
Per-path `resolvePortalPath` — a single zip may legitimately span providers when the user multi-selects at the virtual root. Reject `kind === "root"`.

Local entries keep today's fast path exactly, via `localAbsolutePath()` → `archive.directory(abs, name)` / `archive.file(abs, {name})`.

Remote entries append lazily. Archiver processes appended entries **serially**, so wrapping each fetch in an async generator means one upstream connection at a time and nothing buffered:

```ts
function lazyRemoteStream(provider: Provider, rel: string): Readable {
  // The fetch does not start until archiver pulls the first byte of THIS
  // entry, so N appended files ⇒ 1 live connection, not N.
  return Readable.from((async function* () {
    const rr = await provider.read(rel, null);
    for await (const chunk of rr.body) yield chunk;
  })());
}
```

`walkFiles` for rclone = one `operations/list` with `opt: { recurse:true, filesOnly:true, noMimeType:true, noModTime:true }`; `item.Path` is already relative to `remote`. New `MAX_ZIP_ENTRIES = 50_000` bounds recursive expansion (`MAX_ZIP_PATHS = 10_000` still bounds the request).

Known limitation, same as today: an error after the first byte cannot become an HTTP status — `archive.destroy(err)` truncates and we log a ref. Worth release-noting, since a mid-zip remote read failure is far more likely than a local one.

### `handleUpload` (:736) — the hard one
Validation (`invalidBaseName`, dir check, `content-length > maxUploadBytes` → 413, `!req.body` → 400) stays in the handler. Body handling moves to `provider.writeStream(...)`. Local is verbatim today's code.

**Rclone: manual multipart framing over `node:http`, not `fetch`.** Params in the query string, body is the stream:

```
POST /operations/uploadfile?fs=gdrive%3A&remote=Photos%2F2024
Content-Type: multipart/form-data; boundary=<32 hex>
Content-Length: <head + declared + tail>     ← only when the client sent one,
                                                else Transfer-Encoding: chunked
--<b>\r\nContent-Disposition: form-data; name="file"; filename="<escaped>"\r\n
Content-Type: application/octet-stream\r\n\r\n<raw bytes, streamed>\r\n--<b>--\r\n
```

`node:http.request` rather than `fetch(…, {duplex:"half"})` because it gives the same `write()` → `false` → `await 'drain'` backpressure primitive the local path already uses. Identical flow control means TCP backpressure reaches the browser, so XHR upload progress stays honest. Bun's `fetch` with a streaming body is the fallback if `node:http` misbehaves under Bun.

The reader loop enforces `maxBytes` mid-stream (413 + `req.destroy()`); on any abort, best-effort `operations/deletefile` cleans up a partial object. `quoteMultipartFilename` escapes `\` and `"` as quoted-pairs (`\r`/`\n` already excluded by `invalidBaseName`). After a 200, **verify with `statOrNull(join(dirRel,name))`** rather than trusting Go's header parsing of non-ASCII filenames — rclone derives the name via `filepath.Base(part.FileName())`.

Honest notes:
- `uploadfile` invokes rclone's `Rcat` (unknown-size upload). Under `--streaming-upload-cutoff` (100 KiB) it buffers and does a normal `Put`; above it, `PutStream` when `Features.PutStream` (Drive and S3 both are), **otherwise it spools to the sidecar's temp dir**. Hence the `rclone_cache` volume. A backend with `PutStream: false` is limited by that disk.
- Sidecar memory: S3 `PutStream` holds `--s3-chunk-size × --s3-upload-concurrency` (~20 MiB) per in-flight upload. Set `mem_limit` and keep concurrency modest.
- **Nothing is buffered whole in Portal's memory on any path.**
- Overwrite semantics match local (`Rcat` replaces; local uses `O_TRUNC`).

### `handleMkdir` (:846) / `handleTouch` (:875)
`RcloneProvider.mkdir`: `operations/mkdir` is idempotent and parent-creating, so it has no EEXIST. Pre-probe `statOrNull` → 409, then create. **This is a check-then-act race**, unlike local `mkdir(recursive:false)` — document it; the local `O_EXCL`/`flag:"wx"` atomicity has no rc equivalent. `createEmptyFile` = `statOrNull` → 409, then a zero-byte `uploadfile`.

Where `emptyDirs === false` the new folder won't appear in the next listing — the capability flag lets the client warn beforehand instead of the folder silently vanishing.

### `handleDelete` (:913)
`kind === "root" || rel === ""` → 400. `RcloneProvider.remove`: `statOrNull` → return silently if absent (matches `force:true`); dir → `operations/purge` (async when non-trivial); else `operations/deletefile`. Swallow "directory not found".

### `handleRename` (:930)
`statOrNull(dest)` → 409, then file → `operations/movefile {srcFs, srcRemote, dstFs, dstRemote}` (same fs both sides); dir → `sync/move` with `createEmptySrcDirs: true, deleteEmptySrcDirs: true, _async: true`. rclone's `sync.MoveDir` takes a server-side `DirMove` fast path when src and dst share an fs and dst doesn't exist, so a Drive folder rename is one API call, not a tree walk.

### `handleGetFile` (:1010) / `handlePutFile` (:1042)
GET: `stat` → 400 on dir, 413 over `maxEditBytes`, then `provider.read`, same forced `octet-stream` + `no-store` + `x-portal-size`/`x-portal-mtime`. Unchanged hardening.

PUT: `readBodyLimited(req, config.maxEditBytes)` stays — **the entire body is buffered before any write begins** (≤10 MB), then `provider.writeBytes`. Local keeps tmp + `rename`, still fully atomic.

**Remote atomicity — chosen semantics, stated plainly.** The save is *not* atomic in Portal. What we do get: we never begin the upload until we hold all the bytes, so a slow or aborted client cannot truncate; rclone's default `--inplace=false` writes-then-renames on backends that support it; object stores make PUT atomic per object; Drive creates a revision atomically. **The genuinely unsafe case** is a backend that is neither object-atomic nor rename-capable (SFTP/FTP/WebDAV with `--inplace` forced on) — there an interrupted upload can truncate. Documented limitation, not papered over. The returned post-write stat may read briefly stale on eventually-consistent backends; impact is a cosmetic stale row until the next poll.

Deferred follow-up (not v1): an `x-portal-if-mtime` request header for lost-update detection, which today's code also lacks.

### `handleTransfer` (:1130) — move/copy including cross-provider
Structure survives; four phases reworked.

**Plan.** `resolvePortalPath` each `from` and the `to`. Reject `kind === "root"` for both, and `rel === ""` as a source (the analogue of `src === config.root`). Self-containment check becomes provider-aware — only meaningful when `src.provider === dst.provider`, using `dstRel === srcRel || dstRel.startsWith(srcRel + "/")`.

**Conflict probe — one round trip instead of N.** Today `stat(p.dest)` runs per plan entry (:1201-1209); on a remote that is one API call per selected file. Replace with a single `toProvider.listNames(toRel)` snapshot that answers every probe. `dedupeDestName` (:1096) loses its `stat` entirely:

```ts
function dedupeDestName(existing: Set<string>, name: string, taken: Set<string>): string
```

Same `file.txt → file 1.txt → file 2.txt`, same trailing-index continuation, same dotfile handling — now pure, synchronous and testable. Local gets the same treatment (`listNames` = one `readdir`), a strict improvement over N stats with identical observable behaviour.

Honest caveat: remote conflict detection is now **snapshot-based and therefore racy** — a concurrent create between listing and write isn't caught. On `duplicateNames === true` backends (Drive) "already exists" isn't a well-defined predicate at all, since Drive will hold two files named `report.pdf` in one folder. Surface this in the conflict-dialog copy for those providers.

**Execute** via `transferOne`:

| src → dst | file | directory |
|---|---|---|
| local → local | `rename`, `EXDEV → cp + rm` (today's code, unchanged) | same |
| any → any (≥1 remote) | `operations/movefile` / `copyfile` with `{srcFs, srcRemote, dstFs, dstRemote}` | `sync/move` / `sync/copy` with `{srcFs: joinFs(srcFs, srcRel), dstFs: joinFs(dstFs, dstRel + "/" + name), createEmptySrcDirs:true, deleteEmptySrcDirs:true (move only), _async:true, _group}` |

- **`sync/*` operates on the *contents* of `srcFs` into `dstFs`.** To move directory `A` into `B` you must set `dstFs = "rem:B/A"`, not `"rem:B"`. Getting this wrong scatters the contents — needs a loud comment.
- **Never `sync/sync`** — it deletes destination files absent from the source. `sync/copy` merges, which is what "overwrite" means after we've purged the destination.
- `overwrite` still does `dst.provider.remove(destRel)` first, so merge-vs-replace is unambiguous.
- Cross-provider is the *same two calls* with different `srcFs`/`dstFs`. This **requires the sidecar to see `/data`** and run as the same uid as Portal, or `deleteEmptySrcDirs` fails to remove the source.
- The `results[]` contract (`moved`/`copied`/`skipped`/`overwritten`/`error`/`as`) is preserved.

**Long transfers.** Bun's `idleTimeout: 30` (:1491) would kill a 5 GB cross-cloud move. Raise to `120` (Bun max 255) — safe for SSE, whose heartbeat is 5 s. Jobs still running at the 120 s deadline report a **new status `"pending"`** with a `jobId` and are handed to a bounded background tracker (cap 64, evict oldest) that keeps polling `job/status` and calls `poke()` on both directories when done; the files then appear through the normal SSE path. A `GET /api/job?id=` progress endpoint is the obvious hook off `core/stats?group=`, explicitly deferred — not needed for parity.

This is the **only** place the client contract changes.

### Unchanged
`/api/me`, `/api/ping`, static serving, CodeMirror vendor route, auth, CSRF, `Sec-Fetch-Site`, CSP, and all three rate-limit buckets. Providers sit strictly below the middleware.

---

## F. Client — `public/app.js`

1. **Provider rows.** Root entries carry `kind: "provider"`; add a `VIEW_KINDS.provider` and an `icon-cloud` CSS mask alongside the existing icon masks. In `buildRow`, render blank size/mtime cells rather than `0 B` / `1970-01-01`.
2. **Capabilities.** `loadPath`/`refreshPath` store `data.caps` in `state.caps` (default all-true so a missing field never regresses). New `applyCaps()` toggles `btnNewFolder`, `btnNewFile`, upload button/`fileInput`, `btnCut` (`!canMove`), `btnCopy`, `btnPaste`, with `title` explaining why. `openRowMenu` hides Edit when `!writable`, Rename/Delete per capability.
3. **Root is inert.** `state.path === "" && data.root` ⇒ all mutating controls disabled; the `drop` handler returns early with `uiAlert("Pick a storage location first")`; `els.dropzonePath` shows "choose a folder".
4. **Empty-dirs warning.** `btnNewFolder`: when `!caps.emptyDirs`, `uiConfirm` — "This storage does not keep empty folders — it will disappear until you add a file. Create anyway?"
5. **Breadcrumbs** (`renderCrumbs`, :610) work unchanged: `""` → `/`, `gdrive/Photos` → `/ › gdrive › Photos`. Optional polish: provider label + icon on the first crumb.
6. **Hash routing** (`pathFromHash`, :1783) unchanged — `#/gdrive/Photos/2024` already round-trips. The `auto` virtual-root default means single-provider deployments keep their existing bookmarks.
7. **Up button** (:1651) and the **`refreshPath` 404 fallback** (:564-571) both already stop at `""` — they now land on the virtual root. Correct as-is.
8. **Transfer results.** `summariseTransferResult` gains a `pending` counter and a line "N still transferring in the background — they'll appear when they're done." `transferLanded` treats `pending` as landed so the view follows into the destination.
9. **Latency feedback.** `loadPath` currently renders nothing while awaiting `/api/list`; remote lists take 300–2000 ms. Add a `state.loading` flag driving a subtle pulse on `els.crumbs`/`els.statusBox`. Small, but it's the difference between "feels remote" and "feels broken".
10. **Must stay unchanged:** `applyEntries` merge semantics, virtualised rendering, `watchPath`/`EventSource` wiring, `probeLiveFailure`, clipboard model, upload XHR, editor, previews, and `VIDEO_EXTS`/`AUDIO_EXTS` (still manually paired with server `STREAM_MEDIA_MIME`).

---

## G. Config & deployment

### `src/config.ts`
```ts
export interface RcloneConfig {
  url: string;                  // PORTAL_RCLONE_URL   e.g. http://rclone:5572
  user: string | null;          // PORTAL_RCLONE_USER
  pass: string | null;          // PORTAL_RCLONE_PASS
  remotes: string[] | null;     // PORTAL_RCLONE_REMOTES  csv allowlist; null ⇒ all
  localFs: string;              // PORTAL_RCLONE_LOCAL_FS default "portal_local:"
  callTimeoutMs: number;        // PORTAL_RCLONE_TIMEOUT_MS         30000
  transferDeadlineMs: number;   // PORTAL_TRANSFER_SYNC_DEADLINE_MS 120000
  pollIntervalMs: number;       // PORTAL_RCLONE_POLL_MS            10000
  maxConcurrency: number;       // PORTAL_RCLONE_MAX_CONCURRENCY    8
  listCacheMs: number;          // PORTAL_RCLONE_LIST_CACHE_MS      1500
}
// AppConfig gains: localId ("local"), localLabel ("Local"),
//                  virtualRoot ("auto"), rclone (null when URL unset)
```
Same env → `config.json` → default precedence; mirror in `config.json` and `.env.example`.

### Boot discovery (`registry.ts`)
1. Always register `LocalProvider(config.root, config.localId)`.
2. If `config.rclone`: `config/listremotes` → filter by allowlist → drop reserved names (`localId`, and the `localFs` remote, which would otherwise duplicate `local`) → validate `^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$`, log-and-skip anything else → `operations/fsinfo` each → build `Capabilities`.
3. **Non-fatal.** If the sidecar isn't up, warn, serve `local` only, retry every 30 s. `depends_on` can't guarantee readiness and Portal must not crash-loop on it.

### `docker-compose.yml`
```yaml
services:
  portal:
    networks: [frontend, rclone_net]
    depends_on: { rclone: { condition: service_healthy } }
    environment:
      PORTAL_RCLONE_URL: "http://rclone:5572"
      PORTAL_RCLONE_LOCAL_FS: "portal_local:"
    # PORTAL_RCLONE_USER / PORTAL_RCLONE_PASS from .env

  rclone:
    image: rclone/rclone:1
    restart: unless-stopped
    # Same uid as portal so files rclone writes into /data are owned identically.
    user: "${PORTAL_UID:-0}:${PORTAL_GID:-0}"
    # NO `ports:` — the rc API is reachable only from `portal`. Publishing 5572
    # would expose a filesystem API with every cloud credential behind it.
    networks: [rclone_net]
    command: [rcd, --rc-addr=:5572, --rc-serve,
              --rc-user=${PORTAL_RCLONE_USER}, --rc-pass=${PORTAL_RCLONE_PASS},
              --config=/config/rclone.conf, --cache-dir=/cache, --temp-dir=/cache/tmp,
              --log-level=NOTICE, --checkers=8, --transfers=4]
    volumes:
      - ./rclone.conf:/config/rclone.conf:ro   # credentials, read-only
      - ./data:/data                            # SAME bind mount as portal
      - rclone_cache:/cache                     # Rcat spool for non-PutStream backends
    security_opt: ["no-new-privileges:true"]
    cap_drop: ["ALL"]
    mem_limit: 512m
    healthcheck:
      test: ["CMD","rclone","rc","--url","http://127.0.0.1:5572",
             "--user","${PORTAL_RCLONE_USER}","--pass","${PORTAL_RCLONE_PASS}","core/version"]
      interval: 30s
      timeout: 5s
      start_period: 5s

networks:
  frontend: {}
  rclone_net: { internal: true }
volumes:
  rclone_cache: {}
```

Host-side `rclone.conf` (`chmod 600`, add to `.gitignore` and `.dockerignore`) must define the alias that makes cross-provider transfers work:
```ini
[portal_local]
type = alias
remote = /data
```

**Why the alias rather than `fs=/data/…`:** rclone accepts a bare absolute path as `fs`, but then a Portal path-handling bug becomes "rclone reads any file the sidecar can see". Routing through `portal_local:` means `fs` is always a constant from config, never a user-derived absolute path. Combined with the sidecar mounting only `/data`, `/config/rclone.conf:ro` and the cache volume, the blast radius of a traversal bug is confined to `/data` — already Portal's own root.

**Why `--rc-user`/`--rc-pass`:** since `portal_local:` is defined *in the config file*, the docs' unauthenticated restriction on bare local paths does not actually block us — so this is defence in depth, not a functional requirement. It costs one random string in `.env` and means a compose misconfiguration or a future sidecar on that network doesn't get a credentialed filesystem API for free.

Portal's own `Dockerfile` and `HEALTHCHECK` are unchanged.

---

## H. Risks and honest tradeoffs

**Latency.** Local `readdir` ~0.1 ms; `operations/list` on Drive 200–800 ms, S3 100–300 ms. Mitigated by the 1.5 s micro-cache, the concurrency cap, and the loading indicator. No prefetch — it multiplies API cost for marginal gain.

**Per-entry cost is actually better on remotes.** Local `handleList` does `readdir` + one `stat` per entry; `operations/list` returns size and modtime in the same call. But `noMimeType: true` is mandatory — some backends issue an extra request per object otherwise.

**Rate limits.** Drive's default is ~1000 queries/100 s/user, and the SSE poller is the main sustained consumer. Worst case at the 256-watcher cap with everything active is ~51 req/s — well over quota. This is precisely why `MAX_WATCHED_DIRS` must stay and why the adaptive backoff must actually be implemented rather than a fixed interval. `PORTAL_RCLONE_POLL_MS` is the operator escape hatch.

**Not atomic, and cannot be made so:** remote `mkdir`/`touch` are check-then-act; editor save can truncate on a non-object-store, non-rename-capable backend; transfer conflict detection is a snapshot, not a lock, and is ill-defined entirely on `DuplicateFiles` backends; cross-provider moves are copy-then-delete inside rclone, so an interruption can leave a file in both places (never neither — rclone deletes only after a verified copy); directory rename without `DirMove` degrades to full copy + delete; empty directories on bucket backends simply do not exist, and we surface that rather than fake it.

**Availability.** A dead sidecar makes remotes 503 while `local` keeps working; discovery retries and nothing crash-loops.

**Security review should focus on, in order:**
1. `lexicalRelative` — is `..` rejection complete, are `\0`/`\r`/`\n` excluded, can anything reach `joinFs` or a query param unescaped?
2. **No upstream rclone header reaches the browser** — specifically `Content-Type` and `Content-Disposition` on `/api/download`, `/api/stream`, `/api/file`. `http.ServeContent` will label an uploaded `.html` as `text/html`; if that leaked, stored XSS in Portal's own origin goes live.
3. `handleStream` still runs the extension allowlist *before* the provider call, and `ranged === false` cannot produce a 206.
4. `rcCall` never invoked with a non-literal path; `RC_ALLOW` has no `config/*` beyond `listremotes`, no `options/*`, no `core/command`.
5. `safeResolve` is unmodified and still the only path-resolution route for `LocalProvider`.
6. rclone service publishes no port, `internal: true` network, auth configured, `rclone.conf` mounted `:ro`.
7. Multipart filename cannot inject a header or a second part; `filepath.Base` on rclone's side is a backstop, not the control.
8. No user-controlled string can reach an `fs:` / `srcFs:` / `dstFs:` construction site.
9. Backend-supplied names — `list`/`listNames`/`walkFiles` drop `..`, absolute, backslash and control-char entries before they can reach a listing, a zip entry name, or `content-disposition`.

---

## I. Verification

**No cloud credentials needed.** Two fake remotes cover the interesting capability space — a `demo` alias remote (`emptyDirs: true`, `DirMove: true`, zero latency) and a **MinIO `s3` remote** (`emptyDirs: false`, no `DirMove`), added to `docker-compose.dev.yml` on `rclone_net` with an `mc` init container to create the bucket.

Run this matrix against `local`, `demo` and `minio`:

| # | Case | Proves |
|---|---|---|
| 1 | root lists all three; crumbs and `#/` round-trip | virtual root, client rendering |
| 2 | drill in, back/forward, deep bookmark | hash routing |
| 3 | download a file — assert `octet-stream` + `attachment` + `nosniff` in devtools | header hardening |
| 4 | **upload `evil.html`, then download it — must NOT render** | the single most important regression test |
| 5 | play + seek a 500 MB mp4 | Range proxying, 206, `content-range` |
| 6 | `Range: bytes=999999999-` on a small file | 416 path |
| 7 | zip a 3-level tree with a unicode filename | `walkFiles`, lazy streams, `contentDisposition` |
| 8 | upload 2 GB watching `docker stats portal` — RSS must stay flat | nothing buffers |
| 9 | abort an upload mid-flight | partial-object cleanup |
| 10 | upload `фото 2024.jpg` | multipart filename encoding + post-upload stat verify |
| 11 | new folder on `minio` | `emptyDirs:false` warning fires; folder does not persist |
| 12 | new file → edit → save → reopen | `writeBytes` + mtime refresh |
| 13 | rename file; rename folder; rename onto an existing name | 409, `sync/move` DirMove |
| 14 | delete file; delete non-empty folder | `deletefile` vs `purge` |
| 15 | move + copy within one provider, file and folder | `movefile`/`copyfile` vs `sync/*` |
| 16 | copy into the same folder ×3 | `dedupeDestName` off a snapshot: `x.txt`, `x 1.txt`, `x 2.txt` |
| 17 | conflict dialog: fail → overwrite → skip | 409 contract preserved |
| 18 | **`local`→`minio` move; `minio`→`demo` copy; `demo`→`local` move** | cross-provider, alias remote, uid/ownership |
| 19 | copy a 3 GB tree cross-provider | `pending` status, background tracker, SSE reveal |
| 20 | two browsers on one folder, mutate in A | `poke` (instant in A), poll (≤10 s in B) |
| 21 | delete the folder being watched | 404 → parent fallback |
| 22 | `docker compose stop rclone`, browse | `local` works, remotes 503, recovery on restart |
| 23 | `curl http://<host>:5572/` from the host | must fail — port unpublished |
| 24 | `curl -XPOST http://rclone:5572/config/dump` from inside `portal` | 401; confirms Portal's allowlist, not the network, is what stops *our* code |
| 25 | `?path=gdrive/../../etc/passwd`, `?path=/etc/passwd`, `?path=..%2f..%2fetc` | `lexicalRelative` + `safeResolve` |
| 26 | out-of-band object named `../evil.txt` in `minio` (via `mc`), then list + zip its parent | backend-name filter: excluded from both, ref logged |

**Automated.** No test infrastructure exists today. Add `bun test`:
- `test/path.test.ts` — `lexicalRelative` (traversal, absolute, NUL/CR/LF, length, unicode, empty segs), `resolvePortalPath` (root, unknown provider, provider-root), `joinFs` (rejects non-bare base, rejects CR/LF).
- `test/dedupe.test.ts` — `dedupeDestName` is pure and synchronous for the first time, so the whole indexing behaviour is table-testable.
- `test/rc-errors.test.ts` — `mapRcError` over recorded rclone error strings.
- `test/remote-names.test.ts` — the rclone-side output filter over fixture listings containing `../evil`, CR/LF, backslash and absolute paths.
- `test/rc-allowlist.test.ts` — asserts `RC_ALLOW` excludes `config/*` (bar `listremotes`), `options/*`, `core/command`, `debug/*`.
- `test/e2e.test.ts` — boot against a temp root + `demo` alias remote, drive every `/api/*` endpoint over HTTP, asserting on **response headers** as well as bodies (that's where the XSS hardening lives).

**Typecheck.** `npm run typecheck` must stay clean; `tsconfig.json` `include` is `src/**/*.ts` so `src/providers/**` is covered automatically. Add `test/**/*.ts` when tests land.

---

## Sequencing

Each step is independently shippable and reviewable.

1. `types.ts` + `path.ts` + `local.ts` + `registry.ts`; migrate all 15 handlers to the interface with only `LocalProvider` registered and `virtualRoot: "never"`. **Zero behaviour change** — this is the risky refactor and it should land, green, before rclone exists.
2. `rc.ts` (transport, allowlist, error mapping) + `rclone.ts` read paths + registry discovery + compose sidecar + `demo` alias. Read-only remotes work.
3. `watch.ts` generalisation + polling watcher. SSE works on remotes.
4. Write paths: `mkdir`, `createEmptyFile`, `remove`, `renameInPlace`, `writeBytes`.
5. `writeStream` multipart upload + `handleZip` remote branch.
6. `transfer.ts` including cross-provider, `pending` status, background job tracker.
7. Client: provider rows, capability gating, root inertness, `pending`, loading state.
8. MinIO in dev compose; full matrix; docs (`README`, `.env.example`, `config.json`).

## Critical files

- `src/server.ts` — all 15 handlers, router, SSE registry
- `src/config.ts` — `RcloneConfig`, new `AppConfig` fields; `safeResolve` **must not change**
- `src/providers/**` — new
- `public/app.js` — provider rows, caps gating, `pending`
- `docker-compose.yml`, `docker-compose.dev.yml`, `.env.example`, `config.json`, `.gitignore`, `.dockerignore`
