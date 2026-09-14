import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

type ToastVariant = "default" | "ok" | "warn" | "error";

interface Toast {
  id: number;
  text: string;
  variant: ToastVariant;
}

interface ToastApi {
  show: (text: string, variant?: ToastVariant) => void;
  ok:    (text: string) => void;
  warn:  (text: string) => void;
  error: (text: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let nextId = 1;
const TIMEOUT_MS = 4200;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const remove = useCallback((id: number) => {
    setToasts(t => t.filter(x => x.id !== id));
  }, []);

  const show = useCallback((text: string, variant: ToastVariant = "default") => {
    const id = nextId++;
    setToasts(t => [...t, { id, text, variant }]);
    /* Single source of truth for auto-dismiss — was previously
       set in BOTH show() and ToastItem useEffect, which fired remove
       twice and caused console warnings on rapid stacks. */
    window.setTimeout(() => remove(id), TIMEOUT_MS);
  }, [remove]);

  const api: ToastApi = {
    show,
    ok:    text => show(text, "ok"),
    warn:  text => show(text, "warn"),
    error: text => show(text, "error"),
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onClose={remove} />
    </ToastContext.Provider>
  );
}

function ToastViewport({ toasts, onClose }: { toasts: Toast[]; onClose: (id: number) => void }) {
  return (
    <div className="toast-wrap" aria-live="polite" aria-atomic="false">
      <AnimatePresence initial={false}>
        {toasts.map(t => <ToastItem key={t.id} toast={t} onClose={onClose} />)}
      </AnimatePresence>
    </div>
  );
}

function ToastItem({ toast, onClose }: { toast: Toast; onClose: (id: number) => void }) {
  const reduce = useReducedMotion();

  const cls =
    toast.variant === "ok"    ? "toast toast-ok"    :
    toast.variant === "warn"  ? "toast toast-warn"  :
    toast.variant === "error" ? "toast toast-error" : "toast";

  /* Slide-in from inline-end (RTL: from the right edge), fade-out in place.
     Spring physics on entry give that "smart-platform" responsive feel
     without being bouncy. */
  const motionProps = reduce
    ? { initial: false }
    : {
        initial: { opacity: 0, x: 24, scale: 0.96 },
        animate: { opacity: 1, x: 0,  scale: 1,
                   transition: { type: "spring" as const, stiffness: 380, damping: 30 } },
        exit:    { opacity: 0, x: 24, scale: 0.98,
                   transition: { duration: 0.18, ease: [0.4, 0, 1, 1] as [number, number, number, number] } },
        layout:  true,
      };

  return (
    <motion.div className={cls} role="status" {...motionProps}>
      <span style={{ flex: 1 }}>{toast.text}</span>
      <button
        onClick={() => onClose(toast.id)}
        aria-label="סגור התראה"
        className="t-eyebrow"
        style={{ background: "transparent", border: 0, color: "inherit", cursor: "pointer", padding: 0, opacity: 0.7 }}
      >
        סגור
      </button>
    </motion.div>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
