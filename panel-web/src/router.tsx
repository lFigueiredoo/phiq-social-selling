import { useEffect, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router";
import { lazy, Suspense } from "react";
import { useAuth } from "@/context/AuthProvider";
import { useOrganization } from "@/context/OrganizationProvider";
import { useMemberships } from "@/hooks/useMemberships";
const HistoricalCommentsPage = lazy(() => import("@/pages/HistoricalCommentsPage")
  .then((module) => ({ default: module.HistoricalCommentsPage })));
const LoginPage = lazy(() => import("@/pages/LoginPage")
  .then((module) => ({ default: module.LoginPage })));
const NoAccessPage = lazy(() => import("@/pages/NoAccessPage")
  .then((module) => ({ default: module.NoAccessPage })));
const QueuePage = lazy(() => import("@/pages/QueuePage")
  .then((module) => ({ default: module.QueuePage })));
const SelectOrganizationPage = lazy(() => import("@/pages/SelectOrganizationPage")
  .then((module) => ({ default: module.SelectOrganizationPage })));
const SocialOverviewPage = lazy(() => import("@/pages/SocialSellingPage")
  .then((module) => ({ default: module.SocialOverviewPage })));
const SocialLeadsPage = lazy(() => import("@/pages/SocialSellingPage")
  .then((module) => ({ default: module.SocialLeadsPage })));
const SocialFunnelPage = lazy(() => import("@/pages/SocialSellingPage")
  .then((module) => ({ default: module.SocialFunnelPage })));
const SocialLeadDetailPage = lazy(() => import("@/pages/SocialLeadDetailPage")
  .then((module) => ({ default: module.SocialLeadDetailPage })));

function FullScreenLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
      Carregando…
    </div>
  );
}

function Protected({ children }: { children: ReactNode }) {
  const { session, isLoading: authLoading } = useAuth();
  const { organizationId, selectOrganization } = useOrganization();
  const { data, isLoading: membershipsLoading, isError } = useMemberships();

  const memberships = data?.memberships ?? [];
  const validSelection = memberships.some(
    (m) => m.organization_id === organizationId,
  );
  const shouldAutoSelect =
    memberships.length === 1 && !validSelection;
  const soleOrganizationId = shouldAutoSelect
    ? memberships[0].organization_id
    : null;

  useEffect(() => {
    if (soleOrganizationId) {
      selectOrganization(soleOrganizationId);
    }
  }, [soleOrganizationId, selectOrganization]);

  if (authLoading) return <FullScreenLoading />;
  if (!session) return <Navigate to="/login" replace />;
  if (membershipsLoading) return <FullScreenLoading />;
  if (isError) return <FullScreenLoading />;
  if (memberships.length === 0) {
    return <Navigate to="/sem-acesso" replace />;
  }
  if (shouldAutoSelect) return <FullScreenLoading />;
  if (!validSelection) {
    return <Navigate to="/selecionar-organizacao" replace />;
  }

  return <>{children}</>;
}

function AdminOnly({ children }: { children: ReactNode }) {
  const { organizationId } = useOrganization();
  const { data, isLoading } = useMemberships();

  if (isLoading) return <FullScreenLoading />;

  const membership = data?.memberships.find(
    (item) => item.organization_id === organizationId,
  );

  if (!membership || membership.role !== "admin") {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

export function AppRouter() {
  return (
    <Suspense fallback={<FullScreenLoading />}>
      <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/sem-acesso" element={<NoAccessPage />} />
      <Route
        path="/selecionar-organizacao"
        element={<SelectOrganizationPage />}
      />
      <Route
        path="/"
        element={
          <Protected>
            <QueuePage />
          </Protected>
        }
      />
      <Route
        path="/historico"
        element={
          <Protected>
            <AdminOnly>
              <HistoricalCommentsPage />
            </AdminOnly>
          </Protected>
        }
      />
      <Route path="/social-selling" element={<Protected><SocialOverviewPage /></Protected>} />
      <Route path="/social-selling/leads" element={<Protected><SocialLeadsPage /></Protected>} />
      <Route path="/social-selling/funil" element={<Protected><SocialFunnelPage /></Protected>} />
      <Route path="/social-selling/lead/:id" element={<Protected><SocialLeadDetailPage /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
