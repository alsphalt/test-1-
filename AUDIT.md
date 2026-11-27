# DARKNOTE NEXUS — audit & verification report

Date: 2026-11-27 · repository: `alsphalt/test-1-` · local verification on a real
SQLite database and a production build (`next build` + `next start`).

This report separates what was **executed and observed** from what is
**implemented but not exercised here**, and from what is **not in this project at
all**. Nothing below is marked working because it compiles.

---

## 1. What this project is

`test-1-` contains **DARKNOTE NEXUS** (Next.js 14, Prisma, PostgreSQL):
accounts, sessions, bot pairing, WhatsApp sessions (Baileys worker), files,
integrations, admin, SSE realtime.

A second, separate project in the workspace (`darknote-src`, remote
`alsphalt/let-try`) is the **CONTROL CENTER** (Pterodactyl console, file manager,
Monaco editor, project explorer, error detector). It was **not** modified or
merged, because the instruction was to keep this project separate. See §7.

---

## 2. Changes made in this pass

Additive only — no existing table, route or view was replaced.

| Area | Change |
| --- | --- |
| Data model | `SetupAccount`, `SetupAccessRequest`, `SetupSession`, `OwnerCredential`, `WhatsAppOutbox` + migration `20260201000000_setup_access`, `20260201000100_whatsapp_outbox` |
| Owner auth | `lib/owner.ts` — owner email allowlist + bcrypt-hashed owner token, rotation policy |
| Setup access | `lib/setup.ts` — codes, activation, approvals, linking, suspension, deletion, sessions, activity, overview |
| API | 11 routes under `/api/setup/*`, all server-authorised |
| UI | `components/views/Setup.tsx` + nav entry; gate, Sessions, Owner Administration, Requests, Logs, Security |
| Locking | server idle timeout + explicit lock + lock on leaving the view + lock when hidden 45 s |
| CORS | `lib/origin.ts` accepts the deployment's own Vercel hosts; preflight verified; API base/`SameSite` documented |
| Signup | client now verifies `/api/auth/me` after register/login, so a dropped cookie surfaces a real error instead of a false success |
| Delivery | `WhatsAppOutbox` + worker `flushOutbox()` — setup codes are really sent through the owner's connected number |
| Tests | `scripts/e2e-setup.mjs` (new), `npm run e2e:setup` |

---

## 3. Verification evidence

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | pass, 0 errors |
| `npx next build` | pass; all `/api/setup/*` routes present |
| `node scripts/e2e.mjs` | **60 / 60 pass** (full platform regression) |
| `node scripts/e2e-setup.mjs` | **61 / 61 pass** |
| `node scripts/e2e-cors.mjs` | **10 / 10 pass** |
| Vercel-preview origin probe (second instance, `VERCEL_URL` set) | preview origin `204` + echoed origin; unknown origin `403` |
| Worker outbox | code path added; **not executed** against a live WhatsApp number |

---

## 4. Feature status

### A. Frontend

| Feature | Status | Notes |
| --- | --- | --- |
| Setup gate (owner token / code / activation / pending / blocked) | WORKING | State comes from `/api/setup/state` |
| Sessions dashboard counters | WORKING | Bots, paired, connected, disconnected, active users, login sessions — all DB queries |
| Owner Administration tables | WORKING | Create, list, search, manage |
| Access requests approve/reject | WORKING | Tested end to end |
| Activity log view | WORKING | Reads `AuditLog` rows with `setup.` prefix |
| Security / token rotation | WORKING | Tested |
| Auto-lock UI | WORKING (logic) | Visibility timer + view-change lock; not measured in a real browser |
| Mobile layout | NOT TESTED | No browser in this environment; layout reuses existing responsive classes |
| Screenshots | NOT UPDATED | Browser unavailable |

### B. Backend

| Feature | Status | Notes |
| --- | --- | --- |
| Owner-only route protection | WORKING | `requireOwnerSetup()`: allowlisted email **and** unlocked OWNER session |
| Authorised-user isolation | WORKING | 403 on overview/activity/accounts; session bound to `account.userId` |
| Setup code hashing | WORKING | bcrypt; API returns the plaintext once at creation/reset only |
| Owner token hashing | WORKING | bcrypt; `1124100` seeded once from `OWNER_SETUP_TOKEN` |
| Rate limits | WORKING | unlock 8/account + 20/IP per 10 min; activate 6/account |
| Lockout | WORKING | 5 wrong codes → 15 min lock |
| Session revocation | WORKING | Reset code, suspend, delete, reset password all revoke immediately |
| Audit logging | WORKING | No codes, tokens or passwords recorded |
| SSE realtime | WORKING (existing) | Owner refresh is triggered on approval |

### C. Database

| Item | Status |
| --- | --- |
| Migrations written for PostgreSQL | WORKING (authored) |
| Migrations applied to Postgres/Neon | NOT TESTED — no `DATABASE_URL` for the production database in this environment |
| Applied to SQLite (local verification) | WORKING |
| Existing data preserved | WORKING — additive tables only |

### D. Owner administration

Account creation, code issue, activation, approval, linking, code reuse, reset,
suspend, reactivate, unlink, delete: **all WORKING and covered by tests**.
WhatsApp delivery of the code: **IMPLEMENTED, NOT LIVE-VERIFIED** (needs a paired
number; the API honestly reports `FAILED` + reason when none is connected).

### E. Session management / bot pairing

| Item | Status |
| --- | --- |
| Counters from real tables | WORKING |
| Bots counted once per bot (no double count on reconnect) | WORKING |
| Disconnected ≠ active | WORKING (2-minute heartbeat window) |
| Website logout does not touch WhatsApp sessions | WORKING (separate tables, no cascade) |
| Real WhatsApp pairing | NOT TESTED here — needs a phone and a long-lived worker host |

### F. External integrations

| Item | Status |
| --- | --- |
| WhatsApp worker (Baileys) | IMPLEMENTED (existing) + outbox send added; NOT LIVE-VERIFIED |
| Integration keys (AES-256-GCM, SSRF guard) | WORKING (existing tests) |
| Vercel deploy | NOT TESTED — no project credentials |

### G. Deployment

| Item | Status |
| --- | --- |
| Build | WORKING |
| Env template updated | WORKING (`OWNER_EMAILS`, `OWNER_SETUP_TOKEN`, `SETUP_IDLE_MINUTES`, `SETUP_CODE_TTL_HOURS`, `ALLOW_VERCEL_PREVIEWS`) |
| Production database migrated | INCOMPLETE — requires `DATABASE_URL`/`DIRECT_URL` and `prisma migrate deploy` |
| Production smoke test | NOT TESTED |

### H. Security

| Item | Status |
| --- | --- |
| Ownership cannot be claimed by typing an owner email | WORKING — needs a session on that account + the token |
| Setup code required in addition to the main login | WORKING |
| Cross-account access | WORKING — denied server-side |
| Setup lock does not disconnect bots | WORKING by construction (different tables) |
| Secrets never in client bundle | WORKING — no `NEXT_PUBLIC_*` secret; hashes only server-side |
| CSRF / origin checks | WORKING — `assertSameOrigin` + middleware |

---

## 5. Known gaps and honest limitations

1. **Production Postgres was not migrated or tested.** The migrations are
   authored; running them requires the real pooled + direct URLs.
2. **WhatsApp code delivery is not proven end to end.** The queue and worker
   sender exist; without a paired owner number it reports `FAILED` with the
   reason rather than pretending.
3. **No browser/mobile test.** The runtime has no browser, so "Samsung A17 /
   mobile Chrome" checks are not claimed.
4. **Setup code is reusable by design.** The specification asks for a
   single-use activation code *and* for later visits to accept the same saved
   code; those conflict. This implementation treats the code as a personal
   passkey (reusable, rate-limited, resettable, revocable).
5. **Owner token `1124100` has been shared in chat.** Rotate it in
   Setup → Security and remove `OWNER_SETUP_TOKEN` from production env after the
   first rotation.

---

## 6. Deployment steps still required

```bash
# 1. environment (Vercel → Project → Settings → Environment Variables)
DATABASE_URL=...pooled...   DIRECT_URL=...direct...
AUTH_SECRET=<32+ chars>     ENCRYPTION_KEY=<64 hex>
APP_URL=https://<domain>    OWNER_EMAILS="alsphaltjimna@gmail.com,welkamals@gmail.com,darknotjimna@gmail.com,jimnaals@gmail.com"
OWNER_SETUP_TOKEN=1124100   ALLOW_VERCEL_PREVIEWS=true

# 2. schema
npx prisma migrate deploy

# 3. verify
curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/
```

The owner must sign in with one of the allowlisted emails — registering that
address is enough to be recognised, but the token is still required.

---

## 7. Not in this project

The hosting-panel CONSOLE work in the specification (Pterodactyl API, web
terminal, advanced file manager, GitHub import, Monaco editor, project explorer,
error detector, dependency engine) lives in the **separate** `darknote-src`
project. It was deliberately not merged into NEXUS. Porting it would be a new
piece of work with its own verification, and it needs Pterodactyl API
credentials to be tested for real.

---

## 8. Database-connection pass (2026-11-27, second run)

Reported symptom: registration shows "The server cannot reach its database."
(that string is the `DATABASE_UNAVAILABLE` message added in the previous pass).

### What was found

1. **No Vercel engine in the Prisma client.** The generated client shipped only
   `libquery_engine-debian-openssl-1.1.x.so.node`, while Vercel runs Amazon
   Linux with OpenSSL 3. That produces a `PrismaClientInitializationError` on
   the first query — i.e. every registration and login fails at initialisation.
   Fixed by pinning `binaryTargets = ["native", "rhel-openssl-3.0.x"]`; the
   build now emits `libquery_engine-rhel-openssl-3.0.x.so.node` (verified).
2. **All database faults collapsed into one message.** A paused database, a
   wrong password, a missing variable, a schema-less database and a client built
   for the wrong provider all returned the same text. Each now maps to its own
   code (see README table).
3. **bcrypt silently truncates at 72 bytes.** Verified locally:
   `compare("a"×72, hash("a"×80 + "1")) === true`. Registration now rejects
   passwords over 72 characters instead of accepting a weakened one.
4. **No structured server logging.** Errors were plain `console.error` strings
   with no route, code or timing, and no redaction. Added `lib/log.ts`.
5. **Race on duplicate email.** The pre-check is not authoritative; a P2002 from
   the unique index now returns the same 409 "account already exists".
6. **Per-IP login limit was too tight for shared IPs** (15 per 5 min). Raised to
   30 per 5 min; the per-account limit (8 per 5 min) is unchanged.

### Verified locally (SQLite; PostgreSQL not available here)

```
/api/health (healthy)            ok:true, query:ok, schema:true, accounts:N
missing DATABASE_URL             503 DATABASE_URL_MISSING
unresolvable host                503 DATABASE_DNS_FAILED
closed port                      503 DATABASE_UNREACHABLE_TCP
tables absent                    503 DATABASE_SCHEMA_MISSING
missing AUTH_SECRET              503 SERVER_MISCONFIGURED
register → duplicate → logout → login → refresh   20/20 (scripts/e2e-auth.mjs)
regression: core 60/60 · setup 62/62 · cors 10/10
log redaction                    password absent from JSON logs
```

### Still requires the deployment

The two remaining causes cannot be fixed from this workspace because they are
environmental: set `DATABASE_URL` for the **Production** scope in Vercel, and
run `npx prisma migrate deploy` against the production database. `/api/health`
will name whichever is still wrong.
