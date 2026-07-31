import { Badge } from "@/components/ui/badge";
import { AccessStatus, ACCESS_STATUS_LABEL } from "@/lib/access-control";

const VARIANT: Record<AccessStatus, "default" | "secondary" | "outline" | "destructive"> = {
  unconfigured: "outline",
  company_paused: "destructive",
  paused: "secondary",
  expired: "destructive",
  expiring: "secondary",
  active: "default",
  scheduled: "outline",
};

export default function AccessStatusBadge({
  status,
  className = "",
}: {
  status: AccessStatus;
  className?: string;
}) {
  return (
    <Badge variant={VARIANT[status]} className={`text-[9px] ${className}`}>
      {ACCESS_STATUS_LABEL[status]}
    </Badge>
  );
}
