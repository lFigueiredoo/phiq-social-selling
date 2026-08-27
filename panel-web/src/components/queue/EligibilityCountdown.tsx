import { Clock } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { formatCountdown, type CountdownUrgency } from "@/lib/utils";

interface EligibilityCountdownProps {
  eligibleUntil: string;
}

const URGENCY_VARIANT: Record<CountdownUrgency, "secondary" | "outline" | "destructive"> = {
  safe: "secondary",
  warning: "outline",
  critical: "destructive",
  expired: "destructive",
};

export function EligibilityCountdown({ eligibleUntil }: EligibilityCountdownProps) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const countdown = formatCountdown(eligibleUntil, now);

  return (
    <Badge variant={URGENCY_VARIANT[countdown.urgency]} className="gap-1">
      <Clock className="size-3" />
      {countdown.label}
    </Badge>
  );
}
