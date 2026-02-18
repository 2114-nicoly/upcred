import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatCurrency, getLoanStatusColor, getStatusLabel } from "@/lib/loan-utils";
import { ArrowLeft, Plus, ChevronDown, History } from "lucide-react";
import { format } from "date-fns";

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
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    const fetch = async () => {
      const { data: c } = await supabase.from("clients").select("*").eq("id", clientId!).single();
      setClient(c);
      const { data: l } = await supabase.from("loans").select("*").eq("client_id", clientId!).order("created_at", { ascending: false });
      setLoans(l || []);
    };
    fetch();
  }, [clientId]);

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
          {activeLoans.map((loan) => (
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
                    </div>
                    <Badge className={getLoanStatusColor(loan.status)}>{getStatusLabel(loan.status)}</Badge>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
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
