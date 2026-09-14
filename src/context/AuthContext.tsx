import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { type Agent, ApiError, getMe, login as apiLogin } from "../api/client";

interface AuthContextValue {
  agent: Agent | null;
  loading: boolean;
  login: (name: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("cpanel_token");
    if (!token) { setLoading(false); return; }
    let cancelled = false;
    getMe()
      .then(({ agent }) => { if (!cancelled) setAgent(agent); })
      .catch((err: unknown) => {
        /* Only drop the session when the server actually rejected the
           token (401/403). A transient 5xx / DB hiccup / proxy outage
           should not silently log the manager out. */
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          localStorage.removeItem("cpanel_token");
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function login(name: string, password: string) {
    const { agent, token } = await apiLogin(name, password);
    localStorage.setItem("cpanel_token", token);
    setAgent(agent);
  }

  function logout() {
    localStorage.removeItem("cpanel_token");
    setAgent(null);
  }

  return (
    <AuthContext.Provider value={{ agent, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
