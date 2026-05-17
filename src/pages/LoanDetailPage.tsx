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
import { createDailyEvent } from "@/lib/daily-events";
import { registerPayment, registerPenaltyPayment, settleLoan, editPayment, recalculateInstallments, reversePayment } from "@/lib/payment-utils";
import { ArrowLeft, CheckCircle, DollarSign, Undo2, Pencil, Trash2, ChevronDown, Plus, Calendar, Calculator, RefreshCw, AlertTriangle, History, Receipt } from "lucide-react";
import { EmptyState } from "@/components/LoadingSkeleton";
import { format } from "date-fns";
import { toast } from "sonner";
import { useConfirm } from "@/hooks/useConfirm";
import { logAction } from "@/lib/audit-utils";

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
  observation: string | null;
  status_detail: string | null;
  renewed_from_loan_id: string | null;
  worker_id: string | null;
  admin_id: string | null;
  clients: { name: string; full_name: string | null; phone: string | null };
};

type RenegotiationInfo = {
  // This loan was renegotiated/renewed → link to the resulting new loan
  newLoanId?: string | null;
  newLoanDate?: string | null;
  // This loan came from a renegotiation/renewal of a previous loan
  sourceLoanId?: string | null;
  sourceLoanDate?: string | null;
  sourceType?: "renegotiation" | "renewal" | null;
  resultType?: "renegotiation" | "renewal" | null;
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
  const confirm = useConfirm();
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

  // Renegotiation (3-step dialog)
  const [renegOpen, setRenegOpen] = useState(false);
  const [renegStep, setRenegStep] = useState<1 | 2 | 3>(1);
  const [renegInterestType, setRenegInterestType] = useState<"percentage" | "fixed">("percentage");
  const [renegInterestValue, setRenegInterestValue] = useState("");
  const [renegInstallmentCount, setRenegInstallmentCount] = useState("");
  const [renegPaymentType, setRenegPaymentType] = useState("daily");
  const [renegFirstDueDate, setRenegFirstDueDate] = useState("");
  const [renegReason, setRenegReason] = useState("");
  const [renegConfirmed, setRenegConfirmed] = useState(false);
  const [renegSubmitting, setRenegSubmitting] = useState(false);

  // Renegotiation history banner
  const [renegInfo, setRenegInfo] = useState<RenegotiationInfo>({});

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

  const [loadingPage, setLoadingPage] = useState(true);

  // Edit observation
  const [obsOpen, setObsOpen] = useState(false);
  const [obsValue, setObsValue] = useState("");

  const handleSaveObservation = async () => {
    if (!loan) return;
    const oldObs = loan.observation || null;
    const newObs = obsValue.trim() || null;
    if (oldObs === newObs) { setObsOpen(false); return; }
    const { error } = await supabase.from("loans").update({ observation: newObs } as any).eq("id", loan.id);
    if (error) { toast.error("Erro ao salvar observação"); return; }
    logAction("editar_observacao_emprestimo", "loan", loan.id, { observation: oldObs }, { observation: newObs });
    toast.success("Observação atualizada!");
    setObsOpen(false);
    fetchData();
  };

  const fetchData = async () => {
    try {
      const { data: l, error: lErr } = await supabase.from("loans").select("*, clients(name, full_name, phone)").eq("id", loanId!).single();
      if (lErr || !l) {
        console.error("Error fetching loan:", lErr);
        setLoadingPage(false);
        return;
      }
      setLoan(l as unknown as Loan);
      const { data: inst } = await supabase.from("installments").select("*").eq("loan_id", loanId!).order("number");
      setInstallments(inst || []);
      const { data: pen } = await supabase.from("penalties").select("*").eq("loan_id", loanId!).order("created_at");
      setPenalties((pen as Penalty[]) || []);

      // Fetch payment history: join cash_movements with daily_events
      const { data: movs } = await supabase.from("cash_movements")
        .select("id, amount, cash_date, observation, created_at, daily_event_id")
        .eq("loan_id", loanId!)
        .eq("type", "recebimento_normal")
        .order("cash_date", { ascending: false });

      const { data: events } = await (supabase.from("daily_events" as any)
        .select("id, cash_date, amount_in, observation, cash_movement_id")
        .eq("loan_id", loanId!)
        .eq("event_type", "pagamento")
        .order("cash_date", { ascending: false }) as any);

      // Match movements with events by the unique financial movement id.
      const history: PaymentHistoryEntry[] = (movs || []).map((m: any) => {
        const matchingEvent = (events || []).find((e: any) => e.id === m.daily_event_id || e.cash_movement_id === m.id);
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

      // Load renegotiation info (this loan as source OR as result)
      const info: RenegotiationInfo = {};
      const { data: asSource } = await (supabase.from("loan_renegotiations" as any)
        .select("new_loan_id, type, created_at")
        .eq("original_loan_id", loanId!)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle() as any);
      if (asSource?.new_loan_id) {
        info.newLoanId = asSource.new_loan_id;
        info.newLoanDate = asSource.created_at;
        info.resultType = asSource.type;
      }
      if ((l as any).renewed_from_loan_id) {
        const { data: asResult } = await (supabase.from("loan_renegotiations" as any)
          .select("original_loan_id, type, created_at")
          .eq("new_loan_id", loanId!)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle() as any);
        info.sourceLoanId = asResult?.original_loan_id ?? (l as any).renewed_from_loan_id;
        info.sourceLoanDate = asResult?.created_at ?? null;
        info.sourceType = asResult?.type ?? "renewal";
      }
      setRenegInfo(info);
    } catch (err) {
      console.error("Error in LoanDetailPage fetchData:", err);
      toast.error("Erro ao carregar dados do empréstimo");
    } finally {
      setLoadingPage(false);
    }
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
    if (payPenaltyAmount && (isNaN(multaValue) || multaValue < 0)) {
      toast.error("Valor de multa inválido");
      return;
    }

    // Same rule as Rota: if no amount typed, default to remaining of next installment
    const firstUnpaid = pendingInstallments.slice().sort((a, b) => a.number - b.number)[0];
    const instRemaining = firstUnpaid
      ? Math.max(0, Number(firstUnpaid.amount) - Number(firstUnpaid.paid_amount))
      : 0;
    const paidValue = parcValue ?? instRemaining;

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
      if (paidValue > 0 && firstUnpaid) {
        await registerPayment({
          loanId: loanId!, amount: paidValue,
          clientId: loan.client_id, clientName: loan.clients.name,
          cashDate: payDate, origin: "detalhe_emprestimo",
          installmentId: firstUnpaid.id,
          startInstNumber: firstUnpaid.number,
        });
        toast.success(`Pagamento: ${formatCurrency(paidValue)} registrado!`);
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

  // --- Undo payment from history ---
  const handleUndoHistoryPayment = async (entry: PaymentHistoryEntry) => {
    if (isSubmitting || !loan) return;
    const ok = await confirm({
      title: "Desfazer pagamento?",
      description: "O valor sai do caixa e a parcela volta a ficar em aberto.",
      affected: [
        { label: "Cliente", value: loan.clients?.name || "—" },
        { label: "Valor", value: formatCurrency(entry.amount) },
        { label: "Data", value: format(new Date(entry.cashDate + "T12:00:00"), "dd/MM/yyyy") },
      ],
      confirmText: "Desfazer", destructive: true,
    });
    if (!ok) return;
    setIsSubmitting(true);
    try {
      await reversePayment({ movementId: entry.movementId });
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
        cashDate: editPayEntry.cashDate, newAmount,
        origin: "detalhe_emprestimo", movementId: editPayEntry.movementId,
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

    const { data: { session } } = await supabase.auth.getSession();
    await supabase.from("penalties").insert({
      loan_id: loanId!, installment_id: installmentId,
      amount: penAmount, observation: penObs || null,
      user_id: session?.user?.id,
    } as any);

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
    try {
      await createDailyEvent({
        cash_date: format(new Date(), "yyyy-MM-dd"),
        event_type: "multa_adicionada",
        client_id: loan?.client_id || null,
        loan_id: loanId!,
        installment_id: installmentId,
        amount_in: 0,
        amount_out: 0,
        observation: `Multa adicionada ${formatCurrency(penAmount)}${penObs ? ` - ${penObs}` : ""}`,
        origin: "detalhe_emprestimo",
      });
    } catch (err) { console.warn("[daily_event multa_adicionada] failed", err); }
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

  // --- Renegotiation (new 3-step flow) ---
  const renegBase = loan ? Number(loan.remaining_balance) : 0;
  const renegNumInterest = parseFloat(renegInterestValue) || 0;
  const renegNumInstallments = parseInt(renegInstallmentCount) || 0;

  const renegCalc = useMemo(() => {
    if (renegBase <= 0 || renegNumInstallments <= 0) return null;
    return calculateLoan(renegBase, renegInterestType, renegNumInterest, renegNumInstallments);
  }, [renegBase, renegInterestType, renegNumInterest, renegNumInstallments]);

  const renegDueDates = useMemo(() => {
    if (!renegFirstDueDate || renegNumInstallments <= 0 || renegPaymentType === "fixed_dates") return [];
    return generateDueDates(
      new Date(renegFirstDueDate + "T12:00:00"),
      renegNumInstallments,
      renegPaymentType as "daily" | "weekly" | "biweekly" | "monthly",
    );
  }, [renegFirstDueDate, renegNumInstallments, renegPaymentType]);

  const openRenegotiate = () => {
    if (!loan) return;
    setRenegStep(1);
    setRenegInterestType((loan.interest_type as "percentage" | "fixed") || "percentage");
    setRenegInterestValue("");
    setRenegInstallmentCount("");
    setRenegPaymentType(loan.payment_type || "daily");
    setRenegFirstDueDate(format(new Date(), "yyyy-MM-dd"));
    setRenegReason("");
    setRenegConfirmed(false);
    setRenegOpen(true);
  };

  const handleRenegotiate = async () => {
    if (!loan || !renegCalc) { toast.error("Preencha as novas condições"); return; }
    if (renegBase <= 0.01) { toast.error("Empréstimo sem saldo devedor — não pode ser renegociado"); return; }
    if (renegDueDates.length === 0) { toast.error("Informe a data do primeiro vencimento"); return; }
    if (!renegReason.trim()) { toast.error("Informe o motivo da renegociação"); return; }
    if (!renegConfirmed) { toast.error("Confirme as novas condições com o cliente"); return; }
    if (renegSubmitting) return;
    setRenegSubmitting(true);
    try {
      // 1. Snapshot + insert renegotiation row
      const { data: renegRow, error: renegErr } = await (supabase.from("loan_renegotiations" as any).insert({
        original_loan_id: loan.id,
        worker_id: loan.worker_id ?? null,
        admin_id: loan.admin_id ?? null,
        type: "renegotiation",
        original_remaining_balance: renegBase,
        original_total_amount: Number(loan.total_amount),
        original_installment_count: loan.installment_count,
        original_payment_type: loan.payment_type,
        original_interest_type: loan.interest_type,
        original_interest_value: Number(loan.interest_value),
        client_paid_amount: 0,
        absorbed_from_new: renegBase,
        released_to_client: 0,
        new_amount: renegBase,
        new_interest_type: renegInterestType,
        new_interest_value: renegNumInterest,
        new_total_amount: renegCalc.totalAmount,
        new_installment_count: renegNumInstallments,
        new_payment_type: renegPaymentType,
        reason: renegReason.trim(),
      } as any).select("id").single() as any);
      if (renegErr) throw renegErr;

      // 2. Mark old loan as renegotiated
      await supabase.from("loans").update({
        status: "paid",
        status_detail: "renegotiated",
        remaining_balance: 0,
      } as any).eq("id", loan.id);

      // 3. Create the new loan
      const { data: newLoan, error: newErr } = await supabase.from("loans").insert({
        client_id: loan.client_id,
        amount: renegBase,
        interest_type: renegInterestType,
        interest_value: renegNumInterest,
        total_amount: renegCalc.totalAmount,
        remaining_balance: renegCalc.totalAmount,
        installment_count: renegNumInstallments,
        payment_type: renegPaymentType,
        loan_date: format(new Date(), "yyyy-MM-dd"),
        first_due_date: renegFirstDueDate || null,
        status: "open",
        is_cravo: loan.is_cravo,
        worker_id: (loan as any).worker_id ?? null,
        admin_id: (loan as any).admin_id ?? null,
        renewed_from_loan_id: loan.id,
        status_detail: "active",
        observation: `Renegociação de ${loan.id.slice(0, 8)} — ${renegReason.trim()}`,
      } as any).select("id").single();
      if (newErr || !newLoan) throw newErr || new Error("Falha ao criar novo empréstimo");

      // 4. Generate installments for the new loan
      if (renegDueDates.length > 0) {
        const newInsts = renegDueDates.map((date, i) => ({
          loan_id: newLoan.id,
          number: i + 1,
          amount: renegCalc.installmentAmount,
          due_date: format(date, "yyyy-MM-dd"),
          status: "pending" as const,
        }));
        await supabase.from("installments").insert(newInsts);
      }

      // 5. Link renegotiation row to the new loan
      if (renegRow?.id) {
        await (supabase.from("loan_renegotiations" as any).update({ new_loan_id: newLoan.id } as any).eq("id", renegRow.id) as any);
      }

      // 6. Audit log
      await logAction(
        "renegociacao_emprestimo",
        "loan_renegotiations",
        renegRow?.id ?? loan.id,
        { old_balance: renegBase, old_total: Number(loan.total_amount), old_installments: loan.installment_count } as any,
        { new_total: renegCalc.totalAmount, new_installments: renegNumInstallments, new_loan_id: newLoan.id, reason: renegReason.trim() } as any,
      );

      await recalculateCashBalanceFromLedger();
      toast.success(`Empréstimo renegociado! Novo plano: ${renegNumInstallments}x ${formatCurrency(renegCalc.installmentAmount)}`);
      setRenegOpen(false);
      navigate(`/loans/${newLoan.id}`);
    } catch (err: any) {
      console.error("[renegotiate] failed", err);
      toast.error("Erro ao renegociar: " + (err?.message || "tente novamente"));
    } finally {
      setRenegSubmitting(false);
    }
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

  // --- Full recalculate after manual edits ---
  const handleFullRecalculate = async () => {
    if (isSubmitting || !loan) return;
    setIsSubmitting(true);
    try {
      // 1. Sum all regular installment amounts to get new total_amount
      const { data: currentInsts } = await supabase
        .from("installments")
        .select("amount")
        .eq("loan_id", loanId!)
        .eq("is_penalty", false);
      const newTotalAmount = (currentInsts || []).reduce((s: number, i: any) => s + Number(i.amount), 0);

      // 2. Get total paid from cash_movements
      const { data: movs } = await supabase
        .from("cash_movements")
        .select("amount")
        .eq("loan_id", loanId!)
        .eq("type", "recebimento_normal");
      const totalPaid = (movs || []).reduce((s: number, m: any) => s + Number(m.amount), 0);

      // 3. Update loan total_amount and remaining_balance
      const newRemainingBalance = Math.max(0, newTotalAmount - totalPaid);
      const newStatus = newRemainingBalance <= 0.01 ? "paid" : "open";
      await supabase.from("loans").update({
        total_amount: newTotalAmount,
        remaining_balance: newRemainingBalance,
        status: newStatus,
      }).eq("id", loanId!);

      // 4. Recalculate installment distribution
      await recalculateInstallments(loanId!);

      // 5. Recalculate cash balance
      await recalculateCashBalanceFromLedger();

      toast.success("Empréstimo atualizado e recalculado!");
    } catch {
      toast.error("Erro ao atualizar empréstimo");
    }
    setIsSubmitting(false);
    fetchData();
  };

  const handleDeleteInstallment = async (id: string) => {
    const inst = installments.find((i) => i.id === id);
    const ok = await confirm({
      title: "Excluir parcela?",
      description: "Esta ação não pode ser desfeita. Multas associadas a esta parcela também serão removidas.",
      affected: [
        { label: "Parcela", value: inst ? `#${inst.number}` : "—" },
        { label: "Valor", value: inst ? formatCurrency(Number(inst.amount)) : "—" },
        { label: "Vencimento", value: inst ? format(new Date(inst.due_date + "T12:00:00"), "dd/MM/yyyy") : "—" },
      ],
      confirmText: "Excluir", destructive: true,
    });
    if (!ok) return;
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
    const ok = await confirm({
      title: "Excluir empréstimo?",
      description: "Todas as parcelas, pagamentos, multas e movimentações deste empréstimo serão removidos. Esta ação é irreversível.",
      affected: [
        { label: "Cliente", value: loan?.clients?.name || "—" },
        { label: "Total", value: loan ? formatCurrency(Number(loan.total_amount)) : "—" },
        { label: "Parcelas", value: String(installments.length) },
        { label: "Pagamentos", value: String(paymentHistory.length) },
      ],
      confirmText: "Excluir tudo", destructive: true,
    });
    if (!ok) return;
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
          {loan.status !== "paid" && (
            <Button variant="ghost" size="sm" onClick={openRenegotiate}>
              <RefreshCw className="mr-1 h-4 w-4" /> Renegociar
            </Button>
          )}
          <Button variant="ghost" size="sm" className="text-destructive" onClick={handleDeleteLoan}>
            <Trash2 className="mr-1 h-4 w-4" /> Excluir
          </Button>
        </div>
      </div>

      {/* Renegotiation history banner */}
      {(renegInfo.newLoanId || renegInfo.sourceLoanId) && (
        <div className="mb-3 space-y-2">
          {renegInfo.newLoanId && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-2.5 text-xs flex items-center justify-between gap-2">
              <span>
                Este empréstimo foi <strong>{renegInfo.resultType === "renewal" ? "renovado" : "renegociado"}</strong>
                {renegInfo.newLoanDate && ` em ${format(new Date(renegInfo.newLoanDate), "dd/MM/yyyy")}`}
              </span>
              <Button size="sm" variant="link" className="h-auto p-0 text-xs" onClick={() => navigate(`/loans/${renegInfo.newLoanId}`)}>
                Ver novo empréstimo →
              </Button>
            </div>
          )}
          {renegInfo.sourceLoanId && (
            <div className="rounded-lg border border-muted bg-muted/30 p-2.5 text-xs flex items-center justify-between gap-2">
              <span>
                Este empréstimo é uma <strong>{renegInfo.sourceType === "renewal" ? "renovação" : "renegociação"}</strong> de um anterior
              </span>
              <Button size="sm" variant="link" className="h-auto p-0 text-xs" onClick={() => navigate(`/loans/${renegInfo.sourceLoanId}`)}>
                Ver empréstimo anterior →
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Loan Info Card */}
      <Card className="mb-4">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">
              <button className="hover:underline text-primary cursor-pointer text-left" onClick={() => navigate(`/clients/${loan.client_id}`)}>
                {loan.clients.name}
              </button>
            </CardTitle>
            <Badge className={getLoanStatusColor(loan.status)}>{getStatusLabel(loan.status)}</Badge>
          </div>
          {(loan.clients.full_name || loan.clients.phone) && (
            <div className="text-xs text-muted-foreground space-y-0.5 mt-1">
              {loan.clients.full_name && <p>{loan.clients.full_name}</p>}
              {loan.clients.phone && <p>📞 {loan.clients.phone}</p>}
            </div>
          )}
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

      {/* Observation Card */}
      <Card className="mb-4">
        <CardContent className="p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase mb-1">Observação</p>
              {loan.observation ? (
                <p className="text-sm whitespace-pre-wrap">{loan.observation}</p>
              ) : (
                <p className="text-sm text-muted-foreground italic">Sem observação</p>
              )}
            </div>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => { setObsValue(loan.observation || ""); setObsOpen(true); }}>
              <Pencil className="h-3.5 w-3.5 mr-1" /> Editar
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={obsOpen} onOpenChange={setObsOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Editar observação</DialogTitle></DialogHeader>
          <Textarea rows={5} value={obsValue} onChange={(e) => setObsValue(e.target.value)} placeholder="Anote condições, garantias, contexto..." />
          <div className="flex justify-end gap-2 mt-2">
            <Button variant="ghost" onClick={() => setObsOpen(false)}>Cancelar</Button>
            <Button onClick={handleSaveObservation}>Salvar</Button>
          </div>
        </DialogContent>
      </Dialog>

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
        <Button className="w-full mb-2 bg-success hover:bg-success/90" size="lg" onClick={() => setPayOpen(true)}>
          <Plus className="mr-2 h-5 w-5" /> Registrar Pagamento
        </Button>
      )}

      {/* === RECALCULATE BUTTON === */}
      <Button variant="outline" className="w-full mb-4" onClick={handleFullRecalculate} disabled={isSubmitting}>
        <Calculator className="mr-2 h-4 w-4" /> Atualizar
      </Button>

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
          </CardContent>
        </Card>
      )}

      {/* === PAYMENT HISTORY SECTION === */}
      <Collapsible open={historyOpen} onOpenChange={setHistoryOpen} className="mt-4 mb-4">
        <CollapsibleTrigger asChild>
          <Button variant="outline" className="w-full">
            <History className="mr-2 h-4 w-4" />
            Histórico de Pagamentos ({paymentHistory.length})
            <ChevronDown className={`ml-auto h-4 w-4 transition-transform ${historyOpen ? "rotate-180" : ""}`} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 space-y-2">
          {paymentHistory.length === 0 ? (
            <EmptyState icon={Receipt} message="Nenhum pagamento registrado" description="Os pagamentos aparecem aqui assim que forem lançados." compact />
          ) : paymentHistory.map((entry) => (
            <Card key={entry.movementId}>
              <CardContent className="p-3">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-success">{formatCurrency(entry.amount)}</p>
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(entry.cashDate + "T12:00:00"), "dd/MM/yyyy")}
                    </p>
                    {entry.observation && (
                      <p className="text-xs text-muted-foreground italic mt-0.5">"{entry.observation}"</p>
                    )}
                  </div>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => {
                      setEditPayEntry(entry);
                      setEditPayNewAmount(String(entry.amount));
                      setEditPayOpen(true);
                    }} disabled={isSubmitting}>
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" onClick={() => handleUndoHistoryPayment(entry)} disabled={isSubmitting}>
                      <Undo2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </CollapsibleContent>
      </Collapsible>

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
              <Label>Valor do pagamento</Label>
              <Input type="number" placeholder={nextInstValue > 0 ? `Padrão: ${nextInstValue.toFixed(2)}` : "Valor"} value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
              <p className="text-xs text-muted-foreground mt-1">
                💡 Em branco = paga o valor da próxima parcela. Sobra avança automaticamente para as próximas.
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
                  <EmptyState icon={AlertTriangle} message="Nenhuma multa registrada" compact />
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

      {/* Renegotiation Dialog (3-step flow) */}
      <Dialog open={renegOpen} onOpenChange={(o) => { if (!o && !renegSubmitting) setRenegOpen(false); }}>
        <DialogContent className="max-w-lg" onOpenAutoFocus={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>Renegociar Empréstimo — Passo {renegStep} de 3</DialogTitle>
          </DialogHeader>
          <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
            {/* STEP 1 — Current situation */}
            {renegStep === 1 && (
              <>
                <Card>
                  <CardContent className="pt-4 space-y-2 text-sm">
                    <div className="flex justify-between"><span className="text-muted-foreground">Valor original:</span><span>{formatCurrency(Number(loan.amount))}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Juros originais:</span><span>{formatCurrency(Number(loan.total_amount) - Number(loan.amount))}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Parcelas:</span><span>{Math.floor(loanProgress.fractionalProgress)} pagas / {loan.installment_count} total</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Valor por parcela:</span><span>{formatCurrency(Number(loan.total_amount) / loan.installment_count)}</span></div>
                    <div className="border-t pt-2 flex justify-between items-baseline">
                      <span className="font-semibold">Saldo devedor:</span>
                      <span className="text-2xl font-bold text-primary">{formatCurrency(renegBase)}</span>
                    </div>
                    {penaltyTotal - penaltyPaid > 0.01 && (
                      <div className="flex justify-between text-destructive">
                        <span>Multas pendentes:</span>
                        <span className="font-semibold">{formatCurrency(penaltyTotal - penaltyPaid)}</span>
                      </div>
                    )}
                  </CardContent>
                </Card>
                <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs">
                  ⚠️ A renegociação vai criar um <strong>novo plano de pagamento</strong>. O empréstimo atual será encerrado e um novo será gerado com as novas condições. O saldo devedor atual ({formatCurrency(renegBase)}) é a base do novo empréstimo.
                </div>
                <Button onClick={() => setRenegStep(2)} className="w-full" disabled={renegBase <= 0.01}>
                  Próximo →
                </Button>
              </>
            )}

            {/* STEP 2 — New conditions */}
            {renegStep === 2 && (
              <>
                <div>
                  <Label className="text-xs text-muted-foreground">Base do novo empréstimo (saldo devedor)</Label>
                  <Input type="text" value={formatCurrency(renegBase)} disabled className="mt-1 font-semibold" />
                </div>
                <div>
                  <Label>Juros adicionais</Label>
                  <div className="flex gap-2 mt-1">
                    <Select value={renegInterestType} onValueChange={(v) => setRenegInterestType(v as "percentage" | "fixed")}>
                      <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="percentage">Porcentagem (%)</SelectItem>
                        <SelectItem value="fixed">Valor Fixo (R$)</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      type="number" step="0.01" inputMode="decimal"
                      placeholder={renegInterestType === "percentage" ? "Ex: 20" : "Ex: 100,00"}
                      value={renegInterestValue}
                      onChange={(e) => setRenegInterestValue(e.target.value)}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Nº de parcelas</Label>
                    <Input type="number" inputMode="numeric" value={renegInstallmentCount} onChange={(e) => setRenegInstallmentCount(e.target.value)} />
                  </div>
                  <div>
                    <Label>Tipo de pagamento</Label>
                    <Select value={renegPaymentType} onValueChange={setRenegPaymentType}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="daily">Diário</SelectItem>
                        <SelectItem value="weekly">Semanal</SelectItem>
                        <SelectItem value="biweekly">Quinzenal</SelectItem>
                        <SelectItem value="monthly">Mensal</SelectItem>
                        <SelectItem value="fixed_dates">Data fixa</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {renegPaymentType !== "fixed_dates" && (
                  <div>
                    <Label>Data da 1ª parcela</Label>
                    <Input type="date" value={renegFirstDueDate} onChange={(e) => setRenegFirstDueDate(e.target.value)} />
                  </div>
                )}
                <div>
                  <Label>Motivo da renegociação <span className="text-destructive">*</span></Label>
                  <Textarea
                    value={renegReason}
                    onChange={(e) => setRenegReason(e.target.value)}
                    placeholder="Ex: cliente pediu prazo maior, mudou de emprego..."
                    rows={2}
                  />
                </div>

                <Card className="border-primary/30 bg-accent">
                  <CardContent className="pt-3 space-y-1 text-sm">
                    <div className="flex justify-between"><span>Base (saldo devedor):</span><span className="font-semibold">{formatCurrency(renegBase)}</span></div>
                    <div className="flex justify-between"><span>Juros adicionais:</span><span className="font-semibold">{formatCurrency(renegCalc?.interest || 0)}</span></div>
                    <div className="flex justify-between border-t pt-1"><span className="font-bold">Novo total:</span><span className="font-bold text-primary">{formatCurrency(renegCalc?.totalAmount || 0)}</span></div>
                    <div className="flex justify-between"><span>Valor por parcela:</span><span className="font-semibold">{formatCurrency(renegCalc?.installmentAmount || 0)}</span></div>
                  </CardContent>
                </Card>

                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setRenegStep(1)} className="flex-1">← Voltar</Button>
                  <Button
                    onClick={() => setRenegStep(3)}
                    className="flex-1"
                    disabled={!renegCalc || renegDueDates.length === 0 || !renegReason.trim()}
                  >
                    Próximo →
                  </Button>
                </div>
              </>
            )}

            {/* STEP 3 — Confirmation */}
            {renegStep === 3 && renegCalc && (
              <>
                <div className="rounded-lg border overflow-hidden text-sm">
                  <div className="grid grid-cols-3 bg-muted/50 px-2 py-1.5 text-xs font-semibold">
                    <span></span><span>Antes</span><span>Depois</span>
                  </div>
                  {[
                    ["Valor base", formatCurrency(Number(loan.amount)), formatCurrency(renegBase)],
                    ["Total a pagar", formatCurrency(Number(loan.total_amount)), formatCurrency(renegCalc.totalAmount)],
                    ["Parcelas", String(loan.installment_count), String(renegNumInstallments)],
                    ["Valor/parcela", formatCurrency(Number(loan.total_amount) / loan.installment_count), formatCurrency(renegCalc.installmentAmount)],
                    ["Tipo pagto", getPaymentTypeLabel(loan.payment_type), getPaymentTypeLabel(renegPaymentType)],
                  ].map(([label, before, after], i) => (
                    <div key={i} className="grid grid-cols-3 border-t px-2 py-1.5 text-xs">
                      <span className="text-muted-foreground">{label}</span>
                      <span>{before}</span>
                      <span className="font-semibold">{after}</span>
                    </div>
                  ))}
                </div>
                <div className="rounded-lg bg-muted/40 p-2 text-xs">
                  <strong>Motivo:</strong> {renegReason.trim()}
                </div>
                <label className="flex items-start gap-2 rounded-lg border p-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={renegConfirmed}
                    onChange={(e) => setRenegConfirmed(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span className="text-sm">Confirmo as novas condições com o cliente</span>
                </label>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setRenegStep(2)} className="flex-1" disabled={renegSubmitting}>← Voltar</Button>
                  <Button
                    onClick={handleRenegotiate}
                    className="flex-1 bg-primary"
                    disabled={!renegConfirmed || renegSubmitting}
                  >
                    {renegSubmitting ? "Processando..." : "Confirmar Renegociação"}
                  </Button>
                </div>
              </>
            )}
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
      {/* Edit Payment Dialog */}
      <Dialog open={editPayOpen} onOpenChange={(o) => { if (!o) { setEditPayOpen(false); setEditPayEntry(null); setEditPayNewAmount(""); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Editar Pagamento</DialogTitle></DialogHeader>
          {editPayEntry && (
            <div className="space-y-3">
              <div className="rounded-lg bg-muted/50 p-3 text-sm space-y-1">
                <div className="flex justify-between"><span>Data:</span><span>{format(new Date(editPayEntry.cashDate + "T12:00:00"), "dd/MM/yyyy")}</span></div>
                <div className="flex justify-between"><span>Valor atual:</span><span className="font-bold">{formatCurrency(editPayEntry.amount)}</span></div>
              </div>
              <div>
                <Label>Novo valor</Label>
                <Input type="number" value={editPayNewAmount} onChange={(e) => setEditPayNewAmount(e.target.value)} />
              </div>
              <Button onClick={handleEditPaymentConfirm} className="w-full" disabled={isSubmitting}>
                {isSubmitting ? "Processando..." : "Salvar Alteração"}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
