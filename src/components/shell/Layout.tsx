import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { CommandPalette } from "./CommandPalette";
import { PurchaseNotifier } from "./PurchaseNotifier";

interface ShellCtx {
  openCmdK: () => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
}
const Ctx = createContext<ShellCtx | null>(null);

export function useShell() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useShell must be used within Layout");
  return v;
}

interface Props {
  header: ReactNode;
  children: ReactNode;
}

const COLLAPSED_KEY = "cpanel_sidebar_collapsed";

export function Layout({ header, children }: Props) {
  const [cmdOpen, setCmdOpen] = useState(false);
  /* Persist the collapsed state across reloads. localStorage may throw
     in private-browsing edge cases, so wrap defensively. */
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === "1"; }
    catch { return false; }
  });

  const openCmdK       = useCallback(() => setCmdOpen(true), []);
  const toggleSidebar  = useCallback(() => {
    setSidebarCollapsed(c => {
      const next = !c;
      try { localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  }, []);

  /* Global Cmd+K / Ctrl+K hotkey + Cmd+B / Ctrl+B for sidebar (matches
     VS Code, Linear, Notion conventions). */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && k === "k") {
        e.preventDefault();
        setCmdOpen(o => !o);
      } else if ((e.metaKey || e.ctrlKey) && k === "b") {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleSidebar]);

  return (
    <Ctx.Provider value={{ openCmdK, sidebarCollapsed, toggleSidebar }}>
      <div className={"shell" + (sidebarCollapsed ? " sidebar-collapsed" : "")}>
        <Sidebar collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
        <div className="shell-main">
          {header}
          <main className="shell-content">{children}</main>
        </div>
      </div>
      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} />
      <PurchaseNotifier />
    </Ctx.Provider>
  );
}
