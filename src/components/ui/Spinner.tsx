interface Props {
  size?: "sm" | "lg";
  inline?: boolean;
  label?: string;
}

export function Spinner({ size = "sm", inline = false, label }: Props) {
  const cls = size === "lg" ? "spin spin-lg" : "spin";
  if (inline) return <span className={cls} aria-label={label ?? "טוען"} />;
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "var(--s-3)", padding: "var(--s-7)" }}>
      <span className={cls} aria-label={label ?? "טוען"} />
      {label && <span className="t-meta">{label}</span>}
    </div>
  );
}
