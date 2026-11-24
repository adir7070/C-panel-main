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
- **Auto-assign:** `admin_settings.leadsAutoAssignTo` = an agent id. Every
  intake lead, and every import/manual add that names no manager, goes
  straight to that user (`autoAssignAgent` in `server/leads.js`). It is set
  on `/admin/leads-distribution` (`GET`/`PUT /api/leads/auto-assign`, which can
  also hand over every lead that is still unassigned). Since 2026-11-24 it
  points at Gali (user decision: "for now").
- `assignedToName` is the user's nickname when they have one ("גלי").
- Frontend API in `src/api/leads.ts`; list in `src/pages/LeadsPage.tsx`.
  Clicking a row opens the lead screen `src/pages/LeadDetailPage.tsx`
  (`/leads/:id`, `/leads/:id/personal_catalog` deep-links the tab). It has
  two tabs: "פרטי ליד" (the intake answers, message, contact details
  editable until the lead is a client, notes, history) and "קטלוג אישי".
  The catalog tab is the client page's own `PersonalCatalogTab` keyed by
  phone, so a quote built on a lead is the client's catalog.
- Intake answers: `POST /api/leads/intake` stores `answers: [{question, answer}]`
  (`extractAnswers` in `server/leads.js`). They come from an explicit
  `answers` list (also `{q,a}` / `{label,value}` / Facebook `{name, values}`),
  from an `answers` object (`{question: answer}`), or from any unknown
  top-level field. `utm_*` / fbclid / form ids go to `tracking`. Only intake
  payloads get answers, not CSV imports. The list endpoint omits
  `answers`/`tracking`; `GET /api/leads/:id` derives them from `raw` for older
  leads.
- Lead → client writes live in ONE place: `backend/services/lead-client.service.js`
  (CommonJS, imported by `server/leads.js`). A manager can open
  `/api/cpanel/clients/:phone/*` for a lead assigned to them while nobody owns
  the phone as a client (`requireClientAccess` → `isAssignedLead`). That is
  what makes the catalog usable on a "חדש" lead. A payment for a phone that
  is still only a lead creates the client before crediting
  (`purchase-sync.ensureUserDoc` → `ensureClientFromLead`; owner = the lead's
  manager, else whoever built the quote).
- Client page "פרופיל" tab shows a "מקור הליד" card (`LeadOriginCard`, from
  `GET /api/leads/for-client/:phone`: admin, the client's manager, or the
  lead's assignee). The backend already owns `/api/leads/by-phone/:phone`,
  which returns different data.

### Price list & quotes (הצעות מחיר)
- **Catalog = the 64 services of the Dashen sales kit**, in 10 categories.
  The single source is `backend/services/service-catalog.data.js`, which
  also holds the kit's quick starts and "works well together" combos.
  Services are stored in `cpanel_products` as `kind: "service"`. Boot
  seeding (`cpanel-products.service.seedDefaults`) only inserts missing
  keys, so a price edited in the DB survives restarts.
- The old Iconiq products (`item` / `prebuilt` / `social` / `coins`) were
  deleted at the user's request on 2026-11-22 and are no longer seeded.
  `refreshSocialDefaults` is gone. Wiping them from a DB is a one-off:
  `MONGO_URI=… node backend/scripts/replace-catalog-with-services.js --apply`
  (dry run without `--apply`; it writes a JSON backup first).
- Quotes are `personal_packages` docs with `kind: "quote"`:
  - Each has setup lines (paid at signing) and monthly lines, quantity per
    line, up to 10% discount, 18% VAT on top, `commitMonths` (default 3),
    `validDays` (14), a global number per year (`2026-001`, from
    `counters._id = "quote_no:<year>"`), and the "הוכן עבור" client details.
  - The server resolves catalog lines and recomputes all totals on every
    save (`services/quote.service.js`). `src/api/quotes.ts`
    `computeQuoteTotals` mirrors it for the live preview.
  - A line already in a quote keeps its quoted price when the catalog
    price changes.
- Max discount is **per user**: `agents.maxDiscountPct` (0–100, set in
  ניהול משתמשים), absent = **10%**, admins included — the role grants
  nothing. Netanel has 100 (no cap; user decision 2026-11-24).
  `quote.service.maxDiscountFor(agent)` is the one rule; quotes, the old
  personal packages, `/cpanel/products` `quoteRules` and the quote defaults
  all use it, and `agentMaxDiscount()` in `src/api/client.ts` mirrors it.
  The cap applies to whoever saves, so editing a quote someone else gave a
  higher discount fails until the discount is lowered.
- Routes (behind `requireClientAccess`):
  - `/api/cpanel/clients/:phone/quotes`: `GET /defaults`, `POST`, `PATCH /:id`,
    and `GET /:id/document`.
  - The document is the printable "הצעת מחיר והסכם התקשרות" HTML in the
    original deshen-quote-agreement layout and agreement text
    (`services/quote-document.service.js`, logo in `backend/assets/`).
  - List and delete go through `/personal-catalog`.
- UI: `src/components/quotes/QuoteBuilder.tsx` is a full-screen builder.
  - Smart search lives in `src/lib/serviceSearch.ts`: Hebrew normalization,
    synonyms, one-typo tolerance and "עד 1000"-style price filters.
  - Also: billing/role/category filters, quick starts, combo suggestions,
    and keyboard control (`/`, ↑↓, Enter).
  - `QuoteCard` sits in the "קטלוג אישי" tab, on both the client page and
    the lead screen.
- **Signing.**
  - "🔗 העתק קישור לחתימה" on the quote card: `POST …/quotes/:id/sign-link`
    creates one secret `signToken` (32 random bytes) per quote.
  - The client opens `/sign/<token>`: `routes/quote-sign.routes.js`, mounted at
    the app root in `server.js`; Vite proxies `/sign` in dev.
    - It's a mobile-first, vanilla HTML/JS page
      (`services/quote-sign-page.service.js`) with 3 steps: the quote → the
      client's details (missing ones flagged) → two consents + a finger
      signature pad with a full-screen mode.
  - On submit (`services/quote-sign.service.js`):
    - Validates the details, the consents, a PNG signature of at most
      400KB, the quote `version` (`updatedAt`) and expiry
      (`quoteDate + validDays`, 410 after).
    - Freezes the signed HTML into `signed_documents`: sha256, IP,
      user-agent, the signature.
    - Sets `personal_packages.signed`.
  - A signed quote can't be edited or deleted (409 `quote_signed`).
  - The panel shows the frozen copy via `GET …/quotes/:id/signed-document`.
  - `/sign` responses send `Referrer-Policy: no-referrer` + `no-store` so the
    token never leaks.
  - Dashen's stamp + Netanel's signature (`backend/assets/deshen-stamp.png`,
    cut from a photo) is on every quote document, together with ח.פ. 517319612.
- **Payment after signing is not built.**
  - The user chose an **automatic monthly charge** (setup at signing +
    Cardcom token for the monthly amount) but hasn't specified the flow yet.
  - The one-amount charge paths refuse quotes (`409 quote_not_chargeable` in
    `chargePersonalIframe` and `contractPay`).

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
- Roles: `sales` · `account_manager` → `supervisor` → `admin` (plus `finance`).
  The backend scopes every non-admin the same way (own leads, own clients).
- `sales` (מכירות, e.g. Gali): the menu and the router (`src/lib/roles.ts`)
  only allow `/` (the lead dashboard `SalesDashboardPage`, data from
  `GET /api/leads/dashboard`), `/leads`, `/clients`, `/tasks`,
  `/appointments`; anything else redirects to `/`. They appear in the
  assign-to lists (`/cpanel/account-managers` returns `account_manager` +
  `sales`).
- `<Protected>` wrapper guards all routes; admin routes additionally check `agent.role === "admin"`
- Root `/` redirects to `/admin` (admins), shows the lead dashboard (sales) or the manager dashboard (everyone else)
- Users: `admin`, `netanel` (admin, no discount cap), `gali` (sales). They
  were created by `backend/scripts/setup-sales-team.js` (idempotent;
  passwords come from env vars and are never committed).

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
