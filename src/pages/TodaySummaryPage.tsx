import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, getStatusColor, getStatusLabel } from "@/lib/loan-utils";
import { ArrowLeft, CheckCircle, XCircle, CalendarDays } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { EmptyState } from "@/components/LoadingSkeleton";

type InstallmentWithLoan = {
  id: string;
  number: number;
  amount: number;
  due_date: string;
  status: string;
  loan_id: string;
  is_penalty: boolean;
  paid_amount: number;
  paid_at: string | null;
  loans: {
    id: string;
    clients: { id: string; name: string };
  };
};

export default function TodaySummaryPage() {
  const navigate = useNavigate();
  const [paidToday, setPaidToday] = useState<InstallmentWithLoan[]>([]);
  const [notPaidToday, setNotPaidToday] = useState<InstallmentWithLoan[]>([]);
  const [loading, setLoading] = useState(true);
  const today = format(new Date(), "yyyy-MM-dd");

  useEffect(() => {
    const fetch = async () => {
      // Installments paid today
      const { data: paid } = await supabase
        .from("installments")
        .select("*, loans(id, clients(id, name))")
        .gte("paid_at", today + "T00:00:00")
        .lte("paid_at", today + "T23:59:59")
        .eq("status", "paid")
        .eq("is_penalty", false);

      setPaidToday((paid as unknown as InstallmentWithLoan[]) || []);

      // Installments marked overdue today (due_date = today and status = overdue)
      const { data: notPaid } = await supabase
        .from("installments")
        .select("*, loans(id, clients(id, name))")
        .eq("due_date", today)
        .eq("status", "overdue")
        .eq("is_penalty", false);

      setNotPaidToday((notPaid as unknown as InstallmentWithLoan[]) || []);
      setLoading(false);
    };
    fetch();
  }, []);

  const totalPaid = paidToday.reduce((s, i) => s + Number(i.paid_amount), 0);
  const totalNotPaid = notPaidToday.reduce((s, i) => s + (Number(i.amount) - Number(i.paid_amount)), 0);

  return (
    <div className="mx-auto max-w-lg p-4">

      <p className="mb-4 text-sm text-muted-foreground">
        {format(new Date(), "EEEE, dd 'de' MMMM", { locale: ptBR })}
      </p>

      <div className="mb-6 grid grid-cols-2 gap-3">
        <Card className="text-center border-success/30">
          <CardContent className="p-3">
            <CheckCircle className="mx-auto mb-1 h-5 w-5 text-success" />
            <p className="text-xs text-muted-foreground">Recebido</p>
            <p className="text-sm font-bold text-success">{formatCurrency(totalPaid)}</p>
            <p className="text-xs text-muted-foreground">{paidToday.length} parcela{paidToday.length !== 1 ? "s" : ""}</p>
          </CardContent>
        </Card>
        <Card className="text-center border-destructive/30">
          <CardContent className="p-3">
            <XCircle className="mx-auto mb-1 h-5 w-5 text-destructive" />
            <p className="text-xs text-muted-foreground">Não Pagou</p>
            <p className="text-sm font-bold text-destructive">{formatCurrency(totalNotPaid)}</p>
            <p className="text-xs text-muted-foreground">{notPaidToday.length} parcela{notPaidToday.length !== 1 ? "s" : ""}</p>
          </CardContent>
        </Card>
      </div>

      {loading ? (
        <p className="text-center text-muted-foreground">Carregando...</p>
      ) : (
        <>
          {paidToday.length > 0 && (
            <div className="mb-4">
              <h2 className="mb-2 text-sm font-semibold text-success flex items-center gap-1">
                <CheckCircle className="h-4 w-4" /> Pagos Hoje
              </h2>
              <div className="space-y-2">
                {paidToday.map((inst) => (
                  <Card key={inst.id} className="border-success/20">
                    <CardContent className="p-3 flex items-center justify-between">
                      <div>
                        <p className="font-medium text-sm">{inst.loans.clients.name}</p>
                        <p className="text-xs text-muted-foreground">
                          Parcela {inst.number} • {formatCurrency(Number(inst.paid_amount))}
                        </p>
                      </div>
                      <Badge className={getStatusColor("paid")}>{getStatusLabel("paid")}</Badge>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {notPaidToday.length > 0 && (
            <div>
              <h2 className="mb-2 text-sm font-semibold text-destructive flex items-center gap-1">
                <XCircle className="h-4 w-4" /> Não Pagaram Hoje
              </h2>
              <div className="space-y-2">
                {notPaidToday.map((inst) => (
                  <Card key={inst.id} className="border-destructive/20">
                    <CardContent className="p-3 flex items-center justify-between">
                      <div>
                        <p className="font-medium text-sm">{inst.loans.clients.name}</p>
                        <p className="text-xs text-muted-foreground">
                          Parcela {inst.number} • {formatCurrency(Number(inst.amount))}
                        </p>
                      </div>
                      <Badge className={getStatusColor("overdue")}>{getStatusLabel("overdue")}</Badge>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {paidToday.length === 0 && notPaidToday.length === 0 && (
            <Card>
              <CardContent className="p-2">
                <EmptyState
                  icon={CalendarDays}
                  message="Nenhuma movimentação registrada hoje"
                  description="Assim que você registrar pagamentos, eles aparecerão aqui."
                  actionLabel="Ir para a rota"
                  onAction={() => navigate("/")}
                />
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
