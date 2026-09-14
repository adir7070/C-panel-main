import { useEffect, useMemo, useState } from "react";
import { CATEGORIES, type Cat, type SubCat } from "../../data/categories";
import {
  listCustomCategories,
  addCustomCategory,
  addCustomSubCategory,
  type CustomCategoryDoc,
} from "../../api/client";
import { Modal } from "../ui/Modal";
import { Field } from "../ui/Field";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { useToast } from "../../context/ToastContext";

interface Props {
  open: boolean;
  current: string;
  currentSubs: string[];
  customSub: string;
  onChangeCategory: (key: string) => void;
  onToggleSub: (key: string) => void;
  onChangeCustomSub: (v: string) => void;
  onClose: () => void;
}

export function CategoryPicker({
  open, current, currentSubs, customSub,
  onChangeCategory, onToggleSub, onChangeCustomSub, onClose,
}: Props) {
  const toast = useToast();
  const [customDocs, setCustomDocs] = useState<CustomCategoryDoc[]>([]);
  const [loading, setLoading] = useState(false);
  const [addingCat, setAddingCat] = useState(false);
  const [newCatLabel, setNewCatLabel] = useState("");
  const [addingSub, setAddingSub] = useState(false);
  const [newSubLabel, setNewSubLabel] = useState("");
  const [busy, setBusy] = useState(false);

  /* Load on open. */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    listCustomCategories()
      .then(r => { if (!cancelled) setCustomDocs(r.categories || []); })
      .catch(() => { /* silent — built-ins still work */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  /* Merge built-in categories + custom-only categories.
     Built-in ones may have additional sub-categories appended via the
     extension docs (extendsBuiltIn=true). */
  const merged = useMemo<Cat[]>(() => {
    /* Build a lookup by parent key for the extension subs. */
    const subExt: Record<string, SubCat[]> = {};
    const customOnly: Cat[] = [];
    for (const d of customDocs) {
      const subs: SubCat[] = (d.subCategories || []).map(s => ({ key: s.key, label: s.label }));
      if (d.label && d.custom && !d.extendsBuiltIn) {
        /* Brand-new custom category — surface as a top-level item. */
        customOnly.push({ key: d.key, label: d.label, subCategories: [...subs, { key: "other_input", label: "אחר" }] });
      } else {
        /* Extension to a built-in parent. */
        subExt[d.key] = subs;
      }
    }

    const merged: Cat[] = CATEGORIES.map(c => {
      if (!subExt[c.key]?.length) return c;
      /* Insert custom subs just before the existing "אחר". */
      const otherIdx = c.subCategories.findIndex(s => s.key === "other_input");
      const head = otherIdx >= 0 ? c.subCategories.slice(0, otherIdx) : c.subCategories;
      const tail = otherIdx >= 0 ? c.subCategories.slice(otherIdx) : [];
      return { ...c, subCategories: [...head, ...subExt[c.key], ...tail] };
    });

    return [...merged, ...customOnly];
  }, [customDocs]);

  const cat = merged.find(c => c.key === current);

  async function handleAddCategory() {
    const label = newCatLabel.trim();
    if (!label) { setAddingCat(false); return; }
    setBusy(true);
    try {
      const r = await addCustomCategory(label);
      setCustomDocs(prev => {
        const without = prev.filter(d => d.key !== r.category.key);
        return [...without, r.category];
      });
      setNewCatLabel("");
      setAddingCat(false);
      onChangeCategory(r.category.key);
      toast.ok(`נוספה קטגוריה "${label}"`);
    } catch (e: any) {
      toast.error(e?.message || "שגיאה בהוספה");
    } finally { setBusy(false); }
  }

  async function handleAddSub() {
    const label = newSubLabel.trim();
    if (!label || !current) { setAddingSub(false); return; }
    setBusy(true);
    try {
      const r = await addCustomSubCategory(current, label);
      setCustomDocs(prev => {
        const without = prev.filter(d => d.key !== r.category.key);
        return [...without, r.category];
      });
      setNewSubLabel("");
      setAddingSub(false);
      /* Auto-select the just-added sub. */
      const newSub = (r.category.subCategories || []).find(s => s.label === label);
      if (newSub) onToggleSub(newSub.key);
      toast.ok(`נוספה תת-קטגוריה "${label}"`);
    } catch (e: any) {
      toast.error(e?.message || "שגיאה בהוספה");
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} eyebrow="Category" title="קטגוריה ותתי-קטגוריה" size="lg">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s-7)" }}>

        {/* ── Main category list ──────────────────────────────── */}
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--s-3)" }}>
            <p className="t-eyebrow">קטגוריה ראשית</p>
            {loading && <span className="t-meta" style={{ fontSize: 11 }}>טוען…</span>}
          </div>

          <div style={{ display: "flex", flexDirection: "column", maxHeight: 460, overflowY: "auto", border: "1px solid var(--rule)", borderRadius: "var(--r-2)" }}>
            {merged.map(c => {
              const isCustom = c.key.startsWith("custom_");
              return (
                <button
                  key={c.key}
                  onClick={() => onChangeCategory(c.key)}
                  style={{
                    textAlign: "right",
                    padding: "var(--s-3) var(--s-4)",
                    background: c.key === current ? "var(--bg-tint)" : "transparent",
                    border: 0,
                    borderBottom: "1px solid var(--rule)",
                    cursor: "pointer",
                    color: "var(--ink)",
                    fontSize: "var(--t-base)",
                    fontFamily: "var(--sans)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  <span>{c.label}</span>
                  {isCustom && <Pill>מותאם</Pill>}
                </button>
              );
            })}

            {/* Add-category row */}
            {addingCat ? (
              <div style={{ padding: "var(--s-3) var(--s-4)", display: "grid", gridTemplateColumns: "1fr auto auto", gap: "var(--s-2)", borderTop: "1px solid var(--rule)" }}>
                <Input
                  autoFocus
                  value={newCatLabel}
                  onChange={e => setNewCatLabel(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") { e.preventDefault(); handleAddCategory(); }
                    if (e.key === "Escape") { setAddingCat(false); setNewCatLabel(""); }
                  }}
                  placeholder="שם קטגוריה חדשה"
                />
                <Button size="sm" onClick={handleAddCategory} disabled={busy}>הוסף</Button>
                <Button size="sm" variant="ghost" onClick={() => { setAddingCat(false); setNewCatLabel(""); }}>בטל</Button>
              </div>
            ) : (
              <button
                onClick={() => setAddingCat(true)}
                style={{
                  textAlign: "right",
                  padding: "var(--s-3) var(--s-4)",
                  background: "transparent",
                  border: 0,
                  borderTop: "1px solid var(--rule)",
                  cursor: "pointer",
                  color: "var(--blue)",
                  fontSize: "var(--t-base)",
                  fontFamily: "var(--sans)",
                  fontWeight: 700,
                }}
              >+ הוסף קטגוריה חדשה</button>
            )}
          </div>
        </div>

        {/* ── Sub-category list ──────────────────────────────── */}
        <div>
          <p className="t-eyebrow" style={{ marginBottom: "var(--s-3)" }}>
            תתי-קטגוריה {cat ? `· ${cat.label}` : ""}
          </p>
          {!cat ? (
            <p className="t-meta">בחר תחילה קטגוריה ראשית.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)", maxHeight: 460, overflowY: "auto" }}>
              {cat.subCategories.map(s => {
                const checked = currentSubs.includes(s.key);
                const isCustom = s.key.startsWith("custom_");
                return (
                  <label key={s.key} style={{
                    display: "flex", alignItems: "center", gap: "var(--s-3)",
                    padding: "var(--s-3) var(--s-4)",
                    border: "1px solid " + (checked ? "var(--ink)" : "var(--rule)"),
                    cursor: "pointer",
                    background: checked ? "var(--bg-tint)" : "transparent",
                    borderRadius: "var(--r-1)",
                  }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggleSub(s.key)}
                    />
                    <span className="t-body" style={{ color: "var(--ink)", flex: 1 }}>{s.label}</span>
                    {isCustom && <Pill>מותאם</Pill>}
                  </label>
                );
              })}
              {currentSubs.includes("other_input") && (
                <div style={{ marginTop: "var(--s-3)" }}>
                  <Field label="פירוט תת-קטגוריה (חופשי)">
                    <Input
                      value={customSub}
                      onChange={e => onChangeCustomSub(e.target.value)}
                      placeholder="לדוגמה: סדנאות אוכל גרוזיני"
                    />
                  </Field>
                </div>
              )}

              {/* Add sub-category row */}
              {addingSub ? (
                <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: "var(--s-2)", marginTop: "var(--s-2)" }}>
                  <Input
                    autoFocus
                    value={newSubLabel}
                    onChange={e => setNewSubLabel(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") { e.preventDefault(); handleAddSub(); }
                      if (e.key === "Escape") { setAddingSub(false); setNewSubLabel(""); }
                    }}
                    placeholder="שם תת-קטגוריה חדשה"
                  />
                  <Button size="sm" onClick={handleAddSub} disabled={busy}>הוסף</Button>
                  <Button size="sm" variant="ghost" onClick={() => { setAddingSub(false); setNewSubLabel(""); }}>בטל</Button>
                </div>
              ) : (
                <button
                  onClick={() => setAddingSub(true)}
                  style={{
                    textAlign: "right",
                    padding: "var(--s-3) var(--s-4)",
                    background: "transparent",
                    border: "1px dashed var(--rule-strong)",
                    borderRadius: "var(--r-1)",
                    cursor: "pointer",
                    color: "var(--blue)",
                    fontSize: "var(--t-base)",
                    fontFamily: "var(--sans)",
                    fontWeight: 700,
                    marginTop: "var(--s-2)",
                  }}
                >+ הוסף תת-קטגוריה חדשה</button>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: 9,
      fontWeight: 800,
      padding: "2px 7px",
      background: "rgba(124,58,237,0.12)",
      color: "#7C3AED",
      borderRadius: 999,
    }}>{children}</span>
  );
}
