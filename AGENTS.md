# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Vite dev server with HMR (proxies /api/* to VITE_API_URL)
npm run build        # tsc -b && vite build → outputs to dist/
npm run lint         # ESLint across entire codebase
npm start            # Express server (loads .env): SPA + local backend + /api proxy
npm run seed:admin -- --name admin --password 'secret' [--role admin|supervisor|account_manager]
```

Local dev needs a MongoDB on `MONGO_URI`. Start it with the DEFAULT dbpath —
`mongod --dbpath /Users/a1234/data/db` — that is where the `dashen` database lives.
No test suite exists in this repo.

TypeScript strict mode is enforced (`noUnusedLocals`, `noUnusedParameters`) — the build fails on unused declarations.

## Architecture

### Runtime topology
This repo is the Dashen Media Tech ops panel (formerly Iconiq — that company
closed; all Iconiq/Make.com/Kliq-app/Fireberry branding and hard dependencies
have been removed, see "Migration notes" below). It is a React SPA plus an
Express server (`server.js`) that:
1. Serves the Vite-built SPA from `dist/`
2. **Local backend (MongoDB, in this repo — `server/db.js`, `server/auth.js`, `server/leads.js`):**
   panel login (`POST /api/agents/login`, `GET /api/agents/me`), the managers
   lists the admin UI needs, and the whole leads pipeline (`/api/leads/*`,
   public intake at `POST /api/leads/intake` guarded by `x-api-key: LEADS_INTAKE_KEY`).
   Toggled by `LOCAL_AUTH` (login) and `LOCAL_LEADS` (leads pipeline), both on by default.
3. Proxies every other `/api/**` → `API_TARGET` (your external backend's origin — set it in `.env`)
4. Runs the WOW-ads generation prompts locally (`POST /api/local-ads/generate`, see `server/localAdsPipeline.js`) instead of forwarding to Make.com
5. Exchanges Facebook OAuth codes directly (`GET /auth/facebook/callback`, see `server/facebookOAuth.js`) instead of forwarding to a Make.com webhook
6. Falls back all other routes to `index.html` (SPA routing)

Everything else the panel calls (clients, campaigns, wallet, WOW products,
chats… — ~130 `/api/cpanel/*` endpoints, see `docs/API-ENDPOINTS.md`) is
served by the **real backend**: the user's local clone of `iconiq-server`
(`~/Documents/GitHub/iconiq/iconiq-server`, Express 5 CJS monolith). Local
topology that works:

| process | port | how |
|---|---|---|
| iconiq-server | 3900 | `cd ~/Documents/GitHub/iconiq/iconiq-server && NODE_ENV=development node server.js` (reads its gitignored `.env.development`: local `MONGO_URI=…/dashen`, `DISABLE_WHOAPP=true`, `DISABLE_WOW_BETA=true`, `SERVER_BASE_URL=http://localhost:3900`, `CPANEL_BASE_URL=http://localhost:3910`) |
| this repo | 3910 | `npm start` with `API_TARGET=http://localhost:3900`, `LOCAL_AUTH=0`, `LOCAL_LEADS=1`, `MONGO_URI=…/dashen` (the SAME database) |

With `LOCAL_AUTH=0` the backend owns login (opaque `agents.token`,
password = sha256(pw + "iconiq2024")); the leads module validates that token
against the shared `agents` collection. Moving a lead to
בתהליך / לסלוק / לקוח פעיל runs `syncLeadToClient()` in `server/leads.js`,
which writes exactly what the backend's Fireberry-free client creation
writes (`cpanel_clients`, `support_chats`) plus a `business_profiles` seed —
so the lead shows up in "כל הלקוחות" and opens as a client with the איפיון
pre-filled. Standalone mode (`LOCAL_AUTH=1`, no backend) still works for
login + leads only.

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
  `iconiq-server/services/purchase-sync.service.js`, in a crash-safe order:
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

### Migration notes (Iconiq → Dashen Media Tech)
- Iconiq closed; all UI branding now reads "דשן מדיה טק" / "Dashen Media Tech".
- No hardcoded `iconiqmedia.co.il` host remains anywhere — `API_TARGET` /
  `VITE_API_URL` / `VITE_SOCKET_URL` / `FB_*` are all required env vars now,
  see `.env.example`.
- The WOW-ads "Generate Again" flow and the Facebook OAuth reconnect flow
  used to proxy through Make.com webhooks; both now run locally in
  `server.js` (see points 3–4 above). `campaign.md` is read verbatim at
  runtime as the Gemini system prompt — edit that file to change the
  creative pipeline's behavior without touching code.
- Features that only made sense with the old "Kliq" consumer mobile app
  (client online/presence indicator, in-app activity/journey feed, Expo
  push tokens, the "client chose you" onboarding notification, and the
  "send app download link" SMS) were removed — there is no separate
  consumer app anymore. The AI chat assistant tag was renamed from
  "Kliq AI" to "עוזר AI"; the chat itself still works over WhatsApp and
  was NOT removed.
- **Fireberry (the old CRM) is fully gone — both repos.** In this repo: the
  Fireberry-embedded `/embed/:tab/:phone` iframe page, "import from Fireberry" /
  "sync assignments" on the admin clients page, and the Fireberry-fed leads
  distribution. In `iconiq-server`: `getClientFbCredentials`, `addClient`,
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
own way, `middlewares/fb-gate.middleware.js` in `iconiq-server` answers them all
with `503 { error: "fb_unavailable" }`. In this repo `isFbUnavailable(err)`
(exported from `src/api/client.ts`, also re-thrown by `softFetch` and surfaced
as `errorCode` by `useApi`) turns that into a calm `<FeatureUnavailable />`
panel — campaigns (client tab + global page), FB leads, quick actions, the
Meta pickers on פרופיל, the FB connect button on איפיון, the client-header FB
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
