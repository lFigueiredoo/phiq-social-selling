import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useOrganization } from "@/context/OrganizationProvider";
import type { PanelMembership } from "@/lib/api/types";

interface OrganizationSwitcherProps {
  memberships: PanelMembership[];
  currentOrganizationId: string;
}

export function OrganizationSwitcher({
  memberships,
  currentOrganizationId,
}: OrganizationSwitcherProps) {
  const { selectOrganization } = useOrganization();
  const current = memberships.find((m) => m.organization_id === currentOrganizationId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          {current?.organization_name ?? "Selecionar organização"}
          <ChevronsUpDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {memberships.map((membership) => (
          <DropdownMenuItem
            key={membership.organization_id}
            onSelect={() => selectOrganization(membership.organization_id)}
          >
            {membership.organization_id === currentOrganizationId && (
              <Check className="size-3.5" />
            )}
            {membership.organization_name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
