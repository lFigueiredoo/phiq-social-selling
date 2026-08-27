import { Navigate } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useOrganization } from "@/context/OrganizationProvider";
import { useMemberships } from "@/hooks/useMemberships";

export function SelectOrganizationPage() {
  const { data, isLoading } = useMemberships();
  const { organizationId, selectOrganization } = useOrganization();

  if (isLoading) return null;

  const memberships = data?.memberships ?? [];
  const alreadyValid = memberships.some((m) => m.organization_id === organizationId);

  if (memberships.length <= 1 || alreadyValid) return <Navigate to="/" replace />;

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-4">
      <h1 className="font-heading text-lg font-medium">Selecione a organização</h1>
      <div className="flex flex-col gap-2">
        {memberships.map((membership) => (
          <Card key={membership.organization_id}>
            <CardContent>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 text-left"
                onClick={() => selectOrganization(membership.organization_id)}
              >
                <span>{membership.organization_name}</span>
                <Badge variant="secondary">{membership.role}</Badge>
              </button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
