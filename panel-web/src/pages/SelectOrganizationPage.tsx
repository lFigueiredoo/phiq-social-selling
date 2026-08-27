import { ArrowRight, Building2 } from "lucide-react";
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
    <div className="grid min-h-screen place-items-center p-4">
      <div className="w-full max-w-lg">
        <div className="mb-5">
          <p className="panel-eyebrow">Acesso multi-organização</p>
          <h1 className="mt-1 font-heading text-2xl font-semibold">Onde você quer revisar agora?</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            A fila, os filtros e as decisões sempre ficam isolados por organização.
          </p>
        </div>
        <div className="flex flex-col gap-3">
          {memberships.map((membership) => (
            <Card key={membership.organization_id} className="panel-surface py-0 transition hover:shadow-md">
              <CardContent className="p-0">
                <button
                  type="button"
                  className="flex w-full items-center gap-3 p-4 text-left"
                  onClick={() => selectOrganization(membership.organization_id)}
                >
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-primary">
                    <Building2 className="size-4.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{membership.organization_name}</p>
                    <Badge variant="secondary" className="mt-1 capitalize">
                      {membership.role}
                    </Badge>
                  </div>
                  <ArrowRight className="size-4 text-muted-foreground" />
                </button>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
