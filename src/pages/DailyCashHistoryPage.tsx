import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { format, subDays, eachDayOfInterval } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/loan-utils";
import { CalendarDays, Lock, Unlock, ChevronRight } from "lucide-react";
import { useNavigate } from "react-router-dom";

type DailyCash = {
  id: string;
  cash_date: string;
  status: string;
  total_received: number;
  total_penalty_received: number;
  total_not_paid_count: number;
  total_items_treated: number;
  closed_at: string | null;
};

export default function DailyCashHistoryPage() {
  const navigate = useNavigate();
  const [records, setRecords] = useState<DailyCash[]>([]);
  const [loading, setLoading] = useState(true);
  const today = format(new Date(), "yyyy-MM-dd");

  useEffect(() => {
    const fetchHistory = async () => {
      // Get last 30 days
      const startDate = format(subDays(new Date(), 30), "yyyy-MM-dd");

      const { data } = await supabase
        .from("daily_cash")
        .select("*")
        .gte("cash_date", startDate)
        .order("cash_date", { ascending: false });

      const closedMap = new Map<string, DailyCash>();
      for (const d of (data || []) as unknown as DailyCash[]) {
        closedMap.set(d.cash_date, d);
      }

      // Generate list of last 30 days
      const days = eachDayOfInterval({
        start: subDays(new Date(), 30),
        end: new Date(),
      }).reverse();

      const allRecords: DailyCash[] = days.map(day => {
        const dateStr = format(day, "yyyy-MM-dd");
        const existing = closedMap.get(dateStr);
        if (existing) return existing;
        return {
          id: dateStr,
          cash_date: dateStr,
          status: dateStr === today ? "open" : "open",
          total_received: 0,
          total_penalty_received: 0,
          total_not_paid_count: 0,
          total_items_treated: 0,
          closed_at: null,
        };
      });

      setRecords(allRecords);
      setLoading(false);
    };
    fetchHistory();
  }, []);

  return (
    <div className="mx-auto max-w-lg p-4">
      <div className="mb-4">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <CalendarDays className="h-6 w-6 text-primary" /> Histórico de Caixas
        </h1>
        <p className="text-sm text-muted-foreground">Últimos 30 dias</p>
      </div>

      {loading ? (
        <p className="text-center text-muted-foreground">Carregando...</p>
      ) : (
        <div className="space-y-2">
          {records.map(record => {
            const isClosed = record.status === "closed";
            const isToday = record.cash_date === today;
            return (
              <Card
                key={record.cash_date}
                className={`cursor-pointer hover:border-primary/50 transition-colors ${isToday ? "border-primary/30" : ""}`}
                onClick={() => navigate(`/?date=${record.cash_date}`)}
              >
                <CardContent className="p-3 flex items-center justify-between">
                  <div>
                    <p className="font-medium text-sm">
                      {format(new Date(record.cash_date + "T12:00:00"), "EEEE, dd/MM", { locale: ptBR })}
                      {isToday && <span className="text-primary ml-1 text-xs">(hoje)</span>}
                    </p>
                    {isClosed && (
                      <div className="flex gap-3 text-xs text-muted-foreground mt-1">
                        <span className="text-success">Recebido: {formatCurrency(Number(record.total_received))}</span>
                        {Number(record.total_penalty_received) > 0 && (
                          <span className="text-warning">Multas: {formatCurrency(Number(record.total_penalty_received))}</span>
                        )}
                        <span>Tratados: {record.total_items_treated}</span>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge className={isClosed
                      ? "bg-success/10 text-success border-success/30"
                      : "bg-warning/10 text-warning border-warning/30"
                    }>
                      {isClosed ? <Lock className="h-3 w-3 mr-1" /> : <Unlock className="h-3 w-3 mr-1" />}
                      {isClosed ? "Fechado" : "Aberto"}
                    </Badge>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
