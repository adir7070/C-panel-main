import type { ReactNode } from "react";

type Variant = "default" | "positive" | "warning" | "negative" | "clay";

interface Props {
  variant?: Variant;
  dot?: boolean;
  children: ReactNode;
}

export function Badge({ variant = "default", dot = false, children }: Props) {
  const cls = [
    "badge",
    variant === "positive" ? "badge-positive" :
    variant === "warning"  ? "badge-warning"  :
    variant === "negative" ? "badge-negative" :
    variant === "clay"     ? "badge-clay"     : "",
  ].filter(Boolean).join(" ");

  const dotCls = [
    "dot",
    variant === "positive" ? "dot-positive" :
    variant === "warning"  ? "dot-warning"  :
    variant === "negative" ? "dot-negative" : "",
  ].filter(Boolean).join(" ");

  return (
    <span className={cls}>
      {dot && <span className={dotCls} />}
      {children}
    </span>
  );
}
