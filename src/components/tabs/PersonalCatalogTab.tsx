import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Spinner } from "../ui/Spinner";
import { EmptyState } from "../ui/EmptyState";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { useToast } from "../../context/ToastContext";
import { useAuth } from "../../context/AuthContext";
import {
  getPersonalCatalog,
  createPersonalPackage,
  updatePersonalPackage,
  deletePersonalPackage,
  getProducts,
  chargePersonalPackageIframe,
  confirmPersonalPayment,
  sendClientSms,
  getClientCoins,
  redeemCoinsForService,
  type PersonalPackage,
  type PersonalPackageDraft,
  type ProductItem,
  type ProductCoins,
  type CoinRedemption,
} from "../../api/client";
import { usePurchaseSync, announcePurchase } from "../../hooks/usePurchaseSync";

function formatIls(n?: number) {
  return new Intl.NumberFormat("he-IL", {
    style: "currency",
    currency: "ILS",
    maximumFractionDigits: 0,
  }).format(n || 0);
}

/* Package-aware price formatting — webinar subscription offers are priced
   in USD (currencyCode 2), everything else in ILS. */
function formatPrice(n: number | undefined, currencyCode?: number) {
  return new Intl.NumberFormat("he-IL", {
    style: "currency",
    currency: currencyCode === 2 ? "USD" : "ILS",
    maximumFractionDigits: 0,
  }).format(n || 0);
}

function emptyDraft(): PersonalPackageDraft {
  return {
    name: "חבילה מותאמת אישית",
    items: {},
    bullets: [],
    basePrice: 0,
    discountPct: 0,
    finalPrice: 0,
    coins: 0,
    notes: "",
    active: true,
  };
}

/* ── Main tab ─────────────────────────────────────────────────────────── */

export function PersonalCatalogTab({ phone }: { phone: string }) {
  const [packages, setPackages] = useState<PersonalPackage[]>([]);
  const [baseItems, setBaseItems] = useState<ProductItem[]>([]);
  const [coinPackages, setCoinPackages] = useState<ProductCoins[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    pkg: PersonalPackage | PersonalPackageDraft;
    isNew: boolean;
  } | null>(null);
  const [chargingId, setChargingId] = useState<string | null>(null);
  /* Packages with an open Cardcom window — polled until the payment lands.
     A package that a reload shows as purchased drops out on its own. */
  const [awaitingIds, setAwaitingIds] = useState<string[]>([]);
  const awaitingPkgIds = useMemo(
    () => awaitingIds.filter(id => packages.some(p => p._id === id && !p.purchased)),
    [awaitingIds, packages],
  );
  const checkPaymentRef = useRef<(() => void) | null>(null);
  const toast = useToast();
  const { agent } = useAuth();
  const maxDiscount = (agent?.name === "admin-boss" || (agent?.phone ?? "").replace(/\D/g, "").endsWith("542587070")) ? 100 : 20;

  /* Coin balance for the coin-redeem flow. Refreshed by reload()
     alongside the catalog so the banner stays in sync after a
     redemption. Independent of activePackage — works for clients
     who only have wallet coins, no active service package yet. */
  const [coinsRemaining, setCoinsRemaining] = useState<number>(0);
  const [coinRedeemOpen, setCoinRedeemOpen] = useState(false);
  const COIN_REDEEM_COST = 1000;

  /* silent: a purchase-sync refresh — keep the list (and any open package
     editor) on screen instead of swapping in the spinner. */
  const reload = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const [pkgs, catalog, balance] = await Promise.all([
        getPersonalCatalog(phone),
        getProducts(),
        getClientCoins(phone).catch(() => ({ coins: 0, coinsUsed: 0, coinsRemaining: 0 })),
      ]);
      setPackages(pkgs);
      setBaseItems(catalog.items ?? []);
      setCoinPackages((catalog.coins ?? []).filter((c) => c.active !== false));
      setCoinsRemaining(balance.coinsRemaining || 0);
      setError(null);
    } catch (e) {
      if (!opts?.silent) setError(e instanceof Error ? e.message : "שגיאה בטעינה");
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [phone]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function handleSave(draft: PersonalPackageDraft, id?: string) {
    try {
      if (id) {
        await updatePersonalPackage(phone, id, draft);
        toast.ok("החבילה עודכנה");
      } else {
        await createPersonalPackage(phone, draft);
        toast.ok("החבילה נוצרה");
      }
      setEditing(null);
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "שמירה נכשלה");
    }
  }

  async function handleDelete(pkg: PersonalPackage) {
    if (!window.confirm(`למחוק את "${pkg.name}"?`)) return;
    try {
      await deletePersonalPackage(phone, pkg._id);
      toast.ok("החבילה נמחקה");
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "מחיקה נכשלה");
    }
  }

  async function handleViewContract(pkg: PersonalPackage) {
    try {
      const token = localStorage.getItem("cpanel_token");
      const base = (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api";
      const res = await fetch(`${base}/packages/contract-html`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ phone, personalPackageId: pkg._id }),
      });
      const html = await res.text();
      const win = window.open("", "_blank");
      if (win) {
        win.document.open();
        win.document.write(html);
        win.document.close();
      }
    } catch {
      toast.error("לא ניתן לטעון את ההסכם");
    }
  }

  async function handleSendContractSms(pkg: PersonalPackage) {
    /* Same-origin URL so the customer's phone never has to resolve the
       backend domain directly — the C-panel Express proxy forwards
       /api/* to the API server. Works on any client network regardless
       of split-DNS / corporate VPN quirks. */
    const contractUrl = `${window.location.origin}/api/packages/contract-view?phone=${encodeURIComponent(phone)}&pkgId=${encodeURIComponent(pkg._id)}`;
    const message =
      `שלום! 👋\n` +
      `הסכם השירות עבור "${pkg.name}" מוכן לחתימה.\n` +
      `לחצו על הקישור כדי לעיין ולחתום:\n${contractUrl}`;
    if (!window.confirm(`לשלוח SMS עם קישור לחתימה ל-${phone}?\n\n${message}`)) return;
    try {
      const r = await sendClientSms(phone, message);
      if (r.sentCount > 0) toast.ok("ה-SMS נשלח ✓");
      else toast.error("שליחת ה-SMS נכשלה");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "שליחת ה-SMS נכשלה");
    }
  }

  async function handleCharge(pkg: PersonalPackage) {
    if (chargingId) return;
    setChargingId(pkg._id);
    try {
      const { url } = await chargePersonalPackageIframe(phone, pkg._id);
      window.open(url, "_blank", "width=820,height=660,noopener");
      toast.warn("חלון התשלום נפתח — לאחר השלמת התשלום הרשימה תתרענן אוטומטית");

      setAwaitingIds(ids => ids.includes(pkg._id) ? ids : [...ids, pkg._id]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "שגיאה ביצירת קישור תשלום");
    } finally {
      setChargingId(null);
    }
  }

  /* Stay in step with payments confirmed anywhere — another window, the
     webhook, another manager. */
  const reloadRef = useRef(reload);
  const toastRef = useRef(toast);
  useEffect(() => { reloadRef.current = reload; toastRef.current = toast; });
  usePurchaseSync(ev => {
    if (ev.phone && ev.phone !== phone) return;
    reloadRef.current({ silent: true });
  });

  /* While Cardcom windows are open, ask the server to check their payment
     pages — Cardcom's webhook can't reach a local or firewalled server. */
  const awaitingKey = awaitingPkgIds.join(",");
  useEffect(() => {
    const ids = awaitingKey ? awaitingKey.split(",") : [];
    if (ids.length === 0) return;
    let done = false;
    let running = false;
    const startedAt = Date.now();
    const check = async () => {
      if (done || running) return;
      if (Date.now() - startedAt > 20 * 60_000) { done = true; setAwaitingIds([]); return; }
      running = true;
      try {
        for (const id of ids) {
          try {
            const r = await confirmPersonalPayment(phone, id);
            if (done || r.status !== "paid") continue;
            setAwaitingIds(list => list.filter(x => x !== id));
            // applied by another check (webhook / page-level) → that one announced it
            if (!r.already) {
              toastRef.current.ok("התשלום התקבל — החבילה הופעלה");
              announcePurchase({ phone });
            }
            reloadRef.current({ silent: true });
          } catch { /* transient — the next tick retries */ }
        }
      } finally {
        running = false;
      }
    };
    checkPaymentRef.current = check;
    const timer = window.setInterval(check, 8000);
    window.addEventListener("focus", check);
    return () => {
      done = true;
      checkPaymentRef.current = null;
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [awaitingKey, phone]);

  if (loading) return <Spinner label='טוען קטלוג אישי' />;
  if (error)
    return (
      <EmptyState
        title='שגיאה'
        meta={error}
      />
    );

  return (
    <div style={{ display: "grid", gap: "var(--s-4)" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}>
        <div>
          <h3 className='t-section'>קטלוג אישי</h3>
          <p
            className='t-meta'
            style={{ fontSize: 11, marginTop: 2 }}>
            חבילות מותאמות ללקוח זה — גלויות לו באפליקציה לרכישה
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {coinsRemaining >= COIN_REDEEM_COST && (
            <Button
              size='sm'
              onClick={() => setCoinRedeemOpen(true)}
              style={{ background: "#eab308", color: "#0f172a", border: "none", fontWeight: 700 }}
              title={`יתרת מטבעות: ${coinsRemaining.toLocaleString("he-IL")}`}
            >
              🪙 מימוש מטבעות
            </Button>
          )}
          {packages.length > 0 && (
            <Button
              size='sm'
              onClick={() => setEditing({ pkg: emptyDraft(), isNew: true })}>
              + חבילה חדשה
            </Button>
          )}
        </div>
      </div>

      {/* Yellow info banner — only when client has enough balance to
          cover at least one service. Sits above the package list. */}
      {coinsRemaining >= COIN_REDEEM_COST && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "var(--s-3) var(--s-4)",
          margin: "var(--s-3) 0",
          background: "linear-gradient(135deg, rgba(234,179,8,0.10) 0%, rgba(234,179,8,0.03) 100%)",
          border: "1px solid rgba(234,179,8,0.30)",
          borderRadius: "var(--r-3)",
          gap: "var(--s-3)", flexWrap: "wrap",
        }}>
          <div>
            <div style={{ fontSize: "var(--t-sm)", fontWeight: 800, color: "var(--ink)" }}>
              🪙 ללקוח יש {coinsRemaining.toLocaleString("he-IL")} מטבעות
            </div>
            <div style={{ fontSize: "var(--t-xs)", color: "var(--ink-2)", marginTop: 2 }}>
              ניתן לממש {COIN_REDEEM_COST.toLocaleString("he-IL")} מטבעות לכל אחד מ: קמפיין לידים / קמפיין תנועה / חבילת סושיאל — בלי לרכוש חבילה חדשה
            </div>
          </div>
        </div>
      )}


      {packages.length === 0 ? (
        <EmptyState
          title='אין חבילות אישיות'
          meta="לחץ על '+ חבילה חדשה' כדי ליצור את הראשונה"
          action={
            <Button
              size='sm'
              onClick={() => setEditing({ pkg: emptyDraft(), isNew: true })}>
              + חבילה חדשה
            </Button>
          }
        />
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {awaitingPkgIds.length > 0 && (
            <div className='card' style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <span className='t-meta' style={{ flex: 1, minWidth: 200 }}>
                ממתין לאישור התשלום מ-Cardcom — המסך יתעדכן אוטומטית כשהתשלום יעבור
              </span>
              <Button size='sm' variant='ghost' onClick={() => checkPaymentRef.current?.()}>בדוק עכשיו</Button>
              <Button size='sm' variant='ghost' onClick={() => setAwaitingIds([])}>הפסק להמתין</Button>
            </div>
          )}
          {packages.map((pkg) => (
            <PackageCard
              key={pkg._id}
              pkg={pkg}
              baseItems={baseItems}
              coinPackages={coinPackages}
              charging={chargingId === pkg._id}
              onEdit={() => setEditing({ pkg, isNew: false })}
              onDelete={() => handleDelete(pkg)}
              onViewContract={() => handleViewContract(pkg)}
              onSendContractSms={() => handleSendContractSms(pkg)}
              onCharge={() => handleCharge(pkg)}
            />
          ))}
        </div>
      )}

      {editing && (
        <PackageEditModal
          pkg={editing.pkg}
          isNew={editing.isNew}
          baseItems={baseItems}
          coinPackages={coinPackages}
          maxDiscount={maxDiscount}
          onClose={() => setEditing(null)}
          onSave={(draft) => {
            const id =
              !editing.isNew && "_id" in editing.pkg
                ? (editing.pkg as PersonalPackage)._id
                : undefined;
            handleSave(draft, id);
          }}
        />
      )}

      {coinRedeemOpen && (
        <CoinRedeemModal
          phone={phone}
          coinsRemaining={coinsRemaining}
          cost={COIN_REDEEM_COST}
          onClose={() => setCoinRedeemOpen(false)}
          onSuccess={() => { setCoinRedeemOpen(false); reload(); }}
        />
      )}
    </div>
  );
}

/* ── Package card ─────────────────────────────────────────────────────── */

function PackageCard({
  pkg,
  baseItems,
  coinPackages,
  charging,
  onEdit,
  onDelete,
  onViewContract,
  onSendContractSms,
  onCharge,
}: {
  pkg: PersonalPackage;
  baseItems: ProductItem[];
  coinPackages: ProductCoins[];
  charging: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onViewContract: () => void;
  onSendContractSms: () => void;
  onCharge: () => void;
}) {
  const itemSummary =
    baseItems
      .filter((bi) => (pkg.items[bi.key] || 0) > 0)
      .map((bi) => bi.label)
      .join(" · ") || "—";

  const coinPkg = coinPackages.find((c) => c.coins === pkg.coins);

  return (
    <div
      className='card'
      style={{
        padding: "12px 16px",
        display: "grid",
        gridTemplateColumns: "1fr auto",
        alignItems: "center",
        gap: 12,
        opacity: pkg.purchased ? 0.65 : 1,
        borderRight: pkg.purchased
          ? "3px solid var(--positive)"
          : "3px solid var(--blue)",
      }}>
      <div>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            flexWrap: "wrap",
          }}>
          <strong style={{ fontSize: 14 }}>{pkg.name || "—"}</strong>
          {pkg.purchased && (
            <span
              style={{
                fontSize: 10,
                padding: "1px 8px",
                borderRadius: 99,
                background: "var(--positive)",
                color: "#fff",
                fontWeight: 700,
              }}>
              נרכשה
            </span>
          )}
          {(pkg.discountPct ?? 0) > 0 && !pkg.purchased && (
            <span style={{ fontSize: 10, color: "var(--positive)" }}>
              {pkg.discountPct}% הנחה
            </span>
          )}
        </div>
        <p
          className='t-meta'
          style={{ fontSize: 11, marginTop: 3 }}>
          {itemSummary}
        </p>
        <div
          style={{
            display: "flex",
            gap: 12,
            marginTop: 4,
            alignItems: "baseline",
          }}>
          <span
            className='num'
            dir='ltr'
            style={{ fontSize: 13, fontWeight: 700 }}>
            {formatPrice(pkg.finalPrice, pkg.currencyCode)}
          </span>
          {pkg.isSubscription && (
            <span
              className='t-meta'
              style={{ fontSize: 11, color: "var(--blue)" }}>
              {pkg.billingCycle === "yearly"
                ? `מנוי שנתי · ${formatPrice(pkg.monthlyPrice ?? Math.round(pkg.finalPrice / 12), pkg.currencyCode)} לחודש · ללא מע"מ`
                : 'מנוי חודשי מתחדש · ללא מע"מ'}
            </span>
          )}
          {pkg.isSubscription && pkg.introEnabled && (pkg.introPrice || 0) > 0 && (
            <span style={{ fontSize: 11, fontWeight: 700, color: "#b45309" }}>
              🎉 חודש ראשון {formatPrice(pkg.introPrice || 0, pkg.currencyCode)} · אח״כ {formatPrice(pkg.finalPrice, pkg.currencyCode)}/חודש
            </span>
          )}
          {!pkg.isSubscription && pkg.priceIncludesVat && (
            <span
              className='t-meta'
              style={{ fontSize: 11, color: "var(--blue)" }}>
              כולל מע"מ
            </span>
          )}
          {(pkg.discountPct ?? 0) > 0 && (
            <span
              className='t-meta'
              style={{ fontSize: 11, textDecoration: "line-through" }}>
              {formatPrice(pkg.basePrice, pkg.currencyCode)}
            </span>
          )}
          {(pkg.coins ?? 0) > 0 && (
            <span
              className='t-meta'
              style={{ fontSize: 11 }}>
              ·{" "}
              {coinPkg ? coinPkg.name : `${pkg.coins.toLocaleString()} מטבעות`}
            </span>
          )}
          {pkg.contractCoinPackage && (
            <span
              className='t-meta'
              style={{ fontSize: 11, color: "#b45309" }}>
              · 🪙 {pkg.contractCoinPackage.coins.toLocaleString()} מטבעות (נרכשו מתוך ההסכם)
            </span>
          )}
        </div>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <Button
          variant='ghost'
          size='sm'
          onClick={onViewContract}>
          הצג הסכם
        </Button>
        {!pkg.purchased && (
          <>
            <Button
              variant='ghost'
              size='sm'
              onClick={onSendContractSms}
              title='שולח SMS עם קישור לחתימה ללקוח'>
              📱 שלח לחתימה
            </Button>
            {/* subscription offers are USD-priced by the server — the edit
                modal would recompute their price from ILS catalog items */}
            {!pkg.isSubscription && (
              <Button
                variant='ghost'
                size='sm'
                onClick={onEdit}>
                ערוך
              </Button>
            )}
            <Button
              variant='ghost'
              size='sm'
              onClick={onDelete}>
              מחק
            </Button>
            <Button
              size='sm'
              disabled={charging}
              onClick={onCharge}
              style={{
                background: "linear-gradient(135deg,#16a34a 0%,#15803d 100%)",
                color: "#fff",
                border: "none",
                opacity: charging ? 0.6 : 1,
              }}>
              {charging ? "…" : "חייב"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Edit modal ───────────────────────────────────────────────────────── */

function PackageEditModal({
  pkg,
  isNew,
  baseItems,
  coinPackages,
  maxDiscount = 20,
  onClose,
  onSave,
}: {
  pkg: PersonalPackage | PersonalPackageDraft;
  isNew: boolean;
  baseItems: ProductItem[];
  coinPackages: ProductCoins[];
  maxDiscount?: number;
  onClose: () => void;
  onSave: (draft: PersonalPackageDraft) => void;
}) {
  const [draft, setDraft] = useState<PersonalPackageDraft>(() => {
    const { name, items, discountPct, coins, notes, active, bullets } =
      pkg as PersonalPackage & PersonalPackageDraft;
    return {
      name: name || "",
      items: { ...(items || {}) },
      basePrice: (pkg as PersonalPackage).basePrice || 0,
      discountPct: discountPct || 0,
      finalPrice: (pkg as PersonalPackage).finalPrice || 0,
      coins: coins || 0,
      notes: notes || "",
      active: active !== false,
      bullets: bullets || [],
    };
  });
  const [busy, setBusy] = useState(false);

  function patch<K extends keyof PersonalPackageDraft>(
    k: K,
    v: PersonalPackageDraft[K],
  ) {
    setDraft((d) => ({ ...d, [k]: v }));
  }

  const selectedCoinPkg =
    coinPackages.find((cp) => cp.coins === draft.coins) ?? null;

  const computedBase = useMemo(() => {
    const itemsTotal = baseItems.reduce(
      (s, bi) => s + (draft.items[bi.key] || 0) * (bi.unitPrice || 0),
      0,
    );
    const coinsPrice =
      coinPackages.find((cp) => cp.coins === draft.coins)?.price ?? 0;
    return itemsTotal + coinsPrice;
  }, [baseItems, draft.items, draft.coins, coinPackages]);

  const itemsTotal = useMemo(
    () =>
      baseItems.reduce(
        (s, bi) => s + (draft.items[bi.key] || 0) * (bi.unitPrice || 0),
        0,
      ),
    [baseItems, draft.items],
  );

  useEffect(() => {
    const final = Math.round(
      computedBase * (1 - (draft.discountPct || 0) / 100),
    );
    setDraft((d) => ({ ...d, basePrice: computedBase, finalPrice: final }));
  }, [computedBase, draft.discountPct]);

  async function submit() {
    if (!draft.name.trim()) return;
    setBusy(true);
    try {
      const bullets = baseItems
        .filter(bi => (draft.items[bi.key] || 0) > 0)
        .map(bi => [bi.emoji, bi.label].filter(Boolean).join(" "));
      onSave({ ...draft, bullets });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={isNew ? "חבילה אישית חדשה" : `עריכה · ${draft.name || "חבילה"}`}>
      <div
        style={{
          display: "grid",
          gap: 14,
          padding: "var(--s-5)",
        }}>
        <Field label='שם החבילה'>
          <input
            type='text'
            value={draft.name}
            onChange={(e) => patch("name", e.target.value)}
            style={inputStyle}
            placeholder='למשל "חבילת הפתעה לדנה"'
          />
        </Field>

        <Field
          label='פריטים בחבילה'
          hint='סמן את הפריטים שכלולים — המחיר מחושב אוטומטית'>
          {baseItems.length === 0 ? (
            <p
              className='t-meta'
              style={{ fontSize: 11 }}>
              לא נמצאו פריטי בסיס
            </p>
          ) : (
            <div style={{ display: "grid", gap: 4 }}>
              {baseItems.map((bi) => {
                const qty    = draft.items[bi.key] || 0;
                const active = qty > 0;
                const setQty = (n: number) => patch("items", { ...draft.items, [bi.key]: Math.max(0, n) });
                return (
                  <div
                    key={bi.key}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      background: active ? "var(--blue-tint, #EBF3FF)" : "var(--bg-tint)",
                      borderRadius: 6,
                      padding: "8px 12px",
                      border: `1px solid ${active ? "var(--blue)" : "transparent"}`,
                      transition: "background .12s, border-color .12s",
                    }}>
                    {/* checkbox — תמיד מוצג */}
                    <input
                      type='checkbox'
                      checked={active}
                      onChange={(e) => setQty(e.target.checked ? 1 : 0)}
                      style={{ width: 16, height: 16, accentColor: "var(--blue)", cursor: "pointer", flexShrink: 0 }}
                    />
                    {/* emoji + label */}
                    <span style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 5, flex: 1 }}>
                      {bi.emoji && <span style={{ fontSize: 15 }}>{bi.emoji}</span>}
                      {bi.label}
                    </span>
                    {/* מחיר */}
                    <span className='t-meta' style={{ fontSize: 11, minWidth: 52, textAlign: "left" }} dir='ltr'>
                      {active && !bi.isPermission
                        ? formatIls(qty * (bi.unitPrice || 0))
                        : formatIls(bi.unitPrice)}
                    </span>
                    {/* counter — רק לפריטים רגילים */}
                    {!bi.isPermission && (
                      <div style={{ display: "flex", alignItems: "center", gap: 0, flexShrink: 0 }}>
                        <button
                          type='button'
                          disabled={!active}
                          onClick={() => setQty(qty - 1)}
                          style={qtyBtnStyle(active)}>
                          −
                        </button>
                        <span style={{
                          minWidth: 28,
                          textAlign: "center",
                          fontSize: 13,
                          fontWeight: 600,
                          color: active ? "var(--ink)" : "var(--ink-3)",
                          borderTop: "1px solid var(--rule)",
                          borderBottom: "1px solid var(--rule)",
                          padding: "0 2px",
                          lineHeight: "26px",
                        }}>
                          {qty}
                        </span>
                        <button
                          type='button'
                          onClick={() => setQty(active ? qty + 1 : 1)}
                          style={qtyBtnStyle(true)}>
                          +
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Field>

        <Field
          label='חבילת מטבעות (אופציונלי)'
          hint={
            selectedCoinPkg
              ? `${formatIls(selectedCoinPkg.price)} יתווספו לסכום הבסיס · הלקוח יקבל ${selectedCoinPkg.coins.toLocaleString()} מטבעות`
              : "אופציונלי — מחיר החבילה ייכלל במחיר הסופי"
          }>
          <select
            value={draft.coins || 0}
            onChange={(e) => patch("coins", Number(e.target.value))}
            style={{ ...inputStyle, cursor: "pointer" }}>
            <option value={0}>ללא מטבעות</option>
            {coinPackages.map((cp) => (
              <option
                key={cp._id}
                value={cp.coins}>
                {cp.name} — {cp.coins.toLocaleString()} מטבעות (
                {formatIls(cp.price)})
              </option>
            ))}
          </select>
        </Field>

        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field
            label={`הנחה (עד ${maxDiscount}%)`}
            hint='על הסכום הכולל (פריטים + מטבעות)'>
            <input
              type='number'
              min={0}
              max={maxDiscount}
              value={draft.discountPct || 0}
              onChange={(e) =>
                patch(
                  "discountPct",
                  Math.min(maxDiscount, Math.max(0, Number(e.target.value))),
                )
              }
              style={inputStyle}
            />
          </Field>
          <Field
            label='מחיר סופי ללקוח (₪)'
            hint={
              computedBase > 0
                ? [
                    itemsTotal > 0 ? `פריטים: ${formatIls(itemsTotal)}` : null,
                    selectedCoinPkg
                      ? `מטבעות: ${formatIls(selectedCoinPkg.price)}`
                      : null,
                    `סה"כ לפני הנחה: ${formatIls(computedBase)}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : "בחר פריטים לחישוב"
            }>
            <div
              style={{
                ...inputStyle,
                background: "var(--bg-tint)",
                fontWeight: 700,
                fontSize: 15,
                display: "flex",
                alignItems: "center",
              }}>
              {formatIls(draft.finalPrice)}
            </div>
          </Field>
        </div>

        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label='פעיל (גלוי ללקוח)'>
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                marginTop: 6,
                cursor: "pointer",
              }}>
              <input
                type='checkbox'
                checked={draft.active !== false}
                onChange={(e) => patch("active", e.target.checked)}
              />
              <span style={{ fontSize: 12 }}>
                {draft.active !== false ? "גלוי" : "מוסתר"}
              </span>
            </label>
          </Field>
        </div>

        <Field label='הערות פנימיות (לא גלוי ללקוח)'>
          <textarea
            value={draft.notes || ""}
            onChange={(e) => patch("notes", e.target.value)}
            rows={3}
            style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical" }}
          />
        </Field>

        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            paddingTop: 8,
            borderTop: "1px solid var(--rule)",
          }}>
          <Button
            onClick={onClose}
            variant='ghost'>
            ביטול
          </Button>
          <Button
            onClick={submit}
            disabled={busy || !draft.name.trim() || draft.finalPrice === 0}>
            {busy ? "שומר…" : isNew ? "צור חבילה" : "שמור"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        style={{
          display: "block",
          fontSize: 11,
          fontWeight: 700,
          color: "var(--ink-2)",
          marginBottom: 4,
        }}>
        {label}
      </label>
      {children}
      {hint && (
        <div
          className='t-meta'
          style={{ fontSize: 10, marginTop: 3 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid var(--rule)",
  background: "var(--paper)",
  fontSize: 13,
  color: "var(--ink)",
};

function qtyBtnStyle(enabled: boolean): React.CSSProperties {
  return {
    width: 26,
    height: 28,
    border: "1px solid var(--rule)",
    background: enabled ? "var(--paper)" : "var(--bg-tint)",
    color: enabled ? "var(--ink)" : "var(--ink-3)",
    fontSize: 15,
    lineHeight: 1,
    cursor: enabled ? "pointer" : "default",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 0,
    padding: 0,
    userSelect: "none",
  };
}

/* ── Coin-redeem modal ─────────────────────────────────────────────
   Spend 1000 coins from the client's existing balance on a
   campaign/social slot tied to existing approved ads. Doesn't sell a
   new package — adds a record to activePackage.coinRedemptions and a
   green 'הקמת קמפיין' card appears at the top of the catalog. */
const REDEEMABLE_SERVICES: { value: CoinRedemption["service"]; label: string }[] = [
  { value: "campaign_leads",   label: "📣 קמפיין לידים" },
  { value: "campaign_traffic", label: "📣 קמפיין תנועה לאתר" },
  { value: "social_ad_10",     label: "✨ חבילת סושיאל (10 מודעות)" },
];

function CoinRedeemModal({ phone, coinsRemaining, cost, onClose, onSuccess }: {
  phone:          string;
  coinsRemaining: number;
  cost:           number;
  onClose:        () => void;
  onSuccess:      () => void;
}) {
  const toast = useToast();
  const [service, setService]   = useState<CoinRedemption["service"]>("campaign_leads");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    try {
      const r = await redeemCoinsForService(phone, service);
      toast.ok(`חויב ${r.cost} מטבעות — יתרה ${r.coinsRemaining.toLocaleString("he-IL")}. הסקציה החדשה זמינה בטאב 'מוצרים'.`);
      onSuccess();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "שגיאה";
      if (msg.includes("INSUFFICIENT_COINS")) toast.error("אין מספיק מטבעות");
      else toast.error(msg);
    } finally { setSubmitting(false); }
  }

  const selectedLabel = REDEEMABLE_SERVICES.find(s => s.value === service)?.label || service;

  return (
    <Modal open onClose={onClose} title="🪙 מימוש מטבעות לשירות">
      <div style={{ display: "grid", gap: "var(--s-4)", padding: "var(--s-3)" }}>
        <p style={{ margin: 0, fontSize: "var(--t-sm)", color: "var(--ink-3)", lineHeight: 1.5 }}>
          יתרה: <strong>{coinsRemaining.toLocaleString("he-IL")}</strong> מטבעות · עלות: <strong>{cost.toLocaleString("he-IL")}</strong> מטבעות. אחרי המימוש תופיע סקציה חדשה בטאב <strong>מוצרים</strong> שבה תוכל לייצר מודעות לקמפיין.
        </p>

        <label style={{ display: "grid", gap: 4, fontSize: "var(--t-sm)" }}>
          <span style={{ color: "var(--ink-2)" }}>שירות לרכישה</span>
          <select
            value={service}
            onChange={e => setService(e.target.value as CoinRedemption["service"])}
            style={{ padding: "var(--s-2) var(--s-3)", border: "1px solid var(--rule)", borderRadius: "var(--r-2)", fontSize: "var(--t-sm)", background: "var(--surface)" }}
          >
            {REDEEMABLE_SERVICES.map(s => (
              <option key={s.value} value={s.value}>{s.label} — {cost.toLocaleString("he-IL")} מטבעות</option>
            ))}
          </select>
        </label>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--s-2)", marginTop: "var(--s-2)" }}>
          <Button variant="ghost" onClick={onClose}>ביטול</Button>
          <Button
            onClick={submit}
            loading={submitting}
            disabled={coinsRemaining < cost}
            style={{ background: "#eab308", color: "#0f172a", border: "none", fontWeight: 700 }}
          >
            חיוב {cost.toLocaleString("he-IL")} מטבעות עבור {selectedLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
