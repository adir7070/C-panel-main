import { useEffect, useState } from "react";
import type { ClientDetail } from "../../api/client";
import { sendClientSms, updateClientNotes } from "../../api/client";
import { categoryByKey } from "../../data/categories";
import { PAGE_GOAL_OPTIONS } from "../../data/options";
import { styleById } from "../../data/styles";
import { useToast } from "../../context/ToastContext";
import { Textarea } from "../ui/Input";
import { Button } from "../ui/Button";
import { SectionHead } from "../ui/SectionHead";

interface Props {
  detail: ClientDetail;
  phone: string;
  onDetailChange: (updater: (prev: ClientDetail | null) => ClientDetail | null) => void;
}

export function OverviewTab({ detail, phone, onDetailChange }: Props) {
  const toast = useToast();
  const [smsFreeText, setSmsFreeText] = useState("");
  const [sending, setSending] = useState(false);
  const clientPhone = detail.chat?.phone ?? phone;

  const profile = (detail.profile ?? {}) as Record<string, unknown>;

  const businessName  = asString(profile.businessName);
  const businessField = asString(profile.businessField);
  const businessPhone = asString(profile.businessPhone);
  const address       = asString(profile.address);
  const email         = asString(profile.email);
  const about         = asString(profile.about);
  const promotion     = asString(profile.promotion);
  const social        = (profile.socialLinks ?? {}) as Record<string, string | undefined>;

  /* Stored values are keys (categoryKey, subCategoryKeys, pageGoal,
     designStyle) — show the Hebrew label, fall back to the raw value. */
  const categoryKey = asString(profile.categoryKey);
  const category    = categoryByKey(categoryKey);
  const subCats     = asStringArray(profile.subCategoryKeys)
    .map(k => category?.subCategories.find(sc => sc.key === k)?.label ?? k);
  const subCustom   = asString(profile.subCategoryCustom);
  if (subCustom) subCats.push(subCustom);
  const pageGoalKey = asString(profile.pageGoal);
  const pageGoal    = PAGE_GOAL_OPTIONS.find(o => o.value === pageGoalKey)?.label ?? pageGoalKey;
  const styleKey    = asString(profile.designStyle);
  const designStyle = styleById(styleKey)?.label ?? styleKey;
  const targetAud   = asStringArray(profile.targetAudience);

  return (
    <div style={{ display: "grid", gap: "var(--s-7)", minWidth: 0, maxWidth: 880 }}>

      {/* Business profile */}
      <section className="section" style={{ marginTop: 0 }}>
        <SectionHead eyebrow="Business" title="פרופיל עסקי" />
        <DefList
          rows={[
            ["שם עסק", businessName],
            ["תחום", businessField],
            ["טלפון עסק", businessPhone, "ltr"],
            ["כתובת", address],
            ["אימייל", email, "ltr"],
            ["קטגוריה", category?.label ?? categoryKey],
            ["תתי קטגוריה", subCats.length ? subCats.join(" · ") : null],
            ["קהל יעד", targetAud.length ? targetAud.join(" · ") : null],
            ["מטרת דף", pageGoal],
            ["סגנון עיצוב", designStyle],
          ]}
        />
      </section>

      {/* About */}
      {about && (
        <section className="section">
          <SectionHead eyebrow="About" title="אודות העסק" />
          <p className="t-body" style={{ whiteSpace: "pre-wrap", maxWidth: 720 }}>
            {about}
          </p>
        </section>
      )}

      {/* Promotion */}
      {promotion && (
        <section className="section">
          <SectionHead eyebrow="Offer" title="מבצע נוכחי" />
          <p className="t-body" style={{ whiteSpace: "pre-wrap", maxWidth: 720 }}>{promotion}</p>
        </section>
      )}

      {/* Notes */}
      <section className="section">
        <SectionHead eyebrow="Notes" title="הערות מנהל" />
        <NotesEditor
          phone={phone}
          initial={detail.chat?.notes ?? ""}
          onSaved={(saved) => onDetailChange(prev => prev && prev.chat ? {
            ...prev,
            chat: { ...prev.chat, notes: saved },
          } : prev)}
        />
      </section>

      {/* Social */}
      {(social.instagram || social.facebook || social.tiktok) && (
        <section className="section">
          <SectionHead eyebrow="Social" title="רשתות חברתיות" />
          <div style={{ display: "flex", gap: "var(--s-4)", flexWrap: "wrap" }}>
            {social.instagram && (
              <a href={normalizeSocial(social.instagram, "instagram")} target="_blank" rel="noreferrer">
                Instagram · {trimUrl(social.instagram)}
              </a>
            )}
            {social.facebook && (
              <a href={normalizeSocial(social.facebook, "facebook")} target="_blank" rel="noreferrer">
                Facebook · {trimUrl(social.facebook)}
              </a>
            )}
            {social.tiktok && (
              <a href={normalizeSocial(social.tiktok, "tiktok")} target="_blank" rel="noreferrer">
                TikTok · {trimUrl(social.tiktok)}
              </a>
            )}
          </div>
        </section>
      )}

      {/* SMS actions */}
      <section className="section">
        <SectionHead eyebrow="פעולות" title="שליחת SMS" />
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>

          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
            <Textarea
              value={smsFreeText}
              onChange={e => setSmsFreeText(e.target.value)}
              placeholder="כתוב הודעה חופשית..."
              rows={3}
            />
            <Button
              loading={sending}
              disabled={sending || !smsFreeText.trim()}
              onClick={async () => {
                setSending(true);
                try {
                  await sendClientSms(clientPhone, smsFreeText.trim());
                  toast.ok("SMS נשלח בהצלחה");
                  setSmsFreeText("");
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "שגיאה בשליחה");
                } finally { setSending(false); }
              }}
            >
              שלח SMS
            </Button>
          </div>

        </div>
      </section>

    </div>
  );
}

/* ── Helpers ───────────────────────────────────────────────────────── */

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter(x => typeof x === "string") as string[] : [];
}
function trimUrl(s: string) {
  return s.length > 32 ? s.slice(0, 32) + "…" : s;
}
function normalizeSocial(raw: string, platform: "instagram" | "facebook" | "tiktok"): string {
  const v = raw.trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (platform === "instagram") return `https://instagram.com/${v.replace(/^@/, "")}`;
  if (platform === "tiktok")    return `https://www.tiktok.com/@${v.replace(/^@/, "")}`;
  return `https://facebook.com/${v.replace(/^@/, "")}`;
}

type DefRow = [label: string, value?: string | null, dir?: "ltr"];

function DefList({ rows }: { rows: DefRow[] }) {
  const filtered = rows.filter(([, v]) => Boolean(v));
  if (filtered.length === 0) {
    return <p className="t-meta">אין נתונים זמינים.</p>;
  }
  return (
    <dl style={{ display: "grid", gridTemplateColumns: "180px 1fr", rowGap: 0 }}>
      {filtered.map(([label, value, dir], i) => (
        <div
          key={label + i}
          style={{
            display: "contents",
          }}
        >
          <dt className="t-eyebrow" style={{
            padding: "var(--s-4) var(--s-4) var(--s-4) 0",
            borderBottom: i < filtered.length - 1 ? "1px solid var(--rule)" : "none",
          }}>
            {label}
          </dt>
          <dd
            dir={dir}
            className="t-body tabular"
            style={{
              padding: "var(--s-4) 0",
              borderBottom: i < filtered.length - 1 ? "1px solid var(--rule)" : "none",
              color: "var(--ink)",
              wordBreak: "break-word",
              textAlign: dir === "ltr" ? "left" : "right",
            }}
          >
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Editable manager-notes block.
 *
 * Default state: read-only display + "ערוך" button.
 * Edit state:    textarea + "שמור" / "בטל" + dirty-tracking so the
 *                save button only enables when the value actually changed.
 *
 * The parent (OverviewTab) is told about the saved value via onSaved so
 * the cached ClientDetail in state stays in sync without needing to
 * re-fetch the whole detail.
 */
function NotesEditor({ phone, initial, onSaved }: {
  phone: string;
  initial: string;
  onSaved: (notes: string) => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState(initial);
  const [saving,  setSaving]  = useState(false);

  /* Re-sync draft when the parent's value changes (e.g. after a refetch
     elsewhere flips notes). Only when not actively editing — don't
     clobber the manager's typing. */
  useEffect(() => { if (!editing) setDraft(initial); }, [initial, editing]);

  const dirty = draft !== initial;

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      const r = await updateClientNotes(phone, draft);
      onSaved(r.notes);
      toast.ok("הערות נשמרו");
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה בשמירת ההערות");
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setDraft(initial);
    setEditing(false);
  }

  if (editing) {
    return (
      <div style={{ display: "grid", gap: "var(--s-3)", maxWidth: 720 }}>
        <Textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          rows={6}
          maxLength={4000}
          placeholder="העדפות, היסטוריה, קונטקסט מיוחד — הכל פה."
          autoFocus
        />
        <div style={{ display: "flex", gap: "var(--s-2)", alignItems: "center", flexWrap: "wrap" }}>
          <Button onClick={save} loading={saving} disabled={!dirty || saving}>שמור הערות</Button>
          <Button variant="ghost" onClick={cancel} disabled={saving}>בטל</Button>
          <span className="t-meta" style={{ marginInlineStart: "auto", fontSize: 11 }}>
            {draft.length} / 4000
          </span>
        </div>
      </div>
    );
  }

  /* Read-only display + edit button. */
  return (
    <div style={{ display: "grid", gap: "var(--s-3)", maxWidth: 720 }}>
      {initial ? (
        <div className="card" style={{ background: "var(--bg-tint)", padding: "var(--s-4)" }}>
          <p className="t-body" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{initial}</p>
        </div>
      ) : (
        <p className="t-meta">אין הערות פעילות על הלקוח.</p>
      )}
      <div>
        <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
          {initial ? "ערוך הערות" : "+ הוסף הערה"}
        </Button>
      </div>
    </div>
  );
}
