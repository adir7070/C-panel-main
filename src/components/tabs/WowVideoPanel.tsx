import { useRef, useState } from "react";
import { useToast } from "../../context/ToastContext";
import { Button } from "../ui/Button";
import { IcoPlus } from "../icons/Icons";

interface Props {
  phone: string;
  /** How many videos the client purchased. */
  quota?: number | null;
}

/**
 * Manager uploads a finished video for the client (or, when the server
 * pipeline lands, kicks off AI video generation). Currently a placeholder
 * panel that shows the purchased quota and a manual-upload button.
 */
export function WowVideoPanel({ phone, quota }: Props) {
  void phone;
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  function pick() { fileInputRef.current?.click(); }

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    setUploading(true);
    try {
      // TODO(server): POST /cpanel/clients/:phone/video/upload (multipart)
      await new Promise(r => setTimeout(r, 600));
      toast.error("מחולל הוידאו עדיין לא חובר לשרת — בקרוב.");
    } catch (err: any) {
      toast.error(err?.message ?? "שגיאה בהעלאה");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "var(--s-5)", borderBottom: "1px solid var(--rule)", display: "flex", alignItems: "center", gap: "var(--s-4)", flexWrap: "wrap" }}>
        <div style={{
          width: 48, height: 48, borderRadius: "var(--r-2)",
          background: "#DB2777", color: "#fff",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontWeight: 800, fontSize: 20,
        }}>
          ▶
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: "#DB2777", letterSpacing: "0.14em", textTransform: "uppercase" }}>
            WOW Video · {quota ?? 1} סרטון
          </div>
          <h3 style={{ fontSize: "var(--t-lg)", fontWeight: 800, color: "var(--ink)", margin: "4px 0 0" }}>
            סרטון פרסומת לעסק
          </h3>
          <p style={{ fontSize: "var(--t-sm)", color: "var(--ink-3)", marginTop: 4, lineHeight: 1.5 }}>
            מחולל הוידאו מבוסס Gemini Video יעלה לאוויר בקרוב. בינתיים — תוכל להעלות סרטון מוכן ולשייך אותו ללקוח.
          </p>
        </div>
        <Button onClick={pick} loading={uploading} size="lg" style={{ background: "#DB2777", color: "#fff", border: "none" }}>
          <IcoPlus size={14} /> העלה סרטון
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="video/mp4,video/quicktime,video/webm"
          style={{ display: "none" }}
          onChange={onFileChosen}
        />
      </div>

      <div style={{
        padding: "var(--s-7) var(--s-5)",
        textAlign: "center",
        background: "var(--bg-tint)",
        color: "var(--ink-3)",
      }}>
        <p style={{ fontSize: "var(--t-md)", fontWeight: 700 }}>בקרוב</p>
        <p className="t-meta" style={{ marginTop: 6, maxWidth: 480, marginInline: "auto" }}>
          ה-AI יקבל את האיפיון של העסק (קטגוריה, שירותים, סגנון), יחלץ פריימים מתוך התמונות שכבר העלית, וייצר סרטון 9:16 או 16:9 לבחירתך.
        </p>
      </div>
    </div>
  );
}
