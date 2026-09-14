import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useAuth } from "./context/AuthContext";
import { LoginPage } from "./pages/LoginPage";
import { ClientListPage } from "./pages/ClientListPage";
import { ClientDetailPage } from "./pages/ClientDetailPage";
import { DashboardPage } from "./pages/DashboardPage";
import { GeneralChatPage } from "./pages/GeneralChatPage";
import { TasksPage } from "./pages/TasksPage";
import { AppointmentsPage } from "./pages/AppointmentsPage";
import { LogsPage } from "./pages/LogsPage";
import { LeadsPage } from "./pages/LeadsPage";
import { BroadcastPage } from "./pages/BroadcastPage";
import { PipelinePage } from "./pages/PipelinePage";
import { DigestPage } from "./pages/DigestPage";
import { CampaignsPage } from "./pages/CampaignsPage";
import { WalletPage } from "./pages/WalletPage";
import { AdminLeadsDistributionPage } from "./pages/admin/AdminLeadsDistributionPage";
import { ProductsReviewPage } from "./pages/ProductsReviewPage";
import { ReviewsPage } from "./pages/ReviewsPage";
import { InstructionsPage } from "./pages/InstructionsPage";
import { AdminDashboardPage } from "./pages/admin/AdminDashboardPage";
import { AdminClientsPage } from "./pages/admin/AdminClientsPage";
import { AdminEscalationsPage } from "./pages/admin/AdminEscalationsPage";
import { AdminAgentUpdatesPage } from "./pages/admin/AdminAgentUpdatesPage";
import { AdminRevenuePage } from "./pages/admin/AdminRevenuePage";
import { AdminIntegrationsPage } from "./pages/admin/AdminIntegrationsPage";
import { AdminBroadcastsPage } from "./pages/admin/AdminBroadcastsPage";
import { AdminReportsPage } from "./pages/admin/AdminReportsPage";
import { AdminUsersPage } from "./pages/admin/AdminUsersPage";
import { AdminInstructionsPage } from "./pages/admin/AdminInstructionsPage";
import { AuditLogPage } from "./pages/admin/AuditLogPage";
import { PersonalCatalogPage } from "./pages/PersonalCatalogPage";
import { Spinner } from "./components/ui/Spinner";

export default function App() {
  return (
    <BrowserRouter
      basename={import.meta.env.BASE_URL.replace(/\/$/, "") || "/"}>
      <AnimatedRoutes />
    </BrowserRouter>
  );
}

/**
 * Routes wrapped in AnimatePresence so each navigation does a subtle
 * fade between the old and new page. Keying off `location.pathname`
 * means only path changes trigger an animation; query/hash do not.
 * Honors prefers-reduced-motion (renders without transition).
 */
function AnimatedRoutes() {
  const location = useLocation();
  const reduce = useReducedMotion();

  return (
    <AnimatePresence
      mode='wait'
      initial={false}>
      <motion.div
        key={location.pathname}
        initial={reduce ? false : { opacity: 0 }}
        animate={
          reduce
            ? undefined
            : {
                opacity: 1,
                transition: { duration: 0.15, ease: [0.22, 1, 0.36, 1] },
              }
        }
        exit={
          reduce
            ? undefined
            : {
                opacity: 0,
                transition: { duration: 0.1, ease: [0.4, 0, 1, 1] },
              }
        }
        style={{ minHeight: "100vh" }}>
        <Routes location={location}>
          <Route
            path='/login'
            element={<LoginGuard />}
          />
          {/* Public client review — token-keyed, no JWT required */}
          <Route
            path='/products-review/:token'
            element={<ProductsReviewPage />}
          />
          <Route
            path='/'
            element={
              <Protected>
                <RoleHome />
              </Protected>
            }
          />
          <Route
            path='/clients'
            element={
              <Protected>
                <ClientListPage />
              </Protected>
            }
          />
          <Route
            path='/clients/:phone'
            element={
              <Protected>
                <ClientDetailPage />
              </Protected>
            }
          />
          <Route
            path='/clients/:phone/:tab'
            element={
              <Protected>
                <ClientDetailPage />
              </Protected>
            }
          />
          <Route
            path='/chat'
            element={
              <Protected>
                <GeneralChatPage />
              </Protected>
            }
          />
          <Route
            path='/broadcast'
            element={
              <Protected>
                <BroadcastPage />
              </Protected>
            }
          />
          <Route
            path='/leads'
            element={
              <Protected>
                <LeadsPage />
              </Protected>
            }
          />
          <Route
            path='/tasks'
            element={
              <Protected>
                <TasksPage />
              </Protected>
            }
          />
          <Route
            path='/appointments'
            element={
              <Protected>
                <AppointmentsPage />
              </Protected>
            }
          />
          <Route
            path='/logs'
            element={
              <Protected>
                <LogsPage />
              </Protected>
            }
          />
          <Route
            path='/pipeline'
            element={
              <Protected>
                <PipelinePage />
              </Protected>
            }
          />
          <Route
            path='/digest'
            element={
              <Protected>
                <DigestPage />
              </Protected>
            }
          />
          <Route
            path='/campaigns'
            element={
              <Protected>
                <CampaignsPage />
              </Protected>
            }
          />
          <Route
            path='/wallet'
            element={
              <Protected>
                <WalletPage />
              </Protected>
            }
          />
          <Route
            path='/admin/leads-distribution'
            element={
              <Protected>
                <AdminOnly>
                  <AdminLeadsDistributionPage />
                </AdminOnly>
              </Protected>
            }
          />
          <Route
            path='/catalog'
            element={
              <Protected>
                <PersonalCatalogPage />
              </Protected>
            }
          />
          <Route
            path='/reviews'
            element={
              <Protected>
                <ReviewsPage />
              </Protected>
            }
          />
          <Route
            path='/instructions'
            element={
              <Protected>
                <InstructionsPage />
              </Protected>
            }
          />
          {/* ── Admin panel (role-gated server-side; sidebar hidden client-side) ── */}
          <Route
            path='/admin'
            element={
              <Protected>
                <AdminOnly>
                  <AdminDashboardPage />
                </AdminOnly>
              </Protected>
            }
          />
          <Route
            path='/admin/clients'
            element={
              <Protected>
                <AdminOnly>
                  <AdminClientsPage />
                </AdminOnly>
              </Protected>
            }
          />
          <Route
            path='/admin/escalations'
            element={
              <Protected>
                <AdminOnly>
                  <OwnerOnly>
                    <AdminEscalationsPage />
                  </OwnerOnly>
                </AdminOnly>
              </Protected>
            }
          />
          <Route
            path='/admin/agent-updates'
            element={
              <Protected>
                <AdminOnly>
                  <OwnerOnly>
                    <AdminAgentUpdatesPage />
                  </OwnerOnly>
                </AdminOnly>
              </Protected>
            }
          />
          <Route
            path='/admin/finance/revenue'
            element={
              <Protected>
                <AdminOnly>
                  <AdminRevenuePage />
                </AdminOnly>
              </Protected>
            }
          />
          <Route
            path='/admin/integrations'
            element={
              <Protected>
                <AdminOnly>
                  <AdminIntegrationsPage />
                </AdminOnly>
              </Protected>
            }
          />
          <Route
            path='/admin/broadcasts'
            element={
              <Protected>
                <AdminOnly>
                  <AdminBroadcastsPage />
                </AdminOnly>
              </Protected>
            }
          />
          <Route
            path='/admin/reports'
            element={
              <Protected>
                <AdminOnly>
                  <AdminReportsPage />
                </AdminOnly>
              </Protected>
            }
          />
          <Route
            path='/admin/users'
            element={
              <Protected>
                <AdminOnly>
                  <AdminUsersPage />
                </AdminOnly>
              </Protected>
            }
          />
          <Route
            path='/admin/instructions'
            element={
              <Protected>
                <AdminOnly>
                  <AdminInstructionsPage />
                </AdminOnly>
              </Protected>
            }
          />
          <Route
            path='/admin/audit'
            element={
              <Protected>
                <AdminOnly>
                  <AuditLogPage />
                </AdminOnly>
              </Protected>
            }
          />
          <Route
            path='*'
            element={
              <Navigate
                to='/'
                replace
              />
            }
          />
        </Routes>
      </motion.div>
    </AnimatePresence>
  );
}

function LoginGuard() {
  const { agent, loading } = useAuth();
  if (loading) return <FullPageSpinner />;
  if (agent)
    return (
      <Navigate
        to='/'
        replace
      />
    );
  return <LoginPage />;
}

function Protected({ children }: { children: React.ReactNode }) {
  const { agent, loading } = useAuth();
  if (loading) return <FullPageSpinner />;
  if (!agent)
    return (
      <Navigate
        to='/login'
        replace
      />
    );
  return <>{children}</>;
}

/** Client-side admin gate — server enforces 403 too. */
function AdminOnly({ children }: { children: React.ReactNode }) {
  const { agent } = useAuth();
  if (!agent || agent.role !== "admin")
    return (
      <Navigate
        to='/'
        replace
      />
    );
  return <>{children}</>;
}

/** The single top owner (ADMIN-BOSS). Same check used elsewhere for the owner. */
export function isOwnerAgent(agent: { name?: string; phone?: string } | null | undefined) {
  return !!agent && (agent.name === "admin-boss"
    || (agent.phone ?? "").replace(/\D/g, "").endsWith("542587070"));
}

/** Owner-only gate — server's requireOwner enforces 403 too. */
function OwnerOnly({ children }: { children: React.ReactNode }) {
  const { agent } = useAuth();
  if (!isOwnerAgent(agent)) return <Navigate to='/admin' replace />;
  return <>{children}</>;
}

/** Root path: admins land on /admin, everyone else on the manager dashboard. */
function RoleHome() {
  const { agent } = useAuth();
  if (agent?.role === "admin")
    return (
      <Navigate
        to='/admin'
        replace
      />
    );
  return <DashboardPage />;
}

function FullPageSpinner() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}>
      <Spinner size='lg' />
    </div>
  );
}
