import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useRoute } from "@/contexts/RouteContext";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { formatCurrency, getLoanStatusColor, getStatusLabel } from "@/lib/loan-utils";
import { Landmark, Filter } from "lucide-react";
import { format } from "date-fns";

type LoanWithClient = {
  id: string;
  amount: number;
  total_amount: number;
  status: string;
  payment_type: string;
  loan_date: string;
  installment_count: number;
  clients: { id: string; name: string };
};

type LoanProgress = {
  progress: number;
  total: number;
  remaining: number;
  penaltyTotal: number;
};

export default function ActiveLoansPage() {
  const navigate = useNavigate();
  const { route } = useRoute();
  const [loans, setLoans] = useState<LoanWithClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterToday, setFilterToday] = useState(false);
  const [todayLoanIds, setTodayLoanIds] = useState<Set<string>>(new Set());
  const [progressMap, setProgressMap] = useState<Record<string, LoanProgress>>({});

  useEffect(() => {
    if (!route) return;
    const fetchData = async () => {
      setLoading(true);
      const { data: loansData } = await supabase
        .from("loans")
        .select("*, clients(id, name)")
        .eq("route_id", route.id)
        .neq("status", "paid")
        .order("loan_date", { ascending: false });

      const loansList = (loansData as unknown as LoanWithClient[]) || [];
      setLoans(loansList);

      const today = format(new Date(), "yyyy-MM-dd");
      const loanIds = loansList.map((l) => l.id);
      if (loanIds.length > 0) {
        const { data: todayInst } = await supabase
          .from("installments")
          .select("loan_id")
          .in("loan_id", loanIds)
          .eq("due_date", today)
          .neq("status", "paid");
        setTodayLoanIds(new Set((todayInst || []).map((i) => i.loan_id)));

        const { data: allInst } = await supabase
          .from("installments")
          .select("loan_id, amount, paid_amount, is_penalty")
          .in("loan_id", loanIds);

        const pm: Record<string, LoanProgress> = {};
        for (const lid of loanIds) {
          const insts = (allInst || []).filter((i: any) => i.loan_id === lid);
          const regular = insts.filter((i: any) => !i.is_penalty);
          const penalties = insts.filter((i: any) => i.is_penalty);
          const totalPaid = regular.reduce((s: number, i: any) => s + Number(i.paid_amount), 0);
          const instValue = regular.length > 0 ? Number(regular[0].amount) : 1;
          pm[lid] = {
            progress: totalPaid / instValue,
            total: regular.length,
            remaining: regular.reduce((s: number, i: any) => s + Number(i.amount), 0) - totalPaid,
            penaltyTotal: penalties.reduce((s: number, i: any) => s + Number(i.amount), 0),
          };
        }
        setProgressMap(pm);
      }
      setLoading(false);
    };
    fetchData();
  }, [route]);

  const paymentTypeLabel: Record<string, string> = {
    daily: "Diário", weekly: "Semanal", biweekly: "Quinzenal", monthly: "Mensal", fixed_dates: "Data Fixa",
  };

  const displayedLoans = filterToday ? loans.filter((l) => todayLoanIds.has(l.id)) : loans;

  return (
    <div className="mx-auto max-w-lg p-4">
      <h1 className="mb-4 text-2xl font-bold">
        <Landmark className="mr-2 inline h-6 w-6 text-primary" /> Empréstimos Ativos
      </h1>

      <div className="mb-4 flex items-center justify-between rounded-lg bg-accent p-3">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Vencimentos de hoje</span>
        </div>
        <Switch checked={filterToday} onCheckedChange={setFilterToday} />
      </div>

      {loading ? (
        <p className="text-center text-muted-foreground">Carregando...</p>
      ) : displayedLoans.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center p-8">
            <p className="text-muted-foreground">
              {filterToday ? "Nenhum empréstimo com vencimento hoje" : "Nenhum empréstimo ativo"}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {displayedLoans.map((loan) => {
            const lp = progressMap[loan.id];
            return (
              <Card key={loan.id} className="cursor-pointer transition-colors hover:bg-accent/50" onClick={() => navigate(`/loans/${loan.id}`)}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-semibold">{loan.clients.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {formatCurrency(Number(loan.total_amount))} • {paymentTypeLabel[loan.payment_type]}
                      </p>
                      {lp && (
                        <p className="text-xs text-primary font-medium">
                          {lp.progress % 1 === 0 ? lp.progress : lp.progress.toFixed(1)}/{lp.total} • Resta: {formatCurrency(Math.max(0, lp.remaining))}
                        </p>
                      )}
                      {lp && lp.penaltyTotal > 0 && (
                        <p className="text-xs text-destructive">Multa: {formatCurrency(lp.penaltyTotal)}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {format(new Date(loan.loan_date + "T12:00:00"), "dd/MM/yyyy")}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Badge className={getLoanStatusColor(loan.status)}>{getStatusLabel(loan.status)}</Badge>
                      {todayLoanIds.has(loan.id) && (
                        <span className="text-xs font-medium text-warning">Vence hoje</span>
                      )}
                    </div>
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
