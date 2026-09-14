import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import DashboardLayout from "./components/layout/DashboardLayout";
import LoginPage from "./pages/LoginPage";
import DashboardPage from "./pages/DashboardPage";
import UsersPage from "./pages/UsersPage";
import LeadsPage from "./pages/LeadsPage";
import FinancePage from "./pages/FinancePage";
import WhatsAppPage from "./pages/WhatsAppPage";
import ContentPage from "./pages/ContentPage";
import SupportPage from "./pages/SupportPage";
import AppointmentsPage from "./pages/AppointmentsPage";
import SystemPage from "./pages/SystemPage";

function ProtectedRoute({ children }) {
  const { token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <DashboardLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="leads" element={<LeadsPage />} />
        <Route path="finance" element={<FinancePage />} />
        <Route path="whatsapp" element={<WhatsAppPage />} />
        <Route path="content" element={<ContentPage />} />
        <Route path="support" element={<SupportPage />} />
        <Route path="appointments" element={<AppointmentsPage />} />
        <Route path="system" element={<SystemPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
