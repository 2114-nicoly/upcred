import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { format, isToday, isYesterday, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/loan-utils";
import { CalendarDays, Lock, Wallet, FileText, Loader2 } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useWorkerFilter } from "@/hooks/useWorkerFilter";
import { useMovementDays } from "@/hooks/useMovementDays";

type Props = {
  /** Excludes this date from the list (typically the currently-viewed day). */
  excludeDate?: string;
  /** How many recent days to show. */
  limit?: number;
};

function labelFor(dateStr: string) {
  const d = parseISO(dateStr + "T12:00:00");
  if (isToday(d)) return "Hoje";
  if (isYesterday(d)) return "Ontem";
  return format(d, "EEE, dd 'de' MMM", { locale: ptBR });
}

export default function RecentWorkDays({ excludeDate, limit = 4 }: Props) {
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const { selectedWorkerId, selectedAdminId } = useWorkerFilter();
  const { days, loading } = useMovementDays({
    workerId: isAdmin ? selectedWorkerId : null,
    adminId: isAdmin && !selectedWorkerId ? selectedAdminId : null,
  });

  const recent = useMemo(
    () => days.filter((d) => !excludeDate || d.date !== excludeDate).slice(0, limit),
    [days, excludeDate, limit]
  );

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Carregando últimos dias...
      </div>
    );
  }
  if (recent.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
          <CalendarDays className="h-3 w-3" /> Últimos dias trabalhados
        </p>
        <button
          className="text-[10px] text-primary hover:underline"
          onClick={() => navigate("/daily-cash-history")}
        >
          Ver tudo
        </button>
      </div>
      <div className="space-y-1.5">
        {recent.map((d) => (
          <Card key={d.date} className="shadow-none">
            <CardContent className="p-2 space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <p className="text-xs font-semibold capitalize leading-tight truncate">{labelFor(d.date)}</p>
                  <p className="text-[9px] text-muted-foreground">{d.date}</p>
                </div>
                {d.status === "closed" ? (
                  <Badge variant="secondary" className="text-[9px] h-4 gap-0.5">
                    <Lock className="h-2.5 w-2.5" /> Fechado
                  </Badge>
                ) : d.status === "open" ? (
                  <Badge className="bg-primary text-primary-foreground text-[9px] h-4">Aberto</Badge>
                ) : null}
              </div>
              <div className="grid grid-cols-2 gap-x-2 text-[10px]">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Entradas</span>
                  <span className="text-success tabular-nums">+{formatCurrency(d.entradas)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Saídas</span>
                  <span className="text-destructive tabular-nums">-{formatCurrency(d.saidas)}</span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[10px] px-1"
                  onClick={() => navigate(`/caixa?date=${d.date}`)}
                >
                  <Wallet className="h-3 w-3 mr-0.5" /> Caixa
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[10px] px-1"
                  onClick={() => navigate(`/daily-report?date=${d.date}`)}
                >
                  <FileText className="h-3 w-3 mr-0.5" /> Relatório
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
