import { createContext, useContext, useState, useCallback } from "react";
import api from "../api/client";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => {
    const t = localStorage.getItem("admin_token");
    if (!t || t === "undefined" || t === "null") {
      localStorage.removeItem("admin_token");
      localStorage.removeItem("admin_agent");
      return null;
    }
    return t;
  });
  const [agent, setAgent] = useState(() => {
    const saved = localStorage.getItem("admin_agent");
    return saved ? JSON.parse(saved) : null;
  });

  const login = useCallback(async (name, password) => {
    const { data } = await api.post("/api/admin/login", { name, password });
    if (!data.agent?.token) throw new Error("Login failed — no token received");
    localStorage.setItem("admin_token", data.agent.token);
    localStorage.setItem("admin_agent", JSON.stringify(data.agent));
    setToken(data.agent.token);
    setAgent(data.agent);
    return data.agent;
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem("admin_token");
    localStorage.removeItem("admin_agent");
    setToken(null);
    setAgent(null);
  }, []);

  return (
    <AuthContext.Provider value={{ token, agent, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
