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
    <div className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center gap-4 p-4 text-center">
      <p className="text-sm">
        Sua conta ainda não tem acesso a nenhuma organização.
        <br />
        Contate um administrador.
      </p>
      <Button variant="outline" onClick={handleSignOut}>
        Sair
      </Button>
    </div>
  );
}
