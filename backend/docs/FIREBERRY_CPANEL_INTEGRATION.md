# Fireberry ← C-panel Embedded Tabs

Embeds four C-panel tabs (Products, Campaigns, Leads, Calendar) inside
Fireberry customer records (object 1005). Reps stay inside Fireberry —
the tabs render the same React UI as the standalone C-panel, calling
the same APIs, with no separate login.

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  Fireberry record (object 1005)                               │
│  ├─ HTML field (Products)                                     │
│  │  └─ <iframe src=".../embed/products/{phone}">              │
│  ├─ HTML field (Campaigns)                                    │
│  │  └─ <iframe src=".../embed/campaigns/{phone}">             │
│  ├─ HTML field (Leads)                                        │
│  │  └─ <iframe src=".../embed/leads/{phone}">                 │
│  └─ HTML field (Calendar)                                     │
│     └─ <iframe src=".../embed/calendar/{phone}">              │
└────────────────────────────┬──────────────────────────────────┘
                             │ each iframe loads
                             ▼
┌───────────────────────────────────────────────────────────────┐
│  C-panel React app (cpanel-973d9819fba6.herokuapp.com)        │
│  • /embed/:tab/:phone route                                   │
│  • No shell (no sidebar, no header, no tab strip)             │
│  • No auth check                                              │
│  • Mounts the selected tab component directly                 │
└────────────────────────────┬──────────────────────────────────┘
                             │ API calls (Bearer-less)
                             ▼
┌───────────────────────────────────────────────────────────────┐
│  iconiq-server cpanel API (iconiq-b19bf9d01fab.herokuapp.com) │
│  authMiddleware:                                              │
│    1. Bearer token? → look up agent, attach req.agent         │
│    2. No token? → check Referer against EMBED_REFERER_ALLOWLIST│
│       Match? → attach synthetic admin-scoped agent             │
│       No match? → 401                                          │
└───────────────────────────────────────────────────────────────┘
```

## Files

| File | Repo | Purpose |
|------|------|---------|
| `src/pages/EmbeddedTabPage.tsx` | C-panel | Renders one tab, no shell, no auth |
| `src/App.tsx` (mod) | C-panel | Adds `/embed/:tab/:phone` route |
| `controllers/cpanel.controller.js` (mod) | iconiq-server | authMiddleware Referer fallback |
| `services/fireberry-cpanel.service.js` | iconiq-server | Reads phone from object 1005, stamps iframe HTML |
| `routes/fireberry-cpanel.routes.js` | iconiq-server | 3 endpoints: sync, sync-all, debug |
| `routes/api.js` (mod) | iconiq-server | Mounts `/fireberry-cpanel` |
| `docs/FIREBERRY_CPANEL_INTEGRATION.md` | iconiq-server | This file |

## Required Fireberry setup (one-time)

### 1. Create four HTML fields on object 1005

In Fireberry: System Settings → Object Editor → ניהול לקוח (1005) → Add Field.

| Suggested name | Type | Purpose |
|---|---|---|
| `iframe מוצרים` | HTML (long text) | Hosts Products tab |
| `iframe קמפיינים` | HTML (long text) | Hosts Campaigns tab |
| `iframe לידים` | HTML (long text) | Hosts Leads tab |
| `iframe לוח שנה` | HTML (long text) | Hosts Calendar tab |

After Fireberry assigns `pcfsystemfield<N>` names, copy them into
`FIREBERRY_FIELD_MAP` in `services/fireberry-cpanel.service.js`
(replace the four placeholders that start with `pcfsystemfield_iframe_`).

### 2. Discover the real pcf names

Open a customer record in Fireberry, copy the GUID from the URL, then hit:

```
GET https://iconiq-b19bf9d01fab.herokuapp.com/api/fireberry-cpanel/debug/{recordId}
```

The response includes the full record and all pcf field names. Find the
four HTML fields you just created and copy their pcf names into the
service file.

### 3. Backfill existing records

```powershell
Invoke-RestMethod -Uri "https://iconiq-b19bf9d01fab.herokuapp.com/api/fireberry-cpanel/sync-all" -Method POST
```

Iterates every record on object 1005 and stamps the four iframe HTML
fields with the actual phone baked into each iframe URL.

### 4. Add an Automation for new records

In Fireberry → System Settings → Automations:

```
Name:    iframes למילוי
Object:  ניהול לקוח (1005)
Trigger: On Create (and optionally On Update of telephone1)
Action:  HTTP POST
  URL:    https://iconiq-b19bf9d01fab.herokuapp.com/api/fireberry-cpanel/sync/{record id merge field}
  Method: POST
  Body:   (empty)
```

Now every new customer record automatically gets its iframe fields
populated with the right phone — no manual editing.

## Auth notes

The `authMiddleware` Referer allow-list (`EMBED_REFERER_ALLOWLIST` in
`controllers/cpanel.controller.js`) is the only relaxation; every other
endpoint still requires a Bearer token.

The synthetic agent attached to embedded requests has `role: "admin"`
and `isFireberryEmbed: true`. Downstream code can branch on
`req.agent.isFireberryEmbed` if it wants to limit what an embedded view
can do (currently no such limits — Fireberry is the trust boundary).

If C-panel ever moves to a new host, add the new origin to
`EMBED_REFERER_ALLOWLIST`. Without that, the embedded API calls return
401.

## Deployment order

1. Merge iconiq-server `feat/cpanel-fireberry-embed` to main, wait for deploy.
2. Merge C-panel `feat/fireberry-embed` to main, wait for deploy.
   (Order is flexible — neither side breaks the other; the C-panel embed
    page just won't get past 401 until iconiq-server is updated.)
3. Create the four HTML fields in Fireberry.
4. Update `FIREBERRY_FIELD_MAP` with real pcf names + push.
5. Run sync-all.
6. Configure the Automation.

## Local development

C-panel dev server runs on `http://localhost:5173`. The Referer
allow-list includes it, so embedded API calls work locally without a
login. To test:

```bash
cd C-panel && npm run dev
# Then open http://localhost:5173/embed/products/0501122345
```
