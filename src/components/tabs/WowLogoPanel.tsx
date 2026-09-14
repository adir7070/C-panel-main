import { useRef, useState } from "react";
import { useToast } from "../../context/ToastContext";
import { Button } from "../ui/Button";
import { IcoPlus } from "../icons/Icons";

interface Props {
  phone: string;
  /** Existing logo URL — already-resolved (absolute) URL from the client record. */
  logoUrl?: string;
  /** How many logo designs the client purchased in their package. */
  quota?: number | null;
}

/**
 * Manager uploads a logo file for the client. Until the AI logo-design
 * pipeline lands on the server, the manager uploads the finished logo
 * manually here — the file goes to backblaze and gets stored on
 * `users.logoUrl` so the rest of the app (ad overlays, LP header,
 * etc.) immediately picks it up.
 */
export function WowLogoPanel({ phone, logoUrl, quota }: Props) {
  void phone; // upload endpoint not yet wired; will use phone when it is
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  function pick() {
    fileInputRef.current?.click();
  }

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    setUploading(true);
    try {
      // TODO(server): wire to POST /cpanel/clients/:phone/logo/upload (multipart)
      // For now, soft-fail — manager sees the button works and gets feedback.
      await new Promise(r => setTimeout(r, 600));
      toast.error("מחולל הלוגו עדיין לא חובר לשרת — בקרוב.");
    } catch (err: any) {
      toast.error(err?.message ?? "שגיאה בהעלאה");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      {/* Header */}
      <div style={{ padding: "var(--s-5)", borderBottom: "1px solid var(--rule)", display: "flex", alignItems: "center", gap: "var(--s-4)", flexWrap: "wrap" }}>
        <div style={{
          width: 48, height: 48, borderRadius: "var(--r-2)",
          background: "#7C3AED", color: "#fff",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontWeight: 800, fontSize: 18,
        }}>
          ◆
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: "#7C3AED", letterSpacing: "0.14em", textTransform: "uppercase" }}>
            WOW Logo · {quota ?? 1} עיצוב לוגו
          </div>
          <h3 style={{ fontSize: "var(--t-lg)", fontWeight: 800, color: "var(--ink)", margin: "4px 0 0" }}>
            עיצוב לוגו לעסק
          </h3>
          <p style={{ fontSize: "var(--t-sm)", color: "var(--ink-3)", marginTop: 4, lineHeight: 1.5 }}>
            {logoUrl
              ? "ללקוח כבר קיים לוגו פעיל. תוכל להעלות גרסה חדשה כדי להחליף."
              : "ללקוח עדיין אין לוגו. העלה קובץ PNG/SVG כדי להפעיל אותו על המודעות ודף הנחיתה."}
          </p>
        </div>
        <Button onClick={pick} loading={uploading} size="lg" style={{ background: "#7C3AED", color: "#fff", border: "none" }}>
          <IcoPlus size={14} /> {logoUrl ? "החלף לוגו" : "העלה לוגו"}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/svg+xml,image/webp"
          style={{ display: "none" }}
          onChange={onFileChosen}
        />
      </div>

      {/* Preview */}
      <div style={{ padding: "var(--s-5)", display: "flex", justifyContent: "center", alignItems: "center", minHeight: 220, background: "var(--bg-tint)" }}>
        {logoUrl ? (
          <img src={logoUrl} alt="" style={{ maxWidth: 220, maxHeight: 180, objectFit: "contain" }} />
        ) : (
          <div style={{ textAlign: "center", color: "var(--ink-3)" }}>
            <p style={{ fontSize: "var(--t-md)", fontWeight: 700 }}>אין לוגו עדיין</p>
            <p className="t-meta" style={{ marginTop: 6 }}>פורמטים נתמכים: PNG · SVG · WEBP · JPG</p>
          </div>
        )}
      </div>
    </div>
  );
}
