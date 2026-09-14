import { useCallback, useEffect, useMemo, useState } from "react";
import { Layout } from "../../components/shell/Layout";
import { Header } from "../../components/shell/Header";
import { Spinner } from "../../components/ui/Spinner";
import { EmptyState } from "../../components/ui/EmptyState";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { useToast } from "../../context/ToastContext";
import {
  listAdminAgents,
  createAdminAgent,
  updateAdminAgent,
  forceLogoutAgent,
  uploadAdminAgentAvatar,
  type AgentRow,
  type AgentRole,
} from "../../api/admin";

const ROLE_LABEL: Record<AgentRole, string> = {
  admin:           "אדמין",
  supervisor:      "אחראי צוות",
  account_manager: "מנהל תיקים",
  finance:         "פיננסים",
};

const ROLE_COLOR: Record<AgentRole, string> = {
  admin:           "#E53935",
  supervisor:      "#7C3AED",
  account_manager: "var(--blue)",
  finance:         "#2E7D32",
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days === 0) return "היום";
  if (days === 1) return "אתמול";
  if (days < 7)   return `לפני ${days} ימים`;
  return d.toLocaleDateString("he-IL");
}

export function AdminUsersPage() {
  const [agents, setAgents]   = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [search, setSearch]   = useState("");
  const [roleFilter, setRoleFilter] = useState<"" | AgentRole>("");
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<{ agent: AgentRow | null; isNew: boolean } | null>(null);
  const toast = useToast();

  const reload = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await listAdminAgents();
      setAgents(r.agents);
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return agents.filter(a => {
      if (!showInactive && !a.active)              return false;
      if (roleFilter && a.role !== roleFilter)    return false;
      if (q) {
        const hay = `${a.name || ""} ${a.nickname || ""} ${a.email || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [agents, search, roleFilter, showInactive]);

  async function handleToggleActive(a: AgentRow) {
    const action = a.active ? "נטרל" : "הפעל";
    const ok = window.confirm(`${action} את החשבון של ${a.nickname || a.name}?\n\nהפעולה תיכתב ל-audit log.`);
    if (!ok) return;
    try {
      await updateAdminAgent(a.id, { active: !a.active });
      toast.ok(`חשבון ${a.active ? "נוטרל" : "הופעל"}`);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה");
    }
  }

  async function handleForceLogout(a: AgentRow) {
    const reason = window.prompt(`לנתק את ${a.nickname || a.name} מהמערכת?\nציין סיבה (תיכתב ל-audit log):`, "");
    if (reason === null) return;
    try {
      await forceLogoutAgent(a.id, reason || undefined);
      toast.ok("הסשן נותק");
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה");
    }
  }

  return (
    <Layout
      header={
        <Header
          eyebrow="ניהול ראשי"
          title="ניהול משתמשים"
          meta={`${visible.length} מתוך ${agents.length} משתמשים`}
        />
      }
    >
      {loading && <Spinner label="טוען משתמשים" />}
      {error   && <EmptyState title="שגיאה" meta={error} />}

      {!loading && !error && (
        <>
          {/* Filter bar */}
          <section className="section" style={{ marginTop: 0 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="חיפוש: שם / אימייל / כינוי…"
                style={{
                  flex: 1, minWidth: 240,
                  padding: "8px 12px", borderRadius: 8,
                  border: "1px solid var(--rule)", background: "var(--paper)",
                  fontSize: 13,
                }}
              />
              <select
                value={roleFilter}
                onChange={e => setRoleFilter(e.target.value as "" | AgentRole)}
                style={{
                  padding: "8px 12px", borderRadius: 8,
                  border: "1px solid var(--rule)", background: "var(--paper)",
                  fontSize: 12, cursor: "pointer",
                }}
              >
                <option value="">כל התפקידים</option>
                {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ink-2)", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={showInactive}
                  onChange={e => setShowInactive(e.target.checked)}
                />
                הצג מנוטרלים
              </label>
              <Button onClick={() => setEditing({ agent: null, isNew: true })} size="sm">
                + הוסף משתמש
              </Button>
            </div>
          </section>

          {/* Table */}
          <section className="section" style={{ marginTop: "var(--s-4)" }}>
            <div className="card" style={{ padding: 0, borderTop: "3px solid #E53935", overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 1000 }}>
                <thead>
                  <tr style={{ background: "var(--bg-tint)" }}>
                    <Th>שם משתמש</Th>
                    <Th>כינוי</Th>
                    <Th>תפקיד</Th>
                    <Th>אימייל</Th>
                    <Th>פעילות אחרונה</Th>
                    <Th>נוצר</Th>
                    <Th>סטטוס</Th>
                    <Th>פעולות</Th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(a => (
                    <tr key={a.id} style={{
                      borderTop: "1px solid var(--rule)",
                      opacity: a.active ? 1 : 0.55,
                    }}>
                      <Td>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          {a.avatarUrl ? (
                            <img
                              src={a.avatarUrl}
                              alt=""
                              style={{
                                width: 28, height: 28, borderRadius: 99,
                                objectFit: "cover", border: `1px solid ${ROLE_COLOR[a.role]}33`,
                              }}
                            />
                          ) : (
                            <span style={{
                              width: 28, height: 28, borderRadius: 99,
                              background: ROLE_COLOR[a.role] + "33",
                              color: ROLE_COLOR[a.role],
                              display: "inline-flex", alignItems: "center", justifyContent: "center",
                              fontSize: 12, fontWeight: 800,
                            }}>{(a.nickname || a.name || "?").charAt(0).toUpperCase()}</span>
                          )}
                          <span dir="ltr" style={{ fontWeight: 600 }}>{a.name || "—"}</span>
                        </div>
                      </Td>
                      <Td><span style={{ fontSize: 12 }}>{a.nickname || "—"}</span></Td>
                      <Td>
                        <span style={{
                          padding: "2px 8px", borderRadius: 99,
                          background: ROLE_COLOR[a.role] + "1a",
                          color: ROLE_COLOR[a.role],
                          fontSize: 11, fontWeight: 700,
                        }}>{ROLE_LABEL[a.role]}</span>
                      </Td>
                      <Td><span dir="ltr" style={{ fontSize: 11, color: "var(--ink-2)" }}>{a.email || "—"}</span></Td>
                      <Td><span style={{ fontSize: 11, color: "var(--ink-3)" }}>{relativeTime(a.lastActiveAt || a.lastLogin)}</span></Td>
                      <Td><span style={{ fontSize: 11, color: "var(--ink-3)" }}>{formatDate(a.createdAt)}</span></Td>
                      <Td>
                        {a.active
                          ? <Badge variant="positive">פעיל</Badge>
                          : <Badge>מנוטרל</Badge>}
                      </Td>
                      <Td>
                        <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                          <button onClick={() => setEditing({ agent: a, isNew: false })} style={miniBtn}>ערוך</button>
                          <button onClick={() => handleForceLogout(a)} style={miniBtn} disabled={!a.active}>נתק</button>
                          <button
                            onClick={() => handleToggleActive(a)}
                            style={{ ...miniBtn, color: a.active ? "var(--negative)" : "var(--positive)" }}
                          >
                            {a.active ? "נטרל" : "הפעל"}
                          </button>
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {visible.length === 0 && (
                <div style={{ padding: 40, textAlign: "center", color: "var(--ink-3)" }}>אין תוצאות</div>
              )}
            </div>
          </section>

          <p className="t-meta" style={{ marginTop: "var(--s-4)", textAlign: "center", fontSize: 11 }}>
            💡 כל פעולה (יצירה, עריכה, נטרול, ניתוק) נכתבת ל-<a href="/admin/audit" style={{ color: "var(--blue)" }}>יומן ביקורת</a>.
          </p>
        </>
      )}

      {editing && (
        <AgentEditModal
          agent={editing.agent}
          isNew={editing.isNew}
          onClose={() => setEditing(null)}
          onComplete={() => { setEditing(null); reload(); }}
        />
      )}
    </Layout>
  );
}

function AgentEditModal({
  agent, isNew, onClose, onComplete,
}: {
  agent: AgentRow | null;
  isNew: boolean;
  onClose: () => void;
  onComplete: () => void;
}) {
  const [name,     setName]     = useState(agent?.name     || "");
  const [nickname, setNickname] = useState(agent?.nickname || "");
  const [email,    setEmail]    = useState(agent?.email    || "");
  const [phone,    setPhone]    = useState(agent?.phone    || "");
  const [role,     setRole]     = useState<AgentRole>(agent?.role || "account_manager");
  const [bio,      setBio]      = useState(agent?.bio      || "");
  const [password, setPassword] = useState("");
  const [busy, setBusy]         = useState(false);
  /* Avatar is its own micro-flow: upload happens immediately on file
     selection (no batching with the rest of the form save) so admins
     can see the new image right away. We keep the latest URL in local
     state so the preview updates without a parent reload. */
  const [avatarUrl, setAvatarUrl] = useState<string | null>(agent?.avatarUrl || null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const toast = useToast();

  async function onPickAvatar(file: File) {
    if (!agent?.id) {
      toast.warn("שמור את המשתמש קודם, ואז העלה תמונה");
      return;
    }
    if (file.size > 5 * 1024 * 1024) { toast.error("הקובץ גדול מדי (מקסימום 5MB)"); return; }
    setAvatarBusy(true);
    try {
      const r = await uploadAdminAgentAvatar(agent.id, file);
      setAvatarUrl(r.avatarUrl);
      toast.ok("התמונה הועלתה");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה בהעלאה");
    } finally {
      setAvatarBusy(false);
    }
  }

  async function submit() {
    if (!name.trim())                            { toast.error("שם משתמש חובה"); return; }
    if (isNew && password.length < 6)            { toast.error("סיסמה חייבת לפחות 6 תווים"); return; }
    if (!isNew && password.length > 0 && password.length < 6) {
      toast.error("סיסמה חדשה חייבת לפחות 6 תווים"); return;
    }

    setBusy(true);
    try {
      if (isNew) {
        await createAdminAgent({
          name:     name.trim(),
          password,
          role,
          nickname: nickname.trim() || undefined,
          email:    email.trim()    || undefined,
          phone:    phone.trim()    || undefined,
        });
        toast.ok("משתמש נוצר");
      } else if (agent) {
        const update: Parameters<typeof updateAdminAgent>[1] = {
          name: name.trim(),
          nickname: nickname.trim(),
          email: email.trim(),
          phone: phone.trim(),
          role,
          bio: bio.trim(),
        };
        if (password.length >= 6) update.password = password;
        await updateAdminAgent(agent.id, update);
        toast.ok("משתמש עודכן");
      }
      onComplete();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={isNew ? "הוספת משתמש" : "עריכת משתמש"}>
      <div style={{ display: "grid", gap: 12, padding: "var(--s-5)", minWidth: 480, maxWidth: 600 }}>
        {role === "admin" && (
          <div style={{
            padding: "8px 12px",
            background: "#FEF3C7",
            border: "1px solid #FBBF24",
            borderRadius: 6,
            fontSize: 12,
            color: "#92400E",
          }}>
            ⚠️ תפקיד <strong>אדמין</strong> נותן גישה מלאה לכל המערכת + פעולות הרסניות (החזרים, מחיקות, override). הענק רק לגורמים בכירים מאוד.
          </div>
        )}

        {/* Profile image — only meaningful for existing managers (need
            an agent.id to attach the upload to). For new agents we hide
            it and prompt to save first. */}
        {!isNew && (
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: "10px 12px",
            background: "var(--bg-tint)",
            border: "1px solid var(--rule)",
            borderRadius: 8,
          }}>
            <div style={{
              width: 64, height: 64, borderRadius: "50%",
              background: "var(--paper)", border: "1px solid var(--rule)",
              overflow: "hidden", flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 22, fontWeight: 700, color: "var(--ink-3)",
            }}>
              {avatarUrl
                ? <img src={avatarUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                : (nickname || name || "?").charAt(0).toUpperCase()}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ margin: 0, fontWeight: 700, fontSize: 13, color: "var(--ink)" }}>
                תמונת פרופיל
              </p>
              <p className="t-meta" style={{ marginTop: 2, fontSize: 11 }}>
                JPG / PNG / WEBP · עד 5MB · תוצג בלקוחות בעת בחירת מנהל באפליקציה
              </p>
            </div>
            <label
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "6px 12px",
                background: avatarBusy ? "var(--rule)" : "var(--blue)",
                color: "#fff", borderRadius: 6,
                fontSize: 12, fontWeight: 700,
                cursor: avatarBusy ? "wait" : "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {avatarBusy ? "מעלה…" : (avatarUrl ? "החלף" : "העלה תמונה")}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={avatarBusy}
                onChange={e => {
                  const f = e.target.files?.[0];
                  if (f) onPickAvatar(f);
                  e.target.value = "";
                }}
                style={{ display: "none" }}
              />
            </label>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="שם משתמש (login)" hint={isNew ? "ייחודי, אנגלית" : "לא ניתן לשנות בקלות"}>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value.replace(/\s/g, ""))}
              dir="ltr"
              style={inputStyle}
            />
          </Field>
          <Field label="כינוי לתצוגה (עברית)">
            <input
              type="text"
              value={nickname}
              onChange={e => setNickname(e.target.value)}
              style={inputStyle}
            />
          </Field>
        </div>

        {!isNew && (
          <Field label="תיאור קצר (Bio)" hint="יוצג ללקוחות בעת בחירת מנהל באפליקציה · עד 500 תווים">
            <textarea
              value={bio}
              onChange={e => setBio(e.target.value.slice(0, 500))}
              rows={3}
              placeholder="דוגמה: מומחה לקמפיינים בעסקים קטנים · 5 שנות ניסיון · מתמחה בפייסבוק ואינסטגרם"
              style={{ ...inputStyle, resize: "vertical", minHeight: 70, fontFamily: "inherit" }}
            />
          </Field>
        )}

        <Field label="תפקיד">
          <select
            value={role}
            onChange={e => setRole(e.target.value as AgentRole)}
            style={inputStyle}
          >
            {(["account_manager", "supervisor", "finance", "admin"] as AgentRole[]).map(r => (
              <option key={r} value={r}>{ROLE_LABEL[r]}</option>
            ))}
          </select>
        </Field>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="אימייל">
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              dir="ltr"
              style={inputStyle}
            />
          </Field>
          <Field label="טלפון">
            <input
              type="tel"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              dir="ltr"
              style={inputStyle}
            />
          </Field>
        </div>

        <Field
          label={isNew ? "סיסמה (חובה — מינ' 6 תווים)" : "סיסמה חדשה (השאר ריק כדי לא לשנות)"}
          hint={isNew ? "המשתמש יוכל לשנות אותה לאחר ההתחברות הראשונה" : "ריק = הסיסמה הנוכחית נשמרת"}
        >
          <input
            type="text"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder={isNew ? "" : "(לא משונה)"}
            dir="ltr"
            style={inputStyle}
          />
        </Field>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 8, borderTop: "1px solid var(--rule)" }}>
          <Button onClick={onClose} variant="ghost">ביטול</Button>
          <Button onClick={submit} disabled={busy || !name.trim() || (isNew && password.length < 6)}>
            {busy ? "שומר…" : isNew ? "צור משתמש" : "שמור"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--ink-2)", marginBottom: 4 }}>{label}</label>
      {children}
      {hint && <div className="t-meta" style={{ fontSize: 10, marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid var(--rule)",
  background: "var(--paper)",
  fontSize: 13,
  color: "var(--ink)",
};

const miniBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--rule)",
  color: "var(--ink-2)",
  fontSize: 11,
  padding: "3px 10px",
  borderRadius: 6,
  cursor: "pointer",
};

function Th({ children }: { children: React.ReactNode }) {
  return <th style={{ padding: "10px 12px", textAlign: "right", fontSize: 11, fontWeight: 700, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td style={{ padding: "10px 12px", textAlign: "right", verticalAlign: "middle" }}>{children}</td>;
}
