import { Button } from "@/components/ui/button";
import { CalendarDays, ChevronRight, History } from "lucide-react";
import { format, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import { useNearestMovementDays } from "@/components/DateNavigator";

type Props = {
  date: string;
  hasMovement: boolean;
  onChange: (date: string) => void;
};

const fmt = (d: string) => format(parseISO(d + "T12:00:00"), "dd/MM", { locale: ptBR });

export default function NoMovementHint({ date, hasMovement, onChange }: Props) {
  const { prev, next, latest } = useNearestMovementDays(date);
  if (hasMovement) return null;
  if (!prev && !next && !latest) return null;
  return (
    <div className="mt-2 rounded-md border border-dashed bg-muted/30 p-2 space-y-1.5">
      <p className="text-[11px] text-muted-foreground flex items-center gap-1">
        <CalendarDays className="h-3 w-3" /> Este dia não tem movimento registrado.
      </p>
      <div className="flex flex-wrap gap-1">
        {prev && (
          <Button variant="outline" size="sm" className="h-6 text-[10px]" onClick={() => onChange(prev)}>
            ← {fmt(prev)}
          </Button>
        )}
        {next && (
          <Button variant="outline" size="sm" className="h-6 text-[10px]" onClick={() => onChange(next)}>
            {fmt(next)} →
          </Button>
        )}
        {latest && latest !== prev && latest !== next && (
          <Button variant="outline" size="sm" className="h-6 text-[10px]" onClick={() => onChange(latest)}>
            <History className="h-2.5 w-2.5 mr-0.5" /> Último ({fmt(latest)})
          </Button>
        )}
      </div>
    </div>
  );
}
