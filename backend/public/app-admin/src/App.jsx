import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import DashboardLayout from "./components/layout/DashboardLayout";
import LoginPage from "./pages/LoginPage";
import UsersPage from "./pages/UsersPage";
import UserDetailPage from "./pages/UserDetailPage";
import ActivityPage from "./pages/ActivityPage";
import LogsPage from "./pages/LogsPage";
import UserActivityPage from "./pages/UserActivityPage";
import MetricsPage from "./pages/MetricsPage";
import ManagersPage from "./pages/ManagersPage";

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
        <Route index element={<Navigate to="/activity" replace />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="users/:phone" element={<UserDetailPage />} />
        <Route path="users/:phone/activity" element={<UserActivityPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="metrics" element={<MetricsPage />} />
        <Route path="managers" element={<ManagersPage />} />
        <Route path="logs" element={<LogsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/activity" replace />} />
    </Routes>
  );
}
