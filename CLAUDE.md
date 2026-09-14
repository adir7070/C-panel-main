# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev              # backend/server.js on PORT (API + sockets + panel routes) + Vite with HMR proxying to it
npm run build            # tsc -b && vite build → outputs to dist/
npm run lint             # ESLint (backend/ is ignored)
npm start                # node backend/server.js — the production process: API, sockets, panel routes, dist/
npm run install:backend  # npm ci --omit=dev inside backend/ (Heroku runs it after the build)
```

First-time setup: `npm ci && cd backend && npm ci`. Local dev needs a MongoDB on
`MONGO_URI`. Start it with the DEFAULT dbpath —
`mongod --dbpath /Users/a1234/data/db` — that is where the `dashen` database lives.
Local env: root `.env` (see `.env.example`) plus `backend/.env.development`
(both git-ignored; root `.env` wins for keys set in both).
No test suite exists in this repo.

TypeScript strict mode is enforced (`noUnusedLocals`, `noUnusedParameters`) — the build fails on unused declarations.

## Architecture

### Runtime topology — one repo, one process
This repo is the Dashen Media Tech ops panel (formerly Iconiq — that company
closed; all Iconiq/Make.com/Kliq-app/Fireberry branding and hard dependencies
have been removed, see "Migration notes" below). It holds both halves and runs
them as ONE Node process:

- `src/` — the React SPA (Vite → `dist/`).
- `backend/` — the Express 5 CommonJS backend, merged in on 2026-09-14 from
  the former separate `backend/` repo. `backend/package.json` must stay
  `"type": "commonjs"` with its own lockfile and `node_modules` (the root is
  ESM). **`backend/server.js` is the entry point**: every backend `/api/*`
  route (~130 `/api/cpanel/*` endpoints, see `docs/API-ENDPOINTS.md`),
  socket.io, crons, the client-notify worker.
- `server/` — the panel's own ESM server modules. `backend/server.js`
  `require()`s `server/panel.js`, which has two hooks (Express answers in
  registration order):
  1. `mountPanelRoutes(app)` — BEFORE the backend's `/api` router: the leads
     pipeline (`server/leads.js`, `/api/leads/*`, public intake
     `POST /api/leads/intake` guarded by `x-api-key: LEADS_INTAKE_KEY`),
     `POST /api/local-ads/generate` (`server/localAdsPipeline.js`, reads
     `campaign.md`), `GET /auth/facebook/callback`, `/generated`.
  2. `mountPanelSpa(app)` — AFTER every backend route: JSON 404 + JSON error
     handler for `/api`, `dist/` static, GET `index.html` fallback for client
     routes (the Cardcom return page is one of them).

Login is the backend's (`POST /api/agents/login`, opaque `agents.token`,
password = sha256(pw + "iconiq2024")); `server/auth.js` `requireAuth` checks
that same token. The leads router attaches auth PER ROUTE, never router-wide,
so the backend's public `/api/leads/*` endpoints (wa-click beacon, referral,
posts, `?page_id=` Facebook leads) fall through to `backend/routes/leads.routes.js`.
Moving a lead to בתהליך / לסלוק / לקוח פעיל runs `syncLeadToClient()` in
`server/leads.js`, which writes exactly what the backend's Fireberry-free
client creation writes (`cpanel_clients`, `support_chats`) plus a
`business_profiles` seed — so the lead shows up in "כל הלקוחות" and opens as a
client with the איפיון pre-filled.

The SPA calls `/api` and opens socket.io on its own origin — leave
`VITE_API_BASE` / `VITE_SOCKET_URL` unset. The process runs from the repo
root: backend code must resolve files from `__dirname`, never `process.cwd()`.

### Production (Heroku + Atlas)
One Heroku app, `dashen-cpanel` (region eu, heroku-24, Basic dyno) —
https://dashen-cpanel-b76c272f93dd.herokuapp.com — auto-deployed by Heroku's
GitHub integration from `main` of adir7070/C-panel-main (no GitHub Actions).

- **Build:** `Procfile` is `web: node backend/server.js`; `heroku-postbuild` builds
  the SPA, then `npm ci --omit=dev` in `backend/`. Buildpacks:
  `heroku-community/chrome-for-testing` (Chrome for PDFs, `PUPPETEER_EXECUTABLE_PATH`),
  then `heroku/nodejs`. Only the ROOT `.slugignore` counts (backend patterns are
  prefixed `/backend/`).
- **Database:** Atlas `cluster0.tjiqrcj`, database `dashen`. `MONGO_URI` must end
  in `/dashen` — the code calls `db()` with no name, so a path-less URI silently
  uses `test`, and then `initAdmin` runs against an empty DB.
- **Config vars:** Dashen values only, never the old Iconiq `.env`; production
  loads no `.env` file at all. `SERVER_BASE_URL` = `BASE_URL` = `CPANEL_BASE_URL` =
  the app's own origin. `DISABLE_WHOAPP=true`, `DISABLE_WOW_BETA=true`,
  `NODE_ENV=production`, `LEADS_INTAKE_KEY`, `GREEN_API_*`. Keep `AWS_MONGO_URI`
  and `PEER_SERVER_URL` unset. `VITE_*` values are baked in at build time —
  changing one needs a new push.
- **Dynos:** exactly ONE web dyno — the backend's node-cron jobs and timers
  have no locks.
- **Legacy Make.com webhooks:** env-gated and off (`PURCHASE_WEBHOOK_URL`,
  `WEBHOOK_URL`, `CARDCOM_LEGACY_NOTIFY_URL`). In production the first admin is
  only created from `INIT_ADMIN_PASSWORD`.
- **Retired:** the separate `dashen-server` Heroku app and the adir7070/iconiq-server
  repo (superseded by `backend/`). The old IconiqMotion repo had Iconiq
  production secrets committed — never reuse it.

### Leads (local)
- Statuses: `new` חדש · `call_again` להתקשר שוב · `not_relevant` לא רלוונטי ·
  `in_process` בתהליך · `to_charge` לסלוק · `active_client` לקוח פעיל.
- Managers only see leads assigned to them; admins see all and distribute
  (`/admin/leads-distribution`: assign / round-robin). Each lead has notes,
  status history, and an "activate" action (→ `active_client`).
- Frontend API in `src/api/leads.ts`; UI in `src/pages/LeadsPage.tsx`.

### Charging → every screen
- Charge paths the panel offers, all in the client page's "קטלוג אישי" tab:
  "חייב" (Cardcom popup, backend `controllers/personal-packages.controller.js`)
  and "שלח חוזה ב-SMS" (the client signs and pays via
  `/api/packages/contract-pay` → `contractPaySuccess`, plus the in-contract
  coin add-on → `contractCoinsSuccess` in `controllers/packages.controller.js`).
- Every one of them applies the payment through
  `backend/services/purchase-sync.service.js`, in a crash-safe order:
  lock row in `package_transactions` (status crediting→done, unique index on
  `lowProfileId`) → `creditUserOnce` (users upsert — lead-born clients have
  no users doc; conditional on `creditedPayments`) → `recordRevenue`
  (`cpanel_pending_purchases.completedAt` + `agentId`) → `markLeadsActive` →
  receipts/notifications only for the caller that flips the lock to done.
  An attempt that dies half-way is resumed by the next check without
  crediting twice.
- Who reads what: users.activePackage → מוצרים tab, "חבילה"/"סטטוס"
  columns, dashboard package counts · the ledger → revenue cards,
  "הוצאה"/"עסקאות", טופ מנהלים · `cpanel_clients.tier` (tier plans) → "רמה"
  · the originating lead → `active_client`.
- Cardcom's webhook can't reach a local server, so "חייב" is also confirmed
  by the panel: `POST /api/cpanel/clients/:phone/personal-catalog/:id/confirm-payment`
  (polled every 8s while a Cardcom window is open, and again when Cardcom
  redirects to `/clients/:phone/personal_catalog?personal_success=<id>`).
- Open screens refresh in place through `src/hooks/usePurchaseSync.ts`
  (socket `cpanel_new_purchase_admin` + BroadcastChannel `dashen-payments`);
  the client page never remounts the open tab, so unsaved edits survive.
- The backend needs `SERVER_BASE_URL` / `CPANEL_BASE_URL`
  (`utils/required-env.js` — no fallback to the old Iconiq hosts) and Cardcom
  credentials; `CARDCOM_*` are blank locally, so charging answers 401 until
  real terminal credentials are set.

### Automatic client WhatsApp messages (Green API)
- Outbox: triggers insert into `client_notifications` (unique `dedupeKey`);
  the worker in `backend/services/client-notify.service.js` renders
  the Hebrew text (every message ends with "צוות דשן") and sends it via
  `services/greenapi.service.js` (`05…` is converted to `972…`).
- Triggers:
  - `welcome`: a lead becomes "לקוח פעיל". It is queued by this repo's
    `server/leads.js` (`queueWelcome`) or by a payment
    (`purchase-sync.markLeadsActive`). Once per client.
  - `brief_done`: "סיים איפיון" → `POST /api/cpanel/clients/:phone/characterization/complete`.
    The server re-checks the required fields and stamps `briefCompletedAt`.
    Once per client.
  - `products_ready`: sent in three cases, with repeat sends inside 10
    minutes collapsed into one.
    - The package status moves to `sent_to_client` ("אשר ושלח ללקוח" /
      "שלח שוב ללקוח").
    - "שלח ללקוח ▶" on a single product.
    - The legacy send-for-approval. It sends no link: `/products-review/:token`
      has no public review API on the backend yet.
    - Dedupe comes from the stored package, never from the request, and
      `PATCH /api/client/project-detail/:id/status` requires panel login plus
      the per-client access check.
- Env: `GREEN_API_INSTANCE_ID` / `GREEN_API_TOKEN` / `GREEN_API_BASE_URL`
  (set in the backend's gitignored `.env.development`; blank → messages are
  marked `skipped` with the text that would have gone out, and are NOT sent
  later). `CLIENT_NOTIFY_WORKER=off` leaves them queued (used by tests).
- Nothing sends until the Green API instance is linked to a WhatsApp number
  (QR scan in the Green API console). The admin screen "בריאות אינטגרציות"
  shows the live instance state and a 24h count of sent / skipped / failed
  messages.

### Migration notes (Iconiq → Dashen Media Tech)
- Iconiq closed; all UI branding now reads "דשן מדיה טק" / "Dashen Media Tech".
- No hardcoded `iconiqmedia.co.il` host remains anywhere — `SERVER_BASE_URL` /
  `BASE_URL` / `CPANEL_BASE_URL` / `FB_*` are all required env vars now,
  see `.env.example`.
- The WOW-ads "Generate Again" flow and the Facebook OAuth reconnect flow
  used to proxy through Make.com webhooks; both now run locally in
  `server/panel.js` (see "Runtime topology" above). `campaign.md` is read verbatim at
  runtime as the Gemini system prompt — edit that file to change the
  creative pipeline's behavior without touching code.
- Features that only made sense with the old "Kliq" consumer mobile app
  (client online/presence indicator, in-app activity/journey feed, Expo
  push tokens, the "client chose you" onboarding notification, and the
  "send app download link" SMS) were removed — there is no separate
  consumer app anymore. The per-client chat column on פרופיל was removed
  too (its manager messages only reached the retired app); the general
  chat page (`/chat`) remains.
- **Fireberry (the old CRM) is fully gone — both repos.** In this repo: the
  Fireberry-embedded `/embed/:tab/:phone` iframe page, "import from Fireberry" /
  "sync assignments" on the admin clients page, and the Fireberry-fed leads
  distribution. In `backend/`: `getClientFbCredentials`, `addClient`,
  `getAppData` and `getClientFbDebug` are MongoDB-only; the Fireberry admin
  endpoints, the `listClients` CRM fallback, the Fireberry-shaped
  lead-distribution endpoints and the `fireberry_customers` index are deleted;
  the referer-based `/embed` auth bypass is gone; and
  `services/fireberry*.service.js` are stubbed so every export throws
  `fireberry_disabled` — nothing anywhere can reach api.powerlink.co.il.
  Leads come from the local intake endpoint / CSV import instead.

- `WOW-ADS-MAKE-INTEGRATION.md`, `campaign.md`, `Social.md`, `new-pipe.md`
  are kept as-is — they document the AI prompts for the creative pipelines.
  Only `campaign.md`'s pipeline is currently wired to local code (see
  above); the others describe pipelines that run inside the separate
  backend repo and are kept here purely as prompt/spec reference.

### Facebook / Meta: switched off
Every per-client Meta credential used to live in Fireberry, so no client has a
usable token today. Rather than let ~28 Graph-backed routes fail each in their
own way, `middlewares/fb-gate.middleware.js` in `backend/` answers them all
with `503 { error: "fb_unavailable" }`. In this repo `isFbUnavailable(err)`
(exported from `src/api/client.ts`, also re-thrown by `softFetch` and surfaced
as `errorCode` by `useApi`) turns that into a calm `<FeatureUnavailable />`
panel — campaigns (client tab + global page), FB leads, quick actions, the FB connect button on איפיון, the client-header FB
badges, and the launch-campaign modal.

To turn Meta back on: store per-client credentials in Mongo
(`users.fb_user_token` / `users.page_id` / `users.ad_account_id` — read by
`getClientFbCredentials`) and set `FB_INTEGRATION_ENABLED=true`. Nothing in the
C-panel needs changing; the panels light up on their own.
### API layer (`src/api/`)
`client.ts` and `admin.ts` are the only two files that call the backend. They export plain `async` functions — no hooks, no React. Every call goes through the `req<T>()` helper which:
- Prepends `VITE_API_BASE` (default `/api`)
- Injects the Bearer token from `localStorage.cpanel_token`
- Throws `ApiError` (with `.status` and `.code`) on non-2xx responses

To add a new endpoint, export a function from `client.ts` that calls `req<ReturnType>(path)`.

### Data fetching in components
Use the `useApi` hook for all async reads:
```typescript
const { data, loading, error, reload } = useApi(
  (signal) => someApiFunction(phone, signal),
  [phone]
);
```
`useApi` aborts in-flight requests on unmount/dep-change and prevents stale overwrites.

### Auth & routing (`src/App.tsx`, `src/context/AuthContext.tsx`)
- Token stored in `localStorage.cpanel_token`; validated on mount via `GET /api/agents/me`
- Three roles: `account_manager` → `supervisor` → `admin`
- `<Protected>` wrapper guards all routes; admin routes additionally check `agent.role === "admin"`
- Root `/` redirects to `/admin` (admins) or `/dashboard` (managers)

### State management
No Redux/Zustand. State lives in:
- **`AuthContext`** — logged-in agent, login/logout
- **`ToastContext`** — toast notifications (`toast.ok()`, `toast.warn()`, `toast.error()`)
- **`useApi` + local `useState`** — per-page/component data

### Real-time (`src/hooks/useSocket.ts`)
Socket.io with a global singleton. Components call `getGlobalSocket()` to get the shared connection. Rooms: `join_account_manager(agentId)` for manager-level events, `join_client_chat(chatId)` for per-client chat.

### Image URLs
Backend returns relative `/api/img?...` URLs. Always pass them through `resolveImgUrl()` (exported from `client.ts`) before rendering — it converts relative paths to absolute when `VITE_API_BASE` is a full origin.

### UI conventions
- All shared primitives are in `src/components/ui/` — use `Button`, `Modal`, `Spinner`, `EmptyState`, `Badge`, `Skeleton` etc. before writing new ones
- Hebrew UI (RTL) throughout
- Tailwind v4 + custom CSS variables for theming; avoid inline style for anything already handled by a CSS variable
