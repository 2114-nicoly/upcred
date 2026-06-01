import { useMemo, useState } from "react";
import { format, isToday, isYesterday, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Calendar } from "@/components/ui/calendar";
import { formatCurrency } from "@/lib/loan-utils";
import { CalendarDays, ChevronRight, FileText, Loader2, Lock, Wallet, MapPin } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { MovementDay, useMovementDays } from "@/hooks/useMovementDays";
import { useAuth } from "@/hooks/useAuth";
import { useWorkerFilter } from "@/hooks/useWorkerFilter";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectDate: (date: string) => void;
  /** Optional: navigate also offered as inline actions. */
  withActions?: boolean;
  /** Origin used to navigate when clicking a calendar day with action context. */
  origin?: "rota" | "caixa" | "relatorio";
};

function labelFor(dateStr: string) {
  const d = parseISO(dateStr + "T12:00:00");
  if (isToday(d)) return "Hoje";
  if (isYesterday(d)) return "Ontem";
  return format(d, "EEE, dd 'de' MMM", { locale: ptBR });
}

export default function MovementDaysSelector({ open, onOpenChange, onSelectDate, withActions = false, origin }: Props) {
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const { selectedWorkerId, selectedAdminId } = useWorkerFilter();
  const { days, loading } = useMovementDays({
    workerId: isAdmin ? selectedWorkerId : null,
    adminId: isAdmin && !selectedWorkerId ? selectedAdminId : null,
  });
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"list" | "calendar">("list");

  const filtered = useMemo(() => {
    if (!q) return days;
    const term = q.toLowerCase();
    return days.filter((d) => d.date.includes(term) || labelFor(d.date).toLowerCase().includes(term));
  }, [days, q]);

  const byDate = useMemo(() => {
    const m = new Map<string, MovementDay>();
    for (const d of days) m.set(d.date, d);
    return m;
  }, [days]);

  const closedDates = useMemo(() => days.filter(d => d.status === "closed").map(d => parseISO(d.date + "T12:00:00")), [days]);
  const openDates = useMemo(() => days.filter(d => d.status === "open").map(d => parseISO(d.date + "T12:00:00")), [days]);
  const cancelledDates = useMemo(() => days.filter(d => d.status === "cancelled").map(d => parseISO(d.date + "T12:00:00")), [days]);

  const handleCalendarSelect = (d?: Date) => {
    if (!d) return;
    const dateStr = format(d, "yyyy-MM-dd");
    onOpenChange(false);
    if (origin === "rota") navigate(`/?date=${dateStr}`);
    else if (origin === "caixa") navigate(`/caixa?date=${dateStr}`);
    else if (origin === "relatorio") navigate(`/daily-report?date=${dateStr}`);
    else onSelectDate(dateStr);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <CalendarDays className="h-4 w-4" /> Dias com movimento
          </DialogTitle>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as any)} className="flex flex-col flex-1 overflow-hidden">
          <TabsList className="grid grid-cols-2 h-8">
            <TabsTrigger value="list" className="text-xs">Lista</TabsTrigger>
            <TabsTrigger value="calendar" className="text-xs">Calendário</TabsTrigger>
          </TabsList>

          <TabsContent value="list" className="flex-1 overflow-hidden flex flex-col space-y-2 mt-2">
            <Input placeholder="Filtrar (data ou dia)" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 text-xs" />
            <div className="overflow-y-auto flex-1 space-y-1.5 pr-1">
              {loading ? (
                <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
              ) : filtered.length === 0 ? (
                <p className="text-center text-xs text-muted-foreground py-8">Nenhum dia com movimento encontrado.</p>
              ) : (
                filtered.map((d) => (
                  <MovementDayRow
                    key={d.date}
                    day={d}
                    withActions={withActions}
                    onSelect={() => { onSelectDate(d.date); onOpenChange(false); }}
                    onAction={(action) => {
                      onOpenChange(false);
                      if (action === "rota") navigate(`/?date=${d.date}`);
                      else if (action === "caixa") navigate(`/caixa?date=${d.date}`);
                      else if (action === "relatorio") navigate(`/daily-report?date=${d.date}`);
                    }}
                  />
                ))
              )}
            </div>
          </TabsContent>

          <TabsContent value="calendar" className="flex-1 overflow-y-auto mt-2 space-y-2">
            <div className="flex flex-wrap justify-center gap-2 text-[10px]">
              <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-success" /> Fechado</span>
              <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-primary" /> Aberto</span>
              <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-muted" /> Sem movimento</span>
              <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-orange-300" /> Cancelado</span>
            </div>
            <Calendar
              mode="single"
              onSelect={handleCalendarSelect}
              locale={ptBR}
              modifiers={{ closed: closedDates, openMov: openDates, cancelled: cancelledDates }}
              modifiersClassNames={{
                closed: "bg-success/20 text-success-foreground font-semibold ring-1 ring-success/40",
                openMov: "bg-primary/20 text-primary-foreground font-semibold ring-1 ring-primary/40",
                cancelled: "bg-orange-200/50 text-orange-900 dark:text-orange-200 ring-1 ring-orange-300/60",
              }}
              className={cn("p-2 pointer-events-auto rounded-md border mx-auto")}
            />
            <p className="text-center text-[10px] text-muted-foreground">
              Toque em um dia para abrir.
            </p>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function MovementDayRow({
  day, onSelect, withActions, onAction,
}: {
  day: MovementDay;
  onSelect: () => void;
  withActions: boolean;
  onAction: (action: "rota" | "caixa" | "relatorio") => void;
}) {
  return (
    <div className="rounded-lg border bg-card p-2.5">
      <button onClick={onSelect} className="w-full text-left">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold capitalize">{labelFor(day.date)}</p>
            <p className="text-[10px] text-muted-foreground">{day.date}</p>
          </div>
          <div className="flex items-center gap-1.5">
            {day.status === "closed" && <Badge variant="secondary" className="text-[9px] h-4 gap-0.5"><Lock className="h-2.5 w-2.5" /> Fechado</Badge>}
            {day.status === "open" && <Badge className="bg-success text-success-foreground text-[9px] h-4">Aberto</Badge>}
            {day.status === "cancelled" && <Badge className="bg-orange-200 text-orange-900 text-[9px] h-4">Cancelado vazio</Badge>}
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mt-1.5 text-[11px]">
          <div className="flex justify-between"><span className="text-muted-foreground">Entradas</span><span className="text-success tabular-nums">+{formatCurrency(day.entradas)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Saídas</span><span className="text-destructive tabular-nums">-{formatCurrency(day.saidas)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Saldo</span><span className={`tabular-nums ${day.saldo >= 0 ? "text-success" : "text-destructive"}`}>{formatCurrency(day.saldo)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Lanç.</span><span className="tabular-nums">{day.eventsCount}{day.notPaidCount > 0 ? ` · ${day.notPaidCount} np` : ""}</span></div>
        </div>
      </button>
      {withActions && (
        <div className="mt-2 grid grid-cols-3 gap-1">
          <Button size="sm" variant="outline" className="h-7 text-[10px] px-1" onClick={() => onAction("rota")}>
            <MapPin className="h-3 w-3 mr-0.5" /> Rota
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-[10px] px-1" onClick={() => onAction("caixa")}>
            <Wallet className="h-3 w-3 mr-0.5" /> Caixa
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-[10px] px-1" onClick={() => onAction("relatorio")}>
            <FileText className="h-3 w-3 mr-0.5" /> Relat.
          </Button>
        </div>
      )}
    </div>
  );
}
