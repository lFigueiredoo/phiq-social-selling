import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export type CountdownUrgency = "safe" | "warning" | "critical" | "expired"

export interface CountdownInfo {
  label: string
  urgency: CountdownUrgency
}

// private_reply rows silently drop out of the panel queue once
// eligible_until passes (enforced server-side) — this is purely a display
// hint so reviewers don't lose one to expiry, not a source of truth.
export function formatCountdown(isoDeadline: string, now: Date = new Date()): CountdownInfo {
  const deadlineMs = new Date(isoDeadline).getTime()
  const diffMs = deadlineMs - now.getTime()

  if (diffMs <= 0) {
    return { label: "Expirado", urgency: "expired" }
  }

  const totalMinutes = Math.floor(diffMs / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  const label =
    hours > 0
      ? `Expira em ${hours}h${minutes.toString().padStart(2, "0")}min`
      : `Expira em ${minutes}min`

  let urgency: CountdownUrgency = "safe"
  if (diffMs <= 30 * 60_000) urgency = "critical"
  else if (diffMs <= 2 * 60 * 60_000) urgency = "warning"

  return { label, urgency }
}
