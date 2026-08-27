import type { ReactNode } from "react";
import { OrganizationSwitcher } from "@/components/layout/OrganizationSwitcher";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/context/AuthProvider";
import { useOrganization } from "@/context/OrganizationProvider";
import { useMemberships } from "@/hooks/useMemberships";

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const { session, signOut } = useAuth();
  const { organizationId, clearOrganization } = useOrganization();
  const { data: membershipsData } = useMemberships();

  const memberships = membershipsData?.memberships ?? [];
  const currentOrganization = memberships.find((m) => m.organization_id === organizationId);

  async function handleSignOut() {
    await signOut();
    clearOrganization();
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
        <span className="font-heading text-lg font-medium">Painel de Aprovação</span>
        <div className="flex items-center gap-2">
          {memberships.length > 1 && currentOrganization && (
            <OrganizationSwitcher
              memberships={memberships}
              currentOrganizationId={currentOrganization.organization_id}
            />
          )}
          {memberships.length === 1 && currentOrganization && (
            <span className="text-sm text-muted-foreground">
              {currentOrganization.organization_name}
            </span>
          )}
          <span className="text-sm text-muted-foreground">{session?.user.email}</span>
          <Button variant="ghost" size="sm" onClick={handleSignOut}>
            Sair
          </Button>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
