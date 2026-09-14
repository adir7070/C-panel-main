import { useEffect, useRef, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import {
  startFbConnect,
  submitFbCode,
  pickFbMethod,
  saveFbResult,
  type FbConnectStart,
} from "../../api/client";

type Stage =
  | "idle"
  | "connecting"
  | "screenshot"
  | "two_factor"
  | "method_picker"
  | "setup"
  | "done"
  | "error";

interface Props {
  phone: string;
  open: boolean;
  onClose: () => void;
  onSuccess: (result: { fbUserId?: string }) => void;
}

export function FbConnectModal({ phone, open, onClose, onSuccess }: Props) {
  const [stage, setStage] = useState<Stage>("idle");
  const [sessionId, setSessionId] = useState("");
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [methods, setMethods] = useState<{ label: string; value: string }[]>([]);
  const [setupSteps, setSetupSteps] = useState<{ label: string; done: boolean }[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!open) {
      setStage("idle");
      setCode("");
      setErrorMsg("");
      setScreenshot(null);
      esRef.current?.close();
    }
  }, [open]);

  function closeEs() {
    esRef.current?.close();
    esRef.current = null;
  }

  function openScreenshotStream(sid: string) {
    closeEs();
    const token = localStorage.getItem("cpanel_token") ?? "";
    const es = new EventSource(`/api/cpanel/clients/${encodeURIComponent(phone)}/fb-connect/${sid}/stream?token=${encodeURIComponent(token)}`);
    esRef.current = es;
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.type === "ping" || d.type === "connected") return;
        if (d.screenshot) setScreenshot(d.screenshot);
        if (d.type === "two_factor") { closeEs(); setStage("two_factor"); }
        if (d.type === "method_picker" && d.options) { closeEs(); setMethods(d.options); setStage("method_picker"); }
        if (d.type === "setup") { closeEs(); openSetupStream(sid); }
        if (d.type === "failed") { closeEs(); setErrorMsg(d.reason ?? "החיבור נכשל"); setStage("error"); }
      } catch { /* ignore parse errors */ }
    };
    es.onerror = () => { closeEs(); setErrorMsg("החיבור לשרת נותק"); setStage("error"); };
  }

  function openSetupStream(sid: string) {
    setStage("setup");
    closeEs();
    const token = localStorage.getItem("cpanel_token") ?? "";
    const es = new EventSource(`/api/cpanel/clients/${encodeURIComponent(phone)}/fb-connect/${sid}/setup-stream?token=${encodeURIComponent(token)}`);
    esRef.current = es;
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.type === "ping" || d.type === "connected") return;
        if (d.type === "step") {
          setSetupSteps(prev => {
            const exists = prev.find(s => s.label === d.label);
            if (exists) return prev.map(s => s.label === d.label ? { ...s, done: d.done ?? s.done } : s);
            return [...prev, { label: d.label, done: false }];
          });
        }
        if (d.type === "done") {
          closeEs();
          saveFbResult(phone, { fbUserId: d.fbUserId }).catch(() => {});
          onSuccess({ fbUserId: d.fbUserId });
          setStage("done");
        }
        if (d.type === "failed") { closeEs(); setErrorMsg(d.reason ?? "ההגדרה נכשלה"); setStage("error"); }
      } catch { /* ignore */ }
    };
    es.onerror = () => { closeEs(); setErrorMsg("החיבור לשרת נותק"); setStage("error"); };
  }

  async function handleStart() {
    setStage("connecting");
    setErrorMsg("");
    setScreenshot(null);
    setSetupSteps([]);
    try {
      const res: FbConnectStart = await startFbConnect(phone);
      const sid = res.sessionId ?? "";
      setSessionId(sid);
      if (res.status === "setup") {
        openSetupStream(sid);
      } else if (res.status === "two_factor") {
        setStage("screenshot");
        openScreenshotStream(sid);
      } else if (res.status === "method_picker" && res.options) {
        setMethods(res.options);
        setStage("method_picker");
      } else if (res.status === "failed") {
        setErrorMsg(res.reason ?? "החיבור נכשל");
        setStage("error");
      } else {
        setStage("screenshot");
        openScreenshotStream(sid);
      }
    } catch (err: any) {
      setErrorMsg(err?.message ?? "שגיאה בהתחלת החיבור");
      setStage("error");
    }
  }

  async function handleCode() {
    if (!code.trim()) return;
    try {
      const res: any = await submitFbCode(phone, sessionId, code.trim());
      setCode("");
      if (res?.status === "setup") {
        openSetupStream(sessionId);
      } else {
        setStage("screenshot");
        openScreenshotStream(sessionId);
      }
    } catch (err: any) {
      setErrorMsg(err?.message ?? "הקוד שגוי");
      setStage("error");
    }
  }

  async function handleMethod(method: string) {
    try {
      const res: any = await pickFbMethod(phone, sessionId, method);
      if (res?.status === "two_factor") {
        setStage("screenshot");
        openScreenshotStream(sessionId);
      }
    } catch (err: any) {
      setErrorMsg(err?.message ?? "שגיאה בבחירת שיטה");
      setStage("error");
    }
  }

  const titles: Record<Stage, string> = {
    idle: "חיבור פייסבוק",
    connecting: "מתחבר לפייסבוק...",
    screenshot: "מתחבר לפייסבוק...",
    two_factor: "אימות דו-שלבי",
    method_picker: "בחר שיטת אימות",
    setup: "מגדיר חשבון...",
    done: "החיבור הצליח!",
    error: "שגיאה",
  };

  return (
    <Modal open={open} onClose={onClose} title={titles[stage]} eyebrow="Facebook">
      <div style={{ display: "grid", gap: "var(--s-5)", minHeight: 120 }}>

        {/* idle */}
        {stage === "idle" && (
          <div style={{ textAlign: "center", paddingTop: 8 }}>
            <p className="t-body" style={{ marginBottom: "var(--s-5)" }}>
              לחץ להתחיל את תהליך חיבור פייסבוק באמצעות פרטי הכניסה השמורים.
            </p>
            <Button onClick={handleStart}>התחבר</Button>
          </div>
        )}

        {/* connecting */}
        {(stage === "connecting") && (
          <div style={{ textAlign: "center", padding: "var(--s-6) 0" }}>
            <p className="t-body">מתחבר לפייסבוק...</p>
          </div>
        )}

        {/* screenshot */}
        {stage === "screenshot" && (
          <div style={{ textAlign: "center" }}>
            {screenshot && (
              <img
                src={`data:image/png;base64,${screenshot}`}
                alt="browser screenshot"
                style={{ width: "100%", borderRadius: "var(--r-2)", border: "1px solid var(--rule)" }}
              />
            )}
            {!screenshot && <p className="t-body">ממתין לתגובה מהדפדפן...</p>}
          </div>
        )}

        {/* 2FA code */}
        {stage === "two_factor" && (
          <>
            {screenshot && (
              <img src={`data:image/png;base64,${screenshot}`} alt="browser"
                style={{ width: "100%", borderRadius: "var(--r-2)", border: "1px solid var(--rule)" }} />
            )}
            <p className="t-body">הכנס את קוד האימות שקיבלת:</p>
            <input
              autoFocus
              inputMode="numeric"
              maxLength={8}
              value={code}
              onChange={e => setCode(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleCode()}
              placeholder="123456"
              dir="ltr"
              style={{
                border: "1px solid var(--rule-strong)",
                borderRadius: "var(--r-2)",
                padding: "10px 14px",
                fontSize: 18,
                textAlign: "center",
                letterSpacing: 4,
                width: "100%",
              }}
            />
            <Button onClick={handleCode} disabled={!code.trim()}>אשר קוד</Button>
          </>
        )}

        {/* method picker */}
        {stage === "method_picker" && (
          <>
            <p className="t-body">בחר שיטת אימות:</p>
            <div style={{ display: "grid", gap: "var(--s-3)" }}>
              {methods.map(m => (
                <Button key={m.value} variant="clay" onClick={() => handleMethod(m.value)}>
                  {m.label}
                </Button>
              ))}
            </div>
          </>
        )}

        {/* setup */}
        {stage === "setup" && (
          <div>
            <p className="t-body" style={{ marginBottom: "var(--s-4)" }}>מגדיר את החשבון...</p>
            <div style={{ display: "grid", gap: "var(--s-3)" }}>
              {setupSteps.map((s, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: "var(--s-3)" }}>
                  <span style={{ color: s.done ? "var(--positive, #16a34a)" : "var(--ink-3)", fontSize: 16 }}>
                    {s.done ? "✓" : "○"}
                  </span>
                  <span className="t-body" style={{ color: s.done ? "var(--ink)" : "var(--ink-2)" }}>
                    {s.label}
                  </span>
                </div>
              ))}
              {setupSteps.length === 0 && <p className="t-caption">ממתין להתחלת ההגדרה...</p>}
            </div>
          </div>
        )}

        {/* done */}
        {stage === "done" && (
          <div style={{ textAlign: "center" }}>
            <p style={{ fontSize: 40 }}>✅</p>
            <p className="t-body">פייסבוק חובר בהצלחה!</p>
          </div>
        )}

        {/* error */}
        {stage === "error" && (
          <div style={{ textAlign: "center" }}>
            <p className="t-body" style={{ color: "var(--negative)", marginBottom: "var(--s-4)" }}>
              {errorMsg || "אירעה שגיאה"}
            </p>
            <Button variant="ghost" onClick={() => setStage("idle")}>נסה שוב</Button>
          </div>
        )}

      </div>
    </Modal>
  );
}
