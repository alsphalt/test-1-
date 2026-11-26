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
  api/events                SSE stream
components/                 Intro, AuthScreen, Shell, NexusCanvas, views/*
lib/                        auth, session, crypto, http, validate, events, net, audit
prisma/schema.prisma        PostgreSQL schema + migration SQL
scripts/e2e.mjs             45-check end-to-end suite against a running server
scripts/bot-agent.mjs       reference connector (pair + heartbeat)
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
2. **Project** — import the repo (framework preset: Next.js; build command `prisma generate && next build`, already in `vercel.json`).
3. **Environment variables** (Production + Preview):

   | Name | Value |
   | --- | --- |
   | `DATABASE_URL` | pooled Postgres URL |
   | `DIRECT_URL` | direct Postgres URL |
   | `AUTH_SECRET` | `openssl rand -base64 48` |
   | `ENCRYPTION_KEY` | `openssl rand -hex 32` |
   | `ADMIN_EMAILS` | your email(s) |
   | `APP_URL` | `https://<project>.vercel.app` |

4. **Schema** — run once from your machine with the production `DIRECT_URL`:

   ```bash
   DATABASE_URL="…" DIRECT_URL="…" npx prisma migrate deploy
   ```

5. **Deploy** — `vercel --prod` (or push to the connected branch).
6. **Verify** — register, create a bot, pair it, run `node scripts/bot-agent.mjs --url https://<project>.vercel.app --code <CODE>`, watch the bot flip to ONLINE and log lines appear without a reload.

### Platform notes

- `app/api/events` is capped at 55 s per connection (`maxDuration: 60` in `vercel.json`). On Hobby the function limit is lower; the browser reconnects and the DB poll keeps state fresh either way.
- Rate limits are in-memory per serverless instance. For strict global limits, move `lib/http.ts → rateLimit` to Upstash Redis.
- Files are stored in Postgres (simple, transactional, 4 MB cap). Swap `FileAsset.data` for Vercel Blob if you need larger uploads.
- `UPSTASH_REDIS_REST_URL` / `..._TOKEN` are optional and only speed up cross-instance fan-out.

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
| GET | `/api/events` | session (SSE) |

## Tests

```bash
npm run build && npm run start -- -p 3210
node scripts/e2e.mjs
```

The suite exercises registration validation, duplicate emails, session issuance, profile updates, bot create → code → redeem → single-use enforcement → heartbeat → logs, file upload/download/delete, SSRF rejection, encrypted integration storage + live test, RBAC, admin suspension/reactivation, persistence across logout, SSE `ready`/`sync` frames, and logout. Latest run: **45/45 passing**.
