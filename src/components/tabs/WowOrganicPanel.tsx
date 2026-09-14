import { useCallback, useEffect, useRef, useState } from "react";
import {
  generateWowOrganic, getWowOrganic, regenerateWowOrganicPost,
  approveWowOrganicPost, updateWowOrganicPostText,
  uploadWowOrganicPostImage,
  generateOrganicPromotionDescription,
  resolveImgUrl,
  COIN_COSTS,
  type WowOrganicPost, type WowOrganicSession, type WowAdsStatus,
} from "../../api/client";
import { useToast } from "../../context/ToastContext";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { IcoRefresh, IcoDownload, IcoActivity, IcoAlert, IcoEdit, IcoCheck, IcoX, IcoAI } from "../icons/Icons";
import { ScheduleSocialModal } from "../modals/ScheduleSocialModal";

interface Props { phone: string; quota?: number | null; coinsRemaining?: number; onCoinsChanged?: () => void }

const STATUS_LABELS: Record<WowAdsStatus, string> = {
  generating_texts:   "מייצר טקסטים אורגניים (1/3)",
  generating_prompts: "מייצר promptים (2/3)",
  generating_images:  "מייצר תמונות אותנטיות (3/3)",
  done:               "הושלם",
  error:              "שגיאה",
};

const TYPE_LABELS: Record<string, { label: string; color: string; bg: string; emoji: string }> = {
  tip:         { label: "טיפ",       color: "#10B981", bg: "rgba(16,185,129,0.10)",  emoji: "💡" },
  story:       { label: "סיפור",     color: "#7C3AED", bg: "rgba(124,58,237,0.10)",  emoji: "📖" },
  behind:      { label: "מאחורי",    color: "#F59E0B", bg: "rgba(245,158,11,0.10)",  emoji: "🎬" },
  testimonial: { label: "המלצה",     color: "#0891B2", bg: "rgba(8,145,178,0.10)",   emoji: "⭐" },
  question:    { label: "שאלה",      color: "#DB2777", bg: "rgba(219,39,119,0.10)",  emoji: "❓" },
};

export function WowOrganicPanel({ phone, quota, coinsRemaining, onCoinsChanged }: Props) {
  const toast = useToast();
  const [session, setSession]  = useState<WowOrganicSession | null>(null);
  const [loading, setLoading]  = useState(true);
  const [generating, setGen]   = useState(false);
  const [regenIds, setRegenIds] = useState<Set<number>>(new Set());
  const [approveIds, setApproveIds] = useState<Set<number>>(new Set());
  const [scheduleOpen, setScheduleOpen] = useState(false);
  /* Lightbox model — store the id (not the post snapshot) so the modal
     always reflects the current session state after edit/regen/approve. */
  const [activeId, setActiveId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await getWowOrganic(phone);
      setSession(r.session);
    } finally { setLoading(false); }
  }, [phone]);

  useEffect(() => { load(); }, [load]);

  const inFlight = session?.status && session.status !== "done" && session.status !== "error";
  useEffect(() => {
    if (!inFlight) return;
    const id = setInterval(load, 3500);
    return () => clearInterval(id);
  }, [inFlight, load]);

  async function start() {
    setGen(true);
    try {
      await generateWowOrganic(phone);
      toast.ok("מתחיל לייצר 5 פוסטים אורגניים");
      await load();
      onCoinsChanged?.();
    } catch (err: any) {
      const msg = err?.message ?? "שגיאה";
      if (msg.includes("חסרים שדות") || msg.includes("INCOMPLETE")) {
        toast.error("האיפיון לא שלם — מלא את כל השדות בטאב 'איפיון'");
      } else if (msg.includes("NO_PACKAGE")) {
        toast.error("ללקוח אין חבילה פעילה — רכוש חבילה בטאב 'חיוב'");
      } else if (msg.includes("INSUFFICIENT_COINS")) {
        toast.error("אין מספיק מטבעות לפעולה זו");
      } else toast.error(msg);
    } finally { setGen(false); }
  }

  async function regenerate(postId: number) {
    setRegenIds(prev => new Set(prev).add(postId));
    try {
      const r = await regenerateWowOrganicPost(phone, postId);
      setSession(prev => prev ? {
        ...prev,
        generatedPosts: prev.generatedPosts.map(p => p.id === postId ? r.post : p),
      } : prev);
      toast.ok("פוסט רוענן");
      onCoinsChanged?.();
    } catch (err: any) {
      const msg = err?.message ?? "שגיאה";
      if (msg.includes("INSUFFICIENT_COINS")) toast.error("אין מספיק מטבעות לרענון");
      else toast.error(msg);
    }
    finally {
      setRegenIds(prev => { const n = new Set(prev); n.delete(postId); return n; });
    }
  }

  async function toggleApprove(postId: number, currentlyApproved: boolean) {
    setApproveIds(prev => new Set(prev).add(postId));
    try {
      const r = await approveWowOrganicPost(phone, postId, !currentlyApproved);
      setSession(prev => prev ? {
        ...prev,
        generatedPosts: prev.generatedPosts.map(p => p.id === postId ? r.post : p),
      } : prev);
      toast.ok(!currentlyApproved ? "פוסט אושר" : "אישור בוטל");
    } catch (err: any) {
      toast.error(err?.message ?? "שגיאה באישור");
    } finally {
      setApproveIds(prev => { const n = new Set(prev); n.delete(postId); return n; });
    }
  }

  async function saveEdit(postId: number, fields: Partial<{ headline: string; description: string; cta: string }>) {
    try {
      const r = await updateWowOrganicPostText(phone, postId, fields);
      setSession(prev => prev ? {
        ...prev,
        generatedPosts: prev.generatedPosts.map(p => p.id === postId ? r.post : p),
      } : prev);
      toast.ok("פוסט עודכן");
    } catch (err: any) {
      toast.error(err?.message ?? "שגיאה בשמירה");
    }
  }

  async function uploadImage(postId: number, file: File) {
    try {
      const r = await uploadWowOrganicPostImage(phone, postId, file);
      setSession(prev => prev ? {
        ...prev,
        generatedPosts: prev.generatedPosts.map(p => p.id === postId ? r.post : p),
      } : prev);
      toast.ok("תמונה הועלתה בהצלחה");
    } catch (err: any) {
      toast.error(err?.message ?? "שגיאה בהעלאת תמונה");
    }
  }

  async function generatePromotion(postId: number) {
    try {
      const r = await generateOrganicPromotionDescription(phone, postId);
      setSession(prev => prev ? {
        ...prev,
        generatedPosts: prev.generatedPosts.map(p => p.id === postId ? r.post : p),
      } : prev);
      toast.ok("תיאור הפרסום נוצר");
    } catch (err: any) {
      toast.error(err?.message ?? "שגיאה ביצירת תיאור");
      throw err;
    }
  }

  const posts = session?.generatedPosts ?? [];
  const approvedPosts = posts.filter(p => !!p.managerApprovedAt);
  const activePost = activeId !== null ? posts.find(p => p.id === activeId) ?? null : null;
  const ready = session?.status === "done";
  const errored = session?.status === "error";

  if (loading) return <div style={{ padding: "var(--s-7)", textAlign: "center", color: "var(--ink-3)" }}>טוען...</div>;

  return (
    <section className="section" style={{ marginTop: 0 }}>
      <div className="card" style={{
        padding: "var(--s-5)",
        marginBottom: "var(--s-5)",
        borderTop: "3px solid var(--positive)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-4)", flexWrap: "wrap" }}>
          <div style={{
            width: 48, height: 48, borderRadius: "var(--r-2)",
            background: "var(--positive)",
            color: "#fff",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <IcoActivity size={22} />
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: "var(--positive)", letterSpacing: "0.14em", textTransform: "uppercase", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span>WOW Organic · {quota != null ? `${quota} פוסטים אורגניים` : "5 פוסטים אורגניים"}</span>
              {quota != null && posts.length > 0 && (
                <span style={{
                  textTransform: "none",
                  letterSpacing: "normal",
                  color: posts.length >= quota ? "var(--negative)" : "var(--ink-3)",
                  fontSize: 11,
                  fontWeight: 700,
                }}>
                  · {posts.length}/{quota} בשימוש
                </span>
              )}
            </div>
            <h3 style={{ fontSize: "var(--t-lg)", fontWeight: 800, color: "var(--ink)", margin: "4px 0 0" }}>
              {session ? STATUS_LABELS[session.status] : `ייצור ${quota ?? 5} מודעות לקידום אורגני`}
            </h3>
            <p style={{ fontSize: "var(--t-sm)", color: "var(--ink-3)", marginTop: 4, lineHeight: 1.5 }}>
              {!session && "פוסטים אותנטיים לאינסטגרם/פייסבוק — לא פרסומיים. מבנה: טיפ + סיפור + מאחורי הקלעים + המלצה + שאלה."}
              {inFlight && `${session.completedCount}/${session.totalPosts} פוסטים מוכנים`}
              {ready && `נוצרו ${posts.filter(p => p.imageUrl).length}/${posts.length} פוסטים בהצלחה`}
              {errored && (session.error || "תקלה — נסה שוב")}
            </p>
          </div>

          <div style={{ display: "flex", gap: "var(--s-2)" }}>
            {(!session || ready || errored) && (() => {
              const quotaFull  = quota != null && posts.length >= quota;
              const lowOnCoins = coinsRemaining != null && coinsRemaining < COIN_COSTS.GENERATE_ORGANIC;
              const label = quotaFull
                ? "מכסה מולאה"
                : lowOnCoins
                  ? `אין מספיק מטבעות (−${COIN_COSTS.GENERATE_ORGANIC})`
                  : ready
                    ? `ייצר מחדש (−${COIN_COSTS.GENERATE_ORGANIC})`
                    : `ייצר ${quota ?? 5} פוסטים (−${COIN_COSTS.GENERATE_ORGANIC})`;
              return (
                <Button
                  onClick={start}
                  loading={generating}
                  size="lg"
                  disabled={quotaFull || lowOnCoins}
                  style={{ background: "var(--positive)", color: "#fff", border: "none" }}
                  title={`עלות: ${COIN_COSTS.GENERATE_ORGANIC} מטבעות${coinsRemaining != null ? ` · יתרה: ${coinsRemaining}` : ""}`}
                >
                  {label}
                </Button>
              );
            })()}
            {approvedPosts.length > 0 && (
              <Button
                onClick={() => setScheduleOpen(true)}
                size="lg"
                variant="ghost"
                style={{
                  border: "2px solid var(--blue)",
                  color: "var(--blue)",
                  fontWeight: 700,
                }}
                title={`תזמן את ${approvedPosts.length} הפוסטים המאושרים לפרסום אוטומטי`}
              >
                ⏰ תזמן {approvedPosts.length} פוסטים
              </Button>
            )}
            {inFlight && <span className="pulse-dot" style={{ alignSelf: "center" }} />}
          </div>
        </div>

        {inFlight && (
          <div style={{ marginTop: "var(--s-4)" }}>
            <div style={{ height: 6, background: "var(--bg-tint)", borderRadius: 99, overflow: "hidden" }}>
              <div style={{
                height: "100%",
                width: `${session ? Math.max(8, (session.completedCount / session.totalPosts) * 100) : 0}%`,
                background: "var(--positive)",
                transition: "width 600ms var(--ease-out)",
                boxShadow: "0 0 12px rgba(16,185,129,0.5)",
              }} />
            </div>
          </div>
        )}
      </div>

      {posts.length > 0 && (
        <div
          role="list"
          aria-label="גלריית פוסטים אורגניים"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
            gap: "var(--s-3)",
          }}
        >
          {posts.map((post, i) => (
            <PostThumbnail
              key={post.id}
              post={post}
              index={i + 1}
              total={posts.length}
              regenerating={regenIds.has(post.id) || !!post.regenerating}
              onClick={() => setActiveId(post.id)}
            />
          ))}
        </div>
      )}

      <Modal
        open={!!activePost}
        onClose={() => setActiveId(null)}
        size="xl"
        eyebrow="פוסט אורגני"
        title={activePost ? `פוסט ${posts.findIndex(p => p.id === activePost.id) + 1} מתוך ${posts.length}` : ""}
      >
        {activePost && (
          <PostCard
            post={activePost}
            regenerating={regenIds.has(activePost.id) || !!activePost.regenerating}
            approving={approveIds.has(activePost.id)}
            onRegenerate={() => regenerate(activePost.id)}
            onApprove={() => toggleApprove(activePost.id, !!activePost.managerApprovedAt)}
            onSaveEdit={(fields) => saveEdit(activePost.id, fields)}
            onUploadImage={(file) => uploadImage(activePost.id, file)}
            onGeneratePromotion={() => generatePromotion(activePost.id)}
            disabled={inFlight && !activePost.imageUrl}
          />
        )}
      </Modal>

      {!session && (
        <div className="empty" style={{ marginTop: "var(--s-5)" }}>
          <p className="empty-title">עדיין לא יוצרו פוסטים אורגניים</p>
          <p className="empty-meta">
            לחץ "ייצר 5 פוסטים" — ה-AI ינתח את האיפיון ויפיק 5 פוסטים אותנטיים בטון אורגני (לא פרסומי), עם תמונות בסגנון lifestyle.
          </p>
        </div>
      )}

      <ScheduleSocialModal
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        posts={approvedPosts}
        phone={phone}
        onScheduled={() => load()}
      />
    </section>
  );
}

/**
 * PostThumbnail — square image tile rendered in the grid above.
 * Click opens the full PostCard in a modal. Visual signals overlaid:
 *   - Approved: green check badge top-left
 *   - Regenerating: spinner overlay
 *   - Errored: amber alert overlay
 *   - Missing image: skeleton-style placeholder
 */
function PostThumbnail({ post, index, total, regenerating, onClick }: {
  post: WowOrganicPost;
  index: number;
  total: number;
  regenerating: boolean;
  onClick: () => void;
}) {
  const isApproved = !!post.managerApprovedAt;
  const hasImage = !!post.imageUrl;
  return (
    <button
      type="button"
      role="listitem"
      onClick={onClick}
      style={{
        position: "relative",
        aspectRatio: "1 / 1",
        border: isApproved ? "2px solid var(--positive)" : "1px solid var(--rule)",
        borderRadius: "var(--r-3)",
        overflow: "hidden",
        cursor: "pointer",
        padding: 0,
        background: "var(--bg-tint)",
        transition: "transform 150ms var(--ease-out), box-shadow 150ms var(--ease-out)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = "translateY(-2px)";
        e.currentTarget.style.boxShadow = "0 8px 24px rgba(11,20,48,0.12)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "";
        e.currentTarget.style.boxShadow = "";
      }}
      aria-label={`פוסט ${index} מתוך ${total}${isApproved ? " — מאושר" : ""}`}
    >
      {hasImage ? (
        <img
          src={resolveImgUrl(post.imageUrl) ?? post.imageUrl}
          alt=""
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      ) : (
        <div style={{
          width: "100%", height: "100%",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "var(--ink-4)",
        }}>
          <IcoAI size={32} />
        </div>
      )}

      {/* Index badge — physical top-right of the image. Use plain `right`
          (not logical inset-inline) so the position stays predictable
          regardless of the inherited RTL direction context. */}
      <span style={{
        position: "absolute", top: 6, right: 6,
        background: "rgba(11,20,48,0.75)", color: "#fff",
        fontSize: 11, fontWeight: 700,
        padding: "2px 6px", borderRadius: 6,
        backdropFilter: "blur(4px)",
      }} dir="ltr">{index}/{total}</span>

      {/* Approved checkmark — physical top-left of the image. */}
      {isApproved && (
        <span style={{
          position: "absolute", top: 6, left: 6,
          width: 24, height: 24,
          background: "var(--positive)", color: "#fff",
          borderRadius: 99,
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: "0 2px 6px rgba(0,0,0,0.2)",
        }}>
          <IcoCheck size={14} />
        </span>
      )}

      {/* Status overlays — full-tile, only visible while busy/broken. */}
      {regenerating && (
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "rgba(255,255,255,0.7)", backdropFilter: "blur(2px)",
        }}>
          <IcoActivity size={28} />
        </div>
      )}
      {post.error && !regenerating && (
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "rgba(254,243,199,0.85)", color: "var(--warning)",
        }}>
          <IcoAlert size={28} />
        </div>
      )}
    </button>
  );
}

/**
 * PostCard — 2-column rich card matching WowAdsPanel's AdSlide. Image
 * left, editable text + actions right. Same button set as ads:
 *   - Edit (headline / description / cta inline)
 *   - Approve / unapprove
 *   - Regenerate
 *   - Download
 *   - Generate promotion description (Meta/Facebook copy-paste body)
 *   - Copy promotion description to clipboard
 *
 * Per the user request — "i would like the social images will be the
 * same also with all the functions like the ads" — feature parity with
 * the ads card. Layout is identical so the experience reads consistent.
 */
function PostCard({ post, regenerating, approving, onRegenerate, onApprove, onSaveEdit, onUploadImage, onGeneratePromotion, disabled }: {
  post: WowOrganicPost;
  regenerating: boolean;
  approving: boolean;
  onRegenerate: () => void;
  onApprove: () => void;
  onSaveEdit: (fields: Partial<{ headline: string; description: string; cta: string }>) => void;
  onUploadImage: (file: File) => Promise<void>;
  onGeneratePromotion: () => Promise<void>;
  disabled?: boolean;
}) {
  const typeMeta       = TYPE_LABELS[post.type] ?? { label: post.type, color: "var(--ink-3)", bg: "var(--bg-tint)", emoji: "📝" };
  const resolvedImgUrl = resolveImgUrl(post.imageUrl);
  const hasImage       = !!resolvedImgUrl;
  const isApproved     = !!post.managerApprovedAt;

  const [editing, setEditing]         = useState(false);
  const [headline, setHeadline]       = useState(post.headline);
  const [description, setDescription] = useState(post.description);
  const [cta, setCta]                 = useState(post.cta);
  const [promoBusy, setPromoBusy]     = useState(false);
  const [promoCopied, setPromoCopied] = useState(false);
  const [uploading, setUploading]     = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleGeneratePromo() {
    if (promoBusy) return;
    setPromoBusy(true);
    try { await onGeneratePromotion(); }
    finally { setPromoBusy(false); }
  }
  async function copyPromo() {
    if (!post.promotionDescription) return;
    try {
      await navigator.clipboard.writeText(post.promotionDescription);
      setPromoCopied(true);
      setTimeout(() => setPromoCopied(false), 1800);
    } catch { /* clipboard rejected — ignore */ }
  }

  function cancelEdit() {
    setHeadline(post.headline);
    setDescription(post.description);
    setCta(post.cta);
    setEditing(false);
  }
  function saveEdit() {
    onSaveEdit({ headline, description, cta });
    setEditing(false);
  }

  return (
    <div style={{
      background: "var(--paper)",
      border: "1px solid var(--rule)",
      borderRadius: "var(--r-3)",
      overflow: "hidden",
      display: "flex",
      minHeight: 320,
      boxShadow: "var(--sh-1)",
    }}>
      {/* ── Left: type pill header + image ── */}
      <div
        style={{
          flexShrink: 0,
          width: "min(340px, 42%)",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-tint)",
        }}
      >
        {/* Type pill — own band above the image so it never covers content. */}
        <div style={{
          padding: "8px 12px",
          background: "var(--paper)",
          borderBottom: "1px solid var(--rule)",
          display: "flex",
          justifyContent: "flex-end",
          flexShrink: 0,
        }}>
          <span style={{
            fontSize: 10, fontWeight: 700,
            padding: "4px 12px",
            background: typeMeta.bg, color: typeMeta.color,
            borderRadius: 999,
            border: `1px solid ${typeMeta.color}40`,
          }}>
            {typeMeta.emoji} {typeMeta.label}
          </span>
        </div>

        {/* Image fills remaining height. */}
        <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        {hasImage ? (
          <img
            src={resolvedImgUrl}
            alt={`Post ${post.id}`}
            onClick={() => setLightboxOpen(true)}
            style={{
              width: "100%", height: "100%", objectFit: "cover", display: "block",
              cursor: "zoom-in",
            }}
            loading="lazy"
            title="לחץ לתצוגה בגודל מלא"
          />
        ) : post.error ? (
          <div style={{
            width: "100%", height: "100%",
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            gap: 8, padding: 24, color: "var(--negative)",
          }}>
            <IcoAlert size={32} />
            <p style={{ fontSize: 12, textAlign: "center", color: "var(--ink-3)" }}>{post.error}</p>
          </div>
        ) : disabled ? (
          <div className="skeleton" style={{ width: "100%", height: "100%", borderRadius: 0 }} />
        ) : (
          <div style={{
            width: "100%", height: "100%",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "var(--ink-4)", fontSize: 12,
          }}>ממתין...</div>
        )}
        </div>
      </div>

      {/* ── Right: content + actions ── */}
      <div style={{
        flex: 1,
        padding: "var(--s-6)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--s-4)",
        justifyContent: "space-between",
      }}>
        {/* Headline */}
        {editing ? (
          <input
            value={headline}
            onChange={e => setHeadline(e.target.value)}
            style={{
              fontSize: "var(--t-md)", fontWeight: 800, color: "var(--ink)",
              border: "1px solid var(--blue)", borderRadius: "var(--r-1)",
              padding: "4px 8px", background: "var(--surface)", outline: "none",
            }}
          />
        ) : (
          <h3 style={{ fontSize: "var(--t-md)", fontWeight: 800, color: "var(--ink)", margin: 0, lineHeight: 1.3 }}>
            {post.headline}
          </h3>
        )}

        {/* Description */}
        {editing ? (
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={4}
            style={{
              width: "100%", fontSize: "var(--t-sm)", color: "var(--ink-2)",
              lineHeight: 1.7, resize: "vertical",
              border: "1px solid var(--blue)", borderRadius: "var(--r-1)",
              padding: "4px 8px", background: "var(--surface)", outline: "none",
            }}
          />
        ) : (
          <p style={{ fontSize: "var(--t-sm)", color: "var(--ink-2)", lineHeight: 1.7, margin: 0, flex: 1 }}>
            {post.description}
          </p>
        )}

        {/* Promotion-ready post body (parity with ads) */}
        <div style={{
          marginTop: "var(--s-2)",
          padding: "var(--s-3)",
          background: "var(--blue-soft)",
          border: "1px dashed rgba(0,115,234,0.3)",
          borderRadius: "var(--r-2)",
        }}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            gap: 8, marginBottom: post.promotionDescription ? 8 : 0,
          }}>
            <p style={{
              margin: 0, fontSize: 11, fontWeight: 800,
              color: "var(--blue)", letterSpacing: "0.06em", textTransform: "uppercase",
            }}>
              📋 תיאור לפרסום ב-Instagram / Facebook
            </p>
            <div style={{ display: "flex", gap: 6 }}>
              {post.promotionDescription && (
                <ActionBtn onClick={copyPromo} color={promoCopied ? "var(--positive)" : undefined}>
                  <IcoCheck size={12} /> {promoCopied ? "הועתק!" : "העתק"}
                </ActionBtn>
              )}
              <ActionBtn onClick={handleGeneratePromo} disabled={promoBusy}>
                <IcoAI size={12} className={promoBusy ? "spin" : undefined} />
                {promoBusy ? "מייצר..." : post.promotionDescription ? "צור מחדש" : "צור תיאור פרסומי"}
              </ActionBtn>
            </div>
          </div>
          {post.promotionDescription ? (
            <p style={{
              margin: 0, fontSize: 13, lineHeight: 1.7, color: "var(--ink)",
              whiteSpace: "pre-wrap",
            }}>{post.promotionDescription}</p>
          ) : promoBusy ? (
            <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ink-3)", fontStyle: "italic" }}>
              מייצר…
            </p>
          ) : null}
        </div>

        {/* CTA + actions row */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)", flexWrap: "wrap" }}>
          {editing ? (
            <input
              value={cta}
              onChange={e => setCta(e.target.value)}
              style={{
                fontSize: "var(--t-sm)", fontWeight: 800,
                padding: "7px 14px", width: 180,
                border: "1px solid var(--blue)", borderRadius: "var(--r-2)",
                background: "var(--surface)", outline: "none", color: "var(--ink)",
              }}
            />
          ) : (
            <span style={{
              fontSize: "var(--t-sm)", fontWeight: 700,
              padding: "8px 16px",
              background: "var(--bg-tint)", color: "var(--ink-2)",
              borderRadius: "var(--r-pill)",
              fontStyle: "italic",
            }}>↳ {post.cta}</span>
          )}

          <div style={{ display: "flex", gap: "var(--s-2)", marginInlineStart: "auto", flexWrap: "wrap" }}>
            {editing ? (
              <>
                <ActionBtn onClick={saveEdit} color="var(--positive)">
                  <IcoCheck size={13} /> שמור
                </ActionBtn>
                <ActionBtn onClick={cancelEdit}>
                  <IcoX size={13} /> ביטול
                </ActionBtn>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    setUploading(true);
                    try { await onUploadImage(file); }
                    finally { setUploading(false); e.target.value = ""; }
                  }}
                />
                <ActionBtn onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                  📎 {uploading ? "מעלה..." : "העלה תמונה"}
                </ActionBtn>
              </>
            ) : (
              <ActionBtn onClick={() => setEditing(true)}>
                <IcoEdit size={13} /> ערוך
              </ActionBtn>
            )}

            <ActionBtn
              onClick={onApprove}
              disabled={approving}
              color={isApproved ? "var(--positive)" : undefined}
              fill={isApproved}
            >
              <IcoCheck size={13} className={approving ? "spin" : undefined} />
              {approving ? "..." : isApproved ? "מאושר ✓" : "אשר פוסט"}
            </ActionBtn>

            <ActionBtn onClick={onRegenerate} disabled={regenerating}>
              <IcoRefresh size={13} className={regenerating ? "spin" : undefined} />
              {regenerating ? "מייצר..." : "רענן"}
            </ActionBtn>

            {hasImage && (
              <a href={resolvedImgUrl} download={`post_${post.id}.png`} target="_blank" rel="noreferrer"
                style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  padding: "5px 11px",
                  background: "transparent", color: "var(--ink-2)",
                  border: "1px solid var(--rule-strong)",
                  borderRadius: "var(--r-1)",
                  fontSize: 12, fontWeight: 600, textDecoration: "none",
                  cursor: "pointer",
                }}>
                <IcoDownload size={13} /> הורד
              </a>
            )}
          </div>
        </div>
      </div>

      {/* Lightbox — click image to view it in full size. Renders on top
          of the existing PostCard modal; closes on backdrop click or Esc. */}
      {hasImage && (
        <Modal
          open={lightboxOpen}
          onClose={() => setLightboxOpen(false)}
          size="xl"
          title=""
        >
          <div style={{
            display: "flex", justifyContent: "center", alignItems: "center",
            background: "var(--bg-tint)",
            borderRadius: "var(--r-2)",
            overflow: "hidden",
            maxHeight: "78vh",
          }}>
            <img
              src={resolvedImgUrl}
              alt={`Post ${post.id} — תצוגה מלאה`}
              style={{
                maxWidth: "100%", maxHeight: "78vh",
                objectFit: "contain", display: "block",
              }}
            />
          </div>
        </Modal>
      )}
    </div>
  );
}

/* Small button used inside post / ad cards. Mirrors the AdSlide style
   so the two cards feel like one component family. */
function ActionBtn({ onClick, disabled, color, fill, children }: {
  onClick?: () => void;
  disabled?: boolean;
  color?: string;
  fill?: boolean;
  children: React.ReactNode;
}) {
  const c = color || "var(--ink-2)";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        padding: "5px 11px",
        background: fill ? c : "transparent",
        color: fill ? "#fff" : c,
        border: `1px solid ${fill ? c : "var(--rule-strong)"}`,
        borderRadius: "var(--r-1)",
        fontSize: 12, fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}
