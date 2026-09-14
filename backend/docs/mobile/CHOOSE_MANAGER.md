# Choose-Your-Manager — Mobile Integration

Two ways to ship this in the mobile app. Same backend either way.

## Option A — WebView (5 minutes, zero native code)

The server already hosts a polished mobile-first page at
`/choose-manager`. Open it in a WebView, pass the user's phone via query
string, listen for the success message.

```tsx
import { WebView } from 'react-native-webview';

<WebView
  source={{ uri: `https://api.iconiqmedia.co.il/choose-manager?phone=${userPhone}` }}
  onMessage={(e) => {
    const msg = e.nativeEvent.data;          // "manager_chosen:<agentId>"
    if (msg.startsWith('manager_chosen:')) {
      const agentId = msg.split(':')[1];
      // close modal, mark onboarding complete, navigate to home
      navigation.replace('Home');
    }
  }}
/>
```

Done. Heebo font, RTL, skeleton loading, error retry — all already in
the page.

## Option B — Native React Native screen (full control)

Use [`ChooseManagerScreen.tsx`](./ChooseManagerScreen.tsx) from this
folder. Self-contained, no external UI libs, no SVGs to wire up. Just
copy the file, set `API_BASE`, mount it on first launch.

```tsx
import { ChooseManagerScreen } from './ChooseManagerScreen';

<ChooseManagerScreen
  phone={userPhone}
  onChosen={({ id, name }) => {
    AsyncStorage.setItem('cpanel_manager_id', id);
    navigation.replace('Home');
  }}
/>
```

Same skeleton/error/empty states as the WebView page, plus pull-to-
refresh, native `ActivityIndicator`, native `Alert` for errors, and a
small `rateMyManager()` helper for the post-interaction rating prompt.

## Showing the client WHO their manager is

After the client picks a manager, the mobile app should surface a
"My Manager" card on the home screen / settings — name, avatar, ★
rating, plus call/WhatsApp shortcuts. Use the drop-in component:

```tsx
import { MyManagerCard } from './MyManagerCard';

<MyManagerCard
  phone={userPhone}
  onChooseManager={() => navigation.navigate('ChooseManager')}
  onRateManager={(manager, existingRating) => {
    // open your star-picker modal, call rateMyManager() on submit
  }}
/>
```

It calls `GET /api/public/my-manager?phone=…` and renders the appropriate
state (empty CTA → "pick a manager", or full card → name/avatar/rating
+ call/WhatsApp buttons + rate button).

## API endpoints

All under `/api/public/`. **No auth** — designed for pre-onboarding.

### GET `/api/public/managers`

Returns active managers with everything needed for the picker UI:

```json
{
  "managers": [
    {
      "id":          "65f3a9...",
      "name":        "סנדי",
      "avatarUrl":   "https://f002.backblazeb2.com/...",
      "bio":         "מומחית לעסקים קטנים · 5 שנות ניסיון",
      "clientCount": 47,
      "rating":      4.6,
      "ratingCount": 18
    }
  ],
  "total": 3
}
```

### GET `/api/public/my-manager?phone=05XXXXXXXX`

Returns the manager currently assigned to this phone, plus this
client's own rating if they've ever rated. `manager` is `null` if the
client hasn't picked anyone yet (or the assigned agent is inactive /
no longer a manager — same handling).

```json
{
  "manager": {
    "id":          "65f3a9...",
    "name":        "סנדי",
    "avatarUrl":   "https://f002.backblazeb2.com/...",
    "bio":         "מומחית לעסקים קטנים · 5 שנות ניסיון",
    "phone":       "0501112222",
    "rating":      4.6,
    "ratingCount": 18,
    "assignedAt":  "2026-05-09T12:34:56.789Z"
  },
  "myRating": { "stars": 5, "comment": "אחלה שירות", "updatedAt": "..." }
}
```

The `phone` field on the manager is the **manager's** phone — used for
tap-to-call / WhatsApp deep links on the client side. Safe to expose
since clients already communicate with their manager directly.

### POST `/api/public/managers/:id/choose`

```json
{ "phone": "0501234567" }
```

Server creates/updates the `cpanel_clients` row tying that phone to the
chosen manager, then emits `cpanel_client_chose_you` over WebSocket
to the manager's room → real-time popup on their C-panel.

### POST `/api/public/managers/:id/rate`

```json
{ "phone": "0501234567", "stars": 5, "comment": "אחלה שירות" }
```

- `stars` must be 1..5
- `comment` optional, ≤500 chars
- **Authorization:** the caller's phone must be the manager's actual
  client (a row in `cpanel_clients` with `{ phone, agentId }`). Anyone
  else gets `403 { error: "not_your_manager" }` — no spam possible.

## Real-time popup on the manager side

Already wired in the C-panel. When a client picks a manager, that
manager (if logged in) sees an indigo gradient banner at the top of the
screen with the client name + a "פתח לקוח" button. A soft two-note
bell plays (distinct from the cha-ching used for new purchases) so
managers can tell the two notification types apart by ear.

## Admin setup

Each manager's profile image + bio comes from `/admin/users` → edit
modal. Avatar uploads to Backblaze (≤5MB, JPG/PNG/WEBP). Bio is a
500-char description that renders on the mobile picker card.

If a manager has no avatar, the picker falls back to a colored circle
with their initial. If they have no bio, the bio line is hidden.
