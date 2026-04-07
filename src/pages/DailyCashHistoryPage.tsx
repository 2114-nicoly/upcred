import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { format, isToday, isYesterday } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/loan-utils";
import { getMovementTypeLabel, getMovementTypeColor } from "@/lib/cash-utils";
import { CalendarDays, ChevronRight, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { ListSkeleton, EmptyState } from "@/components/LoadingSkeleton";
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
  renewals: {
    id: string;
    amount: number;
    total_amount: number;
    clients: { name: string } | null;
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
    const fetchAll = async () => {
      const [{ data }, { data: renewalData }] = await Promise.all([
        supabase.from("cash_movements").select("*, clients(name)").order("created_at", { ascending: false }).limit(500),
        supabase.from("loans").select("id, amount, total_amount, loan_date, clients:client_id(name)").not("renewed_from_loan_id", "is", null) as any,
      ]);

      const grouped: Record<string, MovementDay> = {};
      const ensureDay = (day: string) => {
        if (!grouped[day]) grouped[day] = { date: day, totalIn: 0, totalOut: 0, count: 0, movements: [], renewals: [] };
      };

      for (const mov of (data || []) as any[]) {
        const day = mov.cash_date || format(new Date(mov.created_at), "yyyy-MM-dd");
        ensureDay(day);
        const amount = Number(mov.amount);
        if (amount >= 0) grouped[day].totalIn += amount;
        else grouped[day].totalOut += Math.abs(amount);
        grouped[day].count++;
        grouped[day].movements.push(mov);
      }

      for (const r of (renewalData || []) as any[]) {
        const day = r.loan_date;
        ensureDay(day);
        grouped[day].renewals.push(r);
      }

      const sorted = Object.values(grouped).sort((a, b) => b.date.localeCompare(a.date));
      setDays(sorted);
      setLoading(false);
    };
    fetchAll();
  }, []);

  return (
    <div className="mx-auto max-w-lg p-4">
      <p className="mb-4 text-sm text-muted-foreground">Dias com movimentações registradas</p>

      {loading ? (
        <ListSkeleton count={4} />
      ) : days.length === 0 ? (
        <EmptyState icon={CalendarDays} message="Nenhuma movimentação registrada" />
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
                    {day.renewals.length > 0 && (
                      <div className="mb-2">
                        <p className="text-[10px] font-bold text-primary uppercase tracking-wider mb-1 flex items-center gap-1">
                          <RefreshCw className="h-3 w-3" /> Renovações
                        </p>
                        {day.renewals.map((r: any) => (
                          <div key={r.id} className="flex items-center justify-between rounded-lg bg-primary/5 border border-primary/20 px-3 py-2 mb-1">
                            <div>
                              <p className="text-xs font-medium text-primary">Renovação</p>
                              {r.clients?.name && <p className="text-xs text-muted-foreground">{r.clients.name}</p>}
                            </div>
                            <span className="text-sm font-bold text-primary">{formatCurrency(Number(r.amount))}</span>
                          </div>
                        ))}
                      </div>
                    )}
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
