import { useEffect, useState, useCallback, useMemo, useRef } from "react";
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatCurrency, calculateOverdueDays } from "@/lib/loan-utils";
import { updateCashBalance, createCashMovement, recalculateCashBalanceFromLedger } from "@/lib/cash-utils";
import { Checkbox } from "@/components/ui/checkbox";
import {
  CalendarDays, CheckCircle, XCircle, DollarSign, AlertTriangle,
  Plus, ChevronLeft, ChevronRight, Clock, Lock, LockOpen, MoreVertical, Eye, History, Filter, ChevronDown
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
type PendingFilter = "all" | "overdue" | "today";

export default function DailyCashPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const dateParam = searchParams.get("date");
  const [selectedDate, setSelectedDate] = useState(dateParam || format(new Date(), "yyyy-MM-dd"));
  const today = format(new Date(), "yyyy-MM-dd");

  const [activeTab, setActiveTab] = useState<ActiveTab>("pending");
  const [pendingFilter, setPendingFilter] = useState<PendingFilter>("all");

  const [pendingInstallments, setPendingInstallments] = useState<InstallmentWithLoan[]>([]);
  const [paidInstallments, setPaidInstallments] = useState<InstallmentWithLoan[]>([]);
  const [notPaidMarks, setNotPaidMarks] = useState<(NotPaidMark & { installment?: InstallmentWithLoan })[]>([]);
  const [loanProgressMap, setLoanProgressMap] = useState<Record<string, LoanProgress>>({});
  const [loading, setLoading] = useState(true);
  const [dailyCashStatus, setDailyCashStatus] = useState<string>("open");

  const [payDialogId, setPayDialogId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payPenaltyAmount, setPayPenaltyAmount] = useState("");
  const [payDate, setPayDate] = useState(selectedDate);
  const [notPaidDialogId, setNotPaidDialogId] = useState<string | null>(null);
  const [notPaidObs, setNotPaidObs] = useState("");
  const [showNotPaidObs, setShowNotPaidObs] = useState(false);
  const [selectedForNotPaid, setSelectedForNotPaid] = useState<Set<string>>(new Set());
  const [batchNotPaidDialogOpen, setBatchNotPaidDialogOpen] = useState(false);
  const [batchNotPaidObs, setBatchNotPaidObs] = useState("");
  const [showBatchNotPaidObs, setShowBatchNotPaidObs] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [quitarDialogId, setQuitarDialogId] = useState<string | null>(null);
  const [quitarDate, setQuitarDate] = useState(selectedDate);
  const localActionedLoanIds = useRef<Set<string>>(new Set());

  useEffect(() => { setPayDate(selectedDate); setQuitarDate(selectedDate); localActionedLoanIds.current = new Set(); }, [selectedDate]);

  const changeDate = (offset: number) => {
    const d = new Date(selectedDate + "T12:00:00");
    const newDate = format(addDays(d, offset), "yyyy-MM-dd");
    setSelectedDate(newDate);
    setSearchParams({ date: newDate });
  };

  const isClosed = dailyCashStatus === "closed";

  const getOverdueDays = useCallback((inst: InstallmentWithLoan) => {
    const due = new Date(inst.due_date + "T12:00:00");
    const sel = new Date(selectedDate + "T12:00:00");
    if (sel <= due) return 0;
    if (inst.loans.payment_type === "daily") {
      return calculateOverdueDays(inst.due_date, "daily");
    }
    return differenceInCalendarDays(sel, due);
  }, [selectedDate]);

  // Split pending into overdue vs today
  const { overdueItems, todayItems } = useMemo(() => {
    const overdue: InstallmentWithLoan[] = [];
    const todayList: InstallmentWithLoan[] = [];
    for (const inst of pendingInstallments) {
      if (getOverdueDays(inst) > 0) overdue.push(inst);
      else todayList.push(inst);
    }
    return { overdueItems: overdue, todayItems: todayList };
  }, [pendingInstallments, getOverdueDays]);

  const filteredPending = useMemo(() => {
    if (pendingFilter === "overdue") return overdueItems;
    if (pendingFilter === "today") return todayItems;
    return pendingInstallments;
  }, [pendingFilter, overdueItems, todayItems, pendingInstallments]);

  const fetchData = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setLoading(true);
    if (silent) setIsRefreshing(true);

    try {
      const { data: dcData } = await supabase
        .from("daily_cash").select("*").eq("cash_date", selectedDate).maybeSingle();

      const status = dcData?.status || "open";
      setDailyCashStatus(status);

      const nextDay = format(addDays(new Date(selectedDate + "T12:00:00"), 1), "yyyy-MM-dd");

      const [
        { data: paidData },
        { data: paymentMovementData },
        { data: npData },
      ] = await Promise.all([
        supabase.from("installments")
          .select("*, loans(id, client_id, amount, total_amount, installment_count, payment_type, clients(id, name))")
          .eq("is_penalty", false)
          .gte("paid_at", selectedDate + "T00:00:00")
          .lt("paid_at", nextDay + "T00:00:00")
          .order("number"),
        supabase.from("cash_movements")
          .select("installment_id, created_at")
          .eq("type", "recebimento_normal")
          .gte("created_at", selectedDate + "T00:00:00")
          .lt("created_at", nextDay + "T00:00:00")
          .not("installment_id", "is", null),
        supabase.from("not_paid_marks").select("*").eq("mark_date", selectedDate),
      ]);

      const paidInstMap = new Map<string, InstallmentWithLoan>(
        (((paidData as unknown as InstallmentWithLoan[]) || []).map((inst) => [inst.id, inst]))
      );

      const paymentTimesByInstallment = new Map<string, string>();
      for (const movement of paymentMovementData || []) {
        if (!movement.installment_id) continue;
        const prev = paymentTimesByInstallment.get(movement.installment_id);
        if (!prev || new Date(movement.created_at).getTime() > new Date(prev).getTime()) {
          paymentTimesByInstallment.set(movement.installment_id, movement.created_at);
        }
      }

      const missingPaidIds = [...paymentTimesByInstallment.keys()].filter((id) => !paidInstMap.has(id));
      if (missingPaidIds.length > 0) {
        const { data: paidFromMovements } = await supabase
          .from("installments")
          .select("*, loans(id, client_id, amount, total_amount, installment_count, payment_type, clients(id, name))")
          .in("id", missingPaidIds)
          .eq("is_penalty", false);

        for (const inst of ((paidFromMovements as unknown as InstallmentWithLoan[]) || [])) {
          if (Number(inst.paid_amount) <= 0) continue;
          paidInstMap.set(inst.id, {
            ...inst,
            paid_at: inst.paid_at || paymentTimesByInstallment.get(inst.id) || null,
          });
        }
      }

      const paidInsts = Array.from(paidInstMap.values()).sort((a, b) => a.number - b.number);
      setPaidInstallments(paidInsts);

      const npMarks = (npData || []) as unknown as NotPaidMark[];

      let npInstMap: Record<string, InstallmentWithLoan> = {};
      const npInstIds = npMarks.map(m => m.installment_id);
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

      if (status === "closed") {
        setPendingInstallments([]);
        setSelectedForNotPaid(new Set());
        await computeProgress(paidInsts, enrichedNpMarks, []);
        return;
      }

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

      const actionedLoanIds = new Set([
        ...paidInsts.map(i => i.loan_id),
        ...npMarks.map(m => m.loan_id),
        ...localActionedLoanIds.current,
      ]);

      const allCandidates = [...validOverdue, ...dueToday].filter(
        i => !paidInstIds.has(i.id) && !npMarkInstIds.has(i.id)
          && !actionedLoanIds.has(i.loan_id)
          && Number(i.amount) - Number(i.paid_amount) > 0.01
      );

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
    } finally {
      if (!silent) setLoading(false);
      if (silent) setIsRefreshing(false);
    }
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

  const refreshDataInBackground = useCallback(() => {
    void fetchData({ silent: true });
  }, [fetchData]);

  // === Payment handler with optimistic UI ===
  const handlePay = async (id: string) => {
    if (isSubmitting) return;
    if (isClosed) { toast.error("Caixa fechado. Reabra para registrar."); return; }
    setIsSubmitting(true);

    const allInsts = [...pendingInstallments, ...paidInstallments];
    const inst = allInsts.find(i => i.id === id);
    if (!inst) { setIsSubmitting(false); return; }

    const parcValue = payAmount ? parseFloat(payAmount) : null;
    const multaValue = payPenaltyAmount ? parseFloat(payPenaltyAmount) : 0;
    if (payAmount && (isNaN(parcValue!) || parcValue! <= 0)) { toast.error("Valor inválido"); setIsSubmitting(false); return; }
    if (payPenaltyAmount && (isNaN(multaValue) || multaValue < 0)) { toast.error("Valor de multa inválido"); setIsSubmitting(false); return; }

    const instRemaining = Number(inst.amount) - Number(inst.paid_amount);
    const paidValue = parcValue ?? instRemaining;

    const optimisticPaid: InstallmentWithLoan = {
      ...inst,
      paid_amount: Number(inst.paid_amount) + paidValue,
      status: paidValue >= instRemaining - 0.01 ? "paid" : "partial",
      paid_at: new Date(payDate + "T12:00:00").toISOString(),
    };
    localActionedLoanIds.current.add(inst.loan_id);
    setPendingInstallments(prev => prev.filter(i => i.id !== id && i.loan_id !== inst.loan_id));
    setPaidInstallments(prev => [...prev, optimisticPaid]);
    resetPayDialog();
    toast.success(`Parcela: ${formatCurrency(paidValue)} registrado!`);

    try {
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

      if (parcValue !== null || !payPenaltyAmount) {
        if (paidValue <= 0 && multaValue > 0) return;

        const { data: allUnpaid } = await supabase
          .from("installments").select("*")
          .eq("loan_id", inst.loan_id).neq("status", "paid").eq("is_penalty", false).order("number");

        let remaining = paidValue;
        const toProcess = (allUnpaid || []).filter((i: any) => i.number >= inst.number);
        let isFirst = true;
        for (const i of toProcess) {
          if (remaining <= 0) break;
          const iRemaining = Number(i.amount) - Number(i.paid_amount);
          const applying = Math.min(remaining, iRemaining);
          const newPaidAmount = Number(i.paid_amount) + applying;
          const fullyPaid = newPaidAmount >= Number(i.amount) - 0.01;
          // Always set paid_at on the clicked installment (even partial), so it moves to "Pagos"
          const shouldSetPaidAt = fullyPaid || isFirst;
          await supabase.from("installments").update({
            paid_amount: newPaidAmount,
            status: fullyPaid ? "paid" : (isFirst ? "partial" : i.status),
            paid_at: shouldSetPaidAt ? new Date(payDate + "T12:00:00").toISOString() : i.paid_at,
          }).eq("id", i.id);
          remaining -= applying;
          isFirst = false;
        }
        const totalApplied = paidValue - remaining;
        if (totalApplied > 0) {
          const loanInterest = Number(inst.loans.total_amount) - Number(inst.loans.amount);
          const { data: allLoanInsts } = await supabase
            .from("installments").select("paid_amount")
            .eq("loan_id", inst.loan_id).eq("is_penalty", false);
          const totalPaidNow = (allLoanInsts || []).reduce((s: number, i: any) => s + Number(i.paid_amount), 0);
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
            type: "recebimento_normal", amount: totalApplied,
            client_id: inst.loans.client_id, loan_id: inst.loan_id, installment_id: inst.id,
            observation: `Parcela ${inst.number} - ${inst.loans.clients.name}`,
          });
        }
        if (remaining > 0) toast.info(`Sobra de ${formatCurrency(remaining)}`);
      }
    } catch {
      toast.error("Erro ao sincronizar, recarregando...");
    } finally {
      setIsSubmitting(false);
      refreshDataInBackground();
    }
  };

  const resetPayDialog = () => {
    setPayAmount(""); setPayPenaltyAmount(""); setPayDate(selectedDate); setPayDialogId(null);
  };

  const handleNotPaid = async (id: string) => {
    if (isSubmitting) return;
    if (isClosed) { toast.error("Caixa fechado. Reabra para registrar."); return; }
    setIsSubmitting(true);

    const inst = pendingInstallments.find(i => i.id === id);
    if (!inst) { setIsSubmitting(false); return; }

    const obs = notPaidObs;
    const optimisticMark: NotPaidMark & { installment?: InstallmentWithLoan } = {
      id: "temp-" + Date.now(),
      mark_date: selectedDate,
      installment_id: inst.id,
      loan_id: inst.loan_id,
      client_id: inst.loans.client_id,
      observation: obs || null,
      created_at: new Date().toISOString(),
      installment: inst,
    };
    localActionedLoanIds.current.add(inst.loan_id);
    setPendingInstallments(prev => prev.filter(i => i.id !== id && i.loan_id !== inst.loan_id));
    setNotPaidMarks(prev => [...prev, optimisticMark]);
    setSelectedForNotPaid(prev => { const n = new Set(prev); n.delete(id); return n; });
    setNotPaidObs("");
    setShowNotPaidObs(false);
    setNotPaidDialogId(null);
    toast.info("Marcado como 'Não Pagou'");

    try {
      await supabase.from("not_paid_marks").insert({
        mark_date: selectedDate, installment_id: inst.id,
        loan_id: inst.loan_id, client_id: inst.loans.client_id,
        observation: obs || null,
      });
    } finally {
      setIsSubmitting(false);
      refreshDataInBackground();
    }
  };

  const handleBatchNotPaid = async () => {
    if (isSubmitting) return;
    if (isClosed) { toast.error("Caixa fechado. Reabra para registrar."); return; }
    setIsSubmitting(true);

    const selectedInsts = pendingInstallments.filter(i => selectedForNotPaid.has(i.id));
    if (selectedInsts.length === 0) { setIsSubmitting(false); return; }

    const obs = batchNotPaidObs;
    const optimisticMarks = selectedInsts.map(inst => ({
      id: "temp-" + Date.now() + "-" + inst.id,
      mark_date: selectedDate,
      installment_id: inst.id,
      loan_id: inst.loan_id,
      client_id: inst.loans.client_id,
      observation: obs || null,
      created_at: new Date().toISOString(),
      installment: inst,
    }));

    const batchLoanIds = new Set(selectedInsts.map(i => i.loan_id));
    batchLoanIds.forEach(lid => localActionedLoanIds.current.add(lid));
    setPendingInstallments(prev => prev.filter(i => !selectedForNotPaid.has(i.id) && !batchLoanIds.has(i.loan_id)));
    setNotPaidMarks(prev => [...prev, ...optimisticMarks]);
    setSelectedForNotPaid(new Set());
    setBatchNotPaidDialogOpen(false);
    setBatchNotPaidObs("");
    setShowBatchNotPaidObs(false);
    toast.info(`${selectedInsts.length} parcela(s) marcada(s) como 'Não Pagou'`);

    const inserts = selectedInsts.map(inst => ({
      mark_date: selectedDate,
      installment_id: inst.id,
      loan_id: inst.loan_id,
      client_id: inst.loans.client_id,
      observation: obs || null,
    }));
    try {
      await supabase.from("not_paid_marks").insert(inserts);
    } finally {
      setIsSubmitting(false);
      refreshDataInBackground();
    }
  };

  const toggleSelectForNotPaid = (id: string) => {
    setSelectedForNotPaid(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const toggleSelectAll = () => {
    const currentFiltered = filteredPending;
    const allSelected = currentFiltered.every(i => selectedForNotPaid.has(i.id));
    if (allSelected) {
      setSelectedForNotPaid(prev => {
        const n = new Set(prev);
        currentFiltered.forEach(i => n.delete(i.id));
        return n;
      });
    } else {
      setSelectedForNotPaid(prev => {
        const n = new Set(prev);
        currentFiltered.forEach(i => n.add(i.id));
        return n;
      });
    }
  };

  const selectAllOverdue = () => {
    setSelectedForNotPaid(prev => {
      const n = new Set(prev);
      overdueItems.forEach(i => n.add(i.id));
      return n;
    });
  };

  const selectAllToday = () => {
    setSelectedForNotPaid(prev => {
      const n = new Set(prev);
      todayItems.forEach(i => n.add(i.id));
      return n;
    });
  };

  const handleUndoNotPaid = async (markId: string) => {
    if (isSubmitting) return;
    if (isClosed) { toast.error("Caixa fechado. Reabra para desfazer."); return; }
    setIsSubmitting(true);

    const mark = notPaidMarks.find(m => m.id === markId);
    setNotPaidMarks(prev => prev.filter(m => m.id !== markId));
    if (mark?.installment) {
      setPendingInstallments(prev => [...prev, mark.installment!]);
    }
    toast.success("Marcação desfeita!");
    try {
      await supabase.from("not_paid_marks").delete().eq("id", markId);
    } finally {
      setIsSubmitting(false);
      refreshDataInBackground();
    }
  };

  const handleUndoPayment = async (id: string) => {
    if (isSubmitting) return;
    if (isClosed) { toast.error("Caixa fechado. Reabra para desfazer."); return; }
    setIsSubmitting(true);

    const inst = paidInstallments.find(i => i.id === id);
    setPaidInstallments(prev => prev.filter(i => i.id !== id));
    if (inst) {
      setPendingInstallments(prev => [...prev, { ...inst, status: "pending", paid_at: null, paid_amount: 0 }]);
    }
    toast.success("Pagamento desfeito!");

    try {
      await supabase.from("cash_movements").delete().eq("installment_id", id);
      await supabase.from("installments").update({ status: "pending", paid_at: null, paid_amount: 0 }).eq("id", id);

      if (inst) {
        await supabase
          .from("cash_movements").select("id, amount")
          .eq("loan_id", inst.loan_id).eq("type", "recebimento_multa");
      }

      await recalculateCashBalanceFromLedger();
    } finally {
      setIsSubmitting(false);
      refreshDataInBackground();
    }
  };

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

  const handleReopenCash = async () => {
    const { data: existing } = await supabase
      .from("daily_cash").select("id").eq("cash_date", selectedDate).maybeSingle();

    if (existing) {
      await supabase.from("daily_cash").update({ status: "open", closed_at: null }).eq("id", existing.id);
    }

    toast.success("Caixa reaberto!");
    setDailyCashStatus("open");
    refreshDataInBackground();
  };

  const handleQuitarEmprestimo = async (instId: string) => {
    if (isSubmitting) return;
    if (isClosed) { toast.error("Caixa fechado. Reabra para registrar."); return; }
    setIsSubmitting(true);

    const inst = pendingInstallments.find(i => i.id === instId);
    if (!inst) { setIsSubmitting(false); return; }

    // Optimistic: remove from pending, add to paid
    localActionedLoanIds.current.add(inst.loan_id);
    setPendingInstallments(prev => prev.filter(i => i.loan_id !== inst.loan_id));
    setPaidInstallments(prev => [...prev, { ...inst, status: "paid", paid_amount: Number(inst.amount), paid_at: new Date(quitarDate + "T12:00:00").toISOString() }]);
    setQuitarDialogId(null);
    toast.success("Empréstimo quitado!");

    try {
      // Fetch ALL unpaid installments for this loan (regular + penalty)
      const { data: allUnpaid } = await supabase
        .from("installments").select("*")
        .eq("loan_id", inst.loan_id).neq("status", "paid").order("number");

      if (!allUnpaid || allUnpaid.length === 0) { setIsSubmitting(false); refreshDataInBackground(); return; }

      const regularUnpaid = allUnpaid.filter((i: any) => !i.is_penalty);
      const penaltyUnpaid = allUnpaid.filter((i: any) => i.is_penalty);

      let totalRegularPaying = 0;
      let totalPenaltyPaying = 0;

      // Pay all regular installments
      for (const i of regularUnpaid) {
        const remaining = Number(i.amount) - Number(i.paid_amount);
        if (remaining <= 0.01) continue;
        totalRegularPaying += remaining;
        await supabase.from("installments").update({
          paid_amount: Number(i.amount),
          status: "paid",
          paid_at: new Date(quitarDate + "T12:00:00").toISOString(),
        }).eq("id", i.id);
      }

      // Pay all penalty installments
      for (const i of penaltyUnpaid) {
        const remaining = Number(i.amount) - Number(i.paid_amount);
        if (remaining <= 0.01) continue;
        totalPenaltyPaying += remaining;
        await supabase.from("installments").update({
          paid_amount: Number(i.amount),
          status: "paid",
          paid_at: new Date(quitarDate + "T12:00:00").toISOString(),
        }).eq("id", i.id);
      }

      // Update loan status
      await supabase.from("loans").update({ status: "paid" }).eq("id", inst.loan_id);

      // Update cash balance - regular payments
      if (totalRegularPaying > 0) {
        const loanInterest = Number(inst.loans.total_amount) - Number(inst.loans.amount);
        const { data: allLoanInsts } = await supabase
          .from("installments").select("paid_amount")
          .eq("loan_id", inst.loan_id).eq("is_penalty", false);
        const totalPaidNow = (allLoanInsts || []).reduce((s: number, i: any) => s + Number(i.paid_amount), 0);
        const totalPaidBefore = totalPaidNow - totalRegularPaying;
        const interestRemaining = Math.max(0, loanInterest - totalPaidBefore);
        const toInterest = Math.min(totalRegularPaying, interestRemaining);
        const toPrincipal = totalRegularPaying - toInterest;

        await updateCashBalance({
          available_cash: totalRegularPaying,
          interest_receivable: -toInterest,
          money_lent: -toPrincipal,
        });
        await createCashMovement({
          type: "recebimento_normal", amount: totalRegularPaying,
          client_id: inst.loans.client_id, loan_id: inst.loan_id, installment_id: inst.id,
          observation: `Quitação empréstimo - ${inst.loans.clients.name}`,
        });
      }

      // Update cash balance - penalty payments
      if (totalPenaltyPaying > 0) {
        await updateCashBalance({ available_cash: totalPenaltyPaying, penalty_receivable: -totalPenaltyPaying });
        await createCashMovement({
          type: "recebimento_multa", amount: totalPenaltyPaying,
          client_id: inst.loans.client_id, loan_id: inst.loan_id,
          observation: `Quitação multa - ${inst.loans.clients.name}`,
        });
      }
    } catch {
      toast.error("Erro ao quitar, recarregando...");
    } finally {
      setIsSubmitting(false);
      refreshDataInBackground();
    }
  };

  const totalPendingValue = pendingInstallments.reduce((s, i) => s + (Number(i.amount) - Number(i.paid_amount)), 0);
  const totalPaidValue = paidInstallments.reduce((s, i) => s + Number(i.paid_amount), 0);

  // === Compact pending row ===
  const renderPendingRow = (inst: InstallmentWithLoan) => {
    const lp = loanProgressMap[inst.loan_id];
    const instRemaining = Number(inst.amount) - Number(inst.paid_amount);
    const overdueDays = getOverdueDays(inst);
    const isOverdue = overdueDays > 0;
    const penaltyPending = lp ? lp.penaltyTotal - lp.penaltyPaid : 0;
    const paidCount = lp ? Math.floor(lp.progress) : 0;
    const totalCount = lp ? lp.total : inst.loans.installment_count;
    const isSelected = selectedForNotPaid.has(inst.id);
    const progressPct = totalCount > 0 ? (paidCount / totalCount) * 100 : 0;

    return (
      <div
        key={inst.id}
        className={`rounded-lg border bg-card overflow-hidden transition-all ${isOverdue ? "border-destructive/30" : "border-border"} ${isSelected ? "ring-2 ring-primary/40 bg-accent/30" : ""}`}
      >
        {/* Top row: checkbox + info + menu */}
        <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => toggleSelectForNotPaid(inst.id)}
            className="shrink-0 h-4 w-4"
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-[13px] truncate">{inst.loans.clients.name}</span>
              <span className="font-bold text-[15px] shrink-0 tabular-nums">{formatCurrency(instRemaining)}</span>
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-[11px] text-muted-foreground tabular-nums">
                Parcela {inst.number}/{totalCount} • {format(new Date(inst.due_date + "T12:00:00"), "dd/MM")}
              </span>
              <Badge
                variant="outline"
                className={`text-[9px] px-1.5 py-0 h-4 leading-none font-medium ${isOverdue ? "border-destructive/50 text-destructive bg-destructive/5" : "border-primary/40 text-primary bg-primary/5"}`}
              >
                {isOverdue ? `⚠ ${overdueDays}d atraso` : "Hoje"}
              </Badge>
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="p-1.5 -mr-1 rounded-md hover:bg-muted shrink-0">
                <MoreVertical className="h-4 w-4 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setQuitarDialogId(inst.id)}>
                <DollarSign className="mr-2 h-4 w-4" /> Quitar Empréstimo
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate(`/loans/${inst.loan_id}`)}>
                <Eye className="mr-2 h-4 w-4" /> Ver detalhes
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate(`/clients/${inst.loans.client_id}`)}>
                <History className="mr-2 h-4 w-4" /> Histórico do cliente
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Progress bar */}
        <div className="px-3 pb-1.5">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1.5 rounded-full bg-secondary overflow-hidden">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progressPct}%` }} />
            </div>
            <span className="text-[10px] font-semibold text-primary tabular-nums shrink-0">
              {paidCount}/{totalCount}
            </span>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex border-t border-border">
            <Dialog open={payDialogId === inst.id} onOpenChange={(o) => { setPayDialogId(o ? inst.id : null); if (!o) resetPayDialog(); }}>
              <DialogTrigger asChild>
                <button type="button" className="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-semibold text-success hover:bg-success/5 transition-colors border-r border-border">
                <CheckCircle className="h-3.5 w-3.5" /> PAGOU
              </button>
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
                <Button onClick={() => handlePay(inst.id)} className="w-full bg-success hover:bg-success/90" disabled={isSubmitting}>
                  {isSubmitting ? "Processando..." : "Confirmar Pagamento"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>

            <Dialog open={notPaidDialogId === inst.id} onOpenChange={(o) => { setNotPaidDialogId(o ? inst.id : null); if (!o) { setNotPaidObs(""); setShowNotPaidObs(false); } }}>
              <DialogTrigger asChild>
                <button type="button" className="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-semibold text-destructive hover:bg-destructive/5 transition-colors">
                <XCircle className="h-3.5 w-3.5" /> NÃO PAGOU
              </button>
            </DialogTrigger>
            <DialogContent onOpenAutoFocus={(e) => e.preventDefault()}>
              <DialogHeader><DialogTitle>Marcar Não Pagou</DialogTitle></DialogHeader>
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  {inst.loans.clients.name} — Parcela {inst.number} — {formatCurrency(Number(inst.amount))}
                </p>
                {showNotPaidObs ? (
                  <div>
                    <Label>Observação</Label>
                    <Textarea placeholder="Ex: Cliente não atendeu..." value={notPaidObs} onChange={(e) => setNotPaidObs(e.target.value)} />
                  </div>
                ) : (
                  <button type="button" className="text-sm text-primary hover:underline" onClick={() => setShowNotPaidObs(true)}>
                    + adicionar observação
                  </button>
                )}
                <Button onClick={() => handleNotPaid(inst.id)} variant="destructive" className="w-full" disabled={isSubmitting}>
                  {isSubmitting ? "Processando..." : "Confirmar Não Pagou"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {/* Quitar Dialog */}
        <Dialog open={quitarDialogId === inst.id} onOpenChange={(o) => { if (!o) { setQuitarDialogId(null); setQuitarDate(selectedDate); } }}>
          <DialogContent onOpenAutoFocus={(e) => e.preventDefault()}>
            <DialogHeader><DialogTitle>Quitar Empréstimo</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <p className="text-sm font-medium">{inst.loans.clients.name}</p>
              <div className="rounded-lg border p-3 space-y-1 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Parcelas restantes:</span><span className="font-semibold">{lp ? lp.total - Math.floor(lp.progress) : "..."}/{lp?.total ?? inst.loans.installment_count}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Valor restante parcelas:</span><span className="font-bold text-foreground">{formatCurrency(lp?.remaining ?? 0)}</span></div>
                {(lp && lp.penaltyTotal - lp.penaltyPaid > 0.01) && (
                  <div className="flex justify-between"><span className="text-muted-foreground">Multa pendente:</span><span className="font-bold text-warning">{formatCurrency(lp.penaltyTotal - lp.penaltyPaid)}</span></div>
                )}
                <div className="border-t pt-1 mt-1 flex justify-between"><span className="font-semibold">Total a quitar:</span><span className="font-bold text-primary">{formatCurrency((lp?.remaining ?? 0) + (lp ? Math.max(0, lp.penaltyTotal - lp.penaltyPaid) : 0))}</span></div>
              </div>
              <div>
                <Label>Data do pagamento</Label>
                <Input type="date" value={quitarDate} onChange={(e) => setQuitarDate(e.target.value)} />
              </div>
              <Button onClick={() => handleQuitarEmprestimo(inst.id)} className="w-full bg-success hover:bg-success/90" disabled={isSubmitting}>
                {isSubmitting ? "Processando..." : "Confirmar Quitação"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    );
  };

  // === Compact paid row ===
  const renderPaidRow = (inst: InstallmentWithLoan) => {
    const lp = loanProgressMap[inst.loan_id];
    const instRemaining = Number(inst.amount) - Number(inst.paid_amount);
    const isPartial = instRemaining > 0.01;
    const paidCount = lp ? Math.floor(lp.progress) : 0;
    const totalCount = lp ? lp.total : inst.loans.installment_count;

    return (
      <div key={inst.id} className={`flex items-center gap-2 rounded-lg border bg-card p-2.5 ${isPartial ? "border-warning/30" : "border-success/30"}`}>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-semibold text-sm truncate">{inst.loans.clients.name}</span>
            <span className={`font-bold text-sm shrink-0 ${isPartial ? "text-warning" : "text-success"}`}>
              {formatCurrency(Number(inst.paid_amount))}
            </span>
          </div>
          <div className="flex items-center gap-1 mt-0.5">
            <span className="text-[11px] text-muted-foreground">
              {inst.number}/{totalCount} • Pago {paidCount}/{totalCount}
            </span>
            {isPartial && <span className="text-[11px] text-destructive ml-1">Resta {formatCurrency(instRemaining)}</span>}
            <Badge className={`ml-auto text-[9px] px-1.5 py-0 h-3.5 ${isPartial ? "bg-warning text-warning-foreground" : "bg-paid text-paid-foreground"}`}>
              {isPartial ? "Parcial" : "Pago"}
            </Badge>
          </div>
          {inst.paid_at && (
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {format(new Date(inst.paid_at), "dd/MM HH:mm")}
            </p>
          )}
        </div>
        {!isClosed && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="p-1 rounded-md hover:bg-muted shrink-0">
                <MoreVertical className="h-4 w-4 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => handleUndoPayment(inst.id)} className="text-destructive">
                Desfazer Pagamento
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate(`/loans/${inst.loan_id}`)}>
                <Eye className="mr-2 h-4 w-4" /> Ver detalhes
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    );
  };

  // === Compact not-paid row ===
  const renderNotPaidRow = (mark: NotPaidMark & { installment?: InstallmentWithLoan }) => {
    const inst = mark.installment;
    const lp = inst ? loanProgressMap[inst.loan_id] : null;
    const paidCount = lp ? Math.floor(lp.progress) : 0;
    const totalCount = lp ? lp.total : (inst?.loans.installment_count || 0);

    return (
      <div key={mark.id} className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-card p-2.5">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-semibold text-sm truncate">{inst?.loans.clients.name || "Cliente"}</span>
            <span className="text-sm text-muted-foreground shrink-0">
              {inst ? formatCurrency(Number(inst.amount)) : "—"}
            </span>
          </div>
          <div className="flex items-center gap-1 mt-0.5">
            <span className="text-[11px] text-muted-foreground">
              {inst ? `${inst.number}/${totalCount} • Pago ${paidCount}/${totalCount}` : "—"}
            </span>
            <Badge className="ml-auto bg-destructive text-destructive-foreground text-[9px] px-1.5 py-0 h-3.5">Não Pagou</Badge>
          </div>
          {mark.observation && <p className="text-[10px] text-muted-foreground italic mt-0.5">"{mark.observation}"</p>}
          <p className="text-[10px] text-muted-foreground">{format(new Date(mark.created_at), "dd/MM HH:mm")}</p>
        </div>
        {!isClosed && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="p-1 rounded-md hover:bg-muted shrink-0">
                <MoreVertical className="h-4 w-4 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => handleUndoNotPaid(mark.id)} className="text-destructive">
                Desfazer
              </DropdownMenuItem>
              {inst && (
                <DropdownMenuItem onClick={() => navigate(`/loans/${inst.loan_id}`)}>
                  <Eye className="mr-2 h-4 w-4" /> Ver detalhes
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    );
  };

  // Render sections for pending
  const renderPendingSections = () => {
    if (pendingFilter === "all") {
      return (
        <>
          {todayItems.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-primary uppercase tracking-wider flex items-center gap-1">
                  <Clock className="h-3 w-3" /> Vencem Hoje ({todayItems.length})
                </h3>
                <button
                  className="text-[10px] text-primary hover:underline"
                  onClick={selectAllToday}
                >
                  Selecionar todos
                </button>
              </div>
              {todayItems.map(renderPendingRow)}
            </div>
          )}
          {overdueItems.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-destructive uppercase tracking-wider flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" /> Atrasados ({overdueItems.length})
                </h3>
                <button
                  className="text-[10px] text-primary hover:underline"
                  onClick={selectAllOverdue}
                >
                  Selecionar todos
                </button>
              </div>
              {overdueItems.map(renderPendingRow)}
            </div>
          )}
        </>
      );
    }
    return filteredPending.map(renderPendingRow);
  };

  return (
    <div className="mx-auto max-w-lg p-3 pb-36">
      {/* Header */}
      <div className="mb-3">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <DollarSign className="h-5 w-5 text-primary" /> Caixa do Dia
        </h1>
        <div className="mt-1.5 flex items-center gap-2">
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => changeDate(-1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="flex-1 text-center">
            <p className="text-xs font-medium">
              {format(new Date(selectedDate + "T12:00:00"), "EEE, dd 'de' MMMM", { locale: ptBR })}
            </p>
            {selectedDate !== today && (
              <button className="text-[10px] text-primary underline" onClick={() => { setSelectedDate(today); setSearchParams({}); }}>
                Voltar para hoje
              </button>
            )}
          </div>
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => changeDate(1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        {isClosed && (
          <div className="mt-1.5 rounded-md bg-success/10 border border-success/30 p-1.5 text-center">
            <p className="text-xs font-medium text-success flex items-center justify-center gap-1">
              <Lock className="h-3 w-3" /> Caixa Fechado
            </p>
          </div>
        )}
      </div>

      {/* Summary counters */}
      <div className="mb-3 grid grid-cols-3 gap-1.5">
        <button
          onClick={() => setActiveTab("pending")}
          className={`rounded-lg border p-2 text-center transition-colors ${activeTab === "pending" ? "border-primary/50 bg-accent/50" : "bg-card"}`}
        >
          <p className="text-[10px] text-muted-foreground">Pendentes</p>
          <p className="text-lg font-bold">{pendingInstallments.length}</p>
          {totalPendingValue > 0 && <p className="text-[10px] text-muted-foreground">{formatCurrency(totalPendingValue)}</p>}
        </button>
        <button
          onClick={() => setActiveTab("paid")}
          className={`rounded-lg border p-2 text-center transition-colors ${activeTab === "paid" ? "border-success/50 bg-success/5" : "bg-card"}`}
        >
          <p className="text-[10px] text-muted-foreground">Pagos</p>
          <p className="text-lg font-bold text-success">{paidInstallments.length}</p>
          {totalPaidValue > 0 && <p className="text-[10px] text-success">{formatCurrency(totalPaidValue)}</p>}
        </button>
        <button
          onClick={() => setActiveTab("notpaid")}
          className={`rounded-lg border p-2 text-center transition-colors ${activeTab === "notpaid" ? "border-destructive/50 bg-destructive/5" : "bg-card"}`}
        >
          <p className="text-[10px] text-muted-foreground">Não Pagos</p>
          <p className="text-lg font-bold text-destructive">{notPaidMarks.length}</p>
        </button>
      </div>

      {loading && pendingInstallments.length === 0 && paidInstallments.length === 0 && notPaidMarks.length === 0 ? (
        <p className="text-center text-sm text-muted-foreground py-8">Carregando...</p>
      ) : (
        <>
          {isRefreshing && (
            <div className="mb-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-center text-xs text-muted-foreground">
              Atualizando...
            </div>
          )}
          {activeTab !== "pending" && (
            <Button variant="ghost" size="sm" className="mb-2 h-7 text-xs" onClick={() => setActiveTab("pending")}>
              <ChevronLeft className="mr-1 h-3 w-3" /> Voltar para Pendentes
            </Button>
          )}

          {/* PENDING TAB */}
          {activeTab === "pending" && (
            <div className="space-y-2">
              {isClosed ? (
                <div className="flex flex-col items-center py-8">
                  <Lock className="mb-2 h-8 w-8 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Caixa fechado — sem pendentes</p>
                </div>
              ) : pendingInstallments.length === 0 ? (
                <div className="flex flex-col items-center py-8">
                  <CheckCircle className="mb-2 h-8 w-8 text-success" />
                  <p className="text-sm font-medium">Tudo tratado!</p>
                </div>
              ) : (
                <>
                  {/* Filter pills */}
                  <div className="flex items-center gap-1.5">
                    {(["all", "overdue", "today"] as PendingFilter[]).map(f => (
                      <button
                        key={f}
                        onClick={() => setPendingFilter(f)}
                        className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${pendingFilter === f ? "bg-primary text-primary-foreground border-primary" : "bg-card text-muted-foreground border-border hover:bg-accent"}`}
                      >
                        {f === "all" ? `Todos (${pendingInstallments.length})` : f === "overdue" ? `Atrasados (${overdueItems.length})` : `Hoje (${todayItems.length})`}
                      </button>
                    ))}
                  </div>

                  {/* Select all row */}
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
                      <Checkbox
                        checked={filteredPending.length > 0 && filteredPending.every(i => selectedForNotPaid.has(i.id))}
                        onCheckedChange={toggleSelectAll}
                        className="h-3.5 w-3.5"
                      />
                      Selecionar exibidos
                    </label>
                    {selectedForNotPaid.size > 0 && (
                      <button
                        className="text-[11px] text-muted-foreground hover:underline"
                        onClick={() => setSelectedForNotPaid(new Set())}
                      >
                        Limpar ({selectedForNotPaid.size})
                      </button>
                    )}
                  </div>

                  {/* Items */}
                  {renderPendingSections()}
                </>
              )}
            </div>
          )}

          {/* PAID TAB */}
          {activeTab === "paid" && (
            <div className="space-y-2">
              <h2 className="text-xs font-semibold text-success flex items-center gap-1 uppercase tracking-wider">
                <CheckCircle className="h-3 w-3" /> Pagos do Dia
              </h2>
              {paidInstallments.length === 0 ? (
                <div className="flex flex-col items-center py-8">
                  <DollarSign className="mb-2 h-8 w-8 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Nenhum pagamento registrado</p>
                </div>
              ) : (
                (() => {
                  // Group paid installments by client
                  const grouped = new Map<string, { clientName: string; clientId: string; installments: InstallmentWithLoan[]; totalPaid: number }>();
                  for (const inst of paidInstallments) {
                    const cid = inst.loans.client_id;
                    if (!grouped.has(cid)) {
                      grouped.set(cid, { clientName: inst.loans.clients.name, clientId: cid, installments: [], totalPaid: 0 });
                    }
                    const g = grouped.get(cid)!;
                    g.installments.push(inst);
                    g.totalPaid += Number(inst.paid_amount);
                  }
                  return Array.from(grouped.values()).map(group => {
                    const lp = loanProgressMap[group.installments[0].loan_id];
                    const paidCount = lp ? Math.floor(lp.progress) : 0;
                    const totalCount = lp ? lp.total : group.installments[0].loans.installment_count;
                    const progressPct = totalCount > 0 ? (paidCount / totalCount) * 100 : 0;

                    if (group.installments.length === 1) {
                      return renderPaidRow(group.installments[0]);
                    }

                    return (
                      <Collapsible key={group.clientId}>
                        <div className="rounded-lg border border-success/30 bg-card overflow-hidden">
                          <CollapsibleTrigger className="w-full">
                            <div className="flex items-center gap-2 p-2.5">
                              <div className="flex-1 min-w-0 text-left">
                                <div className="flex items-baseline justify-between gap-2">
                                  <span className="font-semibold text-sm truncate">{group.clientName}</span>
                                  <span className="font-bold text-sm shrink-0 text-success">
                                    {formatCurrency(group.totalPaid)}
                                  </span>
                                </div>
                                <div className="flex items-center gap-1 mt-0.5">
                                  <span className="text-[11px] text-muted-foreground">
                                    {group.installments.length} parcela{group.installments.length > 1 ? "s" : ""} pagas • Progresso {paidCount}/{totalCount}
                                  </span>
                                  <Badge className="ml-auto bg-paid text-paid-foreground text-[9px] px-1.5 py-0 h-3.5">
                                    Pago
                                  </Badge>
                                </div>
                                <div className="flex items-center gap-2 mt-1">
                                  <div className="flex-1 h-1.5 rounded-full bg-secondary overflow-hidden">
                                    <div className="h-full rounded-full bg-success transition-all" style={{ width: `${progressPct}%` }} />
                                  </div>
                                  <span className="text-[10px] font-semibold text-success tabular-nums shrink-0">
                                    {paidCount}/{totalCount}
                                  </span>
                                </div>
                              </div>
                              <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0 transition-transform duration-200 [[data-state=open]>&]:rotate-180" />
                            </div>
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            <div className="border-t border-border px-2.5 pb-2 pt-1 space-y-1.5">
                              {group.installments.map(inst => {
                                const instRemaining = Number(inst.amount) - Number(inst.paid_amount);
                                const isPartial = instRemaining > 0.01;
                                return (
                                  <div key={inst.id} className="flex items-center justify-between text-xs py-1">
                                    <div>
                                      <span className="text-muted-foreground">Parcela {inst.number}</span>
                                      {isPartial && <span className="text-destructive ml-1">Resta {formatCurrency(instRemaining)}</span>}
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <span className={isPartial ? "text-warning font-medium" : "text-success font-medium"}>
                                        {formatCurrency(Number(inst.paid_amount))}
                                      </span>
                                      {!isClosed && (
                                        <DropdownMenu>
                                          <DropdownMenuTrigger asChild>
                                            <button className="p-0.5 rounded hover:bg-muted">
                                              <MoreVertical className="h-3 w-3 text-muted-foreground" />
                                            </button>
                                          </DropdownMenuTrigger>
                                          <DropdownMenuContent align="end">
                                            <DropdownMenuItem onClick={() => handleUndoPayment(inst.id)} className="text-destructive">
                                              Desfazer Pagamento
                                            </DropdownMenuItem>
                                          </DropdownMenuContent>
                                        </DropdownMenu>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </CollapsibleContent>
                        </div>
                      </Collapsible>
                    );
                  });
                })()
              )}
            </div>
          )}

          {/* NOT PAID TAB */}
          {activeTab === "notpaid" && (
            <div className="space-y-2">
              <h2 className="text-xs font-semibold text-destructive flex items-center gap-1 uppercase tracking-wider">
                <XCircle className="h-3 w-3" /> Não Pagos do Dia
              </h2>
              {notPaidMarks.length === 0 ? (
                <div className="flex flex-col items-center py-8">
                  <CheckCircle className="mb-2 h-8 w-8 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Nenhuma marcação</p>
                </div>
              ) : (
                notPaidMarks.map(renderNotPaidRow)
              )}
            </div>
          )}

          {/* Close / Reopen */}
          {isClosed ? (
            <Button onClick={handleReopenCash} className="w-full mt-4" variant="outline" size="sm">
              <LockOpen className="mr-2 h-4 w-4" /> Reabrir Caixa
            </Button>
          ) : (
            <Button onClick={handleCloseCash} className="w-full mt-4" variant="default" size="sm">
              <Lock className="mr-2 h-4 w-4" /> Fechar Caixa do Dia
            </Button>
          )}
        </>
      )}

      {/* Batch not-paid floating bar */}
      {selectedForNotPaid.size > 0 && !isClosed && activeTab === "pending" && (
        <div className="fixed bottom-20 left-0 right-0 z-40 flex items-center justify-center gap-2 px-4">
          <div className="flex items-center gap-2 rounded-xl border bg-card shadow-lg px-4 py-2.5 max-w-lg w-full">
            <Dialog open={batchNotPaidDialogOpen} onOpenChange={(o) => { setBatchNotPaidDialogOpen(o); if (!o) { setBatchNotPaidObs(""); setShowBatchNotPaidObs(false); } }}>
              <DialogTrigger asChild>
                <Button type="button" size="sm" variant="destructive" className="flex-1">
                  <XCircle className="mr-1.5 h-4 w-4" /> Não Pagou ({selectedForNotPaid.size})
                </Button>
              </DialogTrigger>
              <DialogContent onOpenAutoFocus={(e) => e.preventDefault()}>
                <DialogHeader><DialogTitle>Marcar {selectedForNotPaid.size} como Não Pagou</DialogTitle></DialogHeader>
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    {selectedForNotPaid.size} parcela(s) selecionada(s).
                  </p>
                  {showBatchNotPaidObs ? (
                    <div>
                      <Label>Observação</Label>
                      <Textarea placeholder="Ex: Dia de chuva..." value={batchNotPaidObs} onChange={(e) => setBatchNotPaidObs(e.target.value)} />
                    </div>
                  ) : (
                    <button type="button" className="text-sm text-primary hover:underline" onClick={() => setShowBatchNotPaidObs(true)}>
                      + adicionar observação
                    </button>
                  )}
                  <Button onClick={handleBatchNotPaid} variant="destructive" className="w-full">
                    Confirmar Não Pagou ({selectedForNotPaid.size})
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
            <Button size="sm" variant="ghost" onClick={() => setSelectedForNotPaid(new Set())}>
              Limpar
            </Button>
          </div>
        </div>
      )}

      {/* FAB */}
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
