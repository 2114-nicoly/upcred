import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { format, isToday, isYesterday } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/loan-utils";
import { getEventTypeLabel, getEventTypeColor, undoDailyEvent, DailyEvent } from "@/lib/daily-events";
import { CalendarDays, ChevronRight, ChevronDown, ChevronUp, Undo2 } from "lucide-react";
import { ListSkeleton, EmptyState } from "@/components/LoadingSkeleton";
import { useNavigate } from "react-router-dom";

type DayGroup = {
  date: string;
  totalIn: number;
  totalOut: number;
  count: number;
  events: (DailyEvent & { clientName?: string })[];
};

function getDayLabel(dateStr: string): string {
  const date = new Date(dateStr + "T12:00:00");
  if (isToday(date)) return "Hoje";
  if (isYesterday(date)) return "Ontem";
  return format(date, "EEEE, dd/MM/yyyy", { locale: ptBR });
}

export default function DailyCashHistoryPage() {
  const navigate = useNavigate();
  const [days, setDays] = useState<DayGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedDay, setExpandedDay] = useState<string | null>(null);

  useEffect(() => {
    const fetchAll = async () => {
      const { data } = await (supabase.from("daily_events" as any)
        .select("*")
        .order("created_at", { ascending: false })
        .limit(1000) as any);

      const events = (data as unknown as DailyEvent[]) || [];

      // Collect client IDs
      const clientIds = [...new Set(events.filter(e => e.client_id).map(e => e.client_id!))];
      let clientNames: Record<string, string> = {};
      if (clientIds.length > 0) {
        const { data: clients } = await supabase.from("clients").select("id, name").in("id", clientIds);
        for (const c of (clients || [])) clientNames[c.id] = c.name;
      }

      const grouped: Record<string, DayGroup> = {};
      for (const ev of events) {
        const day = ev.cash_date;
        if (!grouped[day]) grouped[day] = { date: day, totalIn: 0, totalOut: 0, count: 0, events: [] };
        grouped[day].totalIn += Number(ev.amount_in);
        grouped[day].totalOut += Number(ev.amount_out);
        grouped[day].count++;
        grouped[day].events.push({
          ...ev,
          clientName: ev.client_id ? clientNames[ev.client_id] : undefined,
        });
      }

      const sorted = Object.values(grouped).sort((a, b) => b.date.localeCompare(a.date));
      setDays(sorted);
      setLoading(false);
    };
    fetchAll();
  }, []);

  return (
    <div className="mx-auto max-w-lg p-4">
      <p className="mb-4 text-sm text-muted-foreground">Dias com lançamentos registrados</p>

      {loading ? (
        <ListSkeleton count={4} />
      ) : days.length === 0 ? (
        <EmptyState icon={CalendarDays} message="Nenhum lançamento registrado" />
      ) : (
        <div className="space-y-2">
          {days.map(day => {
            const isExpanded = expandedDay === day.date;
            const pagCount = day.events.filter(e => e.event_type === "pagamento" || e.event_type === "recebimento_multa").length;
            const npCount = day.events.filter(e => e.event_type === "nao_pagou").length;
            const newCount = day.events.filter(e => e.event_type === "emprestimo_novo").length;
            const renCount = day.events.filter(e => e.event_type === "renovacao").length;

            return (
              <Card key={day.date}>
                <button
                  className="flex w-full items-center justify-between p-4 text-left"
                  onClick={() => setExpandedDay(isExpanded ? null : day.date)}
                >
                  <div>
                    <p className="font-semibold capitalize">{getDayLabel(day.date)}</p>
                    <div className="flex gap-3 text-xs text-muted-foreground mt-0.5 flex-wrap">
                      {day.totalIn > 0 && <span className="text-success">+{formatCurrency(day.totalIn)}</span>}
                      {day.totalOut > 0 && <span className="text-destructive">-{formatCurrency(day.totalOut)}</span>}
                      <span>{day.count} lanç.</span>
                      {pagCount > 0 && <span className="text-success">{pagCount} pag.</span>}
                      {npCount > 0 && <span className="text-destructive">{npCount} np</span>}
                      {renCount > 0 && <span className="text-primary">{renCount} ren.</span>}
                      {newCount > 0 && <span className="text-success">{newCount} novo{newCount > 1 ? "s" : ""}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className="cursor-pointer text-xs"
                      onClick={(e) => { e.stopPropagation(); navigate(`/caixa?date=${day.date}`); }}
                    >
                      Ver caixa <ChevronRight className="h-3 w-3 ml-1" />
                    </Badge>
                    {isExpanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                  </div>
                </button>
                {isExpanded && (
                  <CardContent className="space-y-1 border-t pt-3 pb-3">
                    {day.events.map(ev => (
                      <div key={ev.id} className="flex items-center justify-between rounded-lg bg-accent px-3 py-2">
                        <div>
                          <p className={`text-xs font-medium ${getEventTypeColor(ev.event_type)}`}>
                            {getEventTypeLabel(ev.event_type)}
                          </p>
                          {ev.clientName && <p className="text-xs text-muted-foreground">{ev.clientName}</p>}
                          {ev.observation && <p className="text-xs text-muted-foreground truncate max-w-[200px]">{ev.observation}</p>}
                        </div>
                        <span className={`text-sm font-bold ${Number(ev.amount_in) > 0 ? "text-success" : Number(ev.amount_out) > 0 ? "text-destructive" : "text-muted-foreground"}`}>
                          {Number(ev.amount_in) > 0 ? `+${formatCurrency(Number(ev.amount_in))}` : Number(ev.amount_out) > 0 ? `-${formatCurrency(Number(ev.amount_out))}` : "—"}
                        </span>
                      </div>
                    ))}
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
