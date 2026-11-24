/* Role helpers shared by the router (src/App.tsx) and the sidebar.

   "sales" (מכירות) works leads: a lead dashboard on "/", the leads assigned
   to them, the clients those leads became, tasks and appointments. Every
   other screen is hidden from the menu and redirected to "/". The backend
   already scopes their data like an account manager's (own leads, own
   clients). */

export const SALES_PATHS = ["/", "/leads", "/clients", "/tasks", "/appointments"] as const;

export function isSalesRole(role: string | null | undefined): boolean {
  return role === "sales";
}

/** Whether a "sales" user may open this path (sub-paths included). */
export function salesCanOpen(pathname: string): boolean {
  return SALES_PATHS.some(p => (p === "/" ? pathname === "/" : pathname === p || pathname.startsWith(`${p}/`)));
}

export function roleLabelEn(role: string | null | undefined): string {
  if (role === "admin")      return "Administrator";
  if (role === "supervisor") return "Supervisor";
  if (role === "sales")      return "Sales";
  if (role === "finance")    return "Finance";
  return "Account Manager";
}
