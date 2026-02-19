import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useRoute } from "@/contexts/RouteContext";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, getStatusColor, getStatusLabel } from "@/lib/loan-utils";
import { CalendarCheck, ChevronDown, ChevronUp } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

type PaidInstallment = {
  id: string;
  number: number;
  amount: number;
  due_date: string;
  paid_at: string;
  is_penalty: boolean;
  loan_id: string;
  loans: { id: string; amount: number; clients: { name: string } };
};

export default function PaymentHistoryPage() {
  const { route } = useRoute();
  const [installmentsByDay, setInstallmentsByDay] = useState<Record<string, PaidInstallment[]>>({});
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!route) return;
    const fetchData = async () => {
      const { data: routeLoans } = await supabase.from("loans").select("id").eq("route_id", route.id);
      const loanIds = (routeLoans || []).map((l: any) => l.id);
      if (loanIds.length === 0) { setLoading(false); return; }

      const { data } = await supabase
        .from("installments")
        .select("*, loans(id, amount, clients(name))")
        .in("loan_id", loanIds)
        .eq("status", "paid")
        .not("paid_at", "is", null)
        .order("paid_at", { ascending: false });

      const grouped: Record<string, PaidInstallment[]> = {};
      ((data as unknown as PaidInstallment[]) || []).forEach((inst) => {
        const day = format(new Date(inst.paid_at), "yyyy-MM-dd");
        if (!grouped[day]) grouped[day] = [];
        grouped[day].push(inst);
      });
      setInstallmentsByDay(grouped);
      setLoading(false);
    };
    fetchData();
  }, [route]);

  const days = Object.keys(installmentsByDay).sort((a, b) => b.localeCompare(a));

  return (
    <div className="mx-auto max-w-lg p-4">
      <h1 className="mb-4 text-2xl font-bold">
        <CalendarCheck className="mr-2 inline h-6 w-6 text-primary" /> Histórico de Pagamentos
      </h1>

      {loading ? (
        <p className="text-center text-muted-foreground">Carregando...</p>
      ) : days.length === 0 ? (
        <p className="py-8 text-center text-muted-foreground">Nenhum pagamento registrado</p>
      ) : (
        <div className="space-y-2">
          {days.map((day) => {
            const insts = installmentsByDay[day];
            const total = insts.reduce((s, i) => s + Number(i.amount), 0);
            const isExpanded = expandedDay === day;
            return (
              <Card key={day}>
                <button className="flex w-full items-center justify-between p-4 text-left" onClick={() => setExpandedDay(isExpanded ? null : day)}>
                  <div>
                    <p className="font-semibold">{format(new Date(day), "EEEE, dd/MM/yyyy", { locale: ptBR })}</p>
                    <p className="text-sm text-muted-foreground">{insts.length} pagamento(s) • {formatCurrency(total)}</p>
                  </div>
                  {isExpanded ? <ChevronUp className="h-5 w-5 text-muted-foreground" /> : <ChevronDown className="h-5 w-5 text-muted-foreground" />}
                </button>
                {isExpanded && (
                  <CardContent className="space-y-2 border-t pt-3">
                    {insts.map((inst) => (
                      <div key={inst.id} className="flex items-center justify-between rounded-lg bg-accent p-3">
                        <div>
                          <p className="font-medium">{inst.loans.clients.name}</p>
                          <p className="text-sm text-muted-foreground">
                            {inst.is_penalty ? "Multa" : `Parcela ${inst.number}`} • {formatCurrency(Number(inst.amount))}
                          </p>
                        </div>
                        <Badge className={getStatusColor("paid")}>{getStatusLabel("paid")}</Badge>
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
