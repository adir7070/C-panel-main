import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "default" | "ghost" | "clay" | "danger" | "quiet";
type Size = "sm" | "md" | "lg";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = "default",
  size = "md",
  loading = false,
  disabled,
  className = "",
  children,
  ...rest
}: Props) {
  const cls = [
    "btn",
    variant === "ghost"  ? "btn-ghost"  :
    variant === "clay"   ? "btn-clay"   :
    variant === "danger" ? "btn-danger" :
    variant === "quiet"  ? "btn-quiet"  : "",
    size === "sm" ? "btn-sm" : size === "lg" ? "btn-lg" : "",
    className,
  ].filter(Boolean).join(" ");

  return (
    <button {...rest} className={cls} disabled={disabled || loading} type={rest.type ?? "button"}>
      {loading ? <span className="spin" /> : null}
      {children}
    </button>
  );
}
