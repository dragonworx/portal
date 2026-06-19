# Portal

A small Bun + TypeScript file portal. Run a server with a configured root
folder, then use the browser client to browse, upload, and download files. The
client uses a drilldown (one folder at a time) rather than a tree, with virtual
scrolling so very large folders stay snappy.

## Install

```sh
bun install
# If your machine is behind a proxy that blocks Bun's installer, use npm —
# it produces a node_modules Bun can run against:
#   npm install --no-audit --no-fund
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

On the machine running the server: <http://localhost:4000>.

From any other client on the network: `http://<server-host>:<port>`
(e.g. `http://files.lan:4000` or `http://10.0.0.7:4000`). For this to work
you must:

- keep `host: "0.0.0.0"` in `config.json` (the default — `127.0.0.1` is
  loopback-only), and
- allow inbound TCP on the chosen port in your server's firewall / cloud
  security group (`sudo ufw allow 4000/tcp`, AWS SG rule, etc.).

> **There is no authentication.** Anyone who can reach the port can browse,
> download, and upload to the configured root. Either keep it on a trusted
> network or front it with auth (see *Deploying behind nginx* below).

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

- **No built-in authentication.** Restrict by network or put auth in front
  (e.g. nginx `auth_basic`, oauth2-proxy).
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

## Deploying behind nginx

Three things matter when fronting Portal with nginx: raise the body size
limit, **disable request buffering** so uploads stream through to Bun in real
time (otherwise nginx spools the whole file to disk before Bun sees a byte and
the client's progress bar finishes long before the file lands), and **disable
response buffering** so streamed zips flush as they're built.

### 1. Bind Bun to loopback

Edit `config.json`:

```json
{ "host": "127.0.0.1", "port": 4000, "root": "./files", "maxUploadBytes": 5368709120 }
```

This ensures only nginx can reach the Bun process.

### 2. nginx server block

```nginx
upstream portal_app {
    server 127.0.0.1:4000;
    keepalive 32;
}

server {
    listen 443 ssl http2;
    server_name portal.example.com;

    ssl_certificate     /etc/ssl/portal/fullchain.pem;
    ssl_certificate_key /etc/ssl/portal/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    # Must be >= config.json maxUploadBytes. 0 = unlimited.
    client_max_body_size 5g;
    client_body_buffer_size 256k;

    # Optional but recommended — Portal has no auth of its own.
    # htpasswd -c /etc/nginx/portal.htpasswd alice
    # auth_basic           "Portal";
    # auth_basic_user_file /etc/nginx/portal.htpasswd;

    # Streaming-friendly proxy for upload / download / zip.
    location ~ ^/api/(upload|download|zip) {
        proxy_pass http://portal_app;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection        "";

        proxy_request_buffering off;   # stream uploads through to Bun
        proxy_buffering         off;   # stream zips/downloads back to client
        proxy_max_temp_file_size 0;

        proxy_connect_timeout 60s;
        proxy_send_timeout    1h;
        proxy_read_timeout    1h;
        send_timeout          1h;
    }

    # Everything else (static client, /api/list, /api/ping, /api/mkdir) is
    # small and benefits from default buffering.
    location / {
        proxy_pass http://portal_app;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection        "";
    }
}

server {
    listen 80;
    server_name portal.example.com;
    return 301 https://$host$request_uri;
}
```

```sh
sudo nginx -t && sudo systemctl reload nginx
```

### 3. Keep Bun running (systemd)

`/etc/systemd/system/portal.service`:

```ini
[Unit]
Description=Portal (Bun)
After=network.target

[Service]
Type=simple
User=portal
WorkingDirectory=/opt/portal
Environment=PORTAL_CONFIG=/opt/portal/config.json
ExecStart=/usr/local/bin/bun run src/server.ts
Restart=on-failure
RestartSec=2
ProtectSystem=strict
ReadWritePaths=/opt/portal/files
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now portal
```

### Why each directive matters

| Setting | Reason |
| --- | --- |
| `client_max_body_size 5g` | Default 1 MB makes nginx 413 large uploads before Bun sees them. |
| `proxy_request_buffering off` | Streams uploads to Bun as they arrive — accurate progress, no disk spike. |
| `proxy_buffering off` | Lets `/api/zip` stream the archive to the browser as it's produced. |
| `proxy_max_temp_file_size 0` | Belt-and-braces against nginx spooling responses to disk. |
| `proxy_read/send_timeout 1h` | Multi-GB transfers can legitimately take a while. |
| `proxy_http_version 1.1` + empty `Connection` header | Enables upstream keepalive declared in the `upstream` block. |
| `auth_basic` (optional) | Portal exposes a filesystem; put auth in front before opening it up. |
