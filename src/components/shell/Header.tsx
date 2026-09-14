import type { ReactNode } from "react";
import { useShell } from "./Layout";
import { useAuth } from "../../context/AuthContext";
import { NotificationCenter } from "./NotificationCenter";
import { IcoSearch } from "../icons/Icons";

interface Props {
  eyebrow?: string;
  title: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  back?: ReactNode;
  hideSearch?: boolean;
}

export function Header({ eyebrow, title, meta, trailing, back, hideSearch }: Props) {
  const { openCmdK } = useShell();
  const { agent } = useAuth();

  const initial = (agent?.nickname || agent?.name || "?").charAt(0).toUpperCase();
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPod|iPad/.test(navigator.platform);

  return (
    <header className="shell-header">
      <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)", minWidth: 0, flex: 1 }}>
        {back}
        <div style={{ minWidth: 0 }}>
          {eyebrow && (
            <p style={{
              fontSize: 10, fontWeight: 700, color: "var(--ink-4)",
              letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 1,
            }}>
              {eyebrow}
            </p>
          )}
          <h1 style={{
            fontFamily: "var(--sans)",
            fontWeight: 700,
            fontSize: "var(--t-lg)",
            letterSpacing: "-0.01em",
            margin: 0,
            color: "var(--ink)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            lineHeight: 1.2,
          }}>
            {title}
          </h1>
          {meta && (
            <p style={{ fontSize: "var(--t-xs)", color: "var(--ink-3)", marginTop: 1, fontWeight: 500 }}>
              {meta}
            </p>
          )}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "var(--s-2)", flexShrink: 0 }}>
        {trailing}

        {!hideSearch && (
          <button className="header-search" onClick={openCmdK} type="button" title="חיפוש מהיר">
            <IcoSearch size={13} />
            <span style={{ color: "var(--ink-3)" }}>חפש...</span>
            <span className="header-search-kbd">{isMac ? "⌘K" : "Ctrl K"}</span>
          </button>
        )}

        <NotificationCenter />

        {agent && (
          <div
            title={`${agent.nickname || agent.name} · ${agent.role}`}
            style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "4px 10px 4px 4px",
              background: "var(--bg-tint)",
              border: "1px solid var(--rule)",
              borderRadius: "var(--r-pill)",
              cursor: "default",
            }}
          >
            <div style={{
              width: 28, height: 28, borderRadius: "50%",
              background: "var(--blue)",
              color: "#fff",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 12, fontWeight: 800, flexShrink: 0,
            }}>
              {initial}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 0, lineHeight: 1.15 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)" }}>{agent.nickname || agent.name}</span>
              <span style={{ fontSize: 10, color: "var(--ink-3)", fontWeight: 500 }}>{roleLabel(agent.role)}</span>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}

function roleLabel(role: string): string {
  if (role === "admin")      return "Administrator";
  if (role === "supervisor") return "Supervisor";
  if (role === "manager")    return "Account Manager";
  return role;
}
