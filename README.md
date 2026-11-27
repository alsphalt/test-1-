# Darknote Nexus

A production-shaped version of the Darknote Nexus interface: real accounts, real sessions, real bot pairing, real files, real integrations and a real admin console — backed by PostgreSQL through Prisma.

Next.js 14 (App Router) · TypeScript · Prisma · PostgreSQL · zero client-side demo data.

---

## What actually works

| Area | Behaviour |
| --- | --- |
| Accounts | Register / log in with bcrypt (cost 12) hashed passwords. Emails normalised, passwords need 10+ chars with a letter and a number. Role comes from `ADMIN_EMAILS` or an admin promotion. |
| Sessions | Signed JWT in an `httpOnly`, `SameSite=Lax`, `Secure`-in-production cookie, plus a `Session` row. Revoking a session (or suspending a user) invalidates it on the very next request. Session list shows device, IP and last-seen, and can revoke one or all other devices. |
| Persistence | Everything lives in PostgreSQL: profile, avatar, bots, tokens (hashed), logs, files, integrations, audit trail. Reload, sign out, or sign in from another device — the state is the same. |
| Bot pairing | Dashboard issues a single-use 8-character code (10 min TTL). The bot host redeems it at `POST /api/bots/pair` and receives the only copy of a `dnx_…` token; the server stores a SHA-256 hash and a display prefix. Codes are single-use and revocable. |
| Live status | `POST /api/bots/heartbeat` with `Authorization: Bearer dnx_…` updates status, version, counters, `lastSeenAt` and writes a log line. The UI counts a bot as live only if it reported in the last 2 minutes. |
| Logs | Every heartbeat and every bot error is a `BotLog` row. Global feed, per-bot feed, and a live tail in the dashboard. |
| Files | Multipart upload, 4 MB per file / 50 MB per account, bytes stored in the DB, streamed back as an attachment. Only the owner can read or delete. |
| Integrations | Endpoint + header + API key. Keys are encrypted with AES-256-GCM before insert and never returned to the browser (only `sk_••••abcd`). "Test" performs a real server-side request with an 8 s timeout, records status/latency, and blocks private/loopback hosts (SSRF guard). |
| Admin | Platform totals, 7-day signup/activity series, user search + pagination, promote/demote, suspend/reactivate (suspension revokes sessions), delete, audit log. Self-demotion and self-deletion are refused. |
| WhatsApp | Separate system from Darknote login. Each number is its own Baileys session with a WhatsApp-issued pairing code, encrypted auth state, reconnect, uptime, logs and per-owner access control. |
| Setup | Owner-controlled Setup access. A signed-in Nexus account plus either the owner token or a personal 8-digit setup code. Accounts are created only by the owner, activation creates an approval request, and approval links the Setup account to the main Nexus account. Server-side sessions, immediate revocation, activity log, and a live session overview. Delivery of setup codes goes through the WhatsApp outbox. |
| Realtime | `GET /api/events` is an SSE stream scoped to the signed-in user. It combines an in-process bus with a 4 s database revision poll, so it also works when a heartbeat lands on a different serverless instance. Clients refetch on each `sync` frame; the stream reconnects automatically. |
| Security | Origin check on every mutating request, zod validation on all input, per-IP/per-account rate limits, CSP-ish hardening headers in middleware + `vercel.json`, no secrets in the client bundle, no raw API keys in responses. |

## Layout

```
app/
  page.tsx                  single-page shell (intro → auth → workspace)
  layout.tsx, globals.css   design system ported from the original file
  api/auth/*                register, login, logout, me, sessions
  api/bots/*                CRUD, pair (issue), pair (redeem), revoke, heartbeat, logs
  api/files/*               upload/list/download/delete
  api/integrations/*        CRUD + live connection test
  api/admin/*               stats, users, audit
  api/whatsapp/*            session CRUD, pairing, restart, unlink, logs
  api/admin/whatsapp        platform-wide session view
  api/events                SSE stream
components/                 Intro, AuthScreen, Shell, NexusCanvas, views/*
lib/                        auth, session, crypto, http, validate, events, net, audit
prisma/schema.prisma        PostgreSQL schema + migration SQL
scripts/e2e.mjs             45-check end-to-end suite against a running server
scripts/bot-agent.mjs       reference connector (pair + heartbeat)
worker/index.mjs            Baileys socket worker (separate process)
worker/Dockerfile           image for Railway / Fly / Render / VPS
```

## Local development

```bash
npm install
cp .env.example .env          # fill AUTH_SECRET, ENCRYPTION_KEY, ADMIN_EMAILS
```

With PostgreSQL:

```bash
npx prisma migrate deploy     # or: npx prisma db push
npm run dev                   # http://localhost:3000
```

Without PostgreSQL (SQLite, for a quick spin):

```bash
cp prisma/schema.prisma prisma/schema.local.prisma
# set provider = "sqlite" and remove directUrl inside that file
DATABASE_URL="file:./dev.db" npx prisma db push --schema prisma/schema.local.prisma
npx prisma generate --schema prisma/schema.local.prisma
DATABASE_URL="file:./dev.db" npm run dev
```

Seed an administrator instead of registering one:

```bash
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='strong-pass-1' npm run db:seed
```

## Deploy to Vercel

1. **Database** — create a Postgres instance (Vercel Postgres/Neon/Supabase) and copy both the pooled and direct connection strings.
2. **Project** — import the repo (framework preset: Next.js; build command `npm run vercel-build`, already in `vercel.json`). That command runs `prisma generate`, applies pending migrations, then `next build`, so the schema cannot drift behind the deployed code. A migration *history* problem on an already-correct database (for example tables created with `db push`) can no longer block a release: `db-deploy --advisory` re-checks the live schema with `db-verify --gate` and continues only when nothing the app needs is missing.
3. **Environment variables** (Production + Preview):

   | Name | Value |
   | --- | --- |
   | `DATABASE_URL` | pooled Postgres URL |
   | `DIRECT_URL` | direct Postgres URL (required for migrations) |
   | `AUTH_SECRET` | `openssl rand -base64 48` |
   | `ENCRYPTION_KEY` | `openssl rand -hex 32` |
   | `ADMIN_EMAILS` | your email(s) |
   | `APP_URL` | `https://<project>.vercel.app` |

4. **Schema** — applied automatically by the build. To do it from your machine first (recommended once, so a bad migration never blocks a deploy):

   ```bash
   DATABASE_URL="…" DIRECT_URL="…" npm run db:deploy
   DATABASE_URL="…" DIRECT_URL="…" npm run db:verify:strict
   ```

5. **Deploy** — `vercel --prod` (or push to the connected branch).
6. **Verify** — register, create a bot, pair it, run `node scripts/bot-agent.mjs --url https://<project>.vercel.app --code <CODE>`, watch the bot flip to ONLINE and log lines appear without a reload.

### "The server is missing AUTH_SECRET" on a project that has AUTH_SECRET

Vercel **snapshots environment variables into each deployment**. Adding or
changing a variable never reaches a deployment that already exists, and a
redeploy that fails leaves the previous build serving the domain — so the site
keeps reporting a missing secret while the dashboard shows it as set.

`GET /api/health` answers this directly. `deployment.commit` is the git commit
that produced the running build, and `secrets.sources` names the variable the
runtime actually resolved:

```json
{
  "env": { "AUTH_SECRET": "set", "ENCRYPTION_KEY": "set" },
  "secrets": {
    "sources": {
      "authSecret": { "name": "AUTH_SECRET", "status": "set" },
      "encryptionKey": { "name": "ENCRYPTION_KEY", "status": "set" },
      "checked": { "authSecret": ["AUTH_SECRET", "NEXTAUTH_SECRET", "SESSION_SECRET"] }
    }
  },
  "deployment": { "commit": "…", "target": "production" }
}
```

Read it in this order:

| What you see | What it means |
| --- | --- |
| `AUTH_SECRET: "missing"`, `deployment.commit` older than your latest push | The running deployment predates the variable. Check the Vercel build result for the newer commit; the alias only moves after a build succeeds. |
| `AUTH_SECRET: "missing"`, `deployment.commit` is current | The variable is not in this project **for this environment**. Check Production vs Preview and the value's target environments. |
| `sources.authSecret.name` is `NEXTAUTH_SECRET` | It is configured under an accepted alias; signing works and the state is reported as `set`. |
| `AUTH_SECRET: "too_short"` / `"placeholder"` | The value reached the runtime but is unusable (under 32 characters, or still a template string). |

Secrets are read at request time (`lib/env.ts`), never at build time, so a
deployment that receives a variable still reads the live value. Values are
normalised once (whitespace, surrounding quotes, a pasted `NAME=value` line,
zero-width characters), and the module refuses to be imported into a browser
bundle.

### "The database is connected but its tables are missing or out of date"

That message is `DATABASE_SCHEMA_MISSING` from `lib/errors.ts`: the socket,
credentials and database name are fine, but a `Prisma` query hit a table or
column that does not exist (`P2021`/`P2022`) or migrations are out of sync
(`P3005`/`P3009`). Nothing in the app can create tables, by design — DDL belongs
to migrations.

```bash
# 1. What is actually missing (read-only, never prints the URL)
DATABASE_URL="…" DIRECT_URL="…" npm run db:verify

# 2. Apply every pending migration. Repeatable; drops nothing, deletes nothing.
DATABASE_URL="…" DIRECT_URL="…" npm run db:deploy

# 3. Confirm tables, columns, indexes and foreign keys
DATABASE_URL="…" DIRECT_URL="…" npm run db:verify:strict
```

`db:deploy` is `prisma migrate deploy` plus one repair: when the tables were
originally created with `prisma db push`, `_prisma_migrations` is empty and
Prisma refuses to run (`P3005`). For each migration in that state the script
checks that every table, column and index it creates already exists, and only
then records it as applied (`prisma migrate resolve --applied`). Nothing is
re-executed and no row is touched; if any object is missing it stops and names
it instead of guessing. A Vercel **preview** build skips migrations unless
`DB_MIGRATE_ALLOW_PREVIEW=true`, so a preview can never migrate the production
database by accident.

### Platform notes

- `app/api/events` is capped at 55 s per connection (`maxDuration: 60` in `vercel.json`). On Hobby the function limit is lower; the browser reconnects and the DB poll keeps state fresh either way.
- Rate limits are in-memory per serverless instance. For strict global limits, move `lib/http.ts → rateLimit` to Upstash Redis.
- Files are stored in Postgres (simple, transactional, 4 MB cap). Swap `FileAsset.data` for Vercel Blob if you need larger uploads.
- `UPSTASH_REDIS_REST_URL` / `..._TOKEN` are optional and only speed up cross-instance fan-out.

## Cross-origin setup (the "Cross-origin request blocked" fix)

The UI calls `/api/...` on the same origin, so a normal deploy needs no CORS
configuration at all. Only split deployments (separate API domain, or a preview
host calling the production API) need it.

**Why the browser used to say only "cross-origin request blocked":** a rejected
origin got `403` without `Access-Control-Allow-Origin`, so the browser discarded
the body and DevTools never showed the reason. The rejection now echoes the
origin (without credentials) so the JSON is readable and names the exact value
to add. Every rejection is also logged as `cors.rejected` with the origin, host
and path.

Trusted origins are resolved in this order — no wildcard is ever needed:

0. the product's own domains, built in (`v0-bigbrother.vercel.app`,
   `test-1-three-opal.vercel.app`; override with `PROJECT_ORIGINS`, or set it to
   an empty string to disable),
1. the origin the request was served from (`req.nextUrl.origin`),
2. the `Host` / `X-Forwarded-Host` being requested,
3. `APP_URL`,
4. exact entries in `ALLOWED_ORIGINS`,
5. the deployment's own Vercel hosts (`VERCEL_URL`, `VERCEL_BRANCH_URL`,
   `VERCEL_PROJECT_PRODUCTION_URL`),
6. `*.vercel.app` in the same project when `ALLOW_VERCEL_PREVIEWS=true`.

### v0 preview

- Prefer the same-origin API: leave `NEXT_PUBLIC_API_BASE` unset and call
  relative `/api/...`. If the variable points at the page's own origin it is
  ignored, so the request never enters CORS.
- If the preview must call a different deployment, add the **preview origin**
  (the one in the browser address bar or the v0 iframe) to `ALLOWED_ORIGINS`,
  and set `COOKIE_SAMESITE=none` on the API. `SameSite=None` requires HTTPS; if
  the deployment is not HTTPS the server downgrades to `lax` and logs
  `cookie.samesite_downgraded` instead of sending a cookie the browser discards.
- If v0 renders the app inside an iframe and the frame stays blank, set
  `FRAME_ANCESTORS="'self' https://*.v0.app"`. A non-default value replaces
  `X-Frame-Options: DENY` with a CSP `frame-ancestors` policy.

### Checking a deployment

`GET /api/health` reports `cors.allowedOrigins`, `cors.frameAncestors` and the
effective cookie flags (`httpOnly`, `sameSite`, `secure`), so a mismatch is
visible without guessing. `OPTIONS` preflights reflect the requested method and
headers, so an extra header such as `x-csrf-token` is not rejected.

## Bot agent API (external bot integration)

A WhatsApp bot/control-center process can drive Nexus without merging projects.
Authenticate with the `dnx_…` token issued by **Bots → Details → pairing code**:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/bot/v1/ping` | identity, pending pairing/commands (connection test) |
| POST | `/api/bot/v1/sync` | authoritative snapshot: bot status + `sessions[]`; missing sessions are deleted |
| GET | `/api/bot/v1/pairing` | pairing requests the dashboard queued |
| POST | `/api/bot/v1/pairing/:id` | report the real code (or an error) |
| GET | `/api/bot/v1/commands` | restart/unlink commands, claimed on read |
| POST | `/api/bot/v1/commands/:id` | ack `DONE`/`ERROR` + result |
| POST | `/api/bot/v1/events` | batched log lines (session-scoped or bot-scoped) |

Tokens are hashed at rest, scoped to one owner, revocable from the dashboard and
rejected immediately when the bot is disabled. Sessions reported by a bot are
marked `source: "BOT"`, shown with the bot's name, and deleted when the bot stops
reporting them — so the database, not the browser, stays authoritative.

`docs/` in the bot repository describes the matching connector
(`src/lib/nexus/*`) and the one endpoint the bot process must expose for real
pairing codes.

## WhatsApp (Baileys) — how it actually works

The web app never talks to WhatsApp. It stores intent; a long-lived worker owns the sockets.

```
Browser ──POST /api/whatsapp/sessions──▶ Postgres (WhatsAppSession: PAIRING_REQUESTED)
                                             │
                        worker/index.mjs polls (3s), claims the row, opens a real Baileys socket
                                             │
                        sock.requestPairingCode(phone) ──▶ WhatsApp returns a genuine 8-char code
                                             ▼
                        WhatsAppSession → PAIRING_CODE (+60s expiry)  ── UI shows the code
                                             │
                        owner enters it on their phone  → connection "open"
                                             ▼
                        CONNECTED · meNumber · connectedAt · encrypted creds in WhatsAppKey
```

- **Separate from login.** Darknote sign-in is an httpOnly session cookie. WhatsApp linking needs its own phone number and code; nothing is linked automatically.
- **Multiple sessions.** Each row is an independent socket, credentials set and status. The worker handles many concurrently; the dashboard caps it at 10 per account.
- **Persistence.** `creds` + signal keys are serialised with `BufferJSON`, AES-256-GCM encrypted with `ENCRYPTION_KEY`, and stored in `WhatsAppKey`. After a worker restart the row is re-claimed and reconnects without a new code.
- **Status & alerts.** `CONNECTED / DISCONNECTED / LOGGED_OUT / ERROR` plus `statusDetail`, `disconnectCount`, uptime from `connectedAt`, 15s heartbeat in `lastSeenAt`. The UI raises a toast when a session drops and the worker retries with exponential backoff (6 attempts).
- **Ownership.** Every query is scoped by `userId`; cross-account reads return 404. Admins get `/api/admin/whatsapp` (all sessions + owner email) and audit entries for pair/restart/unlink/delete.

### Running the worker

```bash
# same DATABASE_URL + ENCRYPTION_KEY as the web app
node worker/index.mjs
```

Deploy it anywhere that stays up: Railway/Render/Fly (use `worker/Dockerfile`), a VPS with pm2/systemd, or Docker:

```bash
docker build -f worker/Dockerfile -t darknote-wa .
docker run -e DATABASE_URL=… -e ENCRYPTION_KEY=… darknote-wa
```

Vercel can host the Next.js app but **not** the socket (functions are short-lived). Point both at the same Postgres.

### Verifying without a real phone

- `npm run worker:test` — 18 checks: claim → code → open → disconnect → restart/reconnect with stored creds → unlink wipes keys.
- `npm run worker:fixture` — runs the real worker loop with a stubbed socket so you can click through pairing in the UI. It sends nothing to WhatsApp.
- Real connectivity and code issuance were confirmed from this environment against WhatsApp: a genuine socket negotiated the handshake, and `requestPairingCode()` returned a live 8-character code (`XKPQCCLS`) for a reserved `+1 555` test number. No real phone was contacted and no account was linked.
- Baileys only accepts `requestPairingCode` once the websocket handshake completes — that is, exactly when it would otherwise emit a QR payload. The worker triggers the request on that event; calling it earlier returns `Connection Closed`, which is why the code is not requested at socket construction.

**Operational note:** WhatsApp's Terms of Service do not cover unofficial libraries. Numbers can be rate-limited or banned, especially when a fresh session sends bulk messages. Use dedicated numbers and keep sending low.

## Bot protocol

```bash
# 1. Dashboard → Bots → Details → Issue pairing code
curl -X POST https://<app>/api/bots/pair \
  -H 'content-type: application/json' \
  -d '{"code":"AB12CD34","version":"1.0.0"}'
# → { "botId": "...", "token": "dnx_...", "heartbeatUrl": "..." }

# 2. Report in
curl -X POST https://<app>/api/bots/heartbeat \
  -H 'authorization: Bearer dnx_...' \
  -H 'content-type: application/json' \
  -d '{"status":"ONLINE","message":"poll ok","messagesSent":42,"errors":0}'
```

Status values: `ONLINE`, `OFFLINE`, `PAUSED`, `ERROR`. A disabled bot receives `403`; a revoked/unknown token receives `401`.


## Darknote Setup (owner access)

Setup is a second authorization layer on top of the normal login. It never
replaces the Nexus session, and it is fully independent from WhatsApp: locking
Setup or signing out of the site does not disconnect a paired bot.

| Piece | Behaviour |
| --- | --- |
| Owner identity | An owner email (allowlist) **plus** the owner setup token. Only a bcrypt hash of the token is stored. Set `OWNER_EMAILS` / `OWNER_SETUP_TOKEN`, then rotate it in Setup → Security. |
| Setup accounts | Created only by the owner: username, password, phone, optional display name, optional link to an existing Nexus account. |
| Personal code | 8 random digits, bcrypt-hashed, `SETUP_CODE_TTL_HOURS` (72h) TTL, shown once. It is a reusable passkey for later visits until the owner resets it — resetting invalidates the old code and revokes live Setup sessions. |
| Activation | First use requires username + password + code while signed in. It creates a PENDING access request and claims the account so nobody else can. |
| Approval | Only the owner can approve/reject. Approval links the Setup account to the requesting Nexus account and activates it. |
| Locking | Server-side idle timeout (`SETUP_IDLE_MINUTES`), explicit lock, lock on leaving the Setup view, lock when the tab is hidden for 45s. Revocation is immediate because sessions are database rows. |
| Permissions | Every owner route calls `requireOwnerSetup()`; a normal user gets `403` even with a valid session. Setup accounts cannot create accounts, approve, or read other accounts. |
| Delivery | A code is queued in `WhatsAppOutbox` and sent by the Baileys worker through one of the owner's connected numbers. With no connected number the account records `FAILED` with the reason and the owner can retry — it never claims a message was sent. |

## Signup blocked by CORS

The UI calls `/api` on its own origin by default, which is the recommended
setup. If you split the UI and API across domains:

1. `ALLOWED_ORIGINS="https://your-ui.example"` — exact origins, never `*`.
2. `NEXT_PUBLIC_API_BASE="https://your-api.example"` on the UI build.
3. `COOKIE_SAMESITE="none"` on the API (HTTPS only) so the session cookie can
   be stored cross-site.
4. `APP_URL` must be the public API origin.

The origin check already accepts the deployment's own hosts (`VERCEL_URL`,
`VERCEL_BRANCH_URL`, `VERCEL_PROJECT_PRODUCTION_URL`) and, with
`ALLOW_VERCEL_PREVIEWS=true`, other preview hosts in the same project, so
signup works on preview deployments without extra configuration. A blocked
origin returns `403 CROSS_ORIGIN` with the exact fix in the message;
`OPTIONS` preflights are answered by `middleware.ts`.


## "Something went wrong. Please try again." on login

That string was the catch-all 500. The API now names the failing component
instead. Open `/api/health` on the deployment first — it reports, without
exposing any secret:

- `env.AUTH_SECRET`: `set` / `missing` / `too_short`
- `env.DATABASE_URL`, `env.DIRECT_URL`, `env.APP_URL`
- `database.reachable` and `database.schema` (plus a safe `accounts` count)
- `warnings[]` with the exact fix

`/api/health` probes in stages (`dns` → `tcp` → `query` → `schema`) and returns
a specific code, so "cannot reach the database" is never ambiguous:

| `database.error` | Meaning | Fix |
| --- | --- | --- |
| `DATABASE_URL_MISSING` | No URL in this environment | Set `DATABASE_URL` for **Production** (Vercel scopes variables per environment) |
| `DATABASE_DNS_FAILED` | Hostname does not resolve | Fix the host in `DATABASE_URL` |
| `DATABASE_UNREACHABLE_TCP` | Host resolves, port closed | Neon/Supabase project paused, IP allowlist, or database stopped |
| `DATABASE_AUTH_FAILED` | Credentials rejected | Rotate the user/password in the connection string |
| `DATABASE_NOT_FOUND` | Database name wrong | Check the path segment of `DATABASE_URL` |
| `PRISMA_ENGINE_MISSING` | Client built for another OS | `binaryTargets` is already set; clear the build cache and redeploy |
| `DATABASE_CLIENT_MISMATCH` | Client generated from a different schema/provider | `npx prisma generate && redeploy` |
| `DATABASE_SCHEMA_MISSING` | Connected, tables absent or behind | `npm run db:deploy` with production `DATABASE_URL`/`DIRECT_URL`, then `npm run db:verify` |
| `AUTH_SECRET: missing`/`too_short` | Cookies cannot be signed | 32+ random chars (`openssl rand -base64 48`), redeploy |

`ok: true` but login still fails → the credentials are wrong (`401
INVALID_CREDENTIALS`) or the cookie is dropped (`APP_URL` must be `https://` in
production; cross-origin UIs need `COOKIE_SAMESITE=none`).

### Server-side logging

Every failed API call writes one JSON line with `event`, `method`, `path`,
`code`, `status`, `ms` and a redacted `detail`. Connection strings, `dnx_`
tokens, bearer headers and `password=` values are scrubbed before writing. Users
only ever see the clean message; hints and raw errors stay in the logs and
`/api/health`.

Login errors are now distinguishable: `401 INVALID_CREDENTIALS`,
`403 ACCOUNT_SUSPENDED`, `422 VALIDATION_ERROR`, `503 SERVER_MISCONFIGURED`,
`503 DATABASE_UNAVAILABLE`, `503 DATABASE_SCHEMA_MISSING`, `429 RATE_LIMITED`.
Raw errors stay in the server logs; secrets never reach the response.

Run the auth smoke test against any deployment:

```bash
E2E_BASE=https://your-app.vercel.app node scripts/e2e-auth.mjs
```

## API surface

| Method | Path | Auth |
| --- | --- | --- |
| POST | `/api/auth/register` `/api/auth/login` `/api/auth/logout` | public |
| GET/PATCH | `/api/auth/me` | session |
| GET/DELETE | `/api/auth/sessions`, `/api/auth/sessions/:id` | session |
| GET/POST | `/api/bots` | session |
| GET/PATCH/DELETE | `/api/bots/:id` | session |
| POST | `/api/bots/:id/pair` (issue code), `/api/bots/:id/revoke` | session |
| GET | `/api/bots/:id/logs`, `/api/logs` | session |
| POST | `/api/bots/pair` (redeem), `/api/bots/heartbeat` | code / bot token |
| GET/POST | `/api/files` | session |
| GET/DELETE | `/api/files/:id` | session |
| GET/POST | `/api/integrations` | session |
| POST/DELETE | `/api/integrations/:id/test`, `/api/integrations/:id` | session |
| GET | `/api/admin/stats`, `/api/admin/users`, `/api/admin/audit` | admin |
| PATCH/DELETE | `/api/admin/users/:id` | admin |
| GET | `/api/health` | public (no secrets) |
| GET | `/api/events` | session (SSE) |
| GET | `/api/setup/state` | session |
| POST | `/api/setup/unlock`, `/api/setup/lock`, `/api/setup/activate` | session |
| GET/POST | `/api/setup/accounts` | owner setup session |
| POST/DELETE | `/api/setup/accounts/:id/actions`, `/api/setup/accounts/:id` | owner setup session |
| GET/POST | `/api/setup/requests`, `/api/setup/requests/:id` | owner setup session |
| GET | `/api/setup/overview`, `/api/setup/activity` | owner setup session |
| POST | `/api/setup/owner-token` | owner (allowlisted email) |

## Tests

```bash
npm run build && npm run start -- -p 3210
node scripts/e2e.mjs        # core platform
node scripts/e2e-setup.mjs  # Darknote Setup
node scripts/e2e-cors.mjs   # origins / signup
node scripts/e2e-auth.mjs   # register / login / logout / persistence
```

`npm run e2e` exercises registration validation, duplicate emails, session issuance, profile updates, bot create → code → redeem → single-use enforcement → heartbeat → logs, file upload/download/delete, SSRF rejection, encrypted integration storage + live test, RBAC, admin suspension/reactivation, persistence across logout, SSE `ready`/`sync` frames, logout, and WhatsApp session ownership/validation/restart rules. Latest run: **60/60 + 27/27 + 10/10**, plus **18/18** worker checks, the bot repository's own **174** tests and Playwright passes (desktop + mobile) with zero console errors.

## Linking an external bot (panel-owned pairing)

The dashboard never opens a WhatsApp socket itself. An external bot keeps its own
sessions and only talks to the panel through a bot token:

1. **Bots → create** → **Pair** to get a one-time 8-character code.
2. The bot redeems it at `POST /api/bots/pair` and stores the returned `dnx_…`.
3. It reports every session at `POST /api/bot/v1/sync`, polls
   `GET /api/bot/v1/pairing` for numbers the owner wants to add, and issues the
   real WhatsApp code on its own socket.
4. `GET /api/bot/v1/commands` delivers `RESTART` / `LOGOUT`; the bot acks each
   one at `POST /api/bot/v1/commands/:id`.

The panel keeps **one row per number**: a sync either updates the pending row the
owner created (matched by `requestId`, or by phone on the bot's first sync) or
creates the row when the session first appears. Pending rows are never deleted
by a sync, so "pair from the panel" cannot race the bot.
