import { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Inbox } from "lucide-react";

type Props = {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void; variant?: "default" | "outline" | "secondary" };
  compact?: boolean;
};

/**
 * EmptyState reutilizável e profissional.
 * - icon: ícone opcional (Lucide); default Inbox
 * - title + description + action (label + onClick)
 * - compact: padding/altura menores
 */
export default function EmptyState({ icon, title, description, action, compact }: Props) {
  return (
    <Card className="border-dashed bg-muted/20">
      <CardContent className={compact ? "py-6 px-4" : "py-10 px-6"}>
        <div className="flex flex-col items-center text-center gap-2">
          <div className="rounded-full bg-muted p-3 text-muted-foreground">
            {icon ?? <Inbox className="h-5 w-5" />}
          </div>
          <p className="text-sm font-semibold text-foreground">{title}</p>
          {description && (
            <p className="text-xs text-muted-foreground max-w-sm">{description}</p>
          )}
          {action && (
            <Button
              size="sm"
              variant={action.variant ?? "default"}
              onClick={action.onClick}
              className="mt-2"
            >
              {action.label}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
