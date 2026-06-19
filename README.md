# Portal

A small Bun + TypeScript file portal. Run a server with a configured root
folder, then use the browser client to browse, upload, and download files. The
client uses a drilldown (one folder at a time) rather than a tree, with virtual
scrolling so very large folders stay snappy.

## Install

```sh
bun install
```

## Configure

Edit `config.json`:

```json
{
  "root": "./files",           // path served by the portal
  "port": 4000,
  "host": "0.0.0.0",
  "maxUploadBytes": 5368709120 // 5 GB per file
}
```

The root folder is created if it does not exist.

## Run

```sh
bun run start
# or, with hot reload
bun run dev
```

Open <http://localhost:4000>.

## Features

- **Drilldown navigation** with breadcrumb path; URL hash reflects the
  current folder (back/forward and shareable links work).
- **Virtual scrolling** keeps folders with thousands of entries snappy.
- **Filter box** narrows the current folder by substring.
- **Selection-aware download**:
  - 1 file selected → streamed directly from disk.
  - Multiple files or any folder selected → server zips on the fly and streams
    the archive to the browser.
- **Uploads** via the toolbar button or drag-and-drop. Each file is sent as
  its own request so per-file progress is shown.
- **Connection indicator** in the top right pings `/api/ping` every 5 s and
  flips to red when the server is unreachable.
- **New folder** creation inside the current directory.

## Security

- All paths are resolved against the configured root, including
  `realpath` checks, so traversal via `..` or symlinks is rejected.
- Upload filenames are validated to forbid path separators.
- `maxUploadBytes` caps the request body size both at the Bun layer and
  while streaming to disk.

## HTTP API

| Method | Path                              | Purpose                                  |
| ------ | --------------------------------- | ---------------------------------------- |
| GET    | `/api/ping`                       | Liveness check                           |
| GET    | `/api/list?path=…`                | List a directory                         |
| GET    | `/api/download?path=…`            | Download a single file                   |
| POST   | `/api/zip`                        | `{ paths: [], name? }` → streamed zip    |
| POST   | `/api/upload?path=…&name=…`       | Raw body, file written to `path/name`    |
| POST   | `/api/mkdir`                      | `{ path, name }` → create subdirectory   |
