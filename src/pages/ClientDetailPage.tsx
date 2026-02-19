import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatCurrency, getLoanStatusColor, getStatusLabel, calculateOverdueDays, getOverdueDatesList } from "@/lib/loan-utils";
import { ArrowLeft, Plus, ChevronDown, History, Clock } from "lucide-react";
import { format } from "date-fns";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

type Loan = {
  id: string;
  amount: number;
  total_amount: number;
  installment_count: number;
  status: string;
  loan_date: string;
  payment_type: string;
  interest_type: string;
  interest_value: number;
};

type Installment = {
  id: string;
  due_date: string;
  status: string;
  is_penalty: boolean;
};

type Client = {
  id: string;
  name: string;
  phone: string | null;
  notes: string | null;
};

export default function ClientDetailPage() {
  const { clientId } = useParams();
  const navigate = useNavigate();
  const [client, setClient] = useState<Client | null>(null);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [installmentsByLoan, setInstallmentsByLoan] = useState<Record<string, Installment[]>>({});
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      const { data: c } = await supabase.from("clients").select("*").eq("id", clientId!).single();
      setClient(c);
      const { data: l } = await supabase.from("loans").select("*").eq("client_id", clientId!).order("created_at", { ascending: false });
      setLoans(l || []);

      if (l && l.length > 0) {
        const loanIds = l.map((loan: Loan) => loan.id);
        const { data: inst } = await supabase
          .from("installments")
          .select("id, due_date, status, is_penalty, loan_id")
          .in("loan_id", loanIds);

        const grouped: Record<string, Installment[]> = {};
        (inst || []).forEach((i: any) => {
          if (!grouped[i.loan_id]) grouped[i.loan_id] = [];
          grouped[i.loan_id].push(i);
        });
        setInstallmentsByLoan(grouped);
      }
    };
    fetchData();
  }, [clientId]);

  const getOverdueDays = (loan: Loan): number => {
    const insts = installmentsByLoan[loan.id] || [];
    const today = new Date();
    today.setHours(12, 0, 0, 0);

    // Find earliest unpaid installment past due date
    const overdueInsts = insts
      .filter((i) => !i.is_penalty && i.status !== "paid")
      .filter((i) => new Date(i.due_date + "T12:00:00") < today)
      .sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime());

    if (overdueInsts.length === 0) return 0;

    return calculateOverdueDays(overdueInsts[0].due_date, loan.payment_type);
  };

  const activeLoans = loans.filter((l) => l.status !== "paid");
  const paidLoans = loans.filter((l) => l.status === "paid");

  const paymentTypeLabel: Record<string, string> = {
    daily: "Diário",
    weekly: "Semanal",
    biweekly: "Quinzenal",
    monthly: "Mensal",
    fixed_dates: "Data Fixa",
  };

  if (!client) return <p className="p-4 text-center">Carregando...</p>;

  return (
    <div className="mx-auto max-w-lg p-4">
      <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="mb-2">
        <ArrowLeft className="mr-1 h-4 w-4" /> Voltar
      </Button>

      <div className="mb-4">
        <h1 className="text-2xl font-bold">{client.name}</h1>
        {client.phone && <p className="text-sm text-muted-foreground">{client.phone}</p>}
        {client.notes && <p className="text-sm text-muted-foreground">{client.notes}</p>}
      </div>

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Empréstimos Ativos</h2>
        <Link to={`/clients/${clientId}/new-loan`}>
          <Button size="sm">
            <Plus className="mr-1 h-4 w-4" /> Novo
          </Button>
        </Link>
      </div>

      {activeLoans.length === 0 ? (
        <p className="py-4 text-center text-muted-foreground">Nenhum empréstimo ativo</p>
      ) : (
        <div className="space-y-3">
          {activeLoans.map((loan) => {
            const overdueDays = getOverdueDays(loan);
            return (
              <Link key={loan.id} to={`/loans/${loan.id}`}>
                <Card className="cursor-pointer transition-shadow hover:shadow-md">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-lg font-bold">{formatCurrency(Number(loan.total_amount))}</p>
                        <p className="text-sm text-muted-foreground">
                          {loan.installment_count}x • {paymentTypeLabel[loan.payment_type]}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {format(new Date(loan.loan_date), "dd/MM/yyyy")}
                        </p>
                        {overdueDays > 0 && (
                          <Dialog>
                            <DialogTrigger asChild>
                              <button
                                onClick={(e) => e.preventDefault()}
                                className="mt-1 flex items-center gap-1 text-xs font-semibold text-destructive hover:underline"
                              >
                                <Clock className="h-3 w-3" />
                                {overdueDays} dia{overdueDays > 1 ? "s" : ""} em atraso
                              </button>
                            </DialogTrigger>
                            <DialogContent>
                              <DialogHeader>
                                <DialogTitle>Dias em Atraso</DialogTitle>
                              </DialogHeader>
                              <div className="max-h-60 space-y-1 overflow-y-auto">
                                {(() => {
                                  const insts = installmentsByLoan[loan.id] || [];
                                  const today = new Date();
                                  today.setHours(12, 0, 0, 0);
                                  const overdueInsts = insts
                                    .filter((i) => !i.is_penalty && i.status !== "paid")
                                    .filter((i) => new Date(i.due_date + "T12:00:00") < today)
                                    .sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime());
                                  if (overdueInsts.length === 0) return null;
                                  const dates = getOverdueDatesList(overdueInsts[0].due_date, loan.payment_type);
                                  return dates.map((d, idx) => (
                                    <div key={idx} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                                      <span>{format(d, "dd/MM/yyyy (EEEE)")}</span>
                                    </div>
                                  ));
                                })()}
                              </div>
                            </DialogContent>
                          </Dialog>
                        )}
                      </div>
                      <Badge className={getLoanStatusColor(overdueDays > 0 ? "overdue" : loan.status)}>
                        {getStatusLabel(overdueDays > 0 ? "overdue" : loan.status)}
                      </Badge>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}

      {paidLoans.length > 0 && (
        <Collapsible open={historyOpen} onOpenChange={setHistoryOpen} className="mt-6">
          <CollapsibleTrigger asChild>
            <Button variant="outline" className="w-full">
              <History className="mr-2 h-4 w-4" />
              Histórico ({paidLoans.length})
              <ChevronDown className={`ml-auto h-4 w-4 transition-transform ${historyOpen ? "rotate-180" : ""}`} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3 space-y-3">
            {paidLoans.map((loan) => (
              <Link key={loan.id} to={`/loans/${loan.id}`}>
                <Card className="cursor-pointer opacity-75 transition-opacity hover:opacity-100">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-bold">{formatCurrency(Number(loan.total_amount))}</p>
                        <p className="text-sm text-muted-foreground">{loan.installment_count}x</p>
                      </div>
                      <Badge className={getLoanStatusColor(loan.status)}>{getStatusLabel(loan.status)}</Badge>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
