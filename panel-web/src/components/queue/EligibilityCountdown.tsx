import { Clock3 } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn, formatCountdown, type CountdownUrgency } from "@/lib/utils";

interface EligibilityCountdownProps {
  eligibleUntil: string;
}

const URGENCY_CLASS: Record<CountdownUrgency, string> = {
  safe: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/45 dark:text-emerald-300",
  warning: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/45 dark:text-amber-300",
  critical: "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/45 dark:text-red-300",
  expired: "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/45 dark:text-red-300",
};

export function EligibilityCountdown({ eligibleUntil }: EligibilityCountdownProps) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const countdown = formatCountdown(eligibleUntil, now);

  return (
    <Badge
      variant="outline"
      className={cn("h-6 gap-1.5 border px-2.5 font-semibold", URGENCY_CLASS[countdown.urgency])}
    >
      <Clock3 className="size-3" />
      {countdown.label}
    </Badge>
  );
}
