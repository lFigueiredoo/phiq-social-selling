import { useEffect, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router";
import { useAuth } from "@/context/AuthProvider";
import { useOrganization } from "@/context/OrganizationProvider";
import { useMemberships } from "@/hooks/useMemberships";
import { LoginPage } from "@/pages/LoginPage";
import { NoAccessPage } from "@/pages/NoAccessPage";
import { QueuePage } from "@/pages/QueuePage";
import { SelectOrganizationPage } from "@/pages/SelectOrganizationPage";

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
  const validSelection = memberships.some((m) => m.organization_id === organizationId);
  const shouldAutoSelect = memberships.length === 1 && !validSelection;
  const soleOrganizationId = shouldAutoSelect ? memberships[0].organization_id : null;

  useEffect(() => {
    if (soleOrganizationId) {
      selectOrganization(soleOrganizationId);
    }
  }, [soleOrganizationId, selectOrganization]);

  if (authLoading) return <FullScreenLoading />;
  if (!session) return <Navigate to="/login" replace />;
  if (membershipsLoading) return <FullScreenLoading />;
  if (isError) return <FullScreenLoading />;
  if (memberships.length === 0) return <Navigate to="/sem-acesso" replace />;
  if (shouldAutoSelect) return <FullScreenLoading />;
  if (!validSelection) return <Navigate to="/selecionar-organizacao" replace />;

  return <>{children}</>;
}

export function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/sem-acesso" element={<NoAccessPage />} />
      <Route path="/selecionar-organizacao" element={<SelectOrganizationPage />} />
      <Route
        path="/"
        element={
          <Protected>
            <QueuePage />
          </Protected>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
