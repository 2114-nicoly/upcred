import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  formatCurrency,
  getStatusColor,
  getStatusLabel,
  getLoanStatusColor,
  getInstallmentDisplayStatus,
} from "@/lib/loan-utils";
import { ArrowLeft, CheckCircle, XCircle, AlertTriangle, DollarSign, Undo2, Pencil, Trash2 } from "lucide-react";
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
  paid_amount: number;
};

type Penalty = {
  id: string;
  loan_id: string;
  installment_id: string;
  amount: number;
  created_at: string;
};

export default function LoanDetailPage() {
  const { loanId } = useParams();
  const navigate = useNavigate();
  const [loan, setLoan] = useState<Loan | null>(null);
  const [installments, setInstallments] = useState<Installment[]>([]);
  const [penalties, setPenalties] = useState<Penalty[]>([]);
  const [penaltyAmount, setPenaltyAmount] = useState("");
  const [penaltyDialogId, setPenaltyDialogId] = useState<string | null>(null);
  const [payDialogId, setPayDialogId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [penaltyDetailOpen, setPenaltyDetailOpen] = useState(false);
  const [editingPenalty, setEditingPenalty] = useState<string | null>(null);
  const [editPenaltyValue, setEditPenaltyValue] = useState("");

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

    const { data: pen } = await supabase
      .from("penalties")
      .select("*")
      .eq("loan_id", loanId!)
      .order("created_at");
    setPenalties(pen || []);
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
    const paidValue = payAmount ? parseFloat(payAmount) : null;

    if (payAmount && (isNaN(paidValue!) || paidValue! <= 0)) {
      toast.error("Informe um valor válido");
      return;
    }

    const unpaid = installments
      .filter((i) => i.status !== "paid")
      .sort((a, b) => a.number - b.number);

    const currentInst = unpaid.find((i) => i.id === id);
    if (!currentInst) return;

    let remaining = paidValue ?? (Number(currentInst.amount) - Number(currentInst.paid_amount));
    const toProcess = unpaid.filter((i) => i.number >= currentInst.number);

    for (const inst of toProcess) {
      if (remaining <= 0) break;
      const instRemaining = Number(inst.amount) - Number(inst.paid_amount);
      const applying = Math.min(remaining, instRemaining);
      const newPaidAmount = Number(inst.paid_amount) + applying;
      const fullyPaid = newPaidAmount >= Number(inst.amount) - 0.01;

      await supabase
        .from("installments")
        .update({
          paid_amount: newPaidAmount,
          status: fullyPaid ? "paid" : inst.status,
          paid_at: fullyPaid ? new Date().toISOString() : inst.paid_at,
        })
        .eq("id", inst.id);

      remaining -= applying;
    }

    const totalApplied = (paidValue ?? (Number(currentInst.amount) - Number(currentInst.paid_amount))) - remaining;
    toast.success(`Pagamento de ${formatCurrency(totalApplied)} registrado!`);

    if (remaining > 0) {
      toast.info(`Sobra de ${formatCurrency(remaining)} (sem mais parcelas para abater)`);
    }

    await updateLoanStatus();
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
    await supabase.from("installments").update({ status: "pending", paid_at: null, paid_amount: 0 }).eq("id", id);
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

    // Record individual penalty
    await supabase.from("penalties").insert({
      loan_id: loanId!,
      installment_id: installmentId,
      amount,
    });

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

  const handleEditPenalty = async (penaltyId: string) => {
    const newAmount = parseFloat(editPenaltyValue);
    if (!newAmount || newAmount <= 0) {
      toast.error("Informe um valor válido");
      return;
    }

    const penalty = penalties.find((p) => p.id === penaltyId);
    if (!penalty) return;

    const diff = newAmount - Number(penalty.amount);

    await supabase.from("penalties").update({ amount: newAmount }).eq("id", penaltyId);

    // Update penalty_amount on the source installment
    const srcInst = installments.find((i) => i.id === penalty.installment_id);
    if (srcInst) {
      await supabase.from("installments").update({
        penalty_amount: Number(srcInst.penalty_amount) + diff,
      }).eq("id", srcInst.id);
    }

    // Update penalty installment total
    const penaltyInst = installments.find((i) => i.is_penalty);
    if (penaltyInst) {
      await supabase.from("installments").update({
        amount: Number(penaltyInst.amount) + diff,
      }).eq("id", penaltyInst.id);
    }

    toast.success("Multa atualizada!");
    setEditingPenalty(null);
    setEditPenaltyValue("");
    fetchData();
  };

  const handleDeletePenalty = async (penaltyId: string) => {
    const penalty = penalties.find((p) => p.id === penaltyId);
    if (!penalty) return;

    await supabase.from("penalties").delete().eq("id", penaltyId);

    // Subtract from source installment penalty_amount
    const srcInst = installments.find((i) => i.id === penalty.installment_id);
    if (srcInst) {
      await supabase.from("installments").update({
        penalty_amount: Math.max(0, Number(srcInst.penalty_amount) - Number(penalty.amount)),
      }).eq("id", srcInst.id);
    }

    // Subtract from penalty installment
    const penaltyInst = installments.find((i) => i.is_penalty);
    if (penaltyInst) {
      const newAmount = Number(penaltyInst.amount) - Number(penalty.amount);
      if (newAmount <= 0.01) {
        await supabase.from("installments").delete().eq("id", penaltyInst.id);
      } else {
        await supabase.from("installments").update({ amount: newAmount }).eq("id", penaltyInst.id);
      }
    }

    toast.success("Multa removida!");
    fetchData();
  };

  if (!loan) return <p className="p-4 text-center">Carregando...</p>;

  const regularInstallments = installments.filter((i) => !i.is_penalty);
  const totalPaidAmount = regularInstallments.reduce((s, i) => s + Number(i.paid_amount), 0);
  const installmentValue = regularInstallments.length > 0 ? Number(regularInstallments[0].amount) : 1;
  const paidInstallmentsProgress = totalPaidAmount / installmentValue;
  const totalInstallments = regularInstallments.length;
  const progressPercent = totalInstallments > 0 ? (paidInstallmentsProgress / totalInstallments) * 100 : 0;

  const totalPaid = installments.reduce((s, i) => s + Number(i.paid_amount), 0);
  const totalOwed = installments.reduce((s, i) => s + Number(i.amount), 0);
  const remaining = totalOwed - totalPaid;

  const paymentTypeLabel: Record<string, string> = {
    daily: "Diário",
    weekly: "Semanal",
    biweekly: "Quinzenal",
    monthly: "Mensal",
    fixed_dates: "Data Fixa",
  };

  // Find which installment each penalty belongs to
  const getInstallmentNumber = (installmentId: string) => {
    const inst = installments.find((i) => i.id === installmentId);
    return inst ? inst.number : "?";
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
              {paidInstallmentsProgress % 1 === 0
                ? `${paidInstallmentsProgress}/${totalInstallments}`
                : `${paidInstallmentsProgress.toFixed(1)}/${totalInstallments}`} parcelas pagas
            </span>
          </div>
          <Progress value={Math.min(progressPercent, 100)} className="mb-3" />
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
        {installments.map((inst) => {
          const displayStatus = getInstallmentDisplayStatus(inst);
          const instRemaining = Number(inst.amount) - Number(inst.paid_amount);

          return (
            <Card key={inst.id} className={inst.is_penalty ? "border-warning/50" : ""}>
              <CardContent className="p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div>
                    <p className="font-semibold">
                      {inst.is_penalty ? (
                        <button
                          className="flex items-center gap-1 text-left hover:underline"
                          onClick={() => setPenaltyDetailOpen(true)}
                        >
                          🔶 Multa <span className="text-xs text-muted-foreground">({penalties.length} registro{penalties.length !== 1 ? "s" : ""})</span>
                        </button>
                      ) : (
                        `Parcela ${inst.number}`
                      )}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {format(new Date(inst.due_date + "T12:00:00"), "dd/MM/yyyy")} • {formatCurrency(Number(inst.amount))}
                    </p>
                    {Number(inst.paid_amount) > 0 && inst.status !== "paid" && (
                      <p className="text-xs text-partial">
                        Pago: {formatCurrency(Number(inst.paid_amount))} / Resta: {formatCurrency(instRemaining)}
                      </p>
                    )}
                    {Number(inst.penalty_amount) > 0 && !inst.is_penalty && (
                      <p className="text-xs text-destructive">Multa: {formatCurrency(Number(inst.penalty_amount))}</p>
                    )}
                  </div>
                  <Badge className={getStatusColor(displayStatus)}>{getStatusLabel(displayStatus)}</Badge>
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
                          {Number(inst.paid_amount) > 0 && (
                            <p className="text-sm text-partial">
                              Já pago: {formatCurrency(Number(inst.paid_amount))} — Resta: {formatCurrency(instRemaining)}
                            </p>
                          )}
                          <Input
                            type="number"
                            placeholder={`Valor recebido (padrão: ${instRemaining.toFixed(2)})`}
                            value={payAmount}
                            onChange={(e) => setPayAmount(e.target.value)}
                          />
                          <p className="text-xs text-muted-foreground">
                            💡 Se o valor exceder esta parcela, o restante será abatido nas próximas parcelas automaticamente.
                          </p>
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
          );
        })}
      </div>

      {/* Penalty Detail Dialog */}
      <Dialog open={penaltyDetailOpen} onOpenChange={setPenaltyDetailOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Detalhes das Multas</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 max-h-[60vh] overflow-y-auto">
            {penalties.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">Nenhuma multa registrada.</p>
            ) : (
              penalties.map((p) => (
                <div key={p.id} className="flex items-center justify-between rounded-lg border p-3">
                  {editingPenalty === p.id ? (
                    <div className="flex flex-1 items-center gap-2">
                      <Input
                        type="number"
                        value={editPenaltyValue}
                        onChange={(e) => setEditPenaltyValue(e.target.value)}
                        className="h-8 w-24"
                      />
                      <Button size="sm" onClick={() => handleEditPenalty(p.id)}>Salvar</Button>
                      <Button size="sm" variant="ghost" onClick={() => { setEditingPenalty(null); setEditPenaltyValue(""); }}>Cancelar</Button>
                    </div>
                  ) : (
                    <>
                      <div>
                        <p className="text-sm font-medium">{formatCurrency(Number(p.amount))}</p>
                        <p className="text-xs text-muted-foreground">
                          Parcela {getInstallmentNumber(p.installment_id)} • {format(new Date(p.created_at), "dd/MM/yyyy HH:mm")}
                        </p>
                      </div>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 w-8 p-0"
                          onClick={() => { setEditingPenalty(p.id); setEditPenaltyValue(String(p.amount)); }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                          onClick={() => handleDeletePenalty(p.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
