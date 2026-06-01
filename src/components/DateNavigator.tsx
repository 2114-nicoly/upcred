import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { format, addDays, isToday } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, CalendarDays, Clock, History, FileText, ArrowLeftToLine, ArrowRightToLine } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useWorkerFilter } from "@/hooks/useWorkerFilter";
import { useMovementDays } from "@/hooks/useMovementDays";
import MovementDaysSelector from "@/components/MovementDaysSelector";

type Props = {
  date: string;
  onChange: (date: string) => void;
  /** Page origin — affects calendar click navigation and quick buttons. */
  origin?: "rota" | "caixa" | "relatorio";
  /** Hide the secondary quick buttons row (Historico/Relatorio). */
  hideQuickLinks?: boolean;
};

export default function DateNavigator({ date, onChange, origin = "rota", hideQuickLinks = false }: Props) {
  const navigate = useNavigate();
  const today = format(new Date(), "yyyy-MM-dd");
  const [open, setOpen] = useState(false);
  const { isAdmin } = useAuth();
  const { selectedWorkerId, selectedAdminId } = useWorkerFilter();
  const { days } = useMovementDays({
    workerId: isAdmin ? selectedWorkerId : null,
    adminId: isAdmin && !selectedWorkerId ? selectedAdminId : null,
  });
  const lastWithMovement = days.find((d) => d.date < date)?.date ?? days[0]?.date ?? null;
  let nextWithMovement: string | null = null;
  for (const d of days) {
    if (d.date > date) nextWithMovement = d.date;
    else break;
  }

  const change = (offset: number) => {
    const d = new Date(date + "T12:00:00");
    onChange(format(addDays(d, offset), "yyyy-MM-dd"));
  };

  const dateObj = new Date(date + "T12:00:00");

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={() => change(-1)} title="Dia anterior">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <button
          onClick={() => setOpen(true)}
          className="flex-1 rounded-md border bg-card px-2 py-1.5 text-center transition-colors hover:bg-accent"
        >
          <p className="text-xs font-medium capitalize leading-tight">
            {format(dateObj, "EEE, dd 'de' MMM", { locale: ptBR })}
          </p>
          <p className="text-[9px] text-muted-foreground flex items-center justify-center gap-1">
            <CalendarDays className="h-2.5 w-2.5" /> Calendário / dias com mov.
          </p>
        </button>
        <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={() => change(1)} title="Próximo dia">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-1">
        <Button
          variant={isToday(dateObj) ? "default" : "outline"}
          size="sm"
          className="h-7 text-[10px] px-1"
          onClick={() => onChange(today)}
          disabled={isToday(dateObj)}
          title="Ir para hoje"
        >
          <Clock className="h-3 w-3 mr-0.5" /> Hoje
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[10px] px-1"
          onClick={() => lastWithMovement && onChange(lastWithMovement)}
          disabled={!lastWithMovement || lastWithMovement === date}
          title={lastWithMovement ? `Último com mov.: ${lastWithMovement}` : "Sem movimento anterior"}
        >
          <ArrowLeftToLine className="h-3 w-3 mr-0.5" /> Último mov.
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[10px] px-1"
          onClick={() => nextWithMovement && onChange(nextWithMovement)}
          disabled={!nextWithMovement}
          title={nextWithMovement ? `Próximo com mov.: ${nextWithMovement}` : "Sem movimento posterior"}
        >
          <ArrowRightToLine className="h-3 w-3 mr-0.5" /> Próximo mov.
        </Button>
      </div>
      {!hideQuickLinks && (
        <div className="grid grid-cols-2 gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[10px] px-1"
            onClick={() => navigate("/cash-history")}
            title="Abrir histórico"
          >
            <History className="h-3 w-3 mr-0.5" /> Histórico
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[10px] px-1"
            onClick={() => navigate(`/daily-report?date=${date}`)}
            title="Abrir relatório do dia"
          >
            <FileText className="h-3 w-3 mr-0.5" /> Relatório
          </Button>
        </div>
      )}
      <MovementDaysSelector open={open} onOpenChange={setOpen} onSelectDate={onChange} origin={origin} />
    </div>
  );
}

/** Returns nearest movement dates around a given date (prev and next). */
export function useNearestMovementDays(date: string) {
  const { isAdmin } = useAuth();
  const { selectedWorkerId, selectedAdminId } = useWorkerFilter();
  const { days } = useMovementDays({
    workerId: isAdmin ? selectedWorkerId : null,
    adminId: isAdmin && !selectedWorkerId ? selectedAdminId : null,
  });
  const prev = days.find((d) => d.date < date)?.date ?? null;
  let next: string | null = null;
  for (const d of days) {
    if (d.date > date) next = d.date;
    else break;
  }
  const latest = days[0]?.date ?? null;
  return { prev, next, latest };
}
