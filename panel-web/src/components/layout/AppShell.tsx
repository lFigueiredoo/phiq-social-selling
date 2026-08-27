import type { ReactNode } from "react";
import { Building2, LogOut, ShieldCheck } from "lucide-react";
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
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-border/75 bg-background/88 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <ShieldCheck className="size-4.5" />
            </div>
            <div className="min-w-0">
              <p className="panel-eyebrow">PHIQ · Social Selling</p>
              <p className="truncate text-sm font-semibold text-foreground">Painel de aprovação</p>
            </div>
          </div>

          <div className="flex min-w-0 items-center gap-2">
            {memberships.length > 1 && currentOrganization && (
              <OrganizationSwitcher
                memberships={memberships}
                currentOrganizationId={currentOrganization.organization_id}
              />
            )}
            {memberships.length === 1 && currentOrganization && (
              <div className="hidden items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1.5 text-xs font-medium sm:flex">
                <Building2 className="size-3.5 text-primary" />
                <span className="max-w-48 truncate">{currentOrganization.organization_name}</span>
              </div>
            )}
            <span className="hidden max-w-52 truncate text-xs text-muted-foreground lg:block">
              {session?.user.email}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={handleSignOut}
            >
              <LogOut className="size-3.5" />
              <span className="hidden sm:inline">Sair</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        {children}
      </main>
    </div>
  );
}
