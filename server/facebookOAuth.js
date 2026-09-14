const FB_APP_ID = process.env.FB_APP_ID || "";
const FB_APP_SECRET = process.env.FB_APP_SECRET || "";
const FB_API_VERSION = process.env.FB_API_VERSION || "v21.0";

/**
 * Exchanges a Facebook OAuth `code` for an access token by calling
 * Facebook's Graph API directly — this used to happen inside a Make.com
 * scenario (redirect_uri pointed at a Make webhook). Facebook requires
 * redirect_uri to be a public HTTPS URL it can redirect the browser to,
 * so this endpoint only works once the server is reachable over the
 * public internet (matching whatever origin FB_OAUTH_REDIRECT_URI /
 * VITE_FB_OAUTH_REDIRECT_URI point at) — it cannot be exercised from
 * `localhost` in local dev, that's a Facebook platform constraint, not
 * a limitation of this code.
 */
export async function exchangeFacebookCode(code, redirectUri) {
  if (!FB_APP_ID || !FB_APP_SECRET) {
    throw new Error("FB_APP_ID / FB_APP_SECRET חסרים ב-.env — לא ניתן להשלים את חיבור הפייסבוק");
  }
  const url = new URL(`https://graph.facebook.com/${FB_API_VERSION}/oauth/access_token`);
  url.searchParams.set("client_id", FB_APP_ID);
  url.searchParams.set("client_secret", FB_APP_SECRET);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code", code);

  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json?.error?.message || `Facebook token exchange failed: HTTP ${res.status}`);
  }
  return json; // { access_token, token_type, expires_in }
}
