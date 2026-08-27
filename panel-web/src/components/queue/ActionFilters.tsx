import { Filter, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  ActionType,
  CommercialPotential,
  Intent,
  PanelListActionsFilters,
} from "@/lib/api/types";

const INTENT_OPTIONS: { value: Intent; label: string }[] = [
  { value: "engagement", label: "Engajamento" },
  { value: "question", label: "Dúvida" },
  { value: "purchase_interest", label: "Interesse de compra" },
  { value: "product_interest", label: "Interesse no produto" },
  { value: "support", label: "Suporte" },
  { value: "complaint", label: "Reclamação" },
  { value: "partnership", label: "Parceria" },
  { value: "spam", label: "Spam" },
  { value: "other", label: "Outro" },
];

const COMMERCIAL_POTENTIAL_OPTIONS: { value: CommercialPotential; label: string }[] = [
  { value: "low", label: "Baixo" },
  { value: "medium", label: "Médio" },
  { value: "high", label: "Alto" },
  { value: "unknown", label: "Desconhecido" },
];

const ACTION_TYPE_OPTIONS: { value: ActionType; label: string }[] = [
  { value: "public_reply", label: "Resposta pública" },
  { value: "private_reply", label: "Resposta privada" },
];

interface ActionFiltersProps {
  filters: PanelListActionsFilters;
  onChange: (filters: PanelListActionsFilters) => void;
}

export function ActionFilters({ filters, onChange }: ActionFiltersProps) {
  const hasActiveFilters = Boolean(
    filters.intent || filters.commercial_potential || filters.action_type,
  );

  return (
    <section className="panel-surface flex flex-col gap-3 rounded-2xl p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-2 text-sm font-medium">
        <div className="flex size-8 items-center justify-center rounded-lg bg-secondary text-primary">
          <Filter className="size-4" />
        </div>
        <div>
          <p>Filtros da fila</p>
          <p className="text-xs font-normal text-muted-foreground">Encontre rapidamente o que merece prioridade.</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={filters.intent ?? "all"}
          onValueChange={(value) =>
            onChange({ ...filters, intent: value === "all" ? undefined : (value as Intent) })
          }
        >
          <SelectTrigger size="sm" className="min-w-38 bg-background">
            <SelectValue placeholder="Intenção" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas as intenções</SelectItem>
            {INTENT_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={filters.commercial_potential ?? "all"}
          onValueChange={(value) =>
            onChange({
              ...filters,
              commercial_potential: value === "all" ? undefined : (value as CommercialPotential),
            })
          }
        >
          <SelectTrigger size="sm" className="min-w-36 bg-background">
            <SelectValue placeholder="Potencial" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todo potencial</SelectItem>
            {COMMERCIAL_POTENTIAL_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={filters.action_type ?? "all"}
          onValueChange={(value) =>
            onChange({
              ...filters,
              action_type: value === "all" ? undefined : (value as ActionType),
            })
          }
        >
          <SelectTrigger size="sm" className="min-w-34 bg-background">
            <SelectValue placeholder="Tipo" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os tipos</SelectItem>
            {ACTION_TYPE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={() => onChange({})}>
            <RotateCcw className="size-3.5" />
            Limpar
          </Button>
        )}
      </div>
    </section>
  );
}
