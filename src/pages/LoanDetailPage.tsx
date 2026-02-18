import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { formatCurrency, getStatusColor, getStatusLabel, getLoanStatusColor } from "@/lib/loan-utils";
import { ArrowLeft, CheckCircle, XCircle, AlertTriangle, DollarSign, Undo2 } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

type Loan = {
  id: string;
  amount: number;
  interest_type: string;
  interest_value: number;
  total_amount: number;
  installment_count: number;
  payment_type: string;
  loan_date: string;
  status: string;
  client_id: string;
  clients: { name: string };
};

type Installment = {
  id: string;
  number: number;
  amount: number;
  due_date: string;
  status: string;
  paid_at: string | null;
  is_penalty: boolean;
  penalty_amount: number;
};

export default function LoanDetailPage() {
  const { loanId } = useParams();
  const navigate = useNavigate();
  const [loan, setLoan] = useState<Loan | null>(null);
  const [installments, setInstallments] = useState<Installment[]>([]);
  const [penaltyAmount, setPenaltyAmount] = useState("");
  const [penaltyDialogId, setPenaltyDialogId] = useState<string | null>(null);
  const [payDialogId, setPayDialogId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState("");

  const fetchData = async () => {
    const { data: l } = await supabase
      .from("loans")
      .select("*, clients(name)")
      .eq("id", loanId!)
      .single();
    setLoan(l as unknown as Loan);

    const { data: inst } = await supabase
      .from("installments")
      .select("*")
      .eq("loan_id", loanId!)
      .order("number");
    setInstallments(inst || []);
  };

  useEffect(() => {
    fetchData();
  }, [loanId]);

  const updateLoanStatus = async () => {
    const { data: inst } = await supabase
      .from("installments")
      .select("status")
      .eq("loan_id", loanId!);

    if (!inst) return;

    const allPaid = inst.every((i) => i.status === "paid");
    const hasOverdue = inst.some((i) => i.status === "overdue");

    let newStatus = "open";
    if (allPaid) newStatus = "paid";
    else if (hasOverdue) newStatus = "overdue";

    await supabase.from("loans").update({ status: newStatus }).eq("id", loanId!);
  };

  const handlePay = async (id: string) => {
    const inst = installments.find((i) => i.id === id);
    if (!inst) return;

    const paidValue = payAmount ? parseFloat(payAmount) : Number(inst.amount);
    if (isNaN(paidValue) || paidValue <= 0) {
      toast.error("Informe um valor válido");
      return;
    }

    await supabase.from("installments").update({
      status: "paid",
      paid_at: new Date().toISOString(),
    }).eq("id", id);

    // If paid less than the installment amount, register the difference info via toast
    const diff = Number(inst.amount) - paidValue;
    if (diff > 0) {
      toast.info(`Diferença de ${formatCurrency(diff)} no pagamento`);
    } else if (diff < 0) {
      toast.info(`Pagamento excedente de ${formatCurrency(Math.abs(diff))}`);
    }

    await updateLoanStatus();
    toast.success(`Pagamento de ${formatCurrency(paidValue)} registrado!`);
    setPayAmount("");
    setPayDialogId(null);
    fetchData();
  };

  const handleNotPaid = async (id: string) => {
    await supabase.from("installments").update({ status: "overdue" }).eq("id", id);
    await updateLoanStatus();
    toast.info("Parcela marcada como atrasada");
    fetchData();
  };

  const handleUndoPayment = async (id: string) => {
    await supabase.from("installments").update({ status: "pending", paid_at: null }).eq("id", id);
    await updateLoanStatus();
    toast.success("Pagamento desfeito!");
    fetchData();
  };

  const handleAddPenalty = async (installmentId: string) => {
    const amount = parseFloat(penaltyAmount);
    if (!amount || amount <= 0) {
      toast.error("Informe um valor válido para a multa");
      return;
    }

    const inst = installments.find((i) => i.id === installmentId);
    if (!inst) return;

    const newPenalty = Number(inst.penalty_amount) + amount;
    await supabase.from("installments").update({ penalty_amount: newPenalty }).eq("id", installmentId);

    const penaltyInst = installments.find((i) => i.is_penalty);
    if (penaltyInst) {
      const newAmount = Number(penaltyInst.amount) + amount;
      await supabase.from("installments").update({ amount: newAmount }).eq("id", penaltyInst.id);
    } else {
      const maxNumber = Math.max(...installments.map((i) => i.number));
      const lastDueDate = installments
        .filter((i) => !i.is_penalty)
        .sort((a, b) => new Date(b.due_date).getTime() - new Date(a.due_date).getTime())[0]?.due_date;

      await supabase.from("installments").insert({
        loan_id: loanId!,
        number: maxNumber + 1,
        amount,
        due_date: lastDueDate || format(new Date(), "yyyy-MM-dd"),
        is_penalty: true,
        status: "pending",
      });
    }

    toast.success("Multa adicionada!");
    setPenaltyAmount("");
    setPenaltyDialogId(null);
    fetchData();
  };

  if (!loan) return <p className="p-4 text-center">Carregando...</p>;

  const paidInstallments = installments.filter((i) => i.status === "paid" && !i.is_penalty);
  const totalInstallments = installments.filter((i) => !i.is_penalty).length;
  const progressPercent = totalInstallments > 0 ? (paidInstallments.length / totalInstallments) * 100 : 0;
  const paidTotal = installments.filter((i) => i.status === "paid").reduce((s, i) => s + Number(i.amount), 0);
  const remaining = Number(loan.total_amount) - paidTotal + installments.filter((i) => i.is_penalty).reduce((s, i) => s + Number(i.amount), 0) - installments.filter((i) => i.is_penalty && i.status === "paid").reduce((s, i) => s + Number(i.amount), 0);

  const paymentTypeLabel: Record<string, string> = {
    daily: "Diário",
    weekly: "Semanal",
    biweekly: "Quinzenal",
    monthly: "Mensal",
    fixed_dates: "Data Fixa",
  };

  return (
    <div className="mx-auto max-w-lg p-4">
      <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="mb-2">
        <ArrowLeft className="mr-1 h-4 w-4" /> Voltar
      </Button>

      {/* Loan Info */}
      <Card className="mb-4">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">{loan.clients.name}</CardTitle>
            <Badge className={getLoanStatusColor(loan.status)}>{getStatusLabel(loan.status)}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Emprestado:</span>
            <span>{formatCurrency(Number(loan.amount))}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Juros ({loan.interest_type === "percentage" ? `${loan.interest_value}%` : `R$ ${loan.interest_value}`}):</span>
            <span>{formatCurrency(Number(loan.total_amount) - Number(loan.amount))}</span>
          </div>
          <div className="flex justify-between font-bold">
            <span>Valor Total:</span>
            <span className="text-primary">{formatCurrency(Number(loan.total_amount))}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Tipo:</span>
            <span>{paymentTypeLabel[loan.payment_type]}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Data:</span>
            <span>{format(new Date(loan.loan_date + "T12:00:00"), "dd/MM/yyyy")}</span>
          </div>
        </CardContent>
      </Card>

      {/* Progress */}
      <Card className="mb-4">
        <CardContent className="p-4">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-medium">Progresso</span>
            <span className="text-muted-foreground">
              {paidInstallments.length}/{totalInstallments} parcelas pagas
            </span>
          </div>
          <Progress value={progressPercent} className="mb-3" />
          <div className="flex items-center justify-between rounded-lg bg-accent p-3">
            <div className="flex items-center gap-2">
              <DollarSign className="h-5 w-5 text-primary" />
              <span className="text-sm font-medium">Saldo Restante</span>
            </div>
            <span className="text-lg font-bold text-primary">{formatCurrency(Math.max(0, remaining))}</span>
          </div>
        </CardContent>
      </Card>

      {/* Installments */}
      <h2 className="mb-3 text-lg font-semibold">Parcelas</h2>
      <div className="space-y-2">
        {installments.map((inst) => (
          <Card key={inst.id} className={inst.is_penalty ? "border-warning/50" : ""}>
            <CardContent className="p-3">
              <div className="mb-2 flex items-center justify-between">
                <div>
                  <p className="font-semibold">
                    {inst.is_penalty ? "🔶 Multa" : `Parcela ${inst.number}`}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {format(new Date(inst.due_date + "T12:00:00"), "dd/MM/yyyy")} • {formatCurrency(Number(inst.amount))}
                  </p>
                  {Number(inst.penalty_amount) > 0 && !inst.is_penalty && (
                    <p className="text-xs text-destructive">Multa: {formatCurrency(Number(inst.penalty_amount))}</p>
                  )}
                </div>
                <Badge className={getStatusColor(inst.status)}>{getStatusLabel(inst.status)}</Badge>
              </div>

              {inst.status === "paid" ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={() => handleUndoPayment(inst.id)}
                >
                  <Undo2 className="mr-1 h-3 w-3" /> Desfazer Pagamento
                </Button>
              ) : (
                <div className="flex gap-2">
                  <Dialog open={payDialogId === inst.id} onOpenChange={(o) => { setPayDialogId(o ? inst.id : null); if (!o) setPayAmount(""); }}>
                    <DialogTrigger asChild>
                      <Button size="sm" className="flex-1 bg-success hover:bg-success/90">
                        <CheckCircle className="mr-1 h-3 w-3" /> Pagou
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Registrar Pagamento</DialogTitle>
                      </DialogHeader>
                      <div className="space-y-3">
                        <p className="text-sm text-muted-foreground">
                          {inst.is_penalty ? "Multa" : `Parcela ${inst.number}`} — Valor: {formatCurrency(Number(inst.amount))}
                        </p>
                        <Input
                          type="number"
                          placeholder={`Valor recebido (padrão: ${Number(inst.amount).toFixed(2)})`}
                          value={payAmount}
                          onChange={(e) => setPayAmount(e.target.value)}
                        />
                        <Button onClick={() => handlePay(inst.id)} className="w-full bg-success hover:bg-success/90">
                          Confirmar Pagamento
                        </Button>
                      </div>
                    </DialogContent>
                  </Dialog>
                  <Button size="sm" variant="destructive" className="flex-1" onClick={() => handleNotPaid(inst.id)}>
                    <XCircle className="mr-1 h-3 w-3" /> Não Pagou
                  </Button>
                  {!inst.is_penalty && (
                    <Dialog open={penaltyDialogId === inst.id} onOpenChange={(o) => setPenaltyDialogId(o ? inst.id : null)}>
                      <DialogTrigger asChild>
                        <Button size="sm" variant="outline" className="px-2">
                          <AlertTriangle className="h-3 w-3" />
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Adicionar Multa</DialogTitle>
                        </DialogHeader>
                        <div className="space-y-3">
                          <p className="text-sm text-muted-foreground">Parcela {inst.number}</p>
                          <Input
                            type="number"
                            placeholder="Valor da multa"
                            value={penaltyAmount}
                            onChange={(e) => setPenaltyAmount(e.target.value)}
                          />
                          <Button onClick={() => handleAddPenalty(inst.id)} className="w-full">
                            Adicionar Multa
                          </Button>
                        </div>
                      </DialogContent>
                    </Dialog>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
