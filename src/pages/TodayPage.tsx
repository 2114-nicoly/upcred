import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, getStatusColor, getStatusLabel } from "@/lib/loan-utils";
import { CalendarDays, CheckCircle, XCircle, DollarSign, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

type InstallmentWithLoan = {
  id: string;
  number: number;
  amount: number;
  due_date: string;
  status: string;
  loan_id: string;
  is_penalty: boolean;
  loans: {
    id: string;
    client_id: string;
    amount: number;
    total_amount: number;
    clients: {
      id: string;
      name: string;
    };
  };
};

export default function TodayPage() {
  const [installments, setInstallments] = useState<InstallmentWithLoan[]>([]);
  const [loading, setLoading] = useState(true);
  const today = format(new Date(), "yyyy-MM-dd");

  const fetchInstallments = async () => {
    const { data, error } = await supabase
      .from("installments")
      .select("*, loans(id, client_id, amount, total_amount, clients(id, name))")
      .eq("due_date", today)
      .neq("status", "paid")
      .order("number");

    if (error) {
      toast.error("Erro ao carregar parcelas");
      return;
    }
    setInstallments((data as unknown as InstallmentWithLoan[]) || []);
    setLoading(false);
  };

  useEffect(() => {
    fetchInstallments();
  }, []);

  const handlePay = async (id: string) => {
    const { error } = await supabase
      .from("installments")
      .update({ status: "paid", paid_at: new Date().toISOString() })
      .eq("id", id);

    if (error) {
      toast.error("Erro ao registrar pagamento");
      return;
    }
    toast.success("Pagamento registrado!");
    fetchInstallments();
  };

  const handleNotPaid = async (id: string) => {
    const { error } = await supabase
      .from("installments")
      .update({ status: "overdue" })
      .eq("id", id);

    if (error) {
      toast.error("Erro ao marcar como não pago");
      return;
    }
    toast.info("Parcela marcada como atrasada");
    fetchInstallments();
  };

  const totalToReceive = installments.reduce((sum, i) => sum + Number(i.amount), 0);
  const paidToday = installments.filter((i) => i.status === "paid");
  const totalReceived = paidToday.reduce((sum, i) => sum + Number(i.amount), 0);

  return (
    <div className="mx-auto max-w-lg p-4">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">
          <CalendarDays className="mr-2 inline h-6 w-6 text-primary" />
          Hoje
        </h1>
        <p className="text-sm text-muted-foreground">
          {format(new Date(), "EEEE, dd 'de' MMMM", { locale: ptBR })}
        </p>
      </div>

      {/* Resumo do dia */}
      <div className="mb-6 grid grid-cols-3 gap-3">
        <Card className="text-center">
          <CardContent className="p-3">
            <DollarSign className="mx-auto mb-1 h-5 w-5 text-primary" />
            <p className="text-xs text-muted-foreground">A Receber</p>
            <p className="text-sm font-bold">{formatCurrency(totalToReceive)}</p>
          </CardContent>
        </Card>
        <Card className="text-center">
          <CardContent className="p-3">
            <CheckCircle className="mx-auto mb-1 h-5 w-5 text-success" />
            <p className="text-xs text-muted-foreground">Recebido</p>
            <p className="text-sm font-bold">{formatCurrency(totalReceived)}</p>
          </CardContent>
        </Card>
        <Card className="text-center">
          <CardContent className="p-3">
            <AlertTriangle className="mx-auto mb-1 h-5 w-5 text-warning" />
            <p className="text-xs text-muted-foreground">Cobranças</p>
            <p className="text-sm font-bold">{installments.length}</p>
          </CardContent>
        </Card>
      </div>

      {/* Lista de parcelas */}
      {loading ? (
        <p className="text-center text-muted-foreground">Carregando...</p>
      ) : installments.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center p-8">
            <CheckCircle className="mb-2 h-12 w-12 text-success" />
            <p className="text-lg font-semibold">Nenhuma cobrança para hoje!</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {installments.map((inst) => (
            <Card key={inst.id} className="overflow-hidden">
              <CardContent className="p-4">
                <div className="mb-2 flex items-center justify-between">
                  <div>
                    <p className="font-semibold">{inst.loans.clients.name}</p>
                    <p className="text-sm text-muted-foreground">
                      Parcela {inst.number} • {formatCurrency(Number(inst.amount))}
                    </p>
                  </div>
                  <Badge className={getStatusColor(inst.status)}>
                    {getStatusLabel(inst.status)}
                  </Badge>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" className="flex-1 bg-success hover:bg-success/90" onClick={() => handlePay(inst.id)}>
                    <CheckCircle className="mr-1 h-4 w-4" />
                    Pagou
                  </Button>
                  <Button size="sm" variant="destructive" className="flex-1" onClick={() => handleNotPaid(inst.id)}>
                    <XCircle className="mr-1 h-4 w-4" />
                    Não Pagou
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
