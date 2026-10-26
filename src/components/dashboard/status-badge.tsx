import { AlertTriangle, CheckCircle2, CircleHelp, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { Tone } from "@/lib/client/status";

const TONES = {
  ok: { variant: "success", Icon: CheckCircle2 },
  warn: { variant: "warning", Icon: AlertTriangle },
  bad: { variant: "destructive", Icon: XCircle },
  unknown: { variant: "secondary", Icon: CircleHelp },
} as const;

/** State badge: always an icon plus a label, never color alone. */
export function ToneBadge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const { variant, Icon } = TONES[tone];
  return (
    // Long labels ("Unknown · last known: …") wrap instead of being clipped on narrow screens.
    <Badge variant={variant} className="h-auto min-h-5 max-w-full text-left whitespace-normal">
      <Icon aria-hidden /> {children}
    </Badge>
  );
}
