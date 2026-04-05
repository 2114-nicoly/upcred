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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
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
} from "@/lib/loan-utils";
import { updateCashBalance, createCashMovement, recalculateCashBalanceFromLedger } from "@/lib/cash-utils";
import { ArrowLeft, CheckCircle, XCircle, AlertTriangle, DollarSign, Undo2, Pencil, Trash2, ChevronDown, Plus, Calendar, Calculator } from "lucide-react";
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

export default function LoanDetailPage() {
  const { loanId } = useParams();
  const navigate = useNavigate();
  const [loan, setLoan] = useState<Loan | null>(null);
  const [installments, setInstallments] = useState<Installment[]>([]);
  const [penalties, setPenalties] = useState<Penalty[]>([]);
  const [penaltyAmount, setPenaltyAmount] = useState("");
  const [penaltyObservation, setPenaltyObservation] = useState("");
  const [penaltyDialogId, setPenaltyDialogId] = useState<string | null>(null);
  const [payDialogId, setPayDialogId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payPenaltyAmount, setPayPenaltyAmount] = useState("");
  const [payDate, setPayDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [penaltyDetailOpen, setPenaltyDetailOpen] = useState(false);
  const [editingPenalty, setEditingPenalty] = useState<string | null>(null);
  const [editPenaltyValue, setEditPenaltyValue] = useState("");
  const [editPenaltyObs, setEditPenaltyObs] = useState("");
  const [_showAllInstallments, _setShowAllInstallments] = useState(true); // unused, kept for compat
  const [paidOpen, setPaidOpen] = useState(false);
  const [overdueOpen, setOverdueOpen] = useState(false);
  // Edit loan (full renegotiation)
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
  // Overdue dates dialog
  const [overdueDatesOpen, setOverdueDatesOpen] = useState(false);
  // Penalty from overdue date
  const [overduePenaltyDate, setOverduePenaltyDate] = useState<string | null>(null);
  const [overduePenaltyAmount, setOverduePenaltyAmount] = useState("");
  const [overduePenaltyObs, setOverduePenaltyObs] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Quitar state
  const [quitarOpen, setQuitarOpen] = useState(false);
  const [quitarDate, setQuitarDate] = useState(format(new Date(), "yyyy-MM-dd"));

  const fetchData = async () => {
    const { data: l } = await supabase.from("loans").select("*, clients(name)").eq("id", loanId!).single();
    setLoan(l as unknown as Loan);
    const { data: inst } = await supabase.from("installments").select("*").eq("loan_id", loanId!).order("number");
    setInstallments(inst || []);
    const { data: pen } = await supabase.from("penalties").select("*").eq("loan_id", loanId!).order("created_at");
    setPenalties((pen as Penalty[]) || []);
  };

  useEffect(() => { fetchData(); }, [loanId]);

  const updateLoanStatus = async () => {
    const { data: inst } = await supabase.from("installments").select("status, due_date").eq("loan_id", loanId!);
    if (!inst) return;
    const todayStr = format(new Date(), "yyyy-MM-dd");
    const allPaid = inst.every((i: any) => i.status === "paid");
    const hasOverdue = inst.some((i: any) => i.status === "overdue" && i.due_date < todayStr);
    let newStatus = "open";
    if (allPaid) newStatus = "paid";
    else if (hasOverdue) newStatus = "overdue";
    await supabase.from("loans").update({ status: newStatus }).eq("id", loanId!);
  };

  // --- Payment ---
  const handlePay = async (id: string) => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    const parcValue = payAmount ? parseFloat(payAmount) : null;
    const multaValue = payPenaltyAmount ? parseFloat(payPenaltyAmount) : 0;
    if (payAmount && (isNaN(parcValue!) || parcValue! <= 0)) { toast.error("Valor inválido"); setIsSubmitting(false); return; }
    if (payPenaltyAmount && (isNaN(multaValue) || multaValue < 0)) { toast.error("Valor de multa inválido"); setIsSubmitting(false); return; }

    if (multaValue > 0) {
      const penaltyInst = installments.find((i) => i.is_penalty);
      if (penaltyInst) {
        const newPaid = Number(penaltyInst.paid_amount) + multaValue;
        const fullyPaid = newPaid >= Number(penaltyInst.amount) - 0.01;
        await supabase.from("installments").update({
          paid_amount: Math.min(newPaid, Number(penaltyInst.amount)),
          status: fullyPaid ? "paid" : penaltyInst.status,
          paid_at: fullyPaid ? new Date(payDate + "T12:00:00").toISOString() : penaltyInst.paid_at,
        }).eq("id", penaltyInst.id);
        // Cash: penalty payment
        await updateCashBalance({ available_cash: multaValue, penalty_receivable: -multaValue });
        await createCashMovement({
          type: "recebimento_multa",
          amount: multaValue,
          client_id: loan?.client_id,
          loan_id: loanId!,
          observation: `Pagamento de multa`,
        });
        toast.success(`Multa: ${formatCurrency(multaValue)} registrado!`);
      } else {
        toast.error("Nenhuma multa registrada para abater");
      }
    }

    if (parcValue !== null || !payPenaltyAmount) {
      const unpaid = installments.filter((i) => i.status !== "paid" && !i.is_penalty).sort((a, b) => a.number - b.number);
      const currentInst = unpaid.find((i) => i.id === id);
      if (!currentInst) {
        if (multaValue > 0) {
          setPayAmount(""); setPayPenaltyAmount(""); setPayDate(format(new Date(), "yyyy-MM-dd")); setPayDialogId(null);
          await updateLoanStatus(); fetchData(); return;
        }
        return;
      }
      let remaining = parcValue ?? (Number(currentInst.amount) - Number(currentInst.paid_amount));
      const toProcess = unpaid.filter((i) => i.number >= currentInst.number);
      let isFirst = true;
      for (const inst of toProcess) {
        if (remaining <= 0) break;
        const instRemaining = Number(inst.amount) - Number(inst.paid_amount);
        const applying = Math.min(remaining, instRemaining);
        const newPaidAmount = Number(inst.paid_amount) + applying;
        const fullyPaid = newPaidAmount >= Number(inst.amount) - 0.01;
        const shouldSetPaidAt = fullyPaid || isFirst;
        await supabase.from("installments").update({
          paid_amount: newPaidAmount,
          status: fullyPaid ? "paid" : (isFirst ? "partial" : inst.status),
          paid_at: shouldSetPaidAt ? new Date(payDate + "T12:00:00").toISOString() : inst.paid_at,
        }).eq("id", inst.id);
        remaining -= applying;
        isFirst = false;
      }
      const totalApplied = (parcValue ?? (Number(currentInst.amount) - Number(currentInst.paid_amount))) - remaining;
      // Cash: normal payment - interest first, then principal
      if (totalApplied > 0) {
        const loanInterest = loan ? (Number(loan.total_amount) - Number(loan.amount)) : 0;
        // Fetch fresh paid amounts from DB (not stale render-time state)
        const { data: freshInsts } = await supabase
          .from("installments").select("paid_amount")
          .eq("loan_id", loanId!).eq("is_penalty", false);
        const totalPaidNow = (freshInsts || []).reduce((s: number, i: any) => s + Number(i.paid_amount), 0);
        const totalPaidBefore = totalPaidNow - totalApplied;
        const interestRemaining = Math.max(0, loanInterest - totalPaidBefore);
        const toInterest = Math.min(totalApplied, interestRemaining);
        const toPrincipal = totalApplied - toInterest;
        await updateCashBalance({
          available_cash: totalApplied,
          interest_receivable: -toInterest,
          money_lent: -toPrincipal,
        });
        await createCashMovement({
          type: "recebimento_normal",
          amount: totalApplied,
          client_id: loan?.client_id,
          loan_id: loanId!,
          installment_id: currentInst.id,
          observation: `Parcela ${currentInst.number}`,
        });
      }
      toast.success(`Parcela: ${formatCurrency(totalApplied)} registrado!`);
      if (remaining > 0) toast.info(`Sobra de ${formatCurrency(remaining)}`);
    }

    await updateLoanStatus();
    setPayAmount(""); setPayPenaltyAmount(""); setPayDate(format(new Date(), "yyyy-MM-dd")); setPayDialogId(null);
    setIsSubmitting(false);
    fetchData();
  };

  const handleNotPaid = async (id: string) => {
    await supabase.from("installments").update({ status: "overdue" }).eq("id", id);
    await updateLoanStatus();
    toast.info("Parcela marcada como atrasada");
    fetchData();
  };

  const handleUndoOverdue = async (id: string) => {
    await supabase.from("installments").update({ status: "pending" }).eq("id", id);
    await updateLoanStatus();
    toast.success("Status restaurado para pendente!");
    fetchData();
  };

  const handleUndoPayment = async (id: string) => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    // 1. Delete ALL cash_movements linked to this installment
    await supabase.from("cash_movements").delete().eq("installment_id", id);

    // 2. Revert installment
    await supabase.from("installments").update({ status: "pending", paid_at: null, paid_amount: 0 }).eq("id", id);

    // 3. Recalculate cash balance from ledger
    await recalculateCashBalanceFromLedger();

    await updateLoanStatus();
    toast.success("Pagamento desfeito!");
    setIsSubmitting(false);
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
      loan_id: loanId!,
      installment_id: installmentId,
      amount: penAmount,
      observation: penObs || null,
    });

    const newPenalty = Number(inst.penalty_amount) + penAmount;
    await supabase.from("installments").update({ penalty_amount: newPenalty }).eq("id", installmentId);

    const penaltyInst = installments.find((i) => i.is_penalty);
    if (penaltyInst) {
      await supabase.from("installments").update({ amount: Number(penaltyInst.amount) + penAmount }).eq("id", penaltyInst.id);
    } else {
      const maxNumber = Math.max(...installments.map((i) => i.number));
      await supabase.from("installments").insert({
        loan_id: loanId!,
        number: maxNumber + 1,
        amount: penAmount,
        due_date: format(new Date(), "yyyy-MM-dd"),
        is_penalty: true,
        status: "pending",
      });
    }

    // Update penalty receivable in cash
    await updateCashBalance({ penalty_receivable: penAmount });

    toast.success("Multa adicionada!");
    setPenaltyAmount(""); setPenaltyObservation(""); setPenaltyDialogId(null);
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
    const penaltyInst = installments.find((i) => i.is_penalty);
    if (penaltyInst) {
      const newPenaltyTotal = Math.max(0, Number(penaltyInst.amount) + diff);
      if (newPenaltyTotal <= 0.01) {
        await supabase.from("installments").delete().eq("id", penaltyInst.id);
      } else {
        await supabase.from("installments").update({ amount: newPenaltyTotal }).eq("id", penaltyInst.id);
      }
    }
    // Update penalty_receivable for the diff
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
    const penaltyInst = installments.find((i) => i.is_penalty);
    if (penaltyInst) {
      const newAmount = Number(penaltyInst.amount) - Number(penalty.amount);
      if (newAmount <= 0.01) await supabase.from("installments").delete().eq("id", penaltyInst.id);
      else await supabase.from("installments").update({ amount: newAmount }).eq("id", penaltyInst.id);
    }
    // Reverse penalty_receivable
    await updateCashBalance({ penalty_receivable: -Number(penalty.amount) });
    toast.success("Multa removida!");
    fetchData();
  };

  // --- Add penalty from overdue date ---
  const handleAddPenaltyFromDate = async () => {
    const amount = parseFloat(overduePenaltyAmount);
    if (!amount || amount <= 0) { toast.error("Valor inválido"); return; }
    // Find the first overdue installment to attach penalty to
    const overdueInsts = installments.filter((i) => !i.is_penalty && getInstallmentDisplayStatus(i) === "overdue").sort((a, b) => a.number - b.number);
    const targetInst = overdueInsts[0];
    if (!targetInst) { toast.error("Nenhuma parcela atrasada encontrada"); return; }

    const obs = overduePenaltyObs ? `${overduePenaltyObs} (Ref: ${overduePenaltyDate})` : `Multa ref. atraso ${overduePenaltyDate}`;
    await handleAddPenalty(targetInst.id, amount, obs);
    setOverduePenaltyDate(null); setOverduePenaltyAmount(""); setOverduePenaltyObs("");
  };

  // --- Renegotiation calc preview ---
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

  // --- Edit loan (full renegotiation) ---
  const handleEditLoan = async () => {
    if (!editCalc) { toast.error("Preencha todos os campos corretamente"); return; }
    if (!editFirstDueDate && editPaymentType !== "fixed_dates") { toast.error("Informe a data do primeiro vencimento"); return; }

    // Update loan record
    await supabase.from("loans").update({
      amount: editNumAmount,
      interest_type: editInterestType,
      interest_value: editNumInterest,
      total_amount: editCalc.totalAmount,
      installment_count: editNumInstallments,
      payment_type: editPaymentType,
      loan_date: editLoanDate,
      first_due_date: editFirstDueDate || null,
      status: editStatus,
      is_cravo: editIsCravo,
    }).eq("id", loanId!);

    // Delete old non-penalty installments and regenerate
    const nonPenaltyIds = installments.filter(i => !i.is_penalty).map(i => i.id);
    if (nonPenaltyIds.length > 0) {
      // Delete penalties linked to these installments
      for (const instId of nonPenaltyIds) {
        await supabase.from("penalties").delete().eq("installment_id", instId);
      }
      await supabase.from("installments").delete().in("id", nonPenaltyIds);
    }

    // Generate new installments
    const dates = editDueDates;
    if (dates.length > 0) {
      const newInstallments = dates.map((date, i) => ({
        loan_id: loanId!,
        number: i + 1,
        amount: editCalc.installmentAmount,
        due_date: format(date, "yyyy-MM-dd"),
        status: "pending" as const,
      }));
      await supabase.from("installments").insert(newInstallments);
    }

    // Recalculate cash balance after renegotiation
    await recalculateCashBalanceFromLedger();
    toast.success("Empréstimo renegociado com sucesso!");
    setEditLoanOpen(false);
    fetchData();
  };

  const openEditLoan = () => {
    if (!loan) return;
    setEditAmount(String(loan.amount));
    setEditInterestValue(String(loan.interest_value));
    setEditInterestType(loan.interest_type);
    setEditPaymentType(loan.payment_type);
    setEditLoanDate(loan.loan_date);
    setEditFirstDueDate(loan.first_due_date || "");
    setEditInstallmentCount(String(loan.installment_count));
    setEditStatus(loan.status);
    setEditIsCravo(loan.is_cravo);
    setEditLoanOpen(true);
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
    // Delete associated penalties and sync
    const relatedPenalties = penalties.filter(p => p.installment_id === id);
    const totalPenaltyRemoved = relatedPenalties.reduce((s, p) => s + Number(p.amount), 0);
    await supabase.from("penalties").delete().eq("installment_id", id);
    // Update penalty installment
    if (totalPenaltyRemoved > 0) {
      const penaltyInst = installments.find((i) => i.is_penalty);
      if (penaltyInst) {
        const newAmount = Number(penaltyInst.amount) - totalPenaltyRemoved;
        if (newAmount <= 0.01) await supabase.from("installments").delete().eq("id", penaltyInst.id);
        else await supabase.from("installments").update({ amount: newAmount }).eq("id", penaltyInst.id);
      }
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
    // Recalculate cash balance since movements were deleted
    await recalculateCashBalanceFromLedger();
    toast.success("Empréstimo excluído!");
    navigate(-1);
  };

  if (!loan) return <p className="p-4 text-center">Carregando...</p>;

  const regularInstallments = installments.filter((i) => !i.is_penalty);
  const penaltyInst = installments.find((i) => i.is_penalty);

  const overdueRegular = regularInstallments.filter((i) => getInstallmentDisplayStatus(i) === "overdue");
  const paidRegular = regularInstallments.filter((i) => i.status === "paid");
  const activeRegular = regularInstallments.filter((i) => {
    const ds = getInstallmentDisplayStatus(i);
    return ds !== "paid" && ds !== "overdue";
  });

  const totalPaidAmount = regularInstallments.reduce((s, i) => s + Number(i.paid_amount), 0);
  const installmentValue = regularInstallments.length > 0 ? Number(regularInstallments[0].amount) : 1;
  const paidInstallmentsProgress = totalPaidAmount / installmentValue;
  const totalInstallments = regularInstallments.length;
  const progressPercent = totalInstallments > 0 ? (paidInstallmentsProgress / totalInstallments) * 100 : 0;

  const totalLoanAmount = Number(loan.total_amount);
  const totalPaidAll = regularInstallments.reduce((s, i) => s + Number(i.paid_amount), 0);
  const penaltyTotal = penaltyInst ? Number(penaltyInst.amount) : 0;
  const penaltyPaid = penaltyInst ? Number(penaltyInst.paid_amount) : 0;
  const remainingLoan = totalLoanAmount - totalPaidAll;

  // Overdue days calculation: from the oldest overdue installment's due_date
  const oldestOverdue = overdueRegular.length > 0
    ? overdueRegular.reduce((oldest, i) => i.due_date < oldest.due_date ? i : oldest, overdueRegular[0])
    : null;
  const overdueDatesList = oldestOverdue
    ? getOverdueDatesList(oldestOverdue.due_date, loan.payment_type)
    : [];
  const overdueDaysCount = overdueDatesList.length;

  // Removed local paymentTypeLabel — using getPaymentTypeLabel from loan-utils

  const getInstallmentNumber = (installmentId: string) => {
    const inst = installments.find((i) => i.id === installmentId);
    return inst ? inst.number : "?";
  };

  // --- Render penalty list (reused in penalty detail and edit loan dialogs) ---
  const renderPenaltyList = () => (
    <div className="space-y-2">
      {penalties.length === 0 ? (
        <p className="py-2 text-center text-sm text-muted-foreground">Nenhuma multa registrada.</p>
      ) : (
        penalties.map((p) => (
          <div key={p.id} className="rounded-lg border p-3">
            {editingPenalty === p.id ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Input type="number" value={editPenaltyValue} onChange={(e) => setEditPenaltyValue(e.target.value)} className="h-8 w-24" placeholder="Valor" />
                </div>
                <Input value={editPenaltyObs} onChange={(e) => setEditPenaltyObs(e.target.value)} className="h-8" placeholder="Observação (opcional)" />
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => handleEditPenalty(p.id)}>Salvar</Button>
                  <Button size="sm" variant="ghost" onClick={() => { setEditingPenalty(null); setEditPenaltyValue(""); setEditPenaltyObs(""); }}>Cancelar</Button>
                </div>
              </div>
            ) : (
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-medium">{formatCurrency(Number(p.amount))}</p>
                  <p className="text-xs text-muted-foreground">
                    Parcela {getInstallmentNumber(p.installment_id)} • {format(new Date(p.created_at), "dd/MM/yyyy HH:mm")}
                  </p>
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
        ))
      )}
    </div>
  );

  const renderInstallmentCard = (inst: Installment, showActions = true) => {
    const displayStatus = getInstallmentDisplayStatus(inst);
    const instRemaining = Number(inst.amount) - Number(inst.paid_amount);
    return (
      <Card key={inst.id}>
        <CardContent className="p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex-1">
              <p className="font-semibold">Parcela {inst.number}</p>
              <p className="text-sm text-muted-foreground">
                {format(new Date(inst.due_date + "T12:00:00"), "dd/MM/yyyy")} • {formatCurrency(Number(inst.amount))}
              </p>
              {Number(inst.paid_amount) > 0 && (
                <p className="text-xs text-partial">Pago: {formatCurrency(Number(inst.paid_amount))} / Resta: {formatCurrency(instRemaining)}</p>
              )}
              {Number(inst.penalty_amount) > 0 && (
                <p className="text-xs text-destructive">Multa: {formatCurrency(Number(inst.penalty_amount))}</p>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Badge className={getStatusColor(displayStatus)}>{getStatusLabel(displayStatus)}</Badge>
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
          {showActions && inst.status !== "paid" && (
            <div className="flex gap-2">
              <Dialog open={payDialogId === inst.id} onOpenChange={(o) => { setPayDialogId(o ? inst.id : null); if (!o) { setPayAmount(""); setPayPenaltyAmount(""); } }}>
                <DialogTrigger asChild>
                  <Button size="sm" className="flex-1 bg-success hover:bg-success/90">
                    <Plus className="mr-1 h-3 w-3" /> Pagamento
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader><DialogTitle>Registrar Pagamento</DialogTitle></DialogHeader>
                  <div className="space-y-3">
                    <p className="text-sm text-muted-foreground">Parcela {inst.number} — {formatCurrency(Number(inst.amount))}</p>
                    {Number(inst.paid_amount) > 0 && <p className="text-sm text-partial">Já pago: {formatCurrency(Number(inst.paid_amount))} — Resta: {formatCurrency(instRemaining)}</p>}
                    <div>
                      <Label>Valor da parcela recebido</Label>
                      <Input type="number" placeholder={`Padrão: ${instRemaining.toFixed(2)}`} value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
                    </div>
                    {penaltyInst && Number(penaltyInst.amount) - Number(penaltyInst.paid_amount) > 0.01 && (
                      <div className="rounded-lg border border-warning/50 p-3 space-y-2">
                        <p className="text-xs font-medium text-warning">Multa pendente: {formatCurrency(Number(penaltyInst.amount) - Number(penaltyInst.paid_amount))}</p>
                        <Label>Valor destinado à multa (opcional)</Label>
                        <Input type="number" placeholder="0.00" value={payPenaltyAmount} onChange={(e) => setPayPenaltyAmount(e.target.value)} />
                      </div>
                    )}
                    <div>
                      <Label>Data do pagamento</Label>
                      <Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
                    </div>
                    <p className="text-xs text-muted-foreground">💡 Valor excedente abate parcelas seguintes.</p>
                    <Button onClick={() => handlePay(inst.id)} className="w-full bg-success hover:bg-success/90" disabled={isSubmitting}>{isSubmitting ? "Processando..." : "Confirmar Pagamento"}</Button>
                  </div>
                </DialogContent>
              </Dialog>
              <Button size="sm" variant="destructive" className="flex-1" onClick={() => handleNotPaid(inst.id)}>
                <XCircle className="mr-1 h-3 w-3" /> Não Pagou
              </Button>
              <Dialog open={penaltyDialogId === inst.id} onOpenChange={(o) => { setPenaltyDialogId(o ? inst.id : null); if (!o) { setPenaltyAmount(""); setPenaltyObservation(""); } }}>
                <DialogTrigger asChild>
                  <Button size="sm" variant="outline" className="px-2"><AlertTriangle className="h-3 w-3" /></Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader><DialogTitle>Adicionar Multa</DialogTitle></DialogHeader>
                  <div className="space-y-3">
                    <p className="text-sm text-muted-foreground">Parcela {inst.number}</p>
                    <div>
                      <Label>Valor da multa</Label>
                      <Input type="number" placeholder="Valor" value={penaltyAmount} onChange={(e) => setPenaltyAmount(e.target.value)} />
                    </div>
                    <div>
                      <Label>Observação (opcional)</Label>
                      <Textarea placeholder="Motivo da multa..." value={penaltyObservation} onChange={(e) => setPenaltyObservation(e.target.value)} />
                    </div>
                    <Button onClick={() => handleAddPenalty(inst.id)} className="w-full">Adicionar Multa</Button>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
          )}
          {showActions && inst.status === "overdue" && (
            <Button size="sm" variant="outline" className="w-full mt-1" onClick={() => handleUndoOverdue(inst.id)}>
              <Undo2 className="mr-1 h-3 w-3" /> Desfazer "Não Pagou"
            </Button>
          )}
          {inst.status === "paid" && (
            <Button size="sm" variant="outline" className="w-full mt-1" onClick={() => handleUndoPayment(inst.id)}>
              <Undo2 className="mr-1 h-3 w-3" /> Desfazer Pagamento
            </Button>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="mx-auto max-w-lg p-4">
      <div className="mb-2 flex items-center justify-end">
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={openEditLoan}>
            <Pencil className="mr-1 h-4 w-4" /> Editar
          </Button>
          <Button variant="ghost" size="sm" className="text-destructive" onClick={handleDeleteLoan}>
            <Trash2 className="mr-1 h-4 w-4" /> Excluir
          </Button>
        </div>
      </div>

      {/* Loan Info */}
      <Card className="mb-4">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">
              <button
                className="hover:underline text-primary cursor-pointer"
                onClick={() => navigate(`/clients/${loan.client_id}`)}
              >
                {loan.clients.name}
              </button>
            </CardTitle>
            <Badge className={getLoanStatusColor(loan.status)}>{getStatusLabel(loan.status)}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Emprestado:</span><span>{formatCurrency(Number(loan.amount))}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Juros:</span><span>{formatCurrency(Number(loan.total_amount) - Number(loan.amount))}</span></div>
          <div className="flex justify-between font-bold"><span>Valor Total do Empréstimo:</span><span className="text-primary">{formatCurrency(totalLoanAmount)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Pago (parcelas):</span><span className="text-success">{formatCurrency(totalPaidAll)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Resta (parcelas):</span><span>{formatCurrency(Math.max(0, remainingLoan))}</span></div>
          {penaltyTotal > 0 && (
            <div className="border-t pt-2 space-y-1">
              <div className="flex justify-between"><span className="text-destructive font-medium">Total de Multas:</span><span className="text-destructive font-semibold">{formatCurrency(penaltyTotal - penaltyPaid)}</span></div>
              {penaltyPaid > 0 && (
                <div className="flex justify-between"><span className="text-muted-foreground">Multa paga:</span><span className="text-success">{formatCurrency(penaltyPaid)}</span></div>
              )}
            </div>
          )}
          {/* Overdue days */}
          {overdueDaysCount > 0 && (
            <div className="border-t pt-2">
              <button
                className="flex w-full items-center justify-between rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-left hover:bg-destructive/10 transition-colors"
                onClick={() => setOverdueDatesOpen(true)}
              >
                <div>
                  <p className="text-sm font-semibold text-destructive">
                    {overdueDaysCount} dia{overdueDaysCount !== 1 ? "s" : ""} em atraso
                  </p>
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
            <span className="text-muted-foreground">
              {paidInstallmentsProgress % 1 === 0 ? paidInstallmentsProgress : paidInstallmentsProgress.toFixed(1)}/{totalInstallments} parcelas
            </span>
          </div>
          <Progress value={Math.min(progressPercent, 100)} className="mb-3" />
        </CardContent>
      </Card>

      {/* Penalty Button */}
      <Button
        variant="outline"
        className="w-full mb-4 border-warning/50 text-warning hover:bg-warning/10"
        onClick={() => setPenaltyDetailOpen(true)}
      >
        <AlertTriangle className="mr-2 h-4 w-4" />
        🔶 Multas {penaltyInst ? `(${formatCurrency(penaltyTotal - penaltyPaid)} pendente)` : ""}
      </Button>

      {/* Section header */}
      <h2 className="mb-3 text-lg font-semibold">Parcelas</h2>

      {/* Paid installments button */}
      {paidRegular.length > 0 && (
        <Collapsible open={paidOpen} onOpenChange={setPaidOpen} className="mb-3">
          <CollapsibleTrigger asChild>
            <Button variant="outline" className="w-full">
              ✅ Parcelas Pagas ({paidRegular.length})
              <ChevronDown className={`ml-auto h-4 w-4 transition-transform ${paidOpen ? "rotate-180" : ""}`} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 space-y-2">
            {paidRegular.map((inst) => renderInstallmentCard(inst, false))}
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Overdue installments (marked "Não Pagou") */}
      {overdueRegular.length > 0 && (
        <Button
          variant="outline"
          className="w-full mb-3 border-destructive/50 text-destructive"
          onClick={() => navigate(`/loans/${loanId}/overdue`)}
        >
          ⚠️ Parcelas Pendentes ({overdueRegular.length})
        </Button>
      )}

      {/* Active installments (pending / partial only) */}
      <div className="space-y-2">
        {activeRegular.map((inst) => renderInstallmentCard(inst))}

        {/* Penalty installment */}
        {penaltyInst && (
          <Card className="border-warning/50">
            <CardContent className="p-3">
              <div className="mb-2 flex items-center justify-between">
                <div>
                  <button className="flex items-center gap-1 text-left font-semibold hover:underline" onClick={() => setPenaltyDetailOpen(true)}>
                    🔶 Multa <span className="text-xs text-muted-foreground">({penalties.length} registro{penalties.length !== 1 ? "s" : ""}) — Ver/Editar</span>
                  </button>
                  <p className="text-sm text-muted-foreground">
                    Total: {formatCurrency(Number(penaltyInst.amount))}
                  </p>
                  {Number(penaltyInst.paid_amount) > 0 && (
                    <p className="text-xs text-success">Pago: {formatCurrency(Number(penaltyInst.paid_amount))} • Resta: {formatCurrency(Number(penaltyInst.amount) - Number(penaltyInst.paid_amount))}</p>
                  )}
                </div>
                <Badge className={getStatusColor(penaltyInst.status)}>{getStatusLabel(penaltyInst.status)}</Badge>
              </div>
              {penaltyInst.status === "paid" ? (
                <Button size="sm" variant="outline" className="w-full" onClick={() => handleUndoPayment(penaltyInst.id)}>
                  <Undo2 className="mr-1 h-3 w-3" /> Desfazer
                </Button>
              ) : (
                <div className="flex gap-2">
                  <Dialog open={payDialogId === penaltyInst.id} onOpenChange={(o) => { setPayDialogId(o ? penaltyInst.id : null); if (!o) setPayAmount(""); }}>
                    <DialogTrigger asChild>
                      <Button size="sm" className="flex-1 bg-success hover:bg-success/90"><Plus className="mr-1 h-3 w-3" /> Pagamento</Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader><DialogTitle>Pagar Multa</DialogTitle></DialogHeader>
                      <div className="space-y-3">
                        <p className="text-sm text-muted-foreground">Multa — {formatCurrency(Number(penaltyInst.amount))}</p>
                        {Number(penaltyInst.paid_amount) > 0 && <p className="text-sm text-success">Já pago: {formatCurrency(Number(penaltyInst.paid_amount))}</p>}
                        <div>
                          <Label>Valor</Label>
                          <Input type="number" placeholder={`Padrão: ${(Number(penaltyInst.amount) - Number(penaltyInst.paid_amount)).toFixed(2)}`} value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
                        </div>
                        <div>
                          <Label>Data do pagamento</Label>
                          <Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
                        </div>
                        <Button onClick={() => {
                          const val = payAmount ? parseFloat(payAmount) : (Number(penaltyInst.amount) - Number(penaltyInst.paid_amount));
                          setPayPenaltyAmount(String(val));
                          setPayAmount("");
                          handlePay(penaltyInst.id);
                        }} className="w-full bg-success hover:bg-success/90">Confirmar</Button>
                      </div>
                    </DialogContent>
                  </Dialog>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>


      {/* Penalty Detail Dialog */}
      <Dialog open={penaltyDetailOpen} onOpenChange={(o) => { setPenaltyDetailOpen(o); if (!o) { setPenaltyAmount(""); setPenaltyObservation(""); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Gerenciar Multas</DialogTitle></DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto space-y-3">
            {penaltyInst && (
              <div className="rounded-lg bg-muted/50 p-3 text-sm space-y-1">
                <div className="flex justify-between"><span>Total de Multas:</span><span className="font-semibold text-destructive">{formatCurrency(penaltyTotal)}</span></div>
                <div className="flex justify-between"><span>Pago:</span><span className="text-success">{formatCurrency(penaltyPaid)}</span></div>
                <div className="flex justify-between"><span>Pendente:</span><span className="text-destructive">{formatCurrency(penaltyTotal - penaltyPaid)}</span></div>
              </div>
            )}

            {/* Add new penalty */}
            <div className="rounded-lg border border-dashed border-warning/50 p-3 space-y-2">
              <p className="text-sm font-medium">Adicionar Multa</p>
              <div>
                <Label className="text-xs">Valor da multa</Label>
                <Input type="number" placeholder="Valor" value={penaltyAmount} onChange={(e) => setPenaltyAmount(e.target.value)} className="h-9" />
              </div>
              <div>
                <Label className="text-xs">Observação (opcional)</Label>
                <Textarea placeholder="Motivo da multa..." value={penaltyObservation} onChange={(e) => setPenaltyObservation(e.target.value)} className="min-h-[60px]" />
              </div>
              <Button
                size="sm"
                className="w-full"
                onClick={() => {
                  // Attach to first pending/overdue regular installment
                  const target = regularInstallments
                    .filter((i) => i.status !== "paid")
                    .sort((a, b) => a.number - b.number)[0];
                  if (!target) {
                    toast.error("Nenhuma parcela disponível para vincular a multa");
                    return;
                  }
                  handleAddPenalty(target.id);
                }}
              >
                <Plus className="mr-1 h-3 w-3" /> Adicionar Multa
              </Button>
            </div>

            {/* Existing penalties */}
            <div>
              <p className="text-sm font-medium mb-2">Histórico de Multas ({penalties.length})</p>
              {renderPenaltyList()}
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
                      <div>
                        <Label className="text-xs">Valor</Label>
                        <Input type="number" placeholder="Valor da multa" value={overduePenaltyAmount} onChange={(e) => setOverduePenaltyAmount(e.target.value)} className="h-8" />
                      </div>
                      <div>
                        <Label className="text-xs">Observação (opcional)</Label>
                        <Input placeholder="Motivo..." value={overduePenaltyObs} onChange={(e) => setOverduePenaltyObs(e.target.value)} className="h-8" />
                      </div>
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

      {/* Edit Loan Dialog - Full Renegotiation */}
      <Dialog open={editLoanOpen} onOpenChange={setEditLoanOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Renegociar Empréstimo</DialogTitle></DialogHeader>
          <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
            <div>
              <Label>Valor Emprestado (R$)</Label>
              <Input type="number" value={editAmount} onChange={(e) => setEditAmount(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Tipo de Juros</Label>
                <Select value={editInterestType} onValueChange={setEditInterestType}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="percentage">Porcentagem (%)</SelectItem>
                    <SelectItem value="fixed">Valor Fixo (R$)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>{editInterestType === "percentage" ? "Juros (%)" : "Juros (R$)"}</Label>
                <Input type="number" value={editInterestValue} onChange={(e) => setEditInterestValue(e.target.value)} />
              </div>
            </div>
            <div>
              <Label>Tipo de Pagamento</Label>
              <Select value={editPaymentType} onValueChange={setEditPaymentType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Diário</SelectItem>
                  <SelectItem value="weekly">Semanal</SelectItem>
                  <SelectItem value="biweekly">Quinzenal</SelectItem>
                  <SelectItem value="monthly">Mensal</SelectItem>
                  <SelectItem value="fixed_dates">Data Fixa</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Quantidade de Parcelas</Label>
              <Input type="number" value={editInstallmentCount} onChange={(e) => setEditInstallmentCount(e.target.value)} />
            </div>
            <div>
              <Label>Data do Empréstimo</Label>
              <Input type="date" value={editLoanDate} onChange={(e) => setEditLoanDate(e.target.value)} />
            </div>
            {editPaymentType !== "fixed_dates" && (
              <div>
                <Label>Data do Primeiro Vencimento</Label>
                <Input type="date" value={editFirstDueDate} onChange={(e) => setEditFirstDueDate(e.target.value)} />
              </div>
            )}
            <div>
              <Label>Status</Label>
              <Select value={editStatus} onValueChange={setEditStatus}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="open">Em Aberto</SelectItem>
                  <SelectItem value="paid">Pago</SelectItem>
                  <SelectItem value="overdue">Atrasado</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <Label className="text-sm">Marcar como Cravo 🔥</Label>
              <Switch checked={editIsCravo} onCheckedChange={setEditIsCravo} />
            </div>

            {/* Renegotiation preview */}
            {editCalc && (
              <Card className="border-primary/30 bg-accent">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center text-base">
                    <Calculator className="mr-2 h-4 w-4" /> Prévia do Recálculo
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-1 text-sm">
                  <div className="flex justify-between"><span>Valor emprestado:</span><span className="font-semibold">{formatCurrency(editNumAmount)}</span></div>
                  <div className="flex justify-between"><span>Juros:</span><span className="font-semibold">{formatCurrency(editCalc.interest)}</span></div>
                  <div className="flex justify-between border-t pt-1"><span className="font-bold">Valor final:</span><span className="font-bold text-primary">{formatCurrency(editCalc.totalAmount)}</span></div>
                  <div className="flex justify-between"><span>Valor de cada parcela:</span><span className="font-semibold">{formatCurrency(editCalc.installmentAmount)}</span></div>
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

            {/* Penalty records */}
            <div className="border-t pt-3">
              <Label className="text-sm font-semibold">Registros de Multas ({penalties.length})</Label>
              {penaltyInst && (
                <div className="mt-1 mb-2 rounded-lg bg-muted/50 p-2 text-xs space-y-1">
                  <div className="flex justify-between"><span>Total:</span><span className="font-semibold text-destructive">{formatCurrency(penaltyTotal)}</span></div>
                  <div className="flex justify-between"><span>Pago:</span><span className="text-success">{formatCurrency(penaltyPaid)}</span></div>
                  <div className="flex justify-between"><span>Pendente:</span><span className="text-destructive">{formatCurrency(penaltyTotal - penaltyPaid)}</span></div>
                </div>
              )}
              {renderPenaltyList()}
            </div>

            <Button onClick={handleEditLoan} className="w-full" size="lg">
              ⚠️ Renegociar Empréstimo
            </Button>
            <p className="text-xs text-center text-muted-foreground">As parcelas existentes serão substituídas pelas novas.</p>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Installment Dialog */}
      <Dialog open={!!editInstId} onOpenChange={(o) => { if (!o) setEditInstId(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Editar Parcela</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Valor da parcela</Label>
              <Input type="number" value={editInstAmount} onChange={(e) => setEditInstAmount(e.target.value)} />
            </div>
            <div>
              <Label>Data de vencimento</Label>
              <Input type="date" value={editInstDueDate} onChange={(e) => setEditInstDueDate(e.target.value)} />
            </div>
            <Button onClick={handleEditInstallment} className="w-full">Salvar</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
