import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { format, isToday, isYesterday } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/loan-utils";
import { getMovementTypeLabel, getMovementTypeColor } from "@/lib/cash-utils";
import { CalendarDays, ChevronRight, ChevronDown, ChevronUp } from "lucide-react";
import { useNavigate } from "react-router-dom";

type MovementDay = {
  date: string;
  totalIn: number;
  totalOut: number;
  count: number;
  movements: {
    id: string;
    type: string;
    amount: number;
    observation: string | null;
    created_at: string;
    clients?: { name: string } | null;
  }[];
};

function getDayLabel(dateStr: string): string {
  const date = new Date(dateStr + "T12:00:00");
  if (isToday(date)) return "Hoje";
  if (isYesterday(date)) return "Ontem";
  return format(date, "EEEE, dd/MM/yyyy", { locale: ptBR });
}

export default function DailyCashHistoryPage() {
  const navigate = useNavigate();
  const [days, setDays] = useState<MovementDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedDay, setExpandedDay] = useState<string | null>(null);

  useEffect(() => {
    const fetch = async () => {
      const { data } = await supabase
        .from("cash_movements")
        .select("*, clients(name)")
        .order("created_at", { ascending: false })
        .limit(500);

      if (!data) { setLoading(false); return; }

      const grouped: Record<string, MovementDay> = {};
      for (const mov of data as any[]) {
        const day = format(new Date(mov.created_at), "yyyy-MM-dd");
        if (!grouped[day]) {
          grouped[day] = { date: day, totalIn: 0, totalOut: 0, count: 0, movements: [] };
        }
        const amount = Number(mov.amount);
        if (amount >= 0) grouped[day].totalIn += amount;
        else grouped[day].totalOut += Math.abs(amount);
        grouped[day].count++;
        grouped[day].movements.push(mov);
      }

      const sorted = Object.values(grouped).sort((a, b) => b.date.localeCompare(a.date));
      setDays(sorted);
      setLoading(false);
    };
    fetch();
  }, []);

  return (
    <div className="mx-auto max-w-lg p-4">
      <div className="mb-4">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <CalendarDays className="h-6 w-6 text-primary" /> Histórico de Caixas
        </h1>
        <p className="text-sm text-muted-foreground">Dias com movimentações registradas</p>
      </div>

      {loading ? (
        <p className="text-center text-muted-foreground">Carregando...</p>
      ) : days.length === 0 ? (
        <p className="text-center text-muted-foreground py-8">Nenhuma movimentação registrada</p>
      ) : (
        <div className="space-y-2">
          {days.map(day => {
            const isExpanded = expandedDay === day.date;
            return (
              <Card key={day.date}>
                <button
                  className="flex w-full items-center justify-between p-4 text-left"
                  onClick={() => setExpandedDay(isExpanded ? null : day.date)}
                >
                  <div>
                    <p className="font-semibold capitalize">{getDayLabel(day.date)}</p>
                    <div className="flex gap-3 text-xs text-muted-foreground mt-0.5">
                      <span className="text-success">+{formatCurrency(day.totalIn)}</span>
                      {day.totalOut > 0 && <span className="text-destructive">-{formatCurrency(day.totalOut)}</span>}
                      <span>{day.count} mov.</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className="cursor-pointer text-xs"
                      onClick={(e) => { e.stopPropagation(); navigate(`/?date=${day.date}`); }}
                    >
                      Ver caixa <ChevronRight className="h-3 w-3 ml-1" />
                    </Badge>
                    {isExpanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                  </div>
                </button>
                {isExpanded && (
                  <CardContent className="space-y-1 border-t pt-3 pb-3">
                    {day.movements.map(mov => (
                      <div key={mov.id} className="flex items-center justify-between rounded-lg bg-accent px-3 py-2">
                        <div>
                          <p className={`text-xs font-medium ${getMovementTypeColor(mov.type)}`}>
                            {getMovementTypeLabel(mov.type)}
                          </p>
                          {mov.clients?.name && <p className="text-xs text-muted-foreground">{mov.clients.name}</p>}
                          {mov.observation && <p className="text-xs text-muted-foreground truncate max-w-[200px]">{mov.observation}</p>}
                        </div>
                        <span className={`text-sm font-bold ${Number(mov.amount) >= 0 ? "text-success" : "text-destructive"}`}>
                          {Number(mov.amount) >= 0 ? "+" : ""}{formatCurrency(Number(mov.amount))}
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
