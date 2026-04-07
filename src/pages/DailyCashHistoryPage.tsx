import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { format, isToday, isYesterday } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/loan-utils";
import { getMovementTypeLabel, getMovementTypeColor } from "@/lib/cash-utils";
import { CalendarDays, ChevronRight, ChevronDown, ChevronUp, RefreshCw, Plus } from "lucide-react";
import { ListSkeleton, EmptyState } from "@/components/LoadingSkeleton";
import { useNavigate } from "react-router-dom";

type NewLoanEntry = {
  id: string;
  amount: number;
  total_amount: number;
  installment_count: number;
  payment_type: string;
  renewed_from_loan_id: string | null;
  clients: { name: string } | null;
};

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
  newLoans: NewLoanEntry[];
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
      const [{ data }, { data: loanData }] = await Promise.all([
        supabase.from("cash_movements").select("*, clients(name)").order("created_at", { ascending: false }).limit(500),
        supabase.from("loans").select("id, amount, total_amount, installment_count, payment_type, loan_date, renewed_from_loan_id, clients:client_id(name)") as any,
      ]);

      const grouped: Record<string, MovementDay> = {};
      const ensureDay = (day: string) => {
        if (!grouped[day]) grouped[day] = { date: day, totalIn: 0, totalOut: 0, count: 0, movements: [], newLoans: [] };
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

      for (const r of (loanData || []) as any[]) {
        const day = r.loan_date;
        ensureDay(day);
        grouped[day].newLoans.push(r);
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
            const renewalCount = day.newLoans.filter(l => !!l.renewed_from_loan_id).length;
            const newCount = day.newLoans.length - renewalCount;
            return (
              <Card key={day.date}>
                <button
                  className="flex w-full items-center justify-between p-4 text-left"
                  onClick={() => setExpandedDay(isExpanded ? null : day.date)}
                >
                  <div>
                    <p className="font-semibold capitalize">{getDayLabel(day.date)}</p>
                    <div className="flex gap-3 text-xs text-muted-foreground mt-0.5 flex-wrap">
                      <span className="text-success">+{formatCurrency(day.totalIn)}</span>
                      {day.totalOut > 0 && <span className="text-destructive">-{formatCurrency(day.totalOut)}</span>}
                      <span>{day.count} mov.</span>
                      {renewalCount > 0 && <span className="text-primary">{renewalCount} renov.</span>}
                      {newCount > 0 && <span className="text-success">{newCount} novo{newCount > 1 ? "s" : ""}</span>}
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
                    {day.newLoans.length > 0 && (
                      <div className="mb-2">
                        <p className="text-[10px] font-bold text-primary uppercase tracking-wider mb-1 flex items-center gap-1">
                          <Plus className="h-3 w-3" /> Empréstimos Novos
                        </p>
                        {day.newLoans.map((r: any) => {
                          const isRenewal = !!r.renewed_from_loan_id;
                          const paymentLabel = r.payment_type === "daily" ? "Diário" : r.payment_type === "weekly" ? "Semanal" : r.payment_type === "monthly" ? "Mensal" : r.payment_type;
                          return (
                            <div key={r.id} className={`flex items-center justify-between rounded-lg px-3 py-2 mb-1 border ${isRenewal ? "bg-primary/5 border-primary/20" : "bg-success/5 border-success/20"}`}>
                              <div>
                                <div className="flex items-center gap-1.5">
                                  <p className={`text-xs font-medium ${isRenewal ? "text-primary" : "text-success"}`}>
                                    {isRenewal ? "Renovação" : "Novo Empréstimo"}
                                  </p>
                                </div>
                                {r.clients?.name && <p className="text-xs text-muted-foreground">{r.clients.name}</p>}
                                <p className="text-[10px] text-muted-foreground">{r.installment_count}x • {paymentLabel}</p>
                              </div>
                              <span className={`text-sm font-bold ${isRenewal ? "text-primary" : "text-success"}`}>{formatCurrency(Number(r.amount))}</span>
                            </div>
                          );
                        })}
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
