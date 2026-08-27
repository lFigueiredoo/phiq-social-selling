import { ShieldX } from "lucide-react";
import { Navigate } from "react-router";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/context/AuthProvider";
import { useOrganization } from "@/context/OrganizationProvider";
import { useMemberships } from "@/hooks/useMemberships";

export function NoAccessPage() {
  const { signOut } = useAuth();
  const { clearOrganization } = useOrganization();
  const { data, isLoading } = useMemberships();

  if (isLoading) return null;
  if ((data?.memberships.length ?? 0) > 0) return <Navigate to="/" replace />;

  async function handleSignOut() {
    await signOut();
    clearOrganization();
  }

  return (
    <div className="grid min-h-screen place-items-center p-4">
      <div className="panel-surface w-full max-w-md rounded-2xl p-6 text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
          <ShieldX className="size-5.5" />
        </div>
        <h1 className="font-heading text-xl font-semibold">Acesso ainda não provisionado</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
          Sua conta está autenticada, mas ainda não pertence a nenhuma organização ativa no painel. Solicite o provisionamento a um administrador.
        </p>
        <Button className="mt-5" variant="outline" onClick={handleSignOut}>
          Sair da conta
        </Button>
      </div>
    </div>
  );
}
