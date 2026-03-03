import { useEffect, useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { format, differenceInCalendarDays, addDays } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { formatCurrency, getStatusColor, getStatusLabel, calculateOverdueDays } from "@/lib/loan-utils";
import { updateCashBalance, createCashMovement, recalculateCashBalanceFromLedger } from "@/lib/cash-utils";
import { Checkbox } from "@/components/ui/checkbox";
import {
  CalendarDays, CheckCircle, XCircle, DollarSign, AlertTriangle,
  Plus, ChevronDown, Undo2, Lock, ChevronLeft, ChevronRight, Clock, LockOpen
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

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
    client_id: string;
    amount: number;
    total_amount: number;
    installment_count: number;
    payment_type: string;
    clients: { id: string; name: string };
  };
};

type NotPaidMark = {
  id: string;
  mark_date: string;
  installment_id: string;
  loan_id: string;
  client_id: string;
  observation: string | null;
  created_at: string;
};

type LoanProgress = {
  progress: number;
  total: number;
  remaining: number;
  penaltyTotal: number;
  penaltyPaid: number;
};

type ActiveTab = "pending" | "paid" | "notpaid";

export default function DailyCashPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const dateParam = searchParams.get("date");
  const [selectedDate, setSelectedDate] = useState(dateParam || format(new Date(), "yyyy-MM-dd"));
  const today = format(new Date(), "yyyy-MM-dd");

  // Tab
  const [activeTab, setActiveTab] = useState<ActiveTab>("pending");

  // Data
  const [pendingInstallments, setPendingInstallments] = useState<InstallmentWithLoan[]>([]);
  const [paidInstallments, setPaidInstallments] = useState<InstallmentWithLoan[]>([]);
  const [notPaidMarks, setNotPaidMarks] = useState<(NotPaidMark & { installment?: InstallmentWithLoan })[]>([]);
  const [loanProgressMap, setLoanProgressMap] = useState<Record<string, LoanProgress>>({});
  const [loading, setLoading] = useState(true);
  const [dailyCashStatus, setDailyCashStatus] = useState<string>("open");

  // Dialog states
  const [payDialogId, setPayDialogId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payPenaltyAmount, setPayPenaltyAmount] = useState("");
  const [payDate, setPayDate] = useState(selectedDate);
  const [notPaidDialogId, setNotPaidDialogId] = useState<string | null>(null);
  const [notPaidObs, setNotPaidObs] = useState("");
  const [selectedForNotPaid, setSelectedForNotPaid] = useState<Set<string>>(new Set());
  const [batchNotPaidDialogOpen, setBatchNotPaidDialogOpen] = useState(false);
  const [batchNotPaidObs, setBatchNotPaidObs] = useState("");

  useEffect(() => {
    setPayDate(selectedDate);
  }, [selectedDate]);

  const changeDate = (offset: number) => {
    const d = new Date(selectedDate + "T12:00:00");
    const newDate = format(addDays(d, offset), "yyyy-MM-dd");
    setSelectedDate(newDate);
    setSearchParams({ date: newDate });
  };

  const isClosed = dailyCashStatus === "closed";

  const fetchData = useCallback(async () => {
    setLoading(true);

    // 1. First check daily_cash status
    const { data: dcData } = await supabase
      .from("daily_cash").select("*").eq("cash_date", selectedDate).maybeSingle();

    const status = dcData?.status || "open";
    setDailyCashStatus(status);

    // 2. Always fetch paid and not-paid marks for display
    const nextDay = format(addDays(new Date(selectedDate + "T12:00:00"), 1), "yyyy-MM-dd");

    const [
      { data: paidData },
      { data: npData },
    ] = await Promise.all([
      supabase.from("installments")
        .select("*, loans(id, client_id, amount, total_amount, installment_count, payment_type, clients(id, name))")
        .eq("is_penalty", false)
        .gte("paid_at", selectedDate + "T00:00:00")
        .lt("paid_at", nextDay + "T00:00:00")
        .order("number"),
      supabase.from("not_paid_marks").select("*").eq("mark_date", selectedDate),
    ]);

    const paidInsts = (paidData as unknown as InstallmentWithLoan[]) || [];
    setPaidInstallments(paidInsts);

    const npMarks = (npData || []) as unknown as NotPaidMark[];

    // Fetch not-paid installment details
    const npInstIds = npMarks.map(m => m.installment_id);
    let npInstMap: Record<string, InstallmentWithLoan> = {};
    if (npInstIds.length > 0) {
      const { data: npInstData } = await supabase
        .from("installments")
        .select("*, loans(id, client_id, amount, total_amount, installment_count, payment_type, clients(id, name))")
        .in("id", npInstIds);
      const npInsts = (npInstData as unknown as InstallmentWithLoan[]) || [];
      npInstMap = Object.fromEntries(npInsts.map(i => [i.id, i]));
    }

    const enrichedNpMarks = npMarks.map(m => ({ ...m, installment: npInstMap[m.installment_id] }));
    setNotPaidMarks(enrichedNpMarks);

    // 3. If CLOSED → frozen: no pending recalculation, just show paid + notpaid
    if (status === "closed") {
      setPendingInstallments([]);
      setSelectedForNotPaid(new Set());
      // Still compute progress for paid/notpaid display
      await computeProgress(paidInsts, enrichedNpMarks, []);
      setLoading(false);
      return;
    }

    // 4. OPEN day: compute pending installments
    const [
      { data: dueTodayData },
      { data: overdueData },
    ] = await Promise.all([
      supabase.from("installments")
        .select("*, loans(id, client_id, amount, total_amount, installment_count, payment_type, clients(id, name))")
        .eq("due_date", selectedDate).neq("status", "paid").eq("is_penalty", false).order("number"),
      supabase.from("installments")
        .select("*, loans(id, client_id, amount, total_amount, installment_count, payment_type, clients(id, name))")
        .lt("due_date", selectedDate).neq("status", "paid").eq("is_penalty", false).order("number"),
    ]);

    const overdueInsts = (overdueData as unknown as InstallmentWithLoan[]) || [];
    const validOverdue = overdueInsts.filter(i => Number(i.amount) - Number(i.paid_amount) > 0.01);
    const dueToday = (dueTodayData as unknown as InstallmentWithLoan[]) || [];

    const paidInstIds = new Set(paidInsts.map(i => i.id));
    const npMarkInstIds = new Set(npMarks.map(m => m.installment_id));

    // CRITICAL: Track loans that already have ANY action for this day
    const actionedLoanIds = new Set([
      ...paidInsts.map(i => i.loan_id),
      ...npMarks.map(m => m.loan_id),
    ]);

    // Combine ALL candidates, filter out actioned
    const allCandidates = [...validOverdue, ...dueToday].filter(
      i => !paidInstIds.has(i.id) && !npMarkInstIds.has(i.id)
        && !actionedLoanIds.has(i.loan_id)
        && Number(i.amount) - Number(i.paid_amount) > 0.01
    );

    // Deduplicate: one installment per loan, oldest number wins
    const seenLoans = new Set<string>();
    const dedupedPending: InstallmentWithLoan[] = [];
    for (const inst of allCandidates.sort((a, b) => a.number - b.number)) {
      if (!seenLoans.has(inst.loan_id)) {
        seenLoans.add(inst.loan_id);
        dedupedPending.push(inst);
      }
    }
    setPendingInstallments(dedupedPending);
    setSelectedForNotPaid(new Set());

    await computeProgress(paidInsts, enrichedNpMarks, dedupedPending);
    setLoading(false);
  }, [selectedDate]);

  const computeProgress = async (
    paidInsts: InstallmentWithLoan[],
    enrichedNpMarks: (NotPaidMark & { installment?: InstallmentWithLoan })[],
    pending: InstallmentWithLoan[]
  ) => {
    const allLoanIds = [
      ...new Set([
        ...pending.map(i => i.loan_id),
        ...paidInsts.map(i => i.loan_id),
        ...enrichedNpMarks.filter(m => m.installment).map(m => m.loan_id),
      ])
    ];

    const progressMap: Record<string, LoanProgress> = {};
    if (allLoanIds.length > 0) {
      const { data: allInstData } = await supabase
        .from("installments")
        .select("loan_id, amount, paid_amount, is_penalty")
        .in("loan_id", allLoanIds);

      if (allInstData) {
        const byLoan: Record<string, typeof allInstData> = {};
        for (const row of allInstData) {
          (byLoan[row.loan_id] ||= []).push(row);
        }
        for (const [lid, insts] of Object.entries(byLoan)) {
          const regular = insts.filter(i => !i.is_penalty);
          const penalties = insts.filter(i => i.is_penalty);
          const totalPaid = regular.reduce((s, i) => s + Number(i.paid_amount), 0);
          const instValue = regular.length > 0 ? Number(regular[0].amount) : 1;
          progressMap[lid] = {
            progress: totalPaid / instValue,
            total: regular.length,
            remaining: regular.reduce((s, i) => s + Number(i.amount), 0) - totalPaid,
            penaltyTotal: penalties.reduce((s, i) => s + Number(i.amount), 0),
            penaltyPaid: penalties.reduce((s, i) => s + Number(i.paid_amount), 0),
          };
        }
      }
    }
    setLoanProgressMap(progressMap);
  };

  useEffect(() => { fetchData(); }, [fetchData]);

  // === Payment handler with optimistic UI ===
  const handlePay = async (id: string) => {
    if (isClosed) { toast.error("Caixa fechado. Reabra para registrar."); return; }

    const allInsts = [...pendingInstallments, ...paidInstallments];
    const inst = allInsts.find(i => i.id === id);
    if (!inst) return;

    const parcValue = payAmount ? parseFloat(payAmount) : null;
    const multaValue = payPenaltyAmount ? parseFloat(payPenaltyAmount) : 0;
    if (payAmount && (isNaN(parcValue!) || parcValue! <= 0)) { toast.error("Valor inválido"); return; }
    if (payPenaltyAmount && (isNaN(multaValue) || multaValue < 0)) { toast.error("Valor de multa inválido"); return; }

    const instRemaining = Number(inst.amount) - Number(inst.paid_amount);
    const paidValue = parcValue ?? instRemaining;

    // Optimistic: move from pending to paid
    const optimisticPaid: InstallmentWithLoan = {
      ...inst,
      paid_amount: Number(inst.paid_amount) + paidValue,
      status: paidValue >= instRemaining - 0.01 ? "paid" : inst.status,
      paid_at: new Date(payDate + "T12:00:00").toISOString(),
    };
    setPendingInstallments(prev => prev.filter(i => i.id !== id));
    setPaidInstallments(prev => [...prev, optimisticPaid]);
    resetPayDialog();
    toast.success(`Parcela: ${formatCurrency(paidValue)} registrado!`);

    // Background sync
    try {
      // Handle penalty payment
      if (multaValue > 0) {
        const { data: penaltyInsts } = await supabase
          .from("installments").select("*").eq("loan_id", inst.loan_id).eq("is_penalty", true);
        const penaltyInst = penaltyInsts?.[0];
        if (penaltyInst) {
          const newPaid = Number(penaltyInst.paid_amount) + multaValue;
          const fullyPaid = newPaid >= Number(penaltyInst.amount) - 0.01;
          await supabase.from("installments").update({
            paid_amount: Math.min(newPaid, Number(penaltyInst.amount)),
            status: fullyPaid ? "paid" : penaltyInst.status,
            paid_at: fullyPaid ? new Date(payDate + "T12:00:00").toISOString() : penaltyInst.paid_at,
          }).eq("id", penaltyInst.id);
          await updateCashBalance({ available_cash: multaValue, penalty_receivable: -multaValue });
          await createCashMovement({
            type: "recebimento_multa", amount: multaValue,
            client_id: inst.loans.client_id, loan_id: inst.loan_id,
            observation: `Pagamento de multa - ${inst.loans.clients.name}`,
          });
          toast.success(`Multa: ${formatCurrency(multaValue)} registrado!`);
        }
      }

      // Handle regular payment (sequential)
      if (parcValue !== null || !payPenaltyAmount) {
        if (paidValue <= 0 && multaValue > 0) { fetchData(); return; }

        const { data: allUnpaid } = await supabase
          .from("installments").select("*")
          .eq("loan_id", inst.loan_id).neq("status", "paid").eq("is_penalty", false).order("number");

        let remaining = paidValue;
        const toProcess = (allUnpaid || []).filter((i: any) => i.number >= inst.number);
        for (const i of toProcess) {
          if (remaining <= 0) break;
          const iRemaining = Number(i.amount) - Number(i.paid_amount);
          const applying = Math.min(remaining, iRemaining);
          const newPaidAmount = Number(i.paid_amount) + applying;
          const fullyPaid = newPaidAmount >= Number(i.amount) - 0.01;
          await supabase.from("installments").update({
            paid_amount: newPaidAmount,
            status: fullyPaid ? "paid" : i.status,
            paid_at: fullyPaid ? new Date(payDate + "T12:00:00").toISOString() : i.paid_at,
          }).eq("id", i.id);
          remaining -= applying;
        }
        const totalApplied = paidValue - remaining;
        if (totalApplied > 0) {
          await updateCashBalance({ available_cash: totalApplied });
          // Split between interest and principal
          const loanInterest = Number(inst.loans.total_amount) - Number(inst.loans.amount);
          const { data: allLoanInsts } = await supabase
            .from("installments").select("paid_amount")
            .eq("loan_id", inst.loan_id).eq("is_penalty", false);
          const totalPaidNow = (allLoanInsts || []).reduce((s: number, i: any) => s + Number(i.paid_amount), 0);
          const totalPaidBefore = totalPaidNow - totalApplied;
          const interestRemaining = Math.max(0, loanInterest - totalPaidBefore);
          const toInterest = Math.min(totalApplied, interestRemaining);
          const toPrincipal = totalApplied - toInterest;
          if (toInterest > 0) await updateCashBalance({ interest_receivable: -toInterest });
          if (toPrincipal > 0) await updateCashBalance({ money_lent: -toPrincipal });
          await createCashMovement({
            type: "recebimento_normal", amount: totalApplied,
            client_id: inst.loans.client_id, loan_id: inst.loan_id, installment_id: inst.id,
            observation: `Parcela ${inst.number} - ${inst.loans.clients.name}`,
          });
        }
        if (remaining > 0) toast.info(`Sobra de ${formatCurrency(remaining)}`);
      }
    } catch {
      toast.error("Erro ao sincronizar, recarregando...");
    }
    fetchData();
  };

  const resetPayDialog = () => {
    setPayAmount(""); setPayPenaltyAmount(""); setPayDate(selectedDate); setPayDialogId(null);
  };

  // === Not Paid handler with optimistic UI ===
  const handleNotPaid = async (id: string) => {
    if (isClosed) { toast.error("Caixa fechado. Reabra para registrar."); return; }

    const inst = pendingInstallments.find(i => i.id === id);
    if (!inst) return;

    const optimisticMark: NotPaidMark & { installment?: InstallmentWithLoan } = {
      id: "temp-" + Date.now(),
      mark_date: selectedDate,
      installment_id: inst.id,
      loan_id: inst.loan_id,
      client_id: inst.loans.client_id,
      observation: notPaidObs || null,
      created_at: new Date().toISOString(),
      installment: inst,
    };
    setPendingInstallments(prev => prev.filter(i => i.id !== id));
    setNotPaidMarks(prev => [...prev, optimisticMark]);
    setSelectedForNotPaid(prev => { const n = new Set(prev); n.delete(id); return n; });
    setNotPaidObs("");
    setNotPaidDialogId(null);
    toast.info("Marcado como 'Não Pagou'");

    await supabase.from("not_paid_marks").insert({
      mark_date: selectedDate, installment_id: inst.id,
      loan_id: inst.loan_id, client_id: inst.loans.client_id,
      observation: notPaidObs || null,
    });
    fetchData();
  };

  // === Batch Not Paid handler ===
  const handleBatchNotPaid = async () => {
    if (isClosed) { toast.error("Caixa fechado. Reabra para registrar."); return; }

    const selectedInsts = pendingInstallments.filter(i => selectedForNotPaid.has(i.id));
    if (selectedInsts.length === 0) return;

    const optimisticMarks = selectedInsts.map(inst => ({
      id: "temp-" + Date.now() + "-" + inst.id,
      mark_date: selectedDate,
      installment_id: inst.id,
      loan_id: inst.loan_id,
      client_id: inst.loans.client_id,
      observation: batchNotPaidObs || null,
      created_at: new Date().toISOString(),
      installment: inst,
    }));

    setPendingInstallments(prev => prev.filter(i => !selectedForNotPaid.has(i.id)));
    setNotPaidMarks(prev => [...prev, ...optimisticMarks]);
    setSelectedForNotPaid(new Set());
    setBatchNotPaidDialogOpen(false);
    setBatchNotPaidObs("");
    toast.info(`${selectedInsts.length} parcela(s) marcada(s) como 'Não Pagou'`);

    const inserts = selectedInsts.map(inst => ({
      mark_date: selectedDate,
      installment_id: inst.id,
      loan_id: inst.loan_id,
      client_id: inst.loans.client_id,
      observation: batchNotPaidObs || null,
    }));
    await supabase.from("not_paid_marks").insert(inserts);
    fetchData();
  };

  const toggleSelectForNotPaid = (id: string) => {
    setSelectedForNotPaid(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const toggleSelectAll = () => {
    if (selectedForNotPaid.size === pendingInstallments.length) {
      setSelectedForNotPaid(new Set());
    } else {
      setSelectedForNotPaid(new Set(pendingInstallments.map(i => i.id)));
    }
  };

  // === Undo not paid with optimistic UI ===
  const handleUndoNotPaid = async (markId: string) => {
    if (isClosed) { toast.error("Caixa fechado. Reabra para desfazer."); return; }

    const mark = notPaidMarks.find(m => m.id === markId);
    setNotPaidMarks(prev => prev.filter(m => m.id !== markId));
    if (mark?.installment) {
      setPendingInstallments(prev => [...prev, mark.installment!]);
    }
    toast.success("Marcação desfeita!");
    await supabase.from("not_paid_marks").delete().eq("id", markId);
    fetchData();
  };

  // === Undo payment with optimistic UI ===
  const handleUndoPayment = async (id: string) => {
    if (isClosed) { toast.error("Caixa fechado. Reabra para desfazer."); return; }

    const inst = paidInstallments.find(i => i.id === id);
    setPaidInstallments(prev => prev.filter(i => i.id !== id));
    if (inst) {
      setPendingInstallments(prev => [...prev, { ...inst, status: "pending", paid_at: null, paid_amount: 0 }]);
    }
    toast.success("Pagamento desfeito!");

    // 1. Delete ALL cash_movements linked to this installment (normal + penalty)
    await supabase.from("cash_movements").delete().eq("installment_id", id);

    // 2. Revert installment payment
    await supabase.from("installments").update({ status: "pending", paid_at: null, paid_amount: 0 }).eq("id", id);

    // 3. If penalty was paid alongside, revert penalty installment too
    if (inst) {
      // Check if penalty payment was made for this loan at the same time
      const { data: penaltyMovs } = await supabase
        .from("cash_movements").select("id, amount")
        .eq("loan_id", inst.loan_id).eq("type", "recebimento_multa");
      // We don't delete penalty movements here since they're linked by loan_id not installment_id
      // But we DO need to check if any penalty movements became orphaned
    }

    // 4. Recalculate cash balance from ledger (source of truth)
    await recalculateCashBalanceFromLedger();
    fetchData();
  };

  // === Close daily cash ===
  const handleCloseCash = async () => {
    const totalReceived = paidInstallments.reduce((s, i) => s + Number(i.paid_amount), 0);

    const nextDay = format(addDays(new Date(selectedDate + "T12:00:00"), 1), "yyyy-MM-dd");
    const { data: penaltyMovements } = await supabase
      .from("cash_movements").select("amount").eq("type", "recebimento_multa")
      .gte("created_at", selectedDate + "T00:00:00")
      .lt("created_at", nextDay + "T00:00:00");

    const totalPenaltyReceived = (penaltyMovements || []).reduce((s: number, m: any) => s + Number(m.amount), 0);

    const { data: existing } = await supabase
      .from("daily_cash").select("id").eq("cash_date", selectedDate).maybeSingle();

    const payload = {
      cash_date: selectedDate, status: "closed", total_received: totalReceived,
      total_penalty_received: totalPenaltyReceived, total_not_paid_count: notPaidMarks.length,
      total_items_treated: paidInstallments.length + notPaidMarks.length, closed_at: new Date().toISOString(),
    };

    if (existing) {
      await supabase.from("daily_cash").update(payload).eq("id", existing.id);
    } else {
      await supabase.from("daily_cash").insert(payload);
    }

    toast.success("Caixa do dia fechado!");
    setDailyCashStatus("closed");
    setPendingInstallments([]);
  };

  // === Reopen daily cash ===
  const handleReopenCash = async () => {
    const { data: existing } = await supabase
      .from("daily_cash").select("id").eq("cash_date", selectedDate).maybeSingle();

    if (existing) {
      await supabase.from("daily_cash").update({ status: "open", closed_at: null }).eq("id", existing.id);
    }

    toast.success("Caixa reaberto!");
    setDailyCashStatus("open");
    fetchData();
  };

  // === Computed values ===
  const totalPendingValue = pendingInstallments.reduce((s, i) => s + (Number(i.amount) - Number(i.paid_amount)), 0);
  const totalPaidValue = paidInstallments.reduce((s, i) => s + Number(i.paid_amount), 0);

  const getOverdueDays = (inst: InstallmentWithLoan) => {
    const due = new Date(inst.due_date + "T12:00:00");
    const sel = new Date(selectedDate + "T12:00:00");
    if (sel <= due) return 0;
    if (inst.loans.payment_type === "daily") {
      return calculateOverdueDays(inst.due_date, "daily");
    }
    return differenceInCalendarDays(sel, due);
  };

  // === Render installment card ===
  const renderPendingCard = (inst: InstallmentWithLoan) => {
    const lp = loanProgressMap[inst.loan_id];
    const instRemaining = Number(inst.amount) - Number(inst.paid_amount);
    const overdueDays = getOverdueDays(inst);
    const isOverdue = overdueDays > 0;
    const penaltyPending = lp ? lp.penaltyTotal - lp.penaltyPaid : 0;

    return (
      <Card key={inst.id} className={`overflow-hidden ${isOverdue ? "border-destructive/50" : ""} ${selectedForNotPaid.has(inst.id) ? "ring-2 ring-destructive/50" : ""}`}>
        <CardContent className="p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-start gap-2 flex-1">
              <Checkbox
                checked={selectedForNotPaid.has(inst.id)}
                onCheckedChange={() => toggleSelectForNotPaid(inst.id)}
                className="mt-1"
              />
              <div className="flex-1">
              <p className="font-semibold">{inst.loans.clients.name}</p>
              <p className="text-sm text-muted-foreground">
                Parcela {inst.number}/{inst.loans.installment_count} • {formatCurrency(Number(inst.amount))}
              </p>
              {isOverdue && (
                <p className="text-xs text-destructive font-medium flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  Vencida {format(new Date(inst.due_date + "T12:00:00"), "dd/MM")} • {overdueDays} dias de atraso
                </p>
              )}
              {Number(inst.paid_amount) > 0 && (
                <p className="text-xs text-primary">Já pago: {formatCurrency(Number(inst.paid_amount))} • Resta: {formatCurrency(instRemaining)}</p>
              )}
              {lp && (
                <p className="text-xs text-muted-foreground">
                  {lp.progress % 1 === 0 ? lp.progress : lp.progress.toFixed(1)}/{lp.total} pagas • Resta: {formatCurrency(Math.max(0, lp.remaining))}
                </p>
              )}
              {penaltyPending > 0.01 && (
                <p className="text-xs text-destructive">Multa pendente: {formatCurrency(penaltyPending)}</p>
              )}
              </div>
            </div>
            <Badge className={isOverdue ? "bg-overdue text-overdue-foreground" : "bg-open text-open-foreground"}>
              {isOverdue ? "Atrasado" : "Em Dia"}
            </Badge>
          </div>
          <div className="flex gap-2">
            {/* Pay button */}
            <Dialog open={payDialogId === inst.id} onOpenChange={(o) => { setPayDialogId(o ? inst.id : null); if (!o) resetPayDialog(); }}>
              <DialogTrigger asChild>
                <Button size="sm" className="flex-1 bg-success hover:bg-success/90">
                  <Plus className="mr-1 h-4 w-4" /> Pagamento
                </Button>
              </DialogTrigger>
              <DialogContent onOpenAutoFocus={(e) => e.preventDefault()}>
                <DialogHeader><DialogTitle>Registrar Pagamento</DialogTitle></DialogHeader>
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    {inst.loans.clients.name} — Parcela {inst.number} — {formatCurrency(Number(inst.amount))}
                  </p>
                  {Number(inst.paid_amount) > 0 && (
                    <p className="text-sm text-primary">Já pago: {formatCurrency(Number(inst.paid_amount))} — Resta: {formatCurrency(instRemaining)}</p>
                  )}
                  <div>
                    <Label>Valor da parcela recebido</Label>
                    <Input type="number" placeholder={`Padrão: ${instRemaining.toFixed(2)}`} value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
                  </div>
                  {penaltyPending > 0.01 && (
                    <div className="rounded-lg border border-warning/50 p-3 space-y-2">
                      <p className="text-xs font-medium text-warning">Multa pendente: {formatCurrency(penaltyPending)}</p>
                      <Label>Valor destinado à multa (opcional)</Label>
                      <Input type="number" placeholder="0.00" value={payPenaltyAmount} onChange={(e) => setPayPenaltyAmount(e.target.value)} />
                    </div>
                  )}
                  <div>
                    <Label>Data do pagamento</Label>
                    <Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
                  </div>
                  <p className="text-xs text-muted-foreground">💡 Valor excedente abate parcelas seguintes.</p>
                  <Button onClick={() => handlePay(inst.id)} className="w-full bg-success hover:bg-success/90">
                    Confirmar Pagamento
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
            {/* Not paid button */}
            <Dialog open={notPaidDialogId === inst.id} onOpenChange={(o) => { setNotPaidDialogId(o ? inst.id : null); if (!o) setNotPaidObs(""); }}>
              <DialogTrigger asChild>
                <Button size="sm" variant="destructive" className="flex-1">
                  <XCircle className="mr-1 h-4 w-4" /> Não Pagou
                </Button>
              </DialogTrigger>
              <DialogContent onOpenAutoFocus={(e) => e.preventDefault()}>
                <DialogHeader><DialogTitle>Marcar Não Pagou</DialogTitle></DialogHeader>
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    {inst.loans.clients.name} — Parcela {inst.number} — {formatCurrency(Number(inst.amount))}
                  </p>
                  <div>
                    <Label>Observação (opcional)</Label>
                    <Textarea placeholder="Ex: Cliente não atendeu..." value={notPaidObs} onChange={(e) => setNotPaidObs(e.target.value)} />
                  </div>
                  <Button onClick={() => handleNotPaid(inst.id)} variant="destructive" className="w-full">
                    Confirmar Não Pagou
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </CardContent>
      </Card>
    );
  };

  const renderPaidCard = (inst: InstallmentWithLoan) => {
    const lp = loanProgressMap[inst.loan_id];
    const instRemaining = Number(inst.amount) - Number(inst.paid_amount);
    const isPartial = instRemaining > 0.01;
    return (
      <Card key={inst.id} className={`overflow-hidden ${isPartial ? "border-warning/30" : "border-success/30"}`}>
        <CardContent className="p-4">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <p className="font-semibold">{inst.loans.clients.name}</p>
              <p className="text-sm text-muted-foreground">
                Parcela {inst.number}/{inst.loans.installment_count} • {formatCurrency(Number(inst.amount))}
              </p>
              <p className={`text-sm font-medium ${isPartial ? "text-warning" : "text-success"}`}>
                Pago: {formatCurrency(Number(inst.paid_amount))}
              </p>
              {isPartial && (
                <p className="text-xs text-destructive font-medium">Resta: {formatCurrency(instRemaining)}</p>
              )}
              {lp && (
                <p className="text-xs text-muted-foreground">
                  {lp.progress % 1 === 0 ? lp.progress : lp.progress.toFixed(1)}/{lp.total} pagas • Resta: {formatCurrency(Math.max(0, lp.remaining))}
                </p>
              )}
            </div>
            <Badge className={isPartial ? "bg-warning text-warning-foreground" : "bg-paid text-paid-foreground"}>
              {isPartial ? "Parcial" : "Pago"}
            </Badge>
          </div>
          {!isClosed && (
            <Button size="sm" variant="outline" className="w-full" onClick={() => handleUndoPayment(inst.id)}>
              <Undo2 className="mr-1 h-3 w-3" /> Desfazer Pagamento
            </Button>
          )}
        </CardContent>
      </Card>
    );
  };

  const renderNotPaidCard = (mark: NotPaidMark & { installment?: InstallmentWithLoan }) => {
    const inst = mark.installment;
    return (
      <Card key={mark.id} className="overflow-hidden border-destructive/30">
        <CardContent className="p-4">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <p className="font-semibold">{inst?.loans.clients.name || "Cliente"}</p>
              <p className="text-sm text-muted-foreground">
                {inst ? `Parcela ${inst.number}/${inst.loans.installment_count} • ${formatCurrency(Number(inst.amount))}` : "—"}
              </p>
              {mark.observation && <p className="text-xs text-muted-foreground italic">"{mark.observation}"</p>}
            </div>
            <Badge className="bg-destructive text-destructive-foreground">Não Pagou</Badge>
          </div>
          {!isClosed && (
            <Button size="sm" variant="outline" className="w-full" onClick={() => handleUndoNotPaid(mark.id)}>
              <Undo2 className="mr-1 h-3 w-3" /> Desfazer
            </Button>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="mx-auto max-w-lg p-4">
      {/* Header with date navigation */}
      <div className="mb-4">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <DollarSign className="h-6 w-6 text-primary" /> Caixa do Dia
        </h1>
        <div className="mt-2 flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => changeDate(-1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="flex-1 text-center">
            <p className="text-sm font-medium">
              {format(new Date(selectedDate + "T12:00:00"), "EEEE, dd 'de' MMMM", { locale: ptBR })}
            </p>
            {selectedDate !== today && (
              <button className="text-xs text-primary underline" onClick={() => { setSelectedDate(today); setSearchParams({}); }}>
                Voltar para hoje
              </button>
            )}
          </div>
          <Button variant="outline" size="icon" onClick={() => changeDate(1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        {isClosed && (
          <div className="mt-2 rounded-lg bg-success/10 border border-success/30 p-2 text-center">
            <p className="text-sm font-medium text-success flex items-center justify-center gap-1">
              <Lock className="h-4 w-4" /> Caixa Fechado
            </p>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="mb-4 grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
        <button
          onClick={() => setActiveTab("pending")}
          className={`flex flex-col items-center rounded-md py-2 px-1 text-xs font-medium transition-colors ${
            activeTab === "pending" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <AlertTriangle className={`mb-0.5 h-4 w-4 ${activeTab === "pending" ? "text-warning" : ""}`} />
          <span>Pendentes</span>
          <span className="text-[10px] font-bold">{pendingInstallments.length}</span>
          {activeTab === "pending" && totalPendingValue > 0 && (
            <span className="text-[9px] text-muted-foreground">{formatCurrency(totalPendingValue)}</span>
          )}
        </button>
        <button
          onClick={() => setActiveTab("paid")}
          className={`flex flex-col items-center rounded-md py-2 px-1 text-xs font-medium transition-colors ${
            activeTab === "paid" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <CheckCircle className={`mb-0.5 h-4 w-4 ${activeTab === "paid" ? "text-success" : ""}`} />
          <span>Pagos</span>
          <span className="text-[10px] font-bold text-success">{paidInstallments.length}</span>
          {activeTab === "paid" && totalPaidValue > 0 && (
            <span className="text-[9px] text-success">{formatCurrency(totalPaidValue)}</span>
          )}
        </button>
        <button
          onClick={() => setActiveTab("notpaid")}
          className={`flex flex-col items-center rounded-md py-2 px-1 text-xs font-medium transition-colors ${
            activeTab === "notpaid" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <XCircle className={`mb-0.5 h-4 w-4 ${activeTab === "notpaid" ? "text-destructive" : ""}`} />
          <span>Não Pagos</span>
          <span className="text-[10px] font-bold text-destructive">{notPaidMarks.length}</span>
        </button>
      </div>

      {loading ? (
        <p className="text-center text-muted-foreground">Carregando...</p>
      ) : (
        <>
          {/* Tab content */}
          {activeTab === "pending" && (
            <div className="space-y-3">
              {isClosed ? (
                <Card>
                  <CardContent className="flex flex-col items-center p-6">
                    <Lock className="mb-2 h-10 w-10 text-muted-foreground" />
                    <p className="text-sm font-medium text-muted-foreground">Caixa fechado — sem pendentes</p>
                  </CardContent>
                </Card>
              ) : pendingInstallments.length === 0 ? (
                <Card>
                  <CardContent className="flex flex-col items-center p-6">
                    <CheckCircle className="mb-2 h-10 w-10 text-success" />
                    <p className="text-sm font-medium">Tudo tratado!</p>
                  </CardContent>
                </Card>
              ) : (
                <>
                  {/* Select all + batch action bar */}
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <Checkbox
                        checked={selectedForNotPaid.size === pendingInstallments.length && pendingInstallments.length > 0}
                        onCheckedChange={toggleSelectAll}
                      />
                      Selecionar todos
                    </label>
                    {selectedForNotPaid.size > 0 && (
                      <Dialog open={batchNotPaidDialogOpen} onOpenChange={setBatchNotPaidDialogOpen}>
                        <DialogTrigger asChild>
                          <Button size="sm" variant="destructive">
                            <XCircle className="mr-1 h-4 w-4" /> Não Pagou ({selectedForNotPaid.size})
                          </Button>
                        </DialogTrigger>
                        <DialogContent onOpenAutoFocus={(e) => e.preventDefault()}>
                          <DialogHeader><DialogTitle>Marcar {selectedForNotPaid.size} como Não Pagou</DialogTitle></DialogHeader>
                          <div className="space-y-3">
                            <p className="text-sm text-muted-foreground">
                              {selectedForNotPaid.size} parcela(s) selecionada(s) serão marcadas como "Não Pagou".
                            </p>
                            <div>
                              <Label>Observação (opcional)</Label>
                              <Textarea placeholder="Ex: Dia de chuva..." value={batchNotPaidObs} onChange={(e) => setBatchNotPaidObs(e.target.value)} />
                            </div>
                            <Button onClick={handleBatchNotPaid} variant="destructive" className="w-full">
                              Confirmar Não Pagou ({selectedForNotPaid.size})
                            </Button>
                          </div>
                        </DialogContent>
                      </Dialog>
                    )}
                  </div>
                  {pendingInstallments.map(renderPendingCard)}
                </>
              )}
            </div>
          )}

          {activeTab === "paid" && (
            <div className="space-y-3">
              {paidInstallments.length === 0 ? (
                <Card>
                  <CardContent className="flex flex-col items-center p-6">
                    <DollarSign className="mb-2 h-10 w-10 text-muted-foreground" />
                    <p className="text-sm font-medium text-muted-foreground">Nenhum pagamento registrado</p>
                  </CardContent>
                </Card>
              ) : (
                paidInstallments.map(renderPaidCard)
              )}
            </div>
          )}

          {activeTab === "notpaid" && (
            <div className="space-y-3">
              {notPaidMarks.length === 0 ? (
                <Card>
                  <CardContent className="flex flex-col items-center p-6">
                    <CheckCircle className="mb-2 h-10 w-10 text-muted-foreground" />
                    <p className="text-sm font-medium text-muted-foreground">Nenhuma marcação</p>
                  </CardContent>
                </Card>
              ) : (
                notPaidMarks.map(renderNotPaidCard)
              )}
            </div>
          )}

          {/* Close / Reopen cash button */}
          {isClosed ? (
            <Button
              onClick={handleReopenCash}
              className="w-full mt-4"
              variant="outline"
            >
              <LockOpen className="mr-2 h-4 w-4" /> Reabrir Caixa
            </Button>
          ) : (
            <Button
              onClick={handleCloseCash}
              className="w-full mt-4"
              variant="default"
            >
              <Lock className="mr-2 h-4 w-4" /> Fechar Caixa do Dia
            </Button>
          )}
        </>
      )}

      {/* FAB - Novo Empréstimo */}
      <button
        onClick={() => navigate("/new-loan")}
        className="fixed bottom-24 right-4 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 transition-colors"
        aria-label="Novo Empréstimo"
      >
        <Plus className="h-7 w-7" />
      </button>
    </div>
  );
}
