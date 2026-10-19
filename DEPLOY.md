# Hosting on Vercel — Supabase for live notifications, Aiven MySQL for data (D-042)

```
Browser ──/api/*──► Frontend (Vercel, Next.js) ──rewrite──► Backend (Vercel, Express serverless) ──► Aiven MySQL
   ▲                                                              │ after each write: Broadcast REST
   └──── private channel user:<id> ◄── Supabase Realtime ◄────────┘
cron-job.org ── every minute ──► Backend /api/cron/tick (worker cycle: reminders, outbox, SLA, sheet sync, relay)
```

- **Database stays on Aiven MySQL.** Supabase is used only for Realtime Broadcast (its database is not used).
- Each signed-in user joins one **private** channel `user:<their id>` with a 5-minute token from
  `GET /api/realtime/token` (session-checked). A Supabase RLS policy lets a token read only its own channel;
  browsers can never send. If Realtime is down the screens poll every 30 s, as before.
- Locally nothing changes: `npm run dev` + `npm run worker` with Socket.IO (`REALTIME_PROVIDER=socketio`).
- **Schema changes** are applied from your machine with `npx prisma migrate deploy` (DATABASE_URL = Aiven).
  Vercel never migrates.

## 1. Supabase (live notifications only)

1. supabase.com → **New project** (region close to Pakistan, e.g. Mumbai or Singapore). Any database password.
2. **Project Settings → API Keys**
   - **Project URL** → backend `SUPABASE_URL` and frontend `NEXT_PUBLIC_SUPABASE_URL`
   - **Publishable key** (`sb_publishable_…`; on older projects the **anon** key) → frontend `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - **Secret key** (`sb_secret_…`; older projects: **service_role**) → backend `SUPABASE_SECRET_KEY` — server only, never in the frontend
3. **Project Settings → JWT Keys → Legacy JWT secret** → reveal → copy → backend `SUPABASE_JWT_SECRET`
   (the backend signs the 5-minute per-user Realtime token with it; keep it secret and do not revoke it).
4. **Realtime → Settings** → turn **off** "Allow public access" (only private channels may be joined).
5. **SQL Editor** → run once:

   ```sql
   -- A browser token may only receive messages on its own channel user:<sub>; no INSERT policy, so browsers cannot send.
   create policy "vertex: read own channel only"
   on realtime.messages
   for select
   to authenticated
   using ( (select realtime.topic()) = 'user:' || (select auth.jwt() ->> 'sub') );
   ```

## 2. Vercel — backend (repo `thevertexhealthbackend`)

1. vercel.com → **Add New → Project** → import the GitHub repo **thevertexhealthbackend**.
   - Framework preset: **Other**. Root directory: the repo root. Build settings come from `vercel.json`
     (`npm run vercel-build` = `prisma generate` + typecheck). Node.js 20 or 22.
2. **Environment Variables** (Production) — names only:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | Aiven URL with `?sslaccept=strict` (the CA comes from the next variable) |
   | `DATABASE_CA_CERT` | full text of `backend/secrets/aiven-ca.pem` (or its base64) |
   | `JWT_ACCESS_SECRET` | long random string (32+ chars) |
   | `FRONTEND_ORIGIN` | the frontend URL, e.g. `https://<frontend>.vercel.app` (comma-separate if several) |
   | `PUBLIC_APP_URL` | the frontend URL (links in messages / password reset) |
   | `COOKIE_SECURE` | `true` |
   | `TRUST_PROXY` | `true` |
   | `REALTIME_PROVIDER` | `supabase` |
   | `SUPABASE_URL` / `SUPABASE_SECRET_KEY` / `SUPABASE_JWT_SECRET` | from step 1 |
   | `CRON_SECRET` | long random string (24+ chars) — also used by cron-job.org |
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | same value as in `backend/.env` |
   | `UPLOADTHING_TOKEN`, `UPLOADTHING_PRIVATE_FILES` | as locally |
   | `WHATSAPP_PROVIDER`, `WHATSAPP_WEBHOOK_SECRET` | as locally |

3. **Deploy.** Open the backend URL: it shows `{"status":"ok","service":"Vertex Health API","time":…}`.

## 3. Vercel — frontend (Next.js)

The `frontend/` folder is not in a Git repo with a remote yet. Push it to its own GitHub repo (or the root
monorepo), then:

1. **Add New → Project** → import it. Framework: **Next.js**. Root directory: the folder that holds
   `frontend/package.json`.
2. **Environment Variables** — names only:

   | Name | Value |
   |---|---|
   | `BACKEND_URL` | the backend Vercel URL (Next rewrites `/api/*` there, so cookies stay first-party) |
   | `NEXT_PUBLIC_REALTIME_PROVIDER` | `supabase` |
   | `NEXT_PUBLIC_SUPABASE_URL` | Project URL from step 1 |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | publishable (or anon) key from step 1 |
   | `NEXT_PUBLIC_APP_TIMEZONE` | `Asia/Karachi` |

3. **Deploy**, then put the frontend URL into the backend's `FRONTEND_ORIGIN` and `PUBLIC_APP_URL` and
   **redeploy the backend**.

## 4. cron-job.org (the worker)

1. cron-job.org → **Create cronjob**.
2. **URL:** `https://<backend>.vercel.app/api/cron/tick` — **every 1 minute**, method **GET**.
3. **Advanced → Headers:** `Authorization` = `Bearer <CRON_SECRET>`.
4. Turn on failure notifications. A tick answers `{"ok":true,…}` with counts; a 401 means the secret differs.

Each tick runs one worker cycle within 25 s (reminders, procedure-day release, SLA alerts, Office Boy rounds,
stock alerts, message outbox with retries, Google Sheets sync, realtime relay). Every unit is idempotent, so a
duplicate or overlapping call never sends twice. Timing granularity becomes one minute (e.g. the 2-minute
auto-send to Reception can fire up to a minute later).

## 4b. Phone notifications (Web Push, D-046)

Free, standard Web Push — no paid service. Generate the keys **once** (keep them; changing them later means every
phone has to switch notifications on again):

```bash
cd backend
npx web-push generate-vapid-keys
```

Add to the **backend** Vercel project → Settings → Environment Variables (Production), then **Redeploy**:

| Name | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | the "Public Key" line |
| `VAPID_PRIVATE_KEY` | the "Private Key" line (secret — never in the frontend or in git) |
| `VAPID_SUBJECT` | `mailto:` + a clinic contact email (or an `https://` site URL) |

All three or none (with only some set the API refuses to start and names the missing ones). The frontend needs no new
variable — it reads the public key from `GET /api/push/config`. Pushes are sent after each request and by the
cron tick, so the cron-job.org job (section 4) should be running.

Each person then: signs in → **On karein** on the blue card (or the 🔔 bell-ring icon → *Phone notifications* →
switch on) → **Send test notification**. iPhone: notifications work only in the app added to the Home Screen
(Safari → Share → Add to Home Screen, iOS 16.4+), opened from there.

## 5. Check it works

1. Sign in on the frontend URL as the Manager → the header shows **Live**.
2. In another browser sign in as Reception and check a patient in → the Manager's notification appears at once.
3. Disable a test user → their next request is refused; their live channel ends within 5 minutes (token expiry).
