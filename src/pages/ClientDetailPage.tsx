import { useEffect, useMemo, useState, useRef } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  type ClientDetail,
  type AccountManager,
  type FbTokenStatus,
  type FbAccountHealth,
  type FbLiveStatus,
  ApiError,
  getClientDetail,
  getAccountManagers,
  assignManager,
  claimClient,
  getClientFbTokenStatus,
  getClientFbAccountHealth,
  getClientFbLiveStatus,
  approveReferralClient,
  closeReferralClient,
  isFbUnavailable,
  confirmPersonalPayment,
  confirmOpenCharges,
} from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { useSocket } from "../hooks/useSocket";
import { Layout } from "../components/shell/Layout";
import { Header } from "../components/shell/Header";
import { Tabs } from "../components/shell/Tabs";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { Modal } from "../components/ui/Modal";
import { Badge } from "../components/ui/Badge";
import { Input } from "../components/ui/Input";

import { PackageStatusBanner } from "../components/client-detail/PackageStatusBanner";
import { OverviewTab } from "../components/tabs/OverviewTab";
import { usePurchaseSync, announcePurchase } from "../hooks/usePurchaseSync";
import { CampaignsTab } from "../components/tabs/CampaignsTab";
import { LeadsTab } from "../components/tabs/LeadsTab";
import { CharacterizationTab } from "../components/tabs/CharacterizationTab";
import { ProductsTab } from "../components/tabs/ProductsTab";
import { CalendarTab } from "../components/tabs/CalendarTab";
import { PersonalCatalogTab } from "../components/tabs/PersonalCatalogTab";

type TabId =
  | "overview" | "characterization" | "products"
  | "campaigns" | "leads" | "calendar" | "personal_catalog";

const TABS: { id: TabId; label: string }[] = [
  { id: "personal_catalog",  label: "קטלוג אישי"   },
  { id: "characterization",  label: "איפיון"       },
  { id: "overview",          label: "פרופיל"       },
  { id: "products",          label: "מוצרים"       },
  { id: "campaigns",         label: "קמפיינים"     },
  { id: "leads",             label: "לידים"        },
  { id: "calendar",          label: "לוח שנה"      },
];

export function ClientDetailPage() {
  const { phone, tab: tabParam } = useParams<{ phone: string; tab?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { agent } = useAuth();
  const toast = useToast();
  const reduce = useReducedMotion();

  // Initialize the global socket on direct page loads (refresh, bookmark, deep link)
  // so purchase events reach this page without a refresh.
  useSocket(agent?.id);

  const [detail, setDetail]       = useState<ClientDetail | null>(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  /* When the ownership gate trips (403 + "not_your_client"), we render a
     dedicated access-denied screen instead of the generic error card so
     the manager understands this isn't a bug — it's policy. */
  const [accessDenied, setAccessDenied] = useState<{ message: string; assignedManagerName: string | null } | null>(null);
  const [claimConfirmOpen, setClaimConfirmOpen] = useState(false);
  const [claiming, setClaiming] = useState(false);
  /* /clients/:phone/:tab deep-links a tab — Cardcom returns to /personal_catalog. */
  const [tab, setTab]             = useState<TabId>(() => TABS.some(t => t.id === tabParam) ? tabParam as TabId : "overview");
  const [managers, setManagers]   = useState<AccountManager[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [fbToken, setFbToken]       = useState<FbTokenStatus | null>(null);
  const [fbHealth, setFbHealth]     = useState<FbAccountHealth | null>(null);
  const [fbLive, setFbLive]         = useState<FbLiveStatus | null>(null);
  /* The Meta integration is switched off server-side (503 fb_unavailable)
     — hide every Facebook affordance rather than showing dead badges. */
  const [fbOff, setFbOff] = useState(false);
  const [fbChecking, setFbChecking] = useState(false);
  const [referralBusy, setReferralBusy] = useState(false);
  const [fbPageId, setFbPageId]               = useState("");
  const [showFbInput, setShowFbInput]         = useState(false);
  const [fbReconnectUrl, setFbReconnectUrl]   = useState<string | null>(null);

  const decodedPhone = useMemo(() => phone ? decodeURIComponent(phone) : "", [phone]);
  const canAssign = agent?.role === "admin" || agent?.role === "supervisor";

  async function recheckFb() {
    setFbChecking(true);
    setFbToken(null);
    setFbHealth(null);
    setFbLive(null);
    try {
      const [detail_, token, health, live] = await Promise.allSettled([
        getClientDetail(decodedPhone),
        getClientFbTokenStatus(decodedPhone),
        getClientFbAccountHealth(decodedPhone),
        getClientFbLiveStatus(decodedPhone),
      ]);
      if (detail_.status === "fulfilled") setDetail(detail_.value);
      if (token.status   === "fulfilled") setFbToken(token.value);
      if (health.status  === "fulfilled") setFbHealth(health.value);
      if (live.status    === "fulfilled") setFbLive(live.value);
      for (const r of [token, health, live]) {
        if (r.status === "rejected" && isFbUnavailable(r.reason)) setFbOff(true);
      }
    } finally {
      setFbChecking(false);
    }
  }

  /* A completed purchase for this client (socket, webhook, or another
     window) bumps syncTick: the detail reloads silently, and the package
     banner, מוצרים and קטלוג אישי refresh in place. Nothing remounts, so an
     unsaved איפיון form, notes draft or SMS text survives. */
  const [syncTick, setSyncTick] = useState(0);
  const silentReload = useRef(false);
  /* A reload is only silent when a client is already on screen — otherwise a
     failure must still surface as the error / access-denied screen. */
  const hasDetailRef = useRef(false);
  useEffect(() => { hasDetailRef.current = detail !== null; }, [detail]);
  usePurchaseSync(ev => {
    if (ev.phone && ev.phone !== decodedPhone) return;
    silentReload.current = true;
    setSyncTick(t => t + 1);
  });

  /* Cardcom sends the charge window back here with ?personal_success=<id>
     (or ?personal_error=<id>). Confirm with the server — its webhook may
     never arrive — then tell every open screen. */
  const returnedPkg = searchParams.get("personal_success");
  const failedPkg   = searchParams.get("personal_error");
  const handledReturn = useRef<string | null>(null);
  /* The confirmation below can keep checking for ~2.5 minutes; once the page
     is gone it must stop, and must not rewrite the URL of wherever the user
     went next. */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    if (!decodedPhone) return;
    const key = returnedPkg ? `ok:${returnedPkg}` : failedPkg ? `fail:${failedPkg}` : null;
    if (!key || handledReturn.current === key) return;
    handledReturn.current = key;
    if (failedPkg) {
      toast.error("התשלום נכשל או בוטל ב-Cardcom");
      setSearchParams({}, { replace: true });
      return;
    }
    const pkgId = returnedPkg as string;
    /* "processing" = another check (the webhook or the opener window) holds
       the claim on this payment. Usually it finishes within a second or two;
       a claim left by a crashed attempt goes stale after 2 minutes, after
       which our own call applies it. So keep looking (1.5s, then every 5s,
       ~2.5 minutes in all) and only say "activated" once it really is. */
    const MAX_ATTEMPTS = 30;
    const confirm = (attempt: number): Promise<void> =>
      confirmPersonalPayment(decodedPhone, pkgId).then(r => {
        if (!mountedRef.current) return;
        if (r.status === "processing" && attempt < MAX_ATTEMPTS) {
          const delay = attempt < 5 ? 1500 : 5000;
          return new Promise<void>(done => window.setTimeout(done, delay)).then(() => confirm(attempt + 1));
        }
        if (r.status === "paid") {
          toast.ok("התשלום התקבל — החבילה הופעלה. אפשר לסגור את חלון התשלום");
          announcePurchase({ phone: decodedPhone });
          // closes the Cardcom popup; browsers ignore this in a regular tab
          window.setTimeout(() => window.close(), 2500);
        } else if (r.status === "processing") {
          toast.warn("התשלום אושר ב-Cardcom ונמצא בעיבוד — המסך יתעדכן כשהחבילה תופעל");
        } else {
          toast.warn("התשלום עדיין לא אושר ב-Cardcom — המסך יתעדכן כשיאושר");
        }
      });
    confirm(0)
      .catch(err => toast.error(err instanceof Error ? err.message : "בדיקת התשלום נכשלה"))
      .finally(() => { if (mountedRef.current) setSearchParams({}, { replace: true }); });
  }, [decodedPhone, returnedPkg, failedPkg, setSearchParams, toast]);

  /* Open Cardcom pages of this client are re-checked when the page loads and
     whenever the window regains focus, so a payment whose charge window was
     closed — or whose catalog tab the manager left — still lands without the
     webhook. Throttled; the server calls Cardcom only for pages still open. */
  const toastRef = useRef(toast);
  useEffect(() => { toastRef.current = toast; });
  useEffect(() => {
    if (!decodedPhone) return;
    let last = 0;
    let cancelled = false;
    const check = () => {
      if (Date.now() - last < 15000) return;
      last = Date.now();
      confirmOpenCharges(decodedPhone)
        .then(r => {
          if (cancelled || !r.paid?.length) return;
          toastRef.current.ok("התקבל תשלום — החבילה הופעלה");
          announcePurchase({ phone: decodedPhone });
        })
        .catch(() => { /* no access or transient — the next focus retries */ });
    };
    // the Cardcom return page confirms its own payment — don't race it on mount
    const params = new URLSearchParams(window.location.search);
    if (!params.has("personal_success") && !params.has("personal_error")) check();
    window.addEventListener("focus", check);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", check);
    };
  }, [decodedPhone]);

  useEffect(() => {
    if (!decodedPhone) return;
    let cancelled = false;
    const silent = silentReload.current && hasDetailRef.current;
    silentReload.current = false;
    if (!silent) { setLoading(true); setError(null); setAccessDenied(null); }
    Promise.all([
      getClientDetail(decodedPhone),
      canAssign ? getAccountManagers().catch(() => []) : Promise.resolve([] as AccountManager[]),
    ])
      .then(([d, m]) => {
        if (cancelled) return;
        setDetail(d);
        setManagers(m);
        setError(null);
        setAccessDenied(null);
      })
      .catch(err => {
        if (cancelled) return;
        // a failed background refresh keeps the loaded page; the next sync retries
        if (silent) return;
        if (err instanceof ApiError && err.status === 403 && err.code === "not_your_client") {
          setAccessDenied({
            message: err.message,
            assignedManagerName: typeof err.data.assignedManagerName === "string" ? err.data.assignedManagerName : null,
          });
          return;
        }
        setError(err instanceof Error ? err.message : "שגיאה בטעינת לקוח");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [decodedPhone, canAssign, syncTick]);

  useEffect(() => {
    if (!decodedPhone) return;
    let cancelled = false;
    getClientFbTokenStatus(decodedPhone)
      .then(t => { if (!cancelled) setFbToken(t); })
      .catch(err => { if (!cancelled && isFbUnavailable(err)) setFbOff(true); });
    getClientFbAccountHealth(decodedPhone)
      .then(h => { if (!cancelled) setFbHealth(h); })
      .catch(err => { if (!cancelled && isFbUnavailable(err)) setFbOff(true); });
    return () => { cancelled = true; };
  }, [decodedPhone]);

  async function onReferralApprove() {
    if (!confirm(`לאשר את ההפניה כרלוונטית?\nהמזמין יקבל 100 מטבעות.`)) return;
    setReferralBusy(true);
    try {
      const res = await approveReferralClient(decodedPhone);
      toast.ok(`אושר! המזמין קיבל 100 מטבעות (יתרה: ${res.new_balance})`);
      setDetail(d => d ? { ...d, referral: d.referral ? { ...d.referral, status: "friend_referral_approved" } : d.referral, chat: d.chat ? { ...d.chat, status: "friend_referral_approved" } : d.chat } : d);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה");
    } finally {
      setReferralBusy(false);
    }
  }

  async function onReferralClose() {
    if (!confirm(`לסמן את ההפניה כנסגרת?\nהמזמין יקבל 1,000 מטבעות.`)) return;
    setReferralBusy(true);
    try {
      const res = await closeReferralClient(decodedPhone);
      toast.ok(`נסגר! המזמין קיבל 1,000 מטבעות (יתרה: ${res.new_balance})`);
      setDetail(d => d ? { ...d, referral: d.referral ? { ...d.referral, status: "done" } : d.referral, chat: d.chat ? { ...d.chat, status: "done" } : d.chat } : d);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה");
    } finally {
      setReferralBusy(false);
    }
  }

  async function onAssign(managerId: string | null) {
    if (!detail?.chat?.id) return;
    setAssigning(true);
    try {
      await assignManager(detail.chat.id, managerId);
      const m = managerId ? managers.find(x => x.id === managerId) : null;
      setDetail(prev => prev && prev.chat ? {
        ...prev,
        chat: {
          ...prev.chat,
          accountManagerId: managerId ?? undefined,
          accountManagerName: m?.name ?? undefined,
        },
      } : prev);
      toast.ok(managerId ? `שויך מנהל: ${m?.name ?? ""}` : "השיוך הוסר");
      setShowPicker(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה בשיוך");
    } finally {
      setAssigning(false);
    }
  }

  /* Builds the Facebook OAuth consent URL. redirect_uri used to point at
     a Make.com webhook that exchanged the code and wrote the token into
     the old backend — that hop is gone. It now points at this server's
     own /auth/facebook/callback (see server.js + server/facebookOAuth.js),
     which exchanges the code directly with Facebook.
     NOTE: Facebook requires redirect_uri to be a public HTTPS URL it can
     redirect the browser to, so this only works once the server is
     deployed publicly — set VITE_FB_OAUTH_REDIRECT_URI to that deployed
     URL. client_id / config_id must be set to Dashen Media Tech's own
     Facebook App (see VITE_FB_APP_ID / VITE_FB_LOGIN_CONFIG_ID). */
  function handleBuildFbUrl() {
    const pid = fbPageId.trim();
    if (!pid) return;
    const appId = import.meta.env.VITE_FB_APP_ID as string | undefined;
    const redirectUri = import.meta.env.VITE_FB_OAUTH_REDIRECT_URI as string | undefined;
    const configId = import.meta.env.VITE_FB_LOGIN_CONFIG_ID as string | undefined;
    if (!appId || !redirectUri) {
      toast.error("חסרים VITE_FB_APP_ID / VITE_FB_OAUTH_REDIRECT_URI — הגדר אותם ב-.env");
      return;
    }
    const state = encodeURIComponent(`phone=${decodedPhone}&page_id=${pid}`);
    setFbReconnectUrl(
      `https://www.facebook.com/v21.0/dialog/oauth?client_id=${encodeURIComponent(appId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=public_profile,email,pages_show_list,pages_manage_ads,ads_management,` +
      `business_management,pages_manage_posts,pages_read_engagement,` +
      `pages_manage_metadata,leads_retrieval` +
      `&response_type=code&state=${state}` +
      (configId ? `&config_id=${encodeURIComponent(configId)}` : "") +
      `&auth_type=rerequest`
    );
    setShowFbInput(false);
  }

  if (loading) {
    return (
      <Layout header={<Header title="טוען לקוח…" back={<BackButton onClick={() => navigate(-1)} />} />}>
        <Spinner size="lg" label="טוען נתונים" />
      </Layout>
    );
  }

  if (accessDenied) {
    return (
      <Layout header={<Header title="גישה חסומה" back={<BackButton onClick={() => navigate(-1)} />} />}>
        <div
          className="card"
          style={{
            maxWidth: 560,
            margin: "var(--s-6) auto 0",
            padding: "var(--s-6)",
            textAlign: "center",
            borderTop: "3px solid var(--warning)",
            display: "grid",
            gap: "var(--s-4)",
            justifyItems: "center",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 64,
              height: 64,
              borderRadius: 16,
              background: "var(--warning-bg, #fef3c7)",
              color: "var(--warning, #b45309)",
            }}
          >
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </span>
          <div>
            <p className="t-eyebrow" style={{ color: "var(--warning)" }}>אין הרשאת גישה</p>
            <h2 style={{ fontSize: "var(--t-xl)", fontWeight: 800, margin: "var(--s-2) 0 0", color: "var(--ink)" }}>
              הלקוח בטיפול מנהל אחר
            </h2>
            {accessDenied.assignedManagerName && (
              <p className="t-meta" style={{ marginTop: "var(--s-2)" }}>
                בטיפול: <strong style={{ color: "var(--ink)" }}>{accessDenied.assignedManagerName}</strong>
              </p>
            )}
            <p className="t-body" style={{ marginTop: "var(--s-3)", color: "var(--ink-2)", maxWidth: 380, marginInline: "auto" }}>
              ניתן לעבוד רק על לקוחות שמשויכים אליך. אם יש צורך לקבל גישה ללקוח זה, פנה למנהל המערכת.
            </p>
          </div>
          <div style={{ display: "flex", gap: "var(--s-3)", flexWrap: "wrap", justifyContent: "center" }}>
            <Button onClick={() => setClaimConfirmOpen(true)}>העבר אליי</Button>
            <Button variant="ghost" onClick={() => navigate("/clients")}>הלקוחות שלי</Button>
            <Button variant="ghost" onClick={() => navigate(-1)}>חזור</Button>
          </div>
        </div>

        <Modal
          open={claimConfirmOpen}
          onClose={() => { if (!claiming) setClaimConfirmOpen(false); }}
          title="העברת לקוח לטיפולך"
        >
          <div style={{ display: "grid", gap: "var(--s-4)", padding: "var(--s-1) 0" }}>
            <p className="t-body" style={{ color: "var(--ink)" }}>
              אתה רוצה להעביר את הלקוח לטיפולך?
            </p>
            {accessDenied.assignedManagerName && (
              <p className="t-meta">
                הלקוח נמצא כעת בטיפול <strong style={{ color: "var(--ink)" }}>{accessDenied.assignedManagerName}</strong>.
                לאחר ההעברה הלקוח יתווסף לרשימה שלך והמנהל הקודם יאבד גישה.
              </p>
            )}
            <div style={{ display: "flex", gap: "var(--s-3)", justifyContent: "flex-end", flexWrap: "wrap" }}>
              <Button variant="ghost" onClick={() => setClaimConfirmOpen(false)} disabled={claiming}>
                ביטול
              </Button>
              <Button
                loading={claiming}
                onClick={async () => {
                  setClaiming(true);
                  try {
                    const r = await claimClient(decodedPhone);
                    toast.ok(r.alreadyOwned ? "הלקוח כבר משויך אליך" : "הלקוח הועבר לטיפולך");
                    setClaimConfirmOpen(false);
                    setAccessDenied(null);
                    /* Re-fetch the client now that we own it. The existing
                       useEffect on decodedPhone already does this when
                       accessDenied transitions back to null + we trigger
                       it by toggling a key. Simpler: hard reload to be
                       sure all child tabs re-mount with fresh permission. */
                    window.location.reload();
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : "שגיאה בהעברת הלקוח");
                    setClaiming(false);
                  }
                }}
              >
                כן, העבר אליי
              </Button>
            </div>
          </div>
        </Modal>
      </Layout>
    );
  }

  if (error || !detail) {
    return (
      <Layout header={<Header title="שגיאה" back={<BackButton onClick={() => navigate(-1)} />} />}>
        <div className="card">
          <p className="t-eyebrow" style={{ color: "var(--negative)" }}>שגיאה</p>
          <p className="t-body" style={{ marginTop: "var(--s-3)" }}>
            {error ?? "לא נמצא לקוח"}
          </p>
          <div style={{ marginTop: "var(--s-5)" }}>
            <Button onClick={() => navigate(-1)}>חזור</Button>
          </div>
        </div>
      </Layout>
    );
  }

  const profile = (detail.profile ?? {}) as Record<string, unknown>;
  const businessName = (profile.businessName as string) || detail.chat?.name || decodedPhone;
  const logoUrl = typeof profile.logoUrl === "string" ? profile.logoUrl : undefined;

  return (
    <Layout
      header={
        <Header
          eyebrow="לקוח"
          title={businessName}
          meta={
            <span dir="ltr" className="tabular">{decodedPhone}</span>
          }
          back={<BackButton onClick={() => navigate(-1)} />}
          trailing={
            detail.chat?.accountManagerName ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => canAssign && setShowPicker(true)}
                disabled={!canAssign}
              >
                מנהל · {detail.chat.accountManagerName}
              </Button>
            ) : canAssign ? (
              <Button variant="ghost" size="sm" onClick={() => setShowPicker(true)}>שייך מנהל</Button>
            ) : (
              <Badge>ללא מנהל</Badge>
            )
          }
        />
      }
    >
      {/* Identity row — identity card + status card side by side */}
      <section className="section" style={{ marginTop: 0 }}>
        <div style={{ display: "flex", gap: "var(--s-4)", alignItems: "stretch" }}>

          {/* Identity card */}
          <div className="card" style={{ flex: 1, padding: "var(--s-5)", borderTop: "3px solid var(--blue)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--s-4)" }}>
              <Logo url={logoUrl} name={businessName} />
              <div style={{ minWidth: 0 }}>
                <h2 style={{ margin: 0, fontSize: "var(--t-xl)", fontWeight: 800, color: "var(--ink)", letterSpacing: "-0.01em" }}>
                  {businessName}
                </h2>
                <div style={{ marginTop: 6, display: "flex", gap: "var(--s-4)", flexWrap: "wrap", alignItems: "center" }}>
                  <span dir="ltr" className="num" style={{ fontSize: "var(--t-sm)", fontWeight: 600, color: "var(--ink-2)" }}>{decodedPhone}</span>
                  {typeof profile.email === "string" && profile.email && (
                    <span style={{ fontSize: "var(--t-sm)", color: "var(--ink-3)" }}>· {String(profile.email)}</span>
                  )}
                  {typeof profile.address === "string" && profile.address && (
                    <span style={{ fontSize: "var(--t-sm)", color: "var(--ink-3)" }}>· {String(profile.address)}</span>
                  )}
                </div>
                <div style={{ marginTop: "var(--s-3)" }}>
                  {fbOff && (
                    <span className="t-meta" style={{ fontSize: 12 }}>חיבור פייסבוק כבוי כרגע</span>
                  )}
                  {!showFbInput && !fbReconnectUrl && (!fbOff && 
                    <Button variant="ghost" size="sm" onClick={() => setShowFbInput(true)}
                      style={{ color: "#1877F2", gap: 6 }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073C0 18.1 4.388 23.094 10.125 24v-8.437H7.078v-3.49h3.047V9.41c0-3.025 1.792-4.697 4.533-4.697 1.312 0 2.686.236 2.686.236v2.97h-1.513c-1.491 0-1.956.93-1.956 1.886v2.267h3.328l-.532 3.49h-2.796V24C19.612 23.094 24 18.1 24 12.073z"/>
                      </svg>
                      חבר לפייסבוק מחדש
                    </Button>
                  )}
                  {showFbInput && (
                    <div style={{ display: "flex", gap: "var(--s-2)", alignItems: "center", flexWrap: "wrap" }}>
                      <Input
                        placeholder="Page ID"
                        value={fbPageId}
                        onChange={e => setFbPageId(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && handleBuildFbUrl()}
                        style={{ maxWidth: 180 }}
                        dir="ltr"
                      />
                      <Button size="sm" onClick={handleBuildFbUrl}>צור קישור</Button>
                      <Button variant="ghost" size="sm" onClick={() => setShowFbInput(false)}>ביטול</Button>
                    </div>
                  )}
                  {fbReconnectUrl && (
                    <div style={{ display: "flex", gap: "var(--s-2)", alignItems: "center", flexWrap: "wrap" }}>
                      <a href={fbReconnectUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                        <button style={{
                          display: "inline-flex", alignItems: "center", gap: 8,
                          background: "#1877F2", color: "#fff", border: "none",
                          borderRadius: 8, padding: "8px 16px", fontWeight: 700,
                          fontSize: 14, cursor: "pointer", fontFamily: "inherit",
                        }}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073C0 18.1 4.388 23.094 10.125 24v-8.437H7.078v-3.49h3.047V9.41c0-3.025 1.792-4.697 4.533-4.697 1.312 0 2.686.236 2.686.236v2.97h-1.513c-1.491 0-1.956.93-1.956 1.886v2.267h3.328l-.532 3.49h-2.796V24C19.612 23.094 24 18.1 24 12.073z"/>
                          </svg>
                          חבר לפייסבוק מחדש
                        </button>
                      </a>
                      <Button variant="ghost" size="sm"
                        onClick={() => { setFbReconnectUrl(null); setShowFbInput(true); }}>
                        שנה page_id
                      </Button>
                    </div>
                  )}
                </div>
              </div>
              {/* Token balance — on the opposite end of the row from the
                  name (left in RTL). `marginInlineStart: auto` pushes it
                  to the inline-end of the flex line. Source: ClientDetail.coins. */}
              <div
                style={{
                  marginInlineStart: "auto",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 2,
                  padding: "var(--s-3) var(--s-4)",
                  borderRadius: "var(--r-2)",
                  background: "linear-gradient(135deg, #FEF3C7 0%, #FDE68A 100%)",
                  border: "1px solid #F59E0B",
                  flexShrink: 0,
                  minWidth: 140,
                }}
                title={detail.coinsUsed != null
                  ? `סה"כ ניתנו: ${(detail.coins ?? 0).toLocaleString("he-IL")} · נוצלו עד כה: ${(detail.coinsUsed).toLocaleString("he-IL")}`
                  : undefined}
              >
                <span style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: "#92400E",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                }}>
                  יתרת טוקנים
                </span>
                <span dir="ltr" className="num" style={{
                  fontSize: 24,
                  fontWeight: 800,
                  color: "#78350F",
                  lineHeight: 1,
                }}>
                  {Math.max(0, (detail.coins ?? 0) - (detail.coinsUsed ?? 0)).toLocaleString("he-IL")}
                </span>
              </div>
            </div>
          </div>

          {/* Status card */}
          <div className="card" style={{ flexShrink: 0, padding: "var(--s-4)", display: "flex", flexDirection: "column", gap: "var(--s-2)", minWidth: 170 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--s-2)" }}>
              <p style={{ margin: 0, fontSize: 10, fontWeight: 700, color: "var(--ink-4)", letterSpacing: "0.12em", textTransform: "uppercase" }}>
                סטטוס חשבון
              </p>
              <button
                onClick={recheckFb}
                disabled={fbChecking}
                style={{
                  fontSize: 10, fontWeight: 600,
                  color: fbChecking ? "var(--ink-4)" : "var(--blue)",
                  background: "transparent",
                  border: "1px solid currentColor",
                  borderRadius: "var(--r-1, 4px)",
                  padding: "2px 6px",
                  cursor: fbChecking ? "default" : "pointer",
                  opacity: fbChecking ? 0.6 : 1,
                  lineHeight: 1.4,
                  whiteSpace: "nowrap",
                }}
              >
                {fbChecking ? "בודק…" : "בדוק שוב"}
              </button>
            </div>
            {!fbOff && (fbChecking && !fbLive
              ? <Badge>Page · בודק…</Badge>
              : fbLive?.page
                ? <Badge variant={fbLive.page.accessible ? "positive" : "negative"}>Page {fbLive.page.accessible ? "✓" : "✗"}</Badge>
                : <Badge variant={detail.pageId ? "positive" : "default"}>Page {detail.pageId ? "✓" : "✗"}</Badge>
            )}
            {!fbOff && (fbChecking && !fbLive
              ? <Badge>Act · בודק…</Badge>
              : fbLive?.act
                ? <Badge variant={fbLive.act.accessible ? "positive" : "negative"}>Act {fbLive.act.accessible ? "✓" : "✗"}</Badge>
                : <Badge variant={detail.adAccountId ? "positive" : "default"}>Act {detail.adAccountId ? "✓" : "✗"}</Badge>
            )}
            <Badge variant={detail.payment?.hasToken ? "positive" : "default"}>
              {detail.payment?.hasToken
                ? `כרטיס · ${detail.payment.last4 ?? "—"}`
                : "אין כרטיס"}
            </Badge>
            {!fbOff && (fbChecking && !fbToken
              ? <Badge>טוקן · בודק…</Badge>
              : fbToken
                ? <Badge variant={fbToken.valid ? "positive" : fbToken.status === "expired" ? "negative" : "default"}>
                    טוקן · {fbToken.status === "valid" ? "תקין" : fbToken.status === "expired" ? "פג" : "חסר"}
                  </Badge>
                : <Badge>טוקן · טוען…</Badge>
            )}
            {!fbOff && detail.adAccountId && (
              fbChecking && !fbHealth
                ? <Badge>חשבון · בודק…</Badge>
                : fbHealth
                  ? <Badge variant={fbHealth.account_status === 1 ? "positive" : "negative"}>
                      {fbHealth.account_status === 1 ? "חשבון · תקין" : "חשבון · בעיה"}
                    </Badge>
                  : <Badge>חשבון · טוען…</Badge>
            )}
          </div>

        </div>
      </section>

      {/* Referral banner — shown only for חבר מביא חבר leads */}
      {detail?.referral && detail.referral.status !== "done" && (
        <div style={{ background: "#EEE9FF", borderBottom: "1px solid #C7B8FF", padding: "10px 20px", display: "flex", alignItems: "center", gap: 12, justifyContent: "space-between", direction: "rtl" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 18 }}>🎁</span>
            <span style={{ fontWeight: 600, color: "#5A3FBF", fontSize: 14 }}>חבר מביא חבר</span>
            {detail.referral.referredBy && (
              <span style={{ color: "#7B61FF", fontSize: 13 }}>הובא ע"י: {detail.referral.referredBy}</span>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {detail.referral.status === "friend_referral" && (
              <Button size="sm" onClick={onReferralApprove} disabled={referralBusy}>
                {referralBusy ? "..." : "הליד רלוונטי? (+100 מטבעות)"}
              </Button>
            )}
            {detail.referral.status === "friend_referral_approved" && (
              <Button size="sm" variant="clay" onClick={onReferralClose} disabled={referralBusy}>
                {referralBusy ? "..." : "הליד נסגר? (+1,000 מטבעות)"}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Package lifecycle STRIP — thin, sticky-friendly. Name, status pill,
          inline transition buttons, "פירוט מוצרים" toggle. Hidden if no
          active package. */}
      <PackageStatusBanner phone={decodedPhone} refreshKey={syncTick} />

      {/* Sticky TAB STRIP — sticks just under the global page header (56px)
          so the manager always knows where they are. layoutId-shared
          underline slides smoothly between tabs via framer-motion. */}
      <Tabs
        tabs={TABS}
        active={tab}
        onChange={t => setTab(t as TabId)}
        sticky
        top={56}
      />

      {/* TAB PANEL — fades + slight y-translate on tab change. AnimatePresence
          uses mode="wait" so previous panel exits before next enters. */}
      <div style={{ padding: "var(--s-6) var(--s-5)", maxWidth: 1280, margin: "0 auto" }}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            id={`panel-${tab}`}
            role="tabpanel"
            aria-labelledby={`tab-${tab}`}
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={reduce ? undefined : { opacity: 1, y: 0 }}
            exit={reduce    ? undefined : { opacity: 0, y: -4 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          >
            {tab === "overview"         && <OverviewTab detail={detail} phone={decodedPhone} onDetailChange={setDetail} />}
            {tab === "characterization" && <CharacterizationTab phone={decodedPhone} />}
            {tab === "campaigns"        && <CampaignsTab phone={decodedPhone} clientName={businessName} />}
            {tab === "leads"            && <LeadsTab phone={decodedPhone} />}
            {tab === "products"          && <ProductsTab phone={decodedPhone} onGotoCharacterization={() => setTab("characterization")} onGotoPersonalCatalog={() => setTab("personal_catalog")} syncTick={syncTick} />}
            {tab === "personal_catalog" && <PersonalCatalogTab phone={decodedPhone} />}
            {tab === "calendar"         && <CalendarTab phone={decodedPhone} />}
          </motion.div>
        </AnimatePresence>
      </div>

      <ManagerPicker
        open={showPicker}
        managers={managers}
        currentId={detail.chat?.accountManagerId}
        loading={assigning}
        onClose={() => setShowPicker(false)}
        onSelect={onAssign}
      />
    </Layout>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="btn-quiet"
      style={{ background: "transparent", border: 0, padding: "var(--s-2) var(--s-3)" }}
      aria-label="חזור"
    >
      <span className="t-eyebrow">‹ חזור</span>
    </button>
  );
}

function Logo({ url, name }: { url?: string; name: string }) {
  if (url) {
    return (
      <img
        src={url}
        alt=""
        style={{
          width: 48, height: 48,
          objectFit: "cover",
          borderRadius: "var(--r-2)",
          border: "1px solid var(--rule)",
          flexShrink: 0,
        }}
      />
    );
  }
  const initial = (name || "?").trim().charAt(0).toUpperCase();
  return (
    <div style={{
      width: 48, height: 48,
      display: "flex", alignItems: "center", justifyContent: "center",
      borderRadius: "var(--r-2)",
      background: "var(--blue)",
      color: "#fff",
      fontFamily: "var(--sans)",
      fontSize: "var(--t-lg)",
      fontWeight: 800,
      letterSpacing: "-0.02em",
      flexShrink: 0,
    }}>{initial}</div>
  );
}


function ManagerPicker({
  open, managers, currentId, loading, onClose, onSelect,
}: {
  open: boolean;
  managers: AccountManager[];
  currentId: string | undefined;
  loading: boolean;
  onClose: () => void;
  onSelect: (id: string | null) => void;
}) {
  return (
    <Modal open={open} onClose={onClose} eyebrow="שיוך" title="בחר מנהל תיק">
      {managers.length === 0 ? (
        <p className="t-meta">לא נמצאו מנהלים זמינים.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {managers.map(m => (
            <button
              key={m.id}
              onClick={() => onSelect(m.id)}
              disabled={loading}
              className="row"
              style={{
                background: currentId === m.id ? "var(--bg-tint)" : "transparent",
                width: "100%", textAlign: "right", border: 0,
                borderBottom: "1px solid var(--rule)",
              }}
            >
              <div>
                <p className="row-title">{m.name}</p>
                {m.phone && <p className="row-meta tabular" dir="ltr">{m.phone}</p>}
              </div>
              {currentId === m.id && <span className="t-eyebrow">נבחר</span>}
            </button>
          ))}
        </div>
      )}
      <div style={{ marginTop: "var(--s-5)", display: "flex", justifyContent: "space-between", gap: "var(--s-3)" }}>
        {currentId ? (
          <Button variant="danger" size="sm" onClick={() => onSelect(null)} disabled={loading}>הסר שיוך</Button>
        ) : <span />}
        <Button variant="ghost" size="sm" onClick={onClose}>סגור</Button>
      </div>
    </Modal>
  );
}
