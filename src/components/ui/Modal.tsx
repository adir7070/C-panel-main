import { useEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Button } from "./Button";

type Size = "sm" | "lg" | "xl";

interface Props {
  open: boolean;
  onClose: () => void;
  title?: string;
  eyebrow?: string;
  size?: Size;
  children: ReactNode;
  footer?: ReactNode;
}

/**
 * Animated modal:
 *   - Overlay fades in 200ms ease-out, fades out 150ms ease-in (per skill rule).
 *   - Dialog scales 0.96 → 1 + opacity 0 → 1.
 *   - prefers-reduced-motion: instant.
 *   - Esc closes; body scroll locked while open.
 *   - Focus restored to the previously-focused element when the modal closes.
 *   - Initial focus on the first focusable child of the dialog (or the close
 *     button if none) — keeps keyboard users from being dropped into limbo.
 */
export function Modal({ open, onClose, title, eyebrow, size = "sm", children, footer }: Props) {
  const reduce = useReducedMotion();
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  /* Latest onClose stashed in a ref so the open-effect below doesn't
     re-fire every render. Without this, an inline onClose like
     `onClose={() => setX(false)}` rebinds on every parent render —
     when the parent re-renders on every keystroke (typing into a
     modal input), the effect tears down and re-runs, restealing focus
     back to the first focusable element after 50ms. Symptom: typing
     one letter in a modal input jumps focus to the close button. */
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;

    /* Remember whoever was focused before, restore on close. */
    restoreFocusRef.current = (document.activeElement as HTMLElement) ?? null;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";

    /* Initial focus — first focusable element inside, fallback to dialog itself. */
    const focusTimer = window.setTimeout(() => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = dialog.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      (focusable ?? dialog).focus();
    }, 50);

    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      window.clearTimeout(focusTimer);
      restoreFocusRef.current?.focus?.();
    };
  }, [open]);

  const cls = ["modal", size === "lg" ? "modal-lg" : size === "xl" ? "modal-xl" : ""].filter(Boolean).join(" ");

  const overlayMotion = reduce
    ? { initial: false, animate: undefined, exit: undefined }
    : {
        initial: { opacity: 0 },
        animate: { opacity: 1, transition: { duration: 0.2, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
        exit:    { opacity: 0, transition: { duration: 0.15, ease: [0.4, 0, 1, 1] as [number, number, number, number] } },
      };
  const dialogMotion = reduce
    ? { initial: false, animate: undefined, exit: undefined }
    : {
        initial: { opacity: 0, scale: 0.96, y: 8 },
        animate: { opacity: 1, scale: 1,    y: 0, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
        exit:    { opacity: 0, scale: 0.97, y: 4, transition: { duration: 0.15, ease: [0.4, 0, 1, 1] as [number, number, number, number] } },
      };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="modal-overlay"
          onClick={onClose}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? "modal-title" : undefined}
          {...overlayMotion}
        >
          <motion.div
            ref={dialogRef}
            className={cls}
            onClick={e => e.stopPropagation()}
            tabIndex={-1}
            {...dialogMotion}
          >
            {(title || eyebrow) && (
              <div className="modal-head">
                <div>
                  {eyebrow && <p className="t-eyebrow" style={{ marginBottom: 6 }}>{eyebrow}</p>}
                  {title && <h2 id="modal-title" className="t-section">{title}</h2>}
                </div>
                <Button variant="quiet" onClick={onClose} size="sm">סגור</Button>
              </div>
            )}
            {children}
            {footer && <div className="modal-foot">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
