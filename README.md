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
  "maxUploadBytes": 5368709120, // 5 GB per file
  "auth": {
    "enabled": false,           // turn on once the values below are filled in
    "clientId": "",             // Google OAuth client ID
    "clientSecret": "",         // Google OAuth client secret
    "publicUrl": "",            // e.g. https://portal.example.com
    "allowedEmails": [],        // exact match, case-insensitive
    "allowedDomains": [],       // e.g. ["example.com"] — optional
    "sessionSecret": "",        // ≥32 chars; `openssl rand -base64 48`
    "cookieSecure": true,       // false only for http://localhost dev
    "sessionTtlSeconds": 604800 // 7 days
  }
}
```

The root folder is created if it does not exist.

Every value can be overridden by an env var:

| Env var                    | Purpose                                  |
| -------------------------- | ---------------------------------------- |
| `PORTAL_ROOT`              | Root folder served by the portal         |
| `PORTAL_PORT`              | Bind port                                |
| `PORTAL_HOST`              | Bind host                                |
| `PORTAL_MAX_UPLOAD_BYTES`  | Max per-file upload size                 |
| `PORTAL_AUTH_ENABLED`      | `true` to require Google sign-in         |
| `GOOGLE_CLIENT_ID`         | OAuth client ID                          |
| `GOOGLE_CLIENT_SECRET`     | OAuth client secret                      |
| `PORTAL_PUBLIC_URL`        | Externally-reachable origin              |
| `PORTAL_ALLOWED_EMAILS`    | Comma-separated allowlist                |
| `PORTAL_ALLOWED_DOMAINS`   | Comma-separated allowlist (e.g. `acme.com`) |
| `PORTAL_SESSION_SECRET`    | HMAC secret for session cookies (≥32 chars) |
| `PORTAL_COOKIE_SECURE`     | `true` (default) — requires HTTPS        |
| `PORTAL_SESSION_TTL`       | Session lifetime in seconds              |

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

> **Authentication is opt-in.** When `auth.enabled` is `false` (the default)
> anyone who can reach the port can browse, upload, and download to the
> configured root. Either keep it on a trusted network, enable Google sign-in
> (below), or front it with another auth layer (see *Deploying behind nginx*).

## Authentication (Google sign-in)

Portal can require sign-in via Google OAuth 2.0 and only allow a configured
list of email addresses (or whole domains) through.

### 1. Create a Google OAuth client

1. Go to <https://console.cloud.google.com/apis/credentials>.
2. **Create credentials → OAuth client ID → Web application.**
3. **Authorised redirect URI:** `<publicUrl>/auth/callback`, e.g.
   `https://portal.example.com/auth/callback`. For local development you can
   add `http://localhost:4000/auth/callback`.
4. Copy the **Client ID** and **Client secret**.

### 2. Generate a session secret

```sh
openssl rand -base64 48
```

This 64-character string is the HMAC key for session cookies. Treat it like a
password — anyone with it can forge sessions. Rotate it to forcibly sign
everyone out.

### 3. Fill in `config.json`

```json
{
  "auth": {
    "enabled": true,
    "clientId": "1234567890-xxxxxxxxxxxxxxxxxxxxx.apps.googleusercontent.com",
    "clientSecret": "GOCSPX-xxxxxxxxxxxxxxxxxxxxxx",
    "publicUrl": "https://portal.example.com",
    "allowedEmails": ["alice@example.com", "bob@example.com"],
    "allowedDomains": [],
    "sessionSecret": "paste-the-openssl-rand-output-here",
    "cookieSecure": true,
    "sessionTtlSeconds": 604800
  }
}
```

For container deployments, prefer env vars (see the table above) so secrets
don't have to live in `config.json`.

> `publicUrl` **must** match exactly what you registered with Google
> (including the scheme and port) — that's what's sent to the token endpoint
> as the `redirect_uri`.

### 4. Restart Portal

Boot output will confirm:

```
[portal] auth        = google oauth (2 emails, 0 domains)
[portal] public url  = https://portal.example.com
```

Hit the portal — unauthenticated requests bounce to `/login`, click *Sign in
with Google*, pick an authorised account, and you're back at the file
browser. Email addresses that aren't on the allowlist see a friendly
"not authorised" message and never get a session cookie.

### Local development with auth

Google's OAuth flow requires a stable redirect URI. For local dev:

- set `publicUrl` to `http://localhost:4000`
- set `cookieSecure` to `false` (or `PORTAL_COOKIE_SECURE=false`) so the
  browser will accept cookies over plain HTTP
- add `http://localhost:4000/auth/callback` to the OAuth client's authorised
  redirect URIs

## Run with Docker

Two ways to get Portal running on a server with Docker. Both use the same
`docker-compose.yml` — the only difference is whether the image is pulled
from a registry or built locally.

### Option 1 — Pull a pre-built image (recommended)

> **Note:** Portal does not currently publish an official image. Replace
> `ghcr.io/OWNER/portal:latest` below with whatever you publish via
> `bun run docker:publish` (see *Publishing your own image* further down).

You only need `docker-compose.yml` and a place for your files. No clone,
no Bun, no Node:

```sh
mkdir portal && cd portal
curl -O https://raw.githubusercontent.com/OWNER/portal/main/docker-compose.yml
mkdir data

# Edit docker-compose.yml: remove the `build: .` line and uncomment the
# `image: ghcr.io/OWNER/portal:latest` line (pointing at your registry).

docker compose up -d
```

Portal is now on <http://127.0.0.1:4000> (the default `ports:` binding is
loopback-only — drop the `127.0.0.1:` prefix in `docker-compose.yml` to
expose it on the network). Drop files into `./data` and they appear in the
UI; uploads land in the same folder.

Upgrade by pulling the new tag and recreating the container:

```sh
docker compose pull
docker compose up -d
```

### Option 2 — Clone and build from source

Use this if you want to track your own fork, modify the code, or run a
version that isn't published.

```sh
git clone https://github.com/OWNER/portal.git
cd portal

# The Dockerfile copies a pre-installed node_modules into the image (see the
# comment at the top of the Dockerfile for why). Run the install once on the
# host before building:
npm install --omit=dev --no-audit --no-fund

bun run docker:build   # docker compose build
bun run docker:up      # docker compose up -d, then tails logs
```

Rebuild after pulling new commits:

```sh
git pull
npm install --omit=dev --no-audit --no-fund
bun run docker:build
bun run docker:up
```

For working on Portal itself, `bun run docker:watch` brings the container up
with the source folders bind-mounted and `bun --hot` watching for changes.

### Publishing your own image

`bun run docker:publish` installs production deps, builds the image, and
pushes it to a registry. Override the tag with env vars:

```sh
# Defaults to ghcr.io/OWNER/portal:latest — change OWNER (and the defaults
# in package.json) once you've decided on a real registry path.
PORTAL_IMAGE=ghcr.io/your-org/portal PORTAL_TAG=1.2.3 bun run docker:publish
```

You'll need to `docker login` to the target registry first.

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

Portal is designed to be safe to expose publicly when sign-in is enabled.
The defences below are layered: each one is intentionally redundant with the
others so a slip in any single check doesn't open a hole.

### Authentication & session

- **Google OAuth 2.0 Authorization Code flow.** The portal never sees the
  user's password; Google returns an `id_token` over TLS from its token
  endpoint and Portal validates `iss`, `aud`, `exp`, and `email_verified`.
- **Email/domain allowlist.** A verified Google email that isn't on
  `allowedEmails` or in `allowedDomains` is rejected before a session cookie
  is ever issued, and the attempt is logged.
- **Cryptographically signed cookies.** Sessions are HMAC-SHA256 tokens over
  `{email, iat, exp}`; tampering invalidates the signature. Comparison uses
  `crypto.timingSafeEqual`. Minimum secret length is enforced (≥32 chars).
- **Cookie hardening:** `HttpOnly`, `Secure` (configurable; required in
  production), `SameSite=Lax`, `Path=/`, explicit `Max-Age`.
- **OAuth `state` is signed + bound to a HttpOnly cookie** with a 10-minute
  TTL, so a stolen `code` cannot be replayed against another browser.
- **Open-redirect protection.** The post-login `returnTo` parameter is
  carried inside the signed state and constrained to same-site absolute
  paths only (no protocol-relative `//evil.com`, no backslashes, no NUL
  bytes, ≤512 chars).

### CSRF

- **Double-submit cookie.** Sign-in sets a separate non-HttpOnly
  `portal_csrf` cookie containing a 256-bit random token. The client echoes
  it back in an `X-CSRF-Token` header on every state-changing request, and
  the server compares them with `timingSafeEqual`. Cross-origin attackers
  can't read the cookie and so can't forge the header.
- **SameSite=Lax** on the session cookie blocks the classic
  cross-origin-form-POST CSRF on top of the token check.

### Filesystem

- All user-supplied paths are resolved against the configured root with
  `realpath`, so `..` traversal and symlinks that escape the root are
  rejected.
- Upload/mkdir names are validated to reject `/`, `\`, `.`, `..`, NUL bytes,
  control characters, names >255 chars, and the empty string.
- Per-file upload size is capped both at the Bun layer and while streaming
  to disk (`maxUploadBytes`).
- `/api/zip` and `/api/mkdir` JSON bodies are capped at 1 MB and `paths[]`
  is capped at 10 000 entries.

### Content & headers

- **Downloads are forced to `application/octet-stream`** with
  `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`.
  This neutralises stored-XSS via uploaded `.html`/`.svg`/`.pdf` (the
  browser refuses to render them inline, so a malicious file can't execute
  in our origin and steal other users' sessions).
- **Strict CSP** on every HTML response:
  `default-src 'self'; script-src 'self'; style-src 'self'; …; object-src 'none'; frame-ancestors 'none'; base-uri 'none'`.
  Inline scripts and remote loads are blocked.
- `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Resource-Policy: same-origin`,
  restrictive `Permissions-Policy`.
- All client errors are returned with sanitised messages — no stack traces
  leak to the wire.

### What Portal does NOT protect against

- **Insider abuse.** Anyone on the allowlist can read/write everything under
  `root`. Use OS permissions to scope what the Bun process can touch and run
  it under an unprivileged user (the systemd unit at the end of this README
  shows the pattern).
- **Dotfiles.** Hidden files (`.env`, `.git/`, …) under `root` are listed
  and served like anything else. Don't put secrets inside `root`.
- **HTTPS termination.** Portal speaks HTTP; put it behind nginx/Caddy/
  similar with TLS in production. `cookieSecure: true` then refuses to send
  cookies over the plaintext link.
- **Rate limiting / brute force protection.** Google handles abuse on its
  end of the OAuth flow; for the portal endpoints themselves use your
  reverse proxy (`limit_req` in nginx) if you expect untrusted load.

### Pre-deploy checklist

- [ ] `auth.enabled` is `true` and `allowedEmails`/`allowedDomains` is
      populated.
- [ ] `sessionSecret` is from `openssl rand -base64 48`, not a guessable
      string, and is **not** committed to source control.
- [ ] `publicUrl` is `https://…` and matches the OAuth client's
      authorised redirect URI exactly.
- [ ] `cookieSecure` is `true`.
- [ ] Portal is behind HTTPS (nginx / Caddy / cloud load balancer).
- [ ] Bun runs as an unprivileged user with `ProtectSystem=strict` +
      `ReadWritePaths` scoped to the file root.
- [ ] `root` does not contain secrets or other files the signed-in users
      shouldn't see.

## HTTP API

| Method | Path                              | Purpose                                  | Auth |
| ------ | --------------------------------- | ---------------------------------------- | ---- |
| GET    | `/api/ping`                       | Liveness check                           | no   |
| GET    | `/api/me`                         | Current user (`{email, authEnabled}`)    | yes  |
| GET    | `/api/list?path=…`                | List a directory                         | yes  |
| GET    | `/api/download?path=…`            | Download a single file                   | yes  |
| POST   | `/api/zip`                        | `{ paths: [], name? }` → streamed zip    | yes  |
| POST   | `/api/upload?path=…&name=…`       | Raw body, file written to `path/name`    | yes  |
| POST   | `/api/mkdir`                      | `{ path, name }` → create subdirectory   | yes  |
| GET    | `/auth/login?returnTo=…`          | Begin Google sign-in                     | no   |
| GET    | `/auth/callback`                  | OAuth callback (called by Google)        | no   |
| GET    | `/auth/logout`                    | Clear session cookies                    | no   |

When `auth.enabled` is `true`, every `POST` must include the
`X-CSRF-Token` header matching the `portal_csrf` cookie.

## Deploying behind nginx

Three things matter when fronting Portal with nginx: raise the body size
limit, **disable request buffering** so uploads stream through to Bun in real
time (otherwise nginx spools the whole file to disk before Bun sees a byte and
the client's progress bar finishes long before the file lands), and **disable
response buffering** so streamed zips flush as they're built.

### 1. Bind Bun to loopback

**Why:** with `host: "0.0.0.0"` Bun listens on every interface, which means
clients could bypass nginx entirely by hitting `http://<server>:4000` and
skip TLS, auth, rate limits, and access logs. Binding to `127.0.0.1` makes
the Bun process reachable only from the same host, so nginx becomes the only
door in. Open the public ports (80/443) on the server firewall and *close*
4000 from the outside.

Edit `config.json`:

```json
{ "host": "127.0.0.1", "port": 4000, "root": "./files", "maxUploadBytes": 5368709120 }
```

### 2. nginx server block

**Why:** nginx's defaults are tuned for small, request/response web apps and
actively harm Portal. `client_max_body_size` defaults to **1 MB**, so any
upload bigger than that gets rejected with `413` before Bun ever sees it.
`proxy_request_buffering` defaults to **on**, which means nginx accepts the
entire upload to a temp file on its own disk *before* forwarding a single
byte to Bun — the client's progress bar finishes long before the file is
really saved, disk usage spikes, and the upload appears to hang at 100 %.
`proxy_buffering` defaults to **on** for responses, which forces nginx to
accumulate the streamed `/api/zip` archive before sending it to the browser,
turning a constant-memory stream into a giant buffer. Default timeouts
(60 s) also kill any multi-GB transfer mid-flight.

The block below fixes those for the streaming routes only, keeps default
buffering for the small JSON/static routes (where it helps), and adds the
usual HTTPS termination, `X-Forwarded-*` headers, and an optional
`auth_basic` since Portal has no auth of its own.

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

**Why:** the nginx block assumes something is always listening on
`127.0.0.1:4000`. If you start Bun by hand in a shell, the first server
reboot — or the first time the process crashes — leaves nginx returning
`502 Bad Gateway` until someone SSHes in and restarts it. A systemd unit
starts Bun at boot, restarts it on failure, runs it as an unprivileged user
so a bug can't read the rest of the disk, and confines writes to the
configured root folder via `ProtectSystem=strict` + `ReadWritePaths`.

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
