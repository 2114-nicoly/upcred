import { useEffect, useState, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  formatCurrency,
  getStatusColor,
  getStatusLabel,
  getLoanStatusColor,
  getInstallmentDisplayStatus,
  getOverdueDatesList,
  getPaymentTypeLabel,
  calculateLoan,
  generateDueDates,
  calculateLoanProgress,
} from "@/lib/loan-utils";
import { updateCashBalance, recalculateCashBalanceFromLedger } from "@/lib/cash-utils";
import { registerPayment, registerPenaltyPayment, settleLoan, reverseInstallmentPayment, editPayment } from "@/lib/payment-utils";
import { deleteDailyEvent } from "@/lib/daily-events";
import { ArrowLeft, CheckCircle, DollarSign, Undo2, Pencil, Trash2, ChevronDown, Plus, Calendar, Calculator, RefreshCw, AlertTriangle, History } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

type Loan = {
  id: string;
  amount: number;
  interest_type: string;
  interest_value: number;
  total_amount: number;
  remaining_balance: number;
  installment_count: number;
  payment_type: string;
  first_due_date: string | null;
  loan_date: string;
  status: string;
  client_id: string;
  is_cravo: boolean;
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
  observation: string | null;
};

type PaymentHistoryEntry = {
  movementId: string;
  eventId: string;
  amount: number;
  cashDate: string;
  observation: string | null;
  createdAt: string;
};

export default function LoanDetailPage() {
  const { loanId } = useParams();
  const navigate = useNavigate();
  const [loan, setLoan] = useState<Loan | null>(null);
  const [installments, setInstallments] = useState<Installment[]>([]);
  const [penalties, setPenalties] = useState<Penalty[]>([]);
  const [paymentHistory, setPaymentHistory] = useState<PaymentHistoryEntry[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Payment dialog
  const [payOpen, setPayOpen] = useState(false);
  const [payAmount, setPayAmount] = useState("");
  const [payPenaltyAmount, setPayPenaltyAmount] = useState("");
  const [payDate, setPayDate] = useState(format(new Date(), "yyyy-MM-dd"));

  // Penalty dialog
  const [penaltyDetailOpen, setPenaltyDetailOpen] = useState(false);
  const [penaltyAmount, setPenaltyAmount] = useState("");
  const [penaltyObservation, setPenaltyObservation] = useState("");
  const [editingPenalty, setEditingPenalty] = useState<string | null>(null);
  const [editPenaltyValue, setEditPenaltyValue] = useState("");
  const [editPenaltyObs, setEditPenaltyObs] = useState("");

  // Quitar
  const [quitarOpen, setQuitarOpen] = useState(false);
  const [quitarDate, setQuitarDate] = useState(format(new Date(), "yyyy-MM-dd"));

  // Overdue dates
  const [overdueDatesOpen, setOverdueDatesOpen] = useState(false);
  const [overduePenaltyDate, setOverduePenaltyDate] = useState<string | null>(null);
  const [overduePenaltyAmount, setOverduePenaltyAmount] = useState("");
  const [overduePenaltyObs, setOverduePenaltyObs] = useState("");

  // Edit loan
  const [editLoanOpen, setEditLoanOpen] = useState(false);
  const [editAmount, setEditAmount] = useState("");
  const [editInterestValue, setEditInterestValue] = useState("");
  const [editInterestType, setEditInterestType] = useState("percentage");
  const [editPaymentType, setEditPaymentType] = useState("");
  const [editLoanDate, setEditLoanDate] = useState("");
  const [editFirstDueDate, setEditFirstDueDate] = useState("");
  const [editInstallmentCount, setEditInstallmentCount] = useState("");
  const [editStatus, setEditStatus] = useState("");
  const [editIsCravo, setEditIsCravo] = useState(false);

  // Edit installment
  const [editInstId, setEditInstId] = useState<string | null>(null);
  const [editInstAmount, setEditInstAmount] = useState("");
  const [editInstDueDate, setEditInstDueDate] = useState("");

  // Collapsible sections
  const [paidOpen, setPaidOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Edit payment
  const [editPayOpen, setEditPayOpen] = useState(false);
  const [editPayEntry, setEditPayEntry] = useState<PaymentHistoryEntry | null>(null);
  const [editPayNewAmount, setEditPayNewAmount] = useState("");

  const fetchData = async () => {
    const { data: l } = await supabase.from("loans").select("*, clients(name)").eq("id", loanId!).single();
    setLoan(l as unknown as Loan);
    const { data: inst } = await supabase.from("installments").select("*").eq("loan_id", loanId!).order("number");
    setInstallments(inst || []);
    const { data: pen } = await supabase.from("penalties").select("*").eq("loan_id", loanId!).order("created_at");
    setPenalties((pen as Penalty[]) || []);

    // Fetch payment history: join cash_movements with daily_events
    const { data: movs } = await supabase.from("cash_movements")
      .select("id, amount, cash_date, observation, created_at")
      .eq("loan_id", loanId!)
      .eq("type", "recebimento_normal")
      .order("cash_date", { ascending: false });

    const { data: events } = await (supabase.from("daily_events" as any)
      .select("id, cash_date, amount_in, observation")
      .eq("loan_id", loanId!)
      .eq("event_type", "pagamento")
      .order("cash_date", { ascending: false }) as any);

    // Match movements with events by cash_date
    const history: PaymentHistoryEntry[] = (movs || []).map((m: any) => {
      const matchingEvent = (events || []).find((e: any) => e.cash_date === m.cash_date);
      return {
        movementId: m.id,
        eventId: matchingEvent?.id || "",
        amount: Number(m.amount),
        cashDate: m.cash_date,
        observation: m.observation,
        createdAt: m.created_at,
      };
    });
    setPaymentHistory(history);
  };

  useEffect(() => { fetchData(); }, [loanId]);

  // --- Derived data ---
  const regularInstallments = installments.filter((i) => !i.is_penalty);
  const penaltyInst = installments.find((i) => i.is_penalty);

  const pendingInstallments = regularInstallments.filter((i) => i.status !== "paid");
  const paidInstallments = regularInstallments.filter((i) => i.status === "paid");

  const loanProgress = loan ? calculateLoanProgress({
    totalAmount: Number(loan.total_amount),
    remainingBalance: Number(loan.remaining_balance),
    installmentCount: loan.installment_count,
  }) : null;

  const penaltyTotal = penaltyInst ? Number(penaltyInst.amount) : 0;
  const penaltyPaid = penaltyInst ? Number(penaltyInst.paid_amount) : 0;

  // Overdue calculation
  const overdueInstallments = regularInstallments.filter((i) => {
    const ds = getInstallmentDisplayStatus(i);
    return ds === "overdue";
  });
  const oldestOverdue = overdueInstallments.length > 0
    ? overdueInstallments.reduce((o, i) => i.due_date < o.due_date ? i : o, overdueInstallments[0])
    : null;
  const overdueDatesList = oldestOverdue && loan
    ? getOverdueDatesList(oldestOverdue.due_date, loan.payment_type)
    : [];
  const overdueDaysCount = overdueDatesList.length;

  // --- Register payment (auto-distribute) ---
  const handleRegisterPayment = async () => {
    if (isSubmitting || !loan) return;
    const parcValue = payAmount ? parseFloat(payAmount) : null;
    const multaValue = payPenaltyAmount ? parseFloat(payPenaltyAmount) : 0;

    if (payAmount && (isNaN(parcValue!) || parcValue! <= 0)) {
      toast.error("Valor inválido");
      return;
    }

    setIsSubmitting(true);
    try {
      // Penalty payment
      if (multaValue > 0) {
        try {
          await registerPenaltyPayment({
            loanId: loanId!, amount: multaValue,
            clientId: loan.client_id, clientName: loan.clients.name,
            cashDate: payDate, origin: "detalhe_emprestimo",
          });
          toast.success(`Multa: ${formatCurrency(multaValue)} registrado!`);
        } catch { toast.error("Nenhuma multa registrada para abater"); }
      }

      // Regular payment - auto-distributes across installments
      if (parcValue && parcValue > 0) {
        // Find first unpaid installment to start from
        const firstUnpaid = pendingInstallments.sort((a, b) => a.number - b.number)[0];
        await registerPayment({
          loanId: loanId!, amount: parcValue,
          clientId: loan.client_id, clientName: loan.clients.name,
          cashDate: payDate, origin: "detalhe_emprestimo",
          installmentId: firstUnpaid?.id,
          startInstNumber: firstUnpaid?.number || 1,
        });
        toast.success(`Pagamento de ${formatCurrency(parcValue)} distribuído nas parcelas!`);
      }
    } catch {
      toast.error("Erro ao processar pagamento");
    }

    setPayAmount("");
    setPayPenaltyAmount("");
    setPayDate(format(new Date(), "yyyy-MM-dd"));
    setPayOpen(false);
    setIsSubmitting(false);
    fetchData();
  };

  // --- Undo payment on a specific installment ---
  const handleUndoPayment = async (instId: string) => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await reverseInstallmentPayment({ installmentId: instId, loanId: loanId! });
      toast.success("Pagamento desfeito!");
    } catch {
      toast.error("Erro ao desfazer pagamento");
    }
    setIsSubmitting(false);
    fetchData();
  };

  // --- Undo payment from history ---
  const handleUndoHistoryPayment = async (entry: PaymentHistoryEntry) => {
    if (isSubmitting || !loan) return;
    if (!confirm(`Desfazer pagamento de ${formatCurrency(entry.amount)}?`)) return;
    setIsSubmitting(true);
    try {
      await supabase.rpc("reverse_loan_payment", { p_loan_id: loanId!, p_amount: entry.amount });
      const { data: movs } = await supabase.from("cash_movements")
        .select("installment_id").eq("id", entry.movementId);
      const instId = movs?.[0]?.installment_id;
      if (instId) {
        await supabase.from("installments").update({
          status: "pending", paid_at: null, paid_amount: 0,
        }).eq("id", instId);
      }
      await supabase.from("cash_movements").delete().eq("id", entry.movementId);
      if (entry.eventId) await deleteDailyEvent(entry.eventId);
      await recalculateCashBalanceFromLedger();
      const { data: loanInsts } = await supabase.from("installments").select("status").eq("loan_id", loanId!);
      const allPaid = loanInsts?.every((i: any) => i.status === "paid");
      const hasOverdue = loanInsts?.some((i: any) => i.status === "overdue");
      await supabase.from("loans").update({
        status: allPaid ? "paid" : hasOverdue ? "overdue" : "open",
      }).eq("id", loanId!);
      toast.success("Pagamento desfeito!");
    } catch { toast.error("Erro ao desfazer pagamento"); }
    setIsSubmitting(false);
    fetchData();
  };

  // --- Edit payment from history ---
  const handleEditPaymentConfirm = async () => {
    if (isSubmitting || !loan || !editPayEntry) return;
    const newAmount = parseFloat(editPayNewAmount);
    if (isNaN(newAmount) || newAmount <= 0) { toast.error("Valor inválido"); return; }
    setIsSubmitting(true);
    try {
      await editPayment({
        loanId: loanId!, clientId: loan.client_id, clientName: loan.clients.name,
        cashDate: editPayEntry.cashDate, oldAmount: editPayEntry.amount, newAmount,
        origin: "detalhe_emprestimo", movementId: editPayEntry.movementId, eventId: editPayEntry.eventId,
      });
      toast.success("Pagamento editado!");
    } catch { toast.error("Erro ao editar pagamento"); }
    setIsSubmitting(false);
    setEditPayOpen(false);
    setEditPayEntry(null);
    setEditPayNewAmount("");
    fetchData();
  };

  // --- Quitar ---
  const handleQuitarEmprestimo = async () => {
    if (isSubmitting || !loan) return;
    setIsSubmitting(true);
    try {
      await settleLoan({
        loanId: loanId!, clientId: loan.client_id,
        clientName: loan.clients.name, cashDate: quitarDate,
        origin: "detalhe_emprestimo",
      });
      toast.success("Empréstimo quitado!");
    } catch {
      toast.error("Erro ao quitar");
    }
    setIsSubmitting(false);
    setQuitarOpen(false);
    setQuitarDate(format(new Date(), "yyyy-MM-dd"));
    fetchData();
  };

  // --- Penalties ---
  const handleAddPenalty = async (installmentId: string, amount?: number, observation?: string) => {
    const penAmount = amount ?? parseFloat(penaltyAmount);
    const penObs = observation ?? penaltyObservation;
    if (!penAmount || penAmount <= 0) { toast.error("Informe um valor válido para a multa"); return; }
    const inst = installments.find((i) => i.id === installmentId);
    if (!inst) return;

    await supabase.from("penalties").insert({
      loan_id: loanId!, installment_id: installmentId,
      amount: penAmount, observation: penObs || null,
    });

    const newPenalty = Number(inst.penalty_amount) + penAmount;
    await supabase.from("installments").update({ penalty_amount: newPenalty }).eq("id", installmentId);

    if (penaltyInst) {
      await supabase.from("installments").update({ amount: Number(penaltyInst.amount) + penAmount }).eq("id", penaltyInst.id);
    } else {
      const maxNumber = Math.max(...installments.map((i) => i.number));
      await supabase.from("installments").insert({
        loan_id: loanId!, number: maxNumber + 1, amount: penAmount,
        due_date: format(new Date(), "yyyy-MM-dd"), is_penalty: true, status: "pending",
      });
    }

    await updateCashBalance({ penalty_receivable: penAmount });
    toast.success("Multa adicionada!");
    setPenaltyAmount(""); setPenaltyObservation("");
    fetchData();
  };

  const handleEditPenalty = async (penaltyId: string) => {
    const newAmount = parseFloat(editPenaltyValue);
    if (!newAmount || newAmount <= 0) { toast.error("Informe um valor válido"); return; }
    const penalty = penalties.find((p) => p.id === penaltyId);
    if (!penalty) return;
    const diff = newAmount - Number(penalty.amount);
    await supabase.from("penalties").update({ amount: newAmount, observation: editPenaltyObs || penalty.observation }).eq("id", penaltyId);
    const srcInst = installments.find((i) => i.id === penalty.installment_id);
    if (srcInst) {
      await supabase.from("installments").update({ penalty_amount: Math.max(0, Number(srcInst.penalty_amount) + diff) }).eq("id", srcInst.id);
    }
    if (penaltyInst) {
      const newPenaltyTotal = Math.max(0, Number(penaltyInst.amount) + diff);
      if (newPenaltyTotal <= 0.01) {
        await supabase.from("installments").delete().eq("id", penaltyInst.id);
      } else {
        await supabase.from("installments").update({ amount: newPenaltyTotal }).eq("id", penaltyInst.id);
      }
    }
    await updateCashBalance({ penalty_receivable: diff });
    toast.success("Multa atualizada!");
    setEditingPenalty(null); setEditPenaltyValue(""); setEditPenaltyObs("");
    fetchData();
  };

  const handleDeletePenalty = async (penaltyId: string) => {
    const penalty = penalties.find((p) => p.id === penaltyId);
    if (!penalty) return;
    await supabase.from("penalties").delete().eq("id", penaltyId);
    const srcInst = installments.find((i) => i.id === penalty.installment_id);
    if (srcInst) {
      await supabase.from("installments").update({ penalty_amount: Math.max(0, Number(srcInst.penalty_amount) - Number(penalty.amount)) }).eq("id", srcInst.id);
    }
    if (penaltyInst) {
      const newAmount = Number(penaltyInst.amount) - Number(penalty.amount);
      if (newAmount <= 0.01) await supabase.from("installments").delete().eq("id", penaltyInst.id);
      else await supabase.from("installments").update({ amount: newAmount }).eq("id", penaltyInst.id);
    }
    await updateCashBalance({ penalty_receivable: -Number(penalty.amount) });
    toast.success("Multa removida!");
    fetchData();
  };

  const handleAddPenaltyFromDate = async () => {
    const amount = parseFloat(overduePenaltyAmount);
    if (!amount || amount <= 0) { toast.error("Valor inválido"); return; }
    const target = regularInstallments.filter((i) => i.status !== "paid").sort((a, b) => a.number - b.number)[0];
    if (!target) { toast.error("Nenhuma parcela disponível"); return; }
    const obs = overduePenaltyObs ? `${overduePenaltyObs} (Ref: ${overduePenaltyDate})` : `Multa ref. atraso ${overduePenaltyDate}`;
    await handleAddPenalty(target.id, amount, obs);
    setOverduePenaltyDate(null); setOverduePenaltyAmount(""); setOverduePenaltyObs("");
  };

  // --- Edit Loan (renegotiation) ---
  const editNumAmount = parseFloat(editAmount) || 0;
  const editNumInterest = parseFloat(editInterestValue) || 0;
  const editNumInstallments = parseInt(editInstallmentCount) || 0;

  const editCalc = useMemo(() => {
    if (editNumAmount <= 0 || editNumInstallments <= 0) return null;
    return calculateLoan(editNumAmount, editInterestType as "percentage" | "fixed", editNumInterest, editNumInstallments);
  }, [editNumAmount, editInterestType, editNumInterest, editNumInstallments]);

  const editDueDates = useMemo(() => {
    if (!editFirstDueDate || editNumInstallments <= 0 || editPaymentType === "fixed_dates") return [];
    return generateDueDates(new Date(editFirstDueDate + "T12:00:00"), editNumInstallments, editPaymentType as "daily" | "weekly" | "biweekly" | "monthly");
  }, [editFirstDueDate, editNumInstallments, editPaymentType]);

  const handleEditLoan = async () => {
    if (!editCalc) { toast.error("Preencha todos os campos corretamente"); return; }
    if (!editFirstDueDate && editPaymentType !== "fixed_dates") { toast.error("Informe a data do primeiro vencimento"); return; }

    await supabase.from("loans").update({
      amount: editNumAmount, interest_type: editInterestType, interest_value: editNumInterest,
      total_amount: editCalc.totalAmount, installment_count: editNumInstallments,
      payment_type: editPaymentType, loan_date: editLoanDate,
      first_due_date: editFirstDueDate || null, status: editStatus, is_cravo: editIsCravo,
    }).eq("id", loanId!);

    const nonPenaltyIds = installments.filter(i => !i.is_penalty).map(i => i.id);
    if (nonPenaltyIds.length > 0) {
      for (const instId of nonPenaltyIds) {
        await supabase.from("penalties").delete().eq("installment_id", instId);
      }
      await supabase.from("installments").delete().in("id", nonPenaltyIds);
    }

    const dates = editDueDates;
    if (dates.length > 0) {
      const newInstallments = dates.map((date, i) => ({
        loan_id: loanId!, number: i + 1,
        amount: editCalc.installmentAmount, due_date: format(date, "yyyy-MM-dd"), status: "pending" as const,
      }));
      await supabase.from("installments").insert(newInstallments);
    }

    await recalculateCashBalanceFromLedger();
    toast.success("Empréstimo renegociado com sucesso!");
    setEditLoanOpen(false);
    fetchData();
  };

  const openEditLoan = () => {
    if (!loan) return;
    setEditAmount(String(loan.amount)); setEditInterestValue(String(loan.interest_value));
    setEditInterestType(loan.interest_type); setEditPaymentType(loan.payment_type);
    setEditLoanDate(loan.loan_date); setEditFirstDueDate(loan.first_due_date || "");
    setEditInstallmentCount(String(loan.installment_count)); setEditStatus(loan.status);
    setEditIsCravo(loan.is_cravo); setEditLoanOpen(true);
  };

  // --- Edit/Delete installment ---
  const handleEditInstallment = async () => {
    if (!editInstId) return;
    const newAmount = parseFloat(editInstAmount);
    if (isNaN(newAmount) || newAmount <= 0) { toast.error("Valor inválido"); return; }
    await supabase.from("installments").update({ amount: newAmount, due_date: editInstDueDate }).eq("id", editInstId);
    toast.success("Parcela atualizada!");
    setEditInstId(null);
    fetchData();
  };

  const handleDeleteInstallment = async (id: string) => {
    if (!confirm("Excluir esta parcela?")) return;
    const relatedPenalties = penalties.filter(p => p.installment_id === id);
    const totalPenaltyRemoved = relatedPenalties.reduce((s, p) => s + Number(p.amount), 0);
    await supabase.from("penalties").delete().eq("installment_id", id);
    if (totalPenaltyRemoved > 0 && penaltyInst) {
      const newAmount = Number(penaltyInst.amount) - totalPenaltyRemoved;
      if (newAmount <= 0.01) await supabase.from("installments").delete().eq("id", penaltyInst.id);
      else await supabase.from("installments").update({ amount: newAmount }).eq("id", penaltyInst.id);
    }
    await supabase.from("installments").delete().eq("id", id);
    toast.success("Parcela excluída!");
    fetchData();
  };

  const handleDeleteLoan = async () => {
    if (!confirm("Excluir este empréstimo e todas as parcelas?")) return;
    await supabase.from("not_paid_marks").delete().eq("loan_id", loanId!);
    await supabase.from("cash_movements").delete().eq("loan_id", loanId!);
    await supabase.from("penalties").delete().eq("loan_id", loanId!);
    await supabase.from("installments").delete().eq("loan_id", loanId!);
    await supabase.from("loans").delete().eq("id", loanId!);
    await recalculateCashBalanceFromLedger();
    toast.success("Empréstimo excluído!");
    navigate(-1);
  };

  const getInstallmentNumber = (installmentId: string) => {
    const inst = installments.find((i) => i.id === installmentId);
    return inst ? inst.number : "?";
  };

  if (!loan || !loanProgress) return <p className="p-4 text-center text-muted-foreground">Carregando...</p>;

  const totalLoanAmount = Number(loan.total_amount);
  const totalPaidAll = loanProgress.totalPaid;
  const remainingLoan = Number(loan.remaining_balance);
  const nextInstallment = pendingInstallments.sort((a, b) => a.number - b.number)[0];
  const nextInstValue = nextInstallment ? Number(nextInstallment.amount) - Number(nextInstallment.paid_amount) : 0;

  return (
    <div className="mx-auto max-w-lg p-4">
      {/* Action buttons */}
      <div className="mb-2 flex items-center justify-between">
        {loan.status !== "paid" && (
          <div className="flex gap-1">
            <Button size="sm" className="bg-success hover:bg-success/90" onClick={() => setQuitarOpen(true)}>
              <DollarSign className="mr-1 h-4 w-4" /> Quitar
            </Button>
            <Button size="sm" variant="outline" onClick={() => navigate(`/clients/${loan.client_id}/new-loan?renewFrom=${loanId}`)}>
              <RefreshCw className="mr-1 h-4 w-4" /> Renovar
            </Button>
          </div>
        )}
        <div className="flex gap-1 ml-auto">
          <Button variant="ghost" size="sm" onClick={openEditLoan}>
            <Pencil className="mr-1 h-4 w-4" /> Editar
          </Button>
          <Button variant="ghost" size="sm" className="text-destructive" onClick={handleDeleteLoan}>
            <Trash2 className="mr-1 h-4 w-4" /> Excluir
          </Button>
        </div>
      </div>

      {/* Loan Info Card */}
      <Card className="mb-4">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">
              <button className="hover:underline text-primary cursor-pointer" onClick={() => navigate(`/clients/${loan.client_id}`)}>
                {loan.clients.name}
              </button>
            </CardTitle>
            <Badge className={getLoanStatusColor(loan.status)}>{getStatusLabel(loan.status)}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Emprestado:</span><span>{formatCurrency(Number(loan.amount))}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Juros:</span><span>{formatCurrency(totalLoanAmount - Number(loan.amount))}</span></div>
          <div className="flex justify-between font-bold"><span>Valor Total:</span><span className="text-primary">{formatCurrency(totalLoanAmount)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Pago:</span><span className="text-success">{formatCurrency(totalPaidAll)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Saldo Restante:</span><span className="font-bold">{formatCurrency(remainingLoan)}</span></div>
          {penaltyTotal > 0 && (
            <div className="border-t pt-2 space-y-1">
              <div className="flex justify-between"><span className="text-destructive font-medium">Total de Multas:</span><span className="text-destructive font-semibold">{formatCurrency(penaltyTotal - penaltyPaid)}</span></div>
              {penaltyPaid > 0 && (
                <div className="flex justify-between"><span className="text-muted-foreground">Multa paga:</span><span className="text-success">{formatCurrency(penaltyPaid)}</span></div>
              )}
            </div>
          )}
          {overdueDaysCount > 0 && (
            <div className="border-t pt-2">
              <button
                className="flex w-full items-center justify-between rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-left hover:bg-destructive/10 transition-colors"
                onClick={() => setOverdueDatesOpen(true)}
              >
                <div>
                  <p className="text-sm font-semibold text-destructive">{overdueDaysCount} dia{overdueDaysCount !== 1 ? "s" : ""} em atraso</p>
                  <p className="text-xs text-muted-foreground">Toque para ver datas e adicionar multas</p>
                </div>
                <Calendar className="h-5 w-5 text-destructive" />
              </button>
            </div>
          )}
          <div className="flex justify-between"><span className="text-muted-foreground">Tipo:</span><span>{getPaymentTypeLabel(loan.payment_type, loan.first_due_date)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Data:</span><span>{format(new Date(loan.loan_date + "T12:00:00"), "dd/MM/yyyy")}</span></div>
          {loan.is_cravo && <Badge className="bg-warning text-warning-foreground">🔥 Cravo</Badge>}
        </CardContent>
      </Card>

      {/* Progress */}
      <Card className="mb-4">
        <CardContent className="p-4">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-medium">Progresso</span>
            <span className="text-muted-foreground">{loanProgress.progressFormatted} parcelas</span>
          </div>
          <Progress value={Math.min(loanProgress.progressPercent, 100)} className="mb-1" />
          <p className="text-xs text-muted-foreground text-right">
            Parcela: {formatCurrency(loanProgress.installmentValue)}
          </p>
        </CardContent>
      </Card>

      {/* Penalty button */}
      <Button variant="outline" className="w-full mb-4 border-warning/50 text-warning hover:bg-warning/10" onClick={() => setPenaltyDetailOpen(true)}>
        <AlertTriangle className="mr-2 h-4 w-4" />
        🔶 Multas {penaltyInst ? `(${formatCurrency(penaltyTotal - penaltyPaid)} pendente)` : ""}
      </Button>

      {/* === REGISTER PAYMENT BUTTON === */}
      {loan.status !== "paid" && (
        <Button className="w-full mb-4 bg-success hover:bg-success/90" size="lg" onClick={() => setPayOpen(true)}>
          <Plus className="mr-2 h-5 w-5" /> Registrar Pagamento
        </Button>
      )}

      {/* === INSTALLMENTS SECTION === */}
      <h2 className="mb-3 text-lg font-semibold">Parcelas</h2>

      {/* Paid installments (collapsible) */}
      {paidInstallments.length > 0 && (
        <Collapsible open={paidOpen} onOpenChange={setPaidOpen} className="mb-3">
          <CollapsibleTrigger asChild>
            <Button variant="outline" className="w-full">
              <CheckCircle className="mr-2 h-4 w-4 text-success" />
              Parcelas Pagas ({paidInstallments.length})
              <ChevronDown className={`ml-auto h-4 w-4 transition-transform ${paidOpen ? "rotate-180" : ""}`} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 space-y-2">
            {paidInstallments.map((inst) => (
              <Card key={inst.id} className="border-success/30">
                <CardContent className="p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">Parcela {inst.number}</span>
                        <Badge className={getStatusColor("paid")}>{getStatusLabel("paid")}</Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {format(new Date(inst.due_date + "T12:00:00"), "dd/MM/yyyy")}
                      </p>
                      <p className="text-sm text-success">
                        Pago: {formatCurrency(Number(inst.paid_amount))} de {formatCurrency(Number(inst.amount))}
                      </p>
                    </div>
                    <Button size="sm" variant="outline" className="h-8" onClick={() => handleUndoPayment(inst.id)} disabled={isSubmitting}>
                      <Undo2 className="mr-1 h-3 w-3" /> Desfazer
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Pending installments */}
      {pendingInstallments.length > 0 ? (
        <div className="space-y-2">
          {pendingInstallments.sort((a, b) => a.number - b.number).map((inst) => {
            const displayStatus = getInstallmentDisplayStatus(inst);
            const paidAmt = Number(inst.paid_amount);
            const totalAmt = Number(inst.amount);
            const remaining = totalAmt - paidAmt;
            const progressPct = totalAmt > 0 ? (paidAmt / totalAmt) * 100 : 0;

            return (
              <Card key={inst.id} className={displayStatus === "overdue" ? "border-destructive/40" : ""}>
                <CardContent className="p-3">
                  <div className="flex items-start justify-between mb-1">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">Parcela {inst.number}</span>
                        <Badge className={getStatusColor(displayStatus)}>{getStatusLabel(displayStatus)}</Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Vencimento: {format(new Date(inst.due_date + "T12:00:00"), "dd/MM/yyyy")}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => {
                        setEditInstId(inst.id);
                        setEditInstAmount(String(inst.amount));
                        setEditInstDueDate(inst.due_date);
                      }}>
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" onClick={() => handleDeleteInstallment(inst.id)}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>

                  {/* Amount details */}
                  <div className="text-sm space-y-1">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Valor:</span>
                      <span className="font-medium">{formatCurrency(totalAmt)}</span>
                    </div>
                    {paidAmt > 0 && (
                      <>
                        <div className="flex justify-between">
                          <span className="text-success">Pago:</span>
                          <span className="text-success font-medium">{formatCurrency(paidAmt)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Falta:</span>
                          <span className="font-bold">{formatCurrency(remaining)}</span>
                        </div>
                        <Progress value={progressPct} className="h-1.5 mt-1" />
                      </>
                    )}
                    {Number(inst.penalty_amount) > 0 && (
                      <div className="flex justify-between">
                        <span className="text-destructive">Multa:</span>
                        <span className="text-destructive">{formatCurrency(Number(inst.penalty_amount))}</span>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        loan.status === "paid" && (
          <p className="py-4 text-center text-muted-foreground">Todas as parcelas foram quitadas ✅</p>
        )
      )}

      {/* Penalty installment card */}
      {penaltyInst && (
        <Card className="border-warning/50 mt-3">
          <CardContent className="p-3">
            <div className="flex items-center justify-between mb-1">
              <div>
                <button className="flex items-center gap-1 text-left font-semibold hover:underline" onClick={() => setPenaltyDetailOpen(true)}>
                  🔶 Multa <span className="text-xs text-muted-foreground">({penalties.length} registro{penalties.length !== 1 ? "s" : ""}) — Ver/Editar</span>
                </button>
                <p className="text-sm text-muted-foreground">Total: {formatCurrency(penaltyTotal)}</p>
                {penaltyPaid > 0 && (
                  <p className="text-xs text-success">Pago: {formatCurrency(penaltyPaid)} • Resta: {formatCurrency(penaltyTotal - penaltyPaid)}</p>
                )}
              </div>
              <Badge className={getStatusColor(penaltyInst.status)}>{getStatusLabel(penaltyInst.status)}</Badge>
            </div>
            {penaltyInst.status === "paid" && (
              <Button size="sm" variant="outline" className="w-full" onClick={() => handleUndoPayment(penaltyInst.id)} disabled={isSubmitting}>
                <Undo2 className="mr-1 h-3 w-3" /> Desfazer
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* ======= DIALOGS ======= */}

      {/* Register Payment Dialog */}
      <Dialog open={payOpen} onOpenChange={(o) => { setPayOpen(o); if (!o) { setPayAmount(""); setPayPenaltyAmount(""); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Registrar Pagamento</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="rounded-lg bg-muted/50 p-3 text-sm space-y-1">
              <div className="flex justify-between"><span>Saldo restante:</span><span className="font-bold">{formatCurrency(remainingLoan)}</span></div>
              {nextInstallment && (
                <div className="flex justify-between"><span>Próxima parcela ({nextInstallment.number}):</span><span>{formatCurrency(nextInstValue)}</span></div>
              )}
              <div className="flex justify-between"><span>Progresso:</span><span>{loanProgress.progressFormatted}</span></div>
            </div>

            <div>
              <Label>Valor do pagamento *</Label>
              <Input type="number" placeholder={nextInstValue > 0 ? `Ex: ${nextInstValue.toFixed(2)}` : "Valor"} value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
              <p className="text-xs text-muted-foreground mt-1">
                💡 O valor será distribuído automaticamente nas parcelas abertas em ordem. Sobra avança para as próximas.
              </p>
            </div>

            {penaltyInst && (penaltyTotal - penaltyPaid) > 0.01 && (
              <div className="rounded-lg border border-warning/50 p-3 space-y-2">
                <p className="text-xs font-medium text-warning">Multa pendente: {formatCurrency(penaltyTotal - penaltyPaid)}</p>
                <Label>Valor destinado à multa (opcional)</Label>
                <Input type="number" placeholder="0.00" value={payPenaltyAmount} onChange={(e) => setPayPenaltyAmount(e.target.value)} />
              </div>
            )}

            <div>
              <Label>Data do pagamento</Label>
              <Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
            </div>

            <Button onClick={handleRegisterPayment} className="w-full bg-success hover:bg-success/90" disabled={isSubmitting}>
              {isSubmitting ? "Processando..." : "Confirmar Pagamento"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Penalty Detail Dialog */}
      <Dialog open={penaltyDetailOpen} onOpenChange={(o) => { setPenaltyDetailOpen(o); if (!o) { setPenaltyAmount(""); setPenaltyObservation(""); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Gerenciar Multas</DialogTitle></DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto space-y-3">
            {penaltyInst && (
              <div className="rounded-lg bg-muted/50 p-3 text-sm space-y-1">
                <div className="flex justify-between"><span>Total:</span><span className="font-semibold text-destructive">{formatCurrency(penaltyTotal)}</span></div>
                <div className="flex justify-between"><span>Pago:</span><span className="text-success">{formatCurrency(penaltyPaid)}</span></div>
                <div className="flex justify-between"><span>Pendente:</span><span className="text-destructive">{formatCurrency(penaltyTotal - penaltyPaid)}</span></div>
              </div>
            )}
            <div className="rounded-lg border border-dashed border-warning/50 p-3 space-y-2">
              <p className="text-sm font-medium">Adicionar Multa</p>
              <div>
                <Label className="text-xs">Valor</Label>
                <Input type="number" placeholder="Valor" value={penaltyAmount} onChange={(e) => setPenaltyAmount(e.target.value)} className="h-9" />
              </div>
              <div>
                <Label className="text-xs">Observação (opcional)</Label>
                <Textarea placeholder="Motivo da multa..." value={penaltyObservation} onChange={(e) => setPenaltyObservation(e.target.value)} className="min-h-[60px]" />
              </div>
              <Button size="sm" className="w-full" onClick={() => {
                const target = regularInstallments.filter((i) => i.status !== "paid").sort((a, b) => a.number - b.number)[0];
                if (!target) { toast.error("Nenhuma parcela disponível"); return; }
                handleAddPenalty(target.id);
              }}>
                <Plus className="mr-1 h-3 w-3" /> Adicionar Multa
              </Button>
            </div>
            <div>
              <p className="text-sm font-medium mb-2">Histórico de Multas ({penalties.length})</p>
              <div className="space-y-2">
                {penalties.length === 0 ? (
                  <p className="py-2 text-center text-sm text-muted-foreground">Nenhuma multa registrada.</p>
                ) : penalties.map((p) => (
                  <div key={p.id} className="rounded-lg border p-3">
                    {editingPenalty === p.id ? (
                      <div className="space-y-2">
                        <Input type="number" value={editPenaltyValue} onChange={(e) => setEditPenaltyValue(e.target.value)} className="h-8 w-24" placeholder="Valor" />
                        <Input value={editPenaltyObs} onChange={(e) => setEditPenaltyObs(e.target.value)} className="h-8" placeholder="Observação" />
                        <div className="flex gap-2">
                          <Button size="sm" onClick={() => handleEditPenalty(p.id)}>Salvar</Button>
                          <Button size="sm" variant="ghost" onClick={() => { setEditingPenalty(null); setEditPenaltyValue(""); setEditPenaltyObs(""); }}>Cancelar</Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="text-sm font-medium">{formatCurrency(Number(p.amount))}</p>
                          <p className="text-xs text-muted-foreground">Parcela {getInstallmentNumber(p.installment_id)} • {format(new Date(p.created_at), "dd/MM/yyyy HH:mm")}</p>
                          {p.observation && <p className="mt-1 text-xs italic text-muted-foreground">"{p.observation}"</p>}
                        </div>
                        <div className="flex gap-1">
                          <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => { setEditingPenalty(p.id); setEditPenaltyValue(String(p.amount)); setEditPenaltyObs(p.observation || ""); }}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-destructive hover:text-destructive" onClick={() => handleDeletePenalty(p.id)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Overdue Dates Dialog */}
      <Dialog open={overdueDatesOpen} onOpenChange={(o) => { setOverdueDatesOpen(o); if (!o) { setOverduePenaltyDate(null); setOverduePenaltyAmount(""); setOverduePenaltyObs(""); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Dias em Atraso ({overdueDaysCount})</DialogTitle></DialogHeader>
          <div className="max-h-[60vh] space-y-1 overflow-y-auto">
            {overdueDatesList.map((date, idx) => {
              const dateStr = format(date, "yyyy-MM-dd");
              const isAdding = overduePenaltyDate === dateStr;
              return (
                <div key={idx} className="rounded-lg border p-2">
                  {isAdding ? (
                    <div className="space-y-2">
                      <p className="text-sm font-medium">{format(date, "dd/MM/yyyy")} — Adicionar Multa</p>
                      <Input type="number" placeholder="Valor" value={overduePenaltyAmount} onChange={(e) => setOverduePenaltyAmount(e.target.value)} className="h-8" />
                      <Input placeholder="Observação..." value={overduePenaltyObs} onChange={(e) => setOverduePenaltyObs(e.target.value)} className="h-8" />
                      <div className="flex gap-2">
                        <Button size="sm" onClick={handleAddPenaltyFromDate}>Adicionar</Button>
                        <Button size="sm" variant="ghost" onClick={() => { setOverduePenaltyDate(null); setOverduePenaltyAmount(""); setOverduePenaltyObs(""); }}>Cancelar</Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <p className="text-sm">{format(date, "dd/MM/yyyy")} <span className="text-xs text-muted-foreground">({idx + 1}º dia)</span></p>
                      <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => setOverduePenaltyDate(dateStr)}>
                        <AlertTriangle className="mr-1 h-3 w-3" /> Multa
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Loan Dialog */}
      <Dialog open={editLoanOpen} onOpenChange={setEditLoanOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Renegociar Empréstimo</DialogTitle></DialogHeader>
          <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
            <div><Label>Valor Emprestado (R$)</Label><Input type="number" value={editAmount} onChange={(e) => setEditAmount(e.target.value)} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Tipo de Juros</Label>
                <Select value={editInterestType} onValueChange={setEditInterestType}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>
                  <SelectItem value="percentage">Porcentagem (%)</SelectItem><SelectItem value="fixed">Valor Fixo (R$)</SelectItem>
                </SelectContent></Select>
              </div>
              <div><Label>{editInterestType === "percentage" ? "Juros (%)" : "Juros (R$)"}</Label><Input type="number" value={editInterestValue} onChange={(e) => setEditInterestValue(e.target.value)} /></div>
            </div>
            <div><Label>Tipo de Pagamento</Label>
              <Select value={editPaymentType} onValueChange={setEditPaymentType}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>
                <SelectItem value="daily">Diário</SelectItem><SelectItem value="weekly">Semanal</SelectItem>
                <SelectItem value="biweekly">Quinzenal</SelectItem><SelectItem value="monthly">Mensal</SelectItem>
                <SelectItem value="fixed_dates">Data Fixa</SelectItem>
              </SelectContent></Select>
            </div>
            <div><Label>Quantidade de Parcelas</Label><Input type="number" value={editInstallmentCount} onChange={(e) => setEditInstallmentCount(e.target.value)} /></div>
            <div><Label>Data do Empréstimo</Label><Input type="date" value={editLoanDate} onChange={(e) => setEditLoanDate(e.target.value)} /></div>
            {editPaymentType !== "fixed_dates" && (
              <div><Label>Data do Primeiro Vencimento</Label><Input type="date" value={editFirstDueDate} onChange={(e) => setEditFirstDueDate(e.target.value)} /></div>
            )}
            <div><Label>Status</Label>
              <Select value={editStatus} onValueChange={setEditStatus}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>
                <SelectItem value="open">Em Aberto</SelectItem><SelectItem value="paid">Pago</SelectItem><SelectItem value="overdue">Atrasado</SelectItem>
              </SelectContent></Select>
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <Label className="text-sm">Marcar como Cravo 🔥</Label>
              <Switch checked={editIsCravo} onCheckedChange={setEditIsCravo} />
            </div>
            {editCalc && (
              <Card className="border-primary/30 bg-accent">
                <CardHeader className="pb-2"><CardTitle className="flex items-center text-base"><Calculator className="mr-2 h-4 w-4" /> Prévia</CardTitle></CardHeader>
                <CardContent className="space-y-1 text-sm">
                  <div className="flex justify-between"><span>Emprestado:</span><span className="font-semibold">{formatCurrency(editNumAmount)}</span></div>
                  <div className="flex justify-between"><span>Juros:</span><span className="font-semibold">{formatCurrency(editCalc.interest)}</span></div>
                  <div className="flex justify-between border-t pt-1"><span className="font-bold">Valor final:</span><span className="font-bold text-primary">{formatCurrency(editCalc.totalAmount)}</span></div>
                  <div className="flex justify-between"><span>Parcela:</span><span className="font-semibold">{formatCurrency(editCalc.installmentAmount)}</span></div>
                  {editDueDates.length > 0 && (
                    <div className="mt-2 border-t pt-2">
                      <p className="mb-1 font-medium">Novos vencimentos:</p>
                      {editDueDates.map((d, i) => (
                        <p key={i} className="text-muted-foreground">Parcela {i + 1}: {format(d, "dd/MM/yyyy")}</p>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
            <div className="border-t pt-3">
              <Label className="text-sm font-semibold">Registros de Multas ({penalties.length})</Label>
              {penaltyInst && (
                <div className="mt-1 mb-2 rounded-lg bg-muted/50 p-2 text-xs space-y-1">
                  <div className="flex justify-between"><span>Total:</span><span className="font-semibold text-destructive">{formatCurrency(penaltyTotal)}</span></div>
                  <div className="flex justify-between"><span>Pago:</span><span className="text-success">{formatCurrency(penaltyPaid)}</span></div>
                  <div className="flex justify-between"><span>Pendente:</span><span className="text-destructive">{formatCurrency(penaltyTotal - penaltyPaid)}</span></div>
                </div>
              )}
            </div>
            <Button onClick={handleEditLoan} className="w-full" size="lg">⚠️ Renegociar Empréstimo</Button>
            <p className="text-xs text-center text-muted-foreground">As parcelas existentes serão substituídas pelas novas.</p>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Installment Dialog */}
      <Dialog open={!!editInstId} onOpenChange={(o) => { if (!o) setEditInstId(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Editar Parcela</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Valor da parcela</Label><Input type="number" value={editInstAmount} onChange={(e) => setEditInstAmount(e.target.value)} /></div>
            <div><Label>Data de vencimento</Label><Input type="date" value={editInstDueDate} onChange={(e) => setEditInstDueDate(e.target.value)} /></div>
            <Button onClick={handleEditInstallment} className="w-full">Salvar</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Quitar Dialog */}
      <Dialog open={quitarOpen} onOpenChange={(o) => { if (!o) { setQuitarOpen(false); setQuitarDate(format(new Date(), "yyyy-MM-dd")); } }}>
        <DialogContent onOpenAutoFocus={(e) => e.preventDefault()}>
          <DialogHeader><DialogTitle>Quitar Empréstimo</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm font-medium">{loan.clients.name}</p>
            <div className="rounded-lg border p-3 space-y-1 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Parcelas restantes:</span><span className="font-semibold">{loan.installment_count - Math.floor(loanProgress.fractionalProgress)}/{loan.installment_count}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Valor restante:</span><span className="font-bold">{formatCurrency(Math.max(0, remainingLoan))}</span></div>
              {penaltyTotal - penaltyPaid > 0.01 && (
                <div className="flex justify-between"><span className="text-muted-foreground">Multa pendente:</span><span className="font-bold text-warning">{formatCurrency(penaltyTotal - penaltyPaid)}</span></div>
              )}
              <div className="border-t pt-1 mt-1 flex justify-between"><span className="font-semibold">Total a quitar:</span><span className="font-bold text-primary">{formatCurrency(Math.max(0, remainingLoan) + Math.max(0, penaltyTotal - penaltyPaid))}</span></div>
            </div>
            <div><Label>Data do pagamento</Label><Input type="date" value={quitarDate} onChange={(e) => setQuitarDate(e.target.value)} /></div>
            <Button onClick={handleQuitarEmprestimo} className="w-full bg-success hover:bg-success/90" disabled={isSubmitting}>
              {isSubmitting ? "Processando..." : "Confirmar Quitação"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
