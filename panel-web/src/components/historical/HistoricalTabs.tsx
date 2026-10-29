import { History, MessageSquareReply } from "lucide-react";
import { NavLink } from "react-router";
import { cn } from "@/lib/utils";

const TABS = [
  {
    to: "/historico",
    end: true,
    label: "Importar comentários",
    icon: History,
  },
  {
    to: "/historico/respostas",
    end: false,
    label: "Fila histórica",
    icon: MessageSquareReply,
  },
] as const;

export function HistoricalTabs() {
  return (
    <nav
      aria-label="Seções dos comentários históricos"
      className="flex w-fit max-w-full items-center gap-1 overflow-x-auto rounded-xl border bg-muted/35 p-1"
    >
      {TABS.map((tab) => {
        const Icon = tab.icon;

        return (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition",
                isActive
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )
            }
          >
            <Icon className="size-3.5" />
            {tab.label}
          </NavLink>
        );
      })}
    </nav>
  );
}
