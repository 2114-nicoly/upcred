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
import { createDailyEvent, deleteDailyEvent } from "@/lib/daily-events";
import { Checkbox } from "@/components/ui/checkbox";
import {
  CalendarDays, CheckCircle, XCircle, DollarSign, AlertTriangle,
  Plus, ChevronLeft, ChevronRight, Clock, Lock, LockOpen, MoreVertical, Eye, History, Filter, ChevronDown, RefreshCw
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CardSkeleton, SummarySkeleton } from "@/components/LoadingSkeleton";
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
    remaining_balance: number;
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

type NewLoanInfo = {
  id: string;
  amount: number;
  total_amount: number;
  installment_count: number;
  payment_type: string;
  loan_date: string;
  renewed_from_loan_id: string | null;
  clients: { id: string; name: string };
};

type PendingFilter = "all" | "overdue" | "today";

export default function DailyCashPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const dateParam = searchParams.get("date");
  const [selectedDate, setSelectedDate] = useState(dateParam || format(new Date(), "yyyy-MM-dd"));
  const today = format(new Date(), "yyyy-MM-dd");

  
  const [pendingFilter, setPendingFilter] = useState<PendingFilter>("all");

  const [pendingInstallments, setPendingInstallments] = useState<InstallmentWithLoan[]>([]);
  const [paidInstallments, setPaidInstallments] = useState<InstallmentWithLoan[]>([]);
  const [movementAmountByLoan, setMovementAmountByLoan] = useState<Record<string, number>>({});
  const [notPaidMarks, setNotPaidMarks] = useState<(NotPaidMark & { installment?: InstallmentWithLoan })[]>([]);
  const [loanProgressMap, setLoanProgressMap] = useState<Record<string, LoanProgress>>({});
  const [newLoans, setNewLoans] = useState<NewLoanInfo[]>([]);
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
  // Track loans actioned optimistically in this session (cleared on each refresh)
  const localActionedInstIds = useRef<Set<string>>(new Set());

  useEffect(() => { setPayDate(selectedDate); setQuitarDate(selectedDate); localActionedInstIds.current = new Set(); }, [selectedDate]);

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

      const { data: paymentMovementData } = await (supabase.from("cash_movements")
        .select("installment_id, loan_id, amount, created_at") as any)
        .eq("type", "recebimento_normal")
        .eq("cash_date", selectedDate)
        .not("installment_id", "is", null);

      const { data: npData } = await supabase.from("not_paid_marks").select("*").eq("mark_date", selectedDate);

      // Build movement amount totals by loan_id from cash_movements
      const movAmountByLoan: Record<string, number> = {};
      const paidInstIds = new Set<string>();
      const paidLoanIds = new Set<string>();
      for (const movement of paymentMovementData || []) {
        if (movement.installment_id) paidInstIds.add(movement.installment_id);
        if (movement.loan_id) {
          paidLoanIds.add(movement.loan_id);
          movAmountByLoan[movement.loan_id] = (movAmountByLoan[movement.loan_id] || 0) + Number(movement.amount);
        }
      }
      setMovementAmountByLoan(movAmountByLoan);

      // Fetch all installments that were paid on this cash_date (by paid_at date match)
      // plus those referenced in cash_movements, to capture multi-installment payments
      let paidInsts: InstallmentWithLoan[] = [];
      if (paidInstIds.size > 0 || paidLoanIds.size > 0) {
        const allPaidMap = new Map<string, InstallmentWithLoan>();
        if (paidInstIds.size > 0) {
          const { data: d1 } = await supabase.from("installments")
            .select("*, loans(id, client_id, amount, total_amount, remaining_balance, installment_count, payment_type, clients(id, name))")
            .in("id", [...paidInstIds]).eq("is_penalty", false);
          for (const inst of ((d1 as unknown as InstallmentWithLoan[]) || [])) {
            if (Number(inst.paid_amount) > 0) allPaidMap.set(inst.id, inst);
          }
        }
        if (paidLoanIds.size > 0) {
          const { data: d2 } = await supabase.from("installments")
            .select("*, loans(id, client_id, amount, total_amount, remaining_balance, installment_count, payment_type, clients(id, name))")
            .in("loan_id", [...paidLoanIds])
            .gte("paid_at", selectedDate + "T00:00:00")
            .lt("paid_at", selectedDate + "T23:59:59.999")
            .eq("is_penalty", false);
          for (const inst of ((d2 as unknown as InstallmentWithLoan[]) || [])) {
            if (Number(inst.paid_amount) > 0) allPaidMap.set(inst.id, inst);
          }
        }
        paidInsts = Array.from(allPaidMap.values()).sort((a, b) => a.number - b.number);
      }
      setPaidInstallments(paidInsts);

      const npMarks = (npData || []) as unknown as NotPaidMark[];

      let npInstMap: Record<string, InstallmentWithLoan> = {};
      const npInstIds = npMarks.map(m => m.installment_id);
      if (npInstIds.length > 0) {
        const { data: npInstData } = await supabase
          .from("installments")
          .select("*, loans(id, client_id, amount, total_amount, remaining_balance, installment_count, payment_type, clients(id, name))")
          .in("id", npInstIds);
        const npInsts = (npInstData as unknown as InstallmentWithLoan[]) || [];
        npInstMap = Object.fromEntries(npInsts.map(i => [i.id, i]));
      }

      const enrichedNpMarks = npMarks.map(m => ({ ...m, installment: npInstMap[m.installment_id] }));
      setNotPaidMarks(enrichedNpMarks);

      // Fetch all loans created on this cash date (new + renewals)
      const { data: newLoanData } = await (supabase
        .from("loans")
        .select("id, amount, total_amount, installment_count, payment_type, loan_date, renewed_from_loan_id, clients:client_id(id, name)") as any)
        .eq("loan_date", selectedDate);
      setNewLoans((newLoanData as NewLoanInfo[]) || []);

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
          .select("*, loans(id, client_id, amount, total_amount, remaining_balance, installment_count, payment_type, clients(id, name))")
          .eq("due_date", selectedDate).neq("status", "paid").eq("is_penalty", false).order("number"),
        supabase.from("installments")
          .select("*, loans(id, client_id, amount, total_amount, remaining_balance, installment_count, payment_type, clients(id, name))")
          .lt("due_date", selectedDate).neq("status", "paid").eq("is_penalty", false).order("number"),
      ]);

      const overdueInsts = (overdueData as unknown as InstallmentWithLoan[]) || [];
      const validOverdue = overdueInsts.filter(i => Number(i.amount) - Number(i.paid_amount) > 0.01);
      const dueToday = (dueTodayData as unknown as InstallmentWithLoan[]) || [];

      // Any installment that received ANY payment today should go to "Pagos", not "Pendentes"
      // paidInstIds already contains all installment IDs from cash_movements for today
      const npMarkInstIds = new Set(npMarks.map(m => m.installment_id));

      // Also build set of loans that have a not-paid mark today (hide those loans entirely)
      const npMarkLoanIds = new Set(npMarks.map(m => m.loan_id));
      // Loans that already have any payment today should also be hidden from pending
      const paidTodayLoanIds = new Set(paidInsts.map(i => i.loan_id));

      // Filter: remove any installment/loan that already has a payment or not-paid mark today
      const allCandidates = [...validOverdue, ...dueToday].filter(
        i => !paidInstIds.has(i.id)
          && !paidTodayLoanIds.has(i.loan_id)
          && !npMarkInstIds.has(i.id)
          && !npMarkLoanIds.has(i.loan_id)
          && !localActionedInstIds.current.has(i.id)
      );

      // Show only the earliest unpaid installment per loan
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

    const newRemainingBalance = Math.max(0, Number(inst.loans.remaining_balance) - paidValue);
    const optimisticPaid: InstallmentWithLoan = {
      ...inst,
      paid_amount: Number(inst.paid_amount) + paidValue,
      status: paidValue >= instRemaining - 0.01 ? "paid" : "partial",
      paid_at: new Date(payDate + "T12:00:00").toISOString(),
      loans: { ...inst.loans, remaining_balance: newRemainingBalance },
    };
    localActionedInstIds.current.add(inst.id);
    setPendingInstallments(prev => prev.filter(i => i.id !== id && i.loan_id !== inst.loan_id));
    setPaidInstallments(prev => [...prev, optimisticPaid]);
    resetPayDialog();
    toast.success(`Pagamento: ${formatCurrency(paidValue)} registrado!`);

    try {
      // Penalty payment (separate flow)
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
            cash_date: selectedDate,
          });
          await createDailyEvent({
            cash_date: payDate, event_type: "recebimento_multa",
            client_id: inst.loans.client_id, loan_id: inst.loan_id,
            amount_in: multaValue,
            observation: `Multa - ${inst.loans.clients.name}`,
            origin: "rota",
          });
          toast.success(`Multa: ${formatCurrency(multaValue)} registrado!`);
        }
      }

      // Main payment: use apply_loan_payment RPC to atomically update remaining_balance
      if (paidValue > 0) {
        await supabase.rpc("apply_loan_payment", { p_loan_id: inst.loan_id, p_amount: paidValue });

        // Update installment record for tracking
        const newPaidAmount = Number(inst.paid_amount) + paidValue;
        const fullyPaid = newPaidAmount >= Number(inst.amount) - 0.01;
        await supabase.from("installments").update({
          paid_amount: newPaidAmount,
          status: fullyPaid ? "paid" : "partial",
          paid_at: new Date(payDate + "T12:00:00").toISOString(),
        }).eq("id", inst.id);

        // If payment exceeds this installment, mark subsequent ones too
        let overflow = paidValue - (Number(inst.amount) - Number(inst.paid_amount));
        if (overflow > 0.01) {
          const { data: nextUnpaid } = await supabase
            .from("installments").select("*")
            .eq("loan_id", inst.loan_id).neq("status", "paid").eq("is_penalty", false)
            .gt("number", inst.number).order("number");
          for (const ni of (nextUnpaid || [])) {
            if (overflow <= 0.01) break;
            const niRemaining = Number(ni.amount) - Number(ni.paid_amount);
            const applying = Math.min(overflow, niRemaining);
            const niNewPaid = Number(ni.paid_amount) + applying;
            await supabase.from("installments").update({
              paid_amount: niNewPaid,
              status: niNewPaid >= Number(ni.amount) - 0.01 ? "paid" : "partial",
              paid_at: new Date(payDate + "T12:00:00").toISOString(),
            }).eq("id", ni.id);
            overflow -= applying;
          }
        }

        // Update cash balance
        const loanInterest = Number(inst.loans.total_amount) - Number(inst.loans.amount);
        const { data: allLoanInsts } = await supabase
          .from("installments").select("paid_amount")
          .eq("loan_id", inst.loan_id).eq("is_penalty", false);
        const totalPaidNow = (allLoanInsts || []).reduce((s: number, i: any) => s + Number(i.paid_amount), 0);
        const totalPaidBefore = totalPaidNow - paidValue;
        const interestRemaining = Math.max(0, loanInterest - totalPaidBefore);
        const toInterest = Math.min(paidValue, interestRemaining);
        const toPrincipal = paidValue - toInterest;
        await updateCashBalance({
          available_cash: paidValue,
          interest_receivable: -toInterest,
          money_lent: -toPrincipal,
        });

        await createCashMovement({
          type: "recebimento_normal", amount: paidValue,
          client_id: inst.loans.client_id, loan_id: inst.loan_id, installment_id: inst.id,
          observation: `Pagamento - ${inst.loans.clients.name}`,
          cash_date: selectedDate,
        });
        await createDailyEvent({
          cash_date: payDate, event_type: "pagamento",
          client_id: inst.loans.client_id, loan_id: inst.loan_id, installment_id: inst.id,
          amount_in: paidValue,
          observation: `Pagamento - ${inst.loans.clients.name}`,
          origin: "rota",
        });
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
    localActionedInstIds.current.add(inst.id);
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
      await createDailyEvent({
        cash_date: selectedDate,
        event_type: "nao_pagou",
        client_id: inst.loans.client_id,
        loan_id: inst.loan_id,
        installment_id: inst.id,
        observation: obs || `Não pagou - ${inst.loans.clients.name}`,
        origin: "rota",
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
    selectedInsts.forEach(i => localActionedInstIds.current.add(i.id));
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
      // Register daily events for each batch item
      for (const inst of selectedInsts) {
        await createDailyEvent({
          cash_date: selectedDate,
          event_type: "nao_pagou",
          client_id: inst.loans.client_id,
          loan_id: inst.loan_id,
          installment_id: inst.id,
          observation: obs || `Não pagou - ${inst.loans.clients.name}`,
          origin: "rota",
        });
      }
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
      // Delete corresponding daily_event
      if (mark) {
        const { data: events } = await (supabase.from("daily_events" as any)
          .select("id").eq("event_type", "nao_pagou")
          .eq("installment_id", mark.installment_id)
          .eq("cash_date", selectedDate) as any);
        for (const ev of (events || [])) {
          await deleteDailyEvent(ev.id);
        }
      }
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

      // Delete corresponding daily_events for this installment
      const { data: events } = await (supabase.from("daily_events" as any)
        .select("id").eq("event_type", "pagamento")
        .eq("installment_id", id)
        .eq("cash_date", selectedDate) as any);
      for (const ev of (events || [])) {
        await deleteDailyEvent(ev.id);
      }

      await recalculateCashBalanceFromLedger();
    } finally {
      setIsSubmitting(false);
      refreshDataInBackground();
    }
  };

  const handleCloseCash = async () => {
    const totalReceived = Object.values(movementAmountByLoan).reduce((s, v) => s + v, 0) || paidInstallments.reduce((s, i) => s + Number(i.paid_amount), 0);

    const { data: penaltyMovements } = await (supabase
      .from("cash_movements").select("amount") as any)
      .eq("type", "recebimento_multa")
      .eq("cash_date", selectedDate);

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
    localActionedInstIds.current.add(inst.id);
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
          cash_date: selectedDate,
        });
      }

      // Update cash balance - penalty payments
      if (totalPenaltyPaying > 0) {
        await updateCashBalance({ available_cash: totalPenaltyPaying, penalty_receivable: -totalPenaltyPaying });
        await createCashMovement({
          type: "recebimento_multa", amount: totalPenaltyPaying,
          client_id: inst.loans.client_id, loan_id: inst.loan_id,
          observation: `Quitação multa - ${inst.loans.clients.name}`,
          cash_date: selectedDate,
        });
      }
      // Register daily event for quitar
      await createDailyEvent({
        cash_date: quitarDate,
        event_type: "pagamento",
        client_id: inst.loans.client_id,
        loan_id: inst.loan_id,
        installment_id: inst.id,
        amount_in: totalRegularPaying + totalPenaltyPaying,
        observation: `Quitação - ${inst.loans.clients.name}`,
        origin: "rota",
      });
    } catch {
      toast.error("Erro ao quitar, recarregando...");
    } finally {
      setIsSubmitting(false);
      refreshDataInBackground();
    }
  };

  const totalPendingValue = pendingInstallments.reduce((s, i) => s + (Number(i.amount) - Number(i.paid_amount)), 0);
  const totalPaidValue = Object.values(movementAmountByLoan).reduce((s, v) => s + v, 0) || paidInstallments.reduce((s, i) => s + Number(i.paid_amount), 0);
  const totalTodayValue = todayItems.reduce((s, i) => s + (Number(i.amount) - Number(i.paid_amount)), 0);
  const totalOverdueValue = overdueItems.reduce((s, i) => s + (Number(i.amount) - Number(i.paid_amount)), 0);
  const totalTreated = paidInstallments.length + notPaidMarks.length;
  const totalAll = totalTreated + pendingInstallments.length;

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
        className={`rounded-lg border overflow-hidden transition-all ${isOverdue ? "bg-card-overdue-bg border-destructive/30" : "bg-card-due-today-bg border-border"} ${isSelected ? "ring-2 ring-primary/40" : ""}`}
      >
        {/* Top row: checkbox + info + menu */}
        <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => toggleSelectForNotPaid(inst.id)}
            className="shrink-0 h-4 w-4"
          />
          <div className="flex-1 min-w-0">
            {/* Row 1: Client name */}
            <span className="font-bold text-base truncate block">{inst.loans.clients.name}</span>

            {/* Row 2: Remaining value (main highlight) */}
            <div className="flex items-center justify-between gap-2 mt-1">
              <span className="text-sm font-extrabold tabular-nums text-foreground">
                Pagar: {formatCurrency(instRemaining)}
              </span>
              {isOverdue && (
                <Badge
                  variant="outline"
                  className="text-[10px] px-1.5 py-0 h-4 leading-none font-semibold border-destructive/50 text-destructive bg-destructive/10"
                >
                  Atraso de {overdueDays} dia{overdueDays > 1 ? "s" : ""}
                </Badge>
              )}
            </div>

            {/* Row 3: Secondary info */}
            <div className="flex items-center justify-between gap-2 mt-0.5">
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {paidCount}/{totalCount} parcelas
              </span>
              <span className={`text-[11px] font-medium tabular-nums ${isOverdue ? "text-destructive" : "text-muted-foreground"}`}>
                Vence em: {format(new Date(inst.due_date + "T12:00:00"), "dd/MM")}
              </span>
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
              <DropdownMenuItem onClick={() => navigate(`/clients/${inst.loans.client_id}/new-loan?renewFrom=${inst.loan_id}`)}>
                <Plus className="mr-2 h-4 w-4" /> Renovar Empréstimo
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
              <div
                className={`h-full rounded-full transition-all ${isOverdue ? "bg-destructive" : "bg-primary"}`}
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <span className={`text-[10px] font-semibold tabular-nums shrink-0 ${isOverdue ? "text-destructive" : "text-primary"}`}>
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

  // === Simple paid row (name + value) ===
  const renderPaidRow = (group: { clientName: string; clientId: string; loanId: string; installments: InstallmentWithLoan[]; totalPaid: number }) => (
    <div key={`${group.clientId}-${group.loanId}`} className="flex items-center justify-between rounded-lg border border-success/30 bg-card px-3 py-2">
      <span className="font-semibold text-sm truncate">{group.clientName}</span>
      <div className="flex items-center gap-2">
        <span className="font-bold text-sm text-success shrink-0">{formatCurrency(group.totalPaid)}</span>
        {!isClosed && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="p-1 rounded-md hover:bg-muted shrink-0">
                <MoreVertical className="h-4 w-4 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {group.installments.map(inst => (
                <DropdownMenuItem key={inst.id} onClick={() => handleUndoPayment(inst.id)} className="text-destructive">
                  Desfazer Parcela {inst.number}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem onClick={() => navigate(`/loans/${group.loanId}`)}>
                <Eye className="mr-2 h-4 w-4" /> Ver detalhes
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );

  // === Simple not-paid row (name only) ===
  const renderNotPaidRow = (mark: NotPaidMark & { installment?: InstallmentWithLoan }) => {
    const inst = mark.installment;
    return (
      <div key={mark.id} className="flex items-center justify-between rounded-lg border border-destructive/30 bg-card px-3 py-2">
        <div className="min-w-0">
          <span className="font-semibold text-sm truncate block">{inst?.loans.clients.name || "Cliente"}</span>
          {mark.observation && <p className="text-[10px] text-muted-foreground italic">"{mark.observation}"</p>}
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
              <div className="flex items-center justify-between border-b border-primary/20 pb-1.5 mb-1">
                <h3 className="text-xs font-bold text-primary uppercase tracking-wider flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" /> HOJE ({todayItems.length})
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
            <div className="space-y-1.5 mt-3">
              <div className="flex items-center justify-between border-b border-destructive/20 pb-1.5 mb-1">
                <h3 className="text-xs font-bold text-destructive uppercase tracking-wider flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5" /> ATRASADOS ({overdueItems.length})
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
      {/* Date navigation */}
      <div className="mb-3">
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

      {/* Top summary: a receber, atrasado, progresso, total recebido */}
      <div className="mb-3 rounded-lg border bg-card p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">A receber hoje</span>
          <span className="text-sm font-bold tabular-nums">{formatCurrency(totalTodayValue)}</span>
        </div>
        {totalOverdueValue > 0 && (
          <div className="flex items-center justify-between">
            <span className="text-xs text-destructive">Total atrasado</span>
            <span className="text-sm font-bold text-destructive tabular-nums">{formatCurrency(totalOverdueValue)}</span>
          </div>
        )}
        <div className="flex items-center justify-between">
          <span className="text-xs text-success">Total recebido</span>
          <span className="text-sm font-bold text-success tabular-nums">{formatCurrency(totalPaidValue)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Progresso</span>
          <div className="flex items-center gap-2">
            <div className="w-20 h-1.5 rounded-full bg-secondary overflow-hidden">
              <div className="h-full rounded-full bg-success transition-all" style={{ width: `${totalAll > 0 ? (totalTreated / totalAll) * 100 : 0}%` }} />
            </div>
            <span className="text-xs font-bold tabular-nums">{totalTreated}/{totalAll}</span>
          </div>
        </div>
      </div>

      {loading && pendingInstallments.length === 0 && paidInstallments.length === 0 && notPaidMarks.length === 0 ? (
        <>
          <SummarySkeleton />
          <CardSkeleton count={5} />
        </>
      ) : (
        <>
          {isRefreshing && (
            <div className="mb-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-center text-xs text-muted-foreground">
              Atualizando...
            </div>
          )}

          {/* PENDENTES */}
          <div className="space-y-2 mb-4">
            <h2 className="text-xs font-semibold text-foreground flex items-center gap-1 uppercase tracking-wider">
              <Clock className="h-3 w-3" /> Pendentes ({pendingInstallments.length})
            </h2>
            {isClosed ? (
              <div className="flex flex-col items-center py-6">
                <Lock className="mb-2 h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Caixa fechado — sem pendentes</p>
              </div>
            ) : pendingInstallments.length === 0 ? (
              <div className="flex flex-col items-center py-6">
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

          {/* PAGOS DO DIA */}
          {paidInstallments.length > 0 && (
            <div className="space-y-1.5 mb-4">
              <h2 className="text-xs font-semibold text-success flex items-center gap-1 uppercase tracking-wider">
                <CheckCircle className="h-3 w-3" /> Pagos do Dia ({paidInstallments.length})
              </h2>
              {(() => {
                const grouped = new Map<string, { clientName: string; clientId: string; loanId: string; installments: InstallmentWithLoan[]; totalPaid: number }>();
                for (const inst of paidInstallments) {
                  const key = `${inst.loans.client_id}-${inst.loan_id}`;
                  if (!grouped.has(key)) {
                    grouped.set(key, { clientName: inst.loans.clients.name, clientId: inst.loans.client_id, loanId: inst.loan_id, installments: [], totalPaid: 0 });
                  }
                  grouped.get(key)!.installments.push(inst);
                }
                for (const g of grouped.values()) {
                  g.totalPaid = movementAmountByLoan[g.loanId] || g.installments.reduce((s, i) => s + Number(i.paid_amount), 0);
                }
                return Array.from(grouped.values()).map(group => renderPaidRow(group));
              })()}
            </div>
          )}

          {/* NÃO PAGOS DO DIA */}
          {notPaidMarks.length > 0 && (
            <div className="space-y-1.5 mb-4">
              <h2 className="text-xs font-semibold text-destructive flex items-center gap-1 uppercase tracking-wider">
                <XCircle className="h-3 w-3" /> Não Pagos do Dia ({notPaidMarks.length})
              </h2>
              {notPaidMarks.map(renderNotPaidRow)}
            </div>
          )}

          {/* NOVOS EMPRÉSTIMOS */}
          {newLoans.length > 0 && (
            <Collapsible className="mb-4">
              <CollapsibleTrigger asChild>
                <button className="flex items-center gap-1 text-xs font-semibold text-primary uppercase tracking-wider w-full">
                  <Plus className="h-3 w-3" /> Novos do Dia ({newLoans.length})
                  <ChevronDown className="ml-auto h-3.5 w-3.5" />
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 space-y-2">
                {newLoans.map(r => {
                  const isRenewal = !!r.renewed_from_loan_id;
                  const paymentLabel = r.payment_type === "daily" ? "Diário" : r.payment_type === "weekly" ? "Semanal" : r.payment_type === "monthly" ? "Mensal" : r.payment_type;
                  return (
                    <div key={r.id} className={`rounded-lg border bg-card p-3 ${isRenewal ? "border-primary/30" : "border-success/30"}`}>
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-semibold text-sm">{r.clients?.name || "Cliente"}</p>
                          <p className="text-xs text-muted-foreground">
                            {r.installment_count}x de {formatCurrency(Number(r.total_amount) / r.installment_count)} • {paymentLabel}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className={`text-sm font-bold ${isRenewal ? "text-primary" : "text-success"}`}>{formatCurrency(Number(r.amount))}</p>
                          <Badge className={`text-[9px] px-1.5 py-0 h-3.5 ${isRenewal ? "bg-primary/10 text-primary" : "bg-success/10 text-success"}`}>
                            {isRenewal ? "Renovação" : "Novo"}
                          </Badge>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </CollapsibleContent>
            </Collapsible>
          )}

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
      {selectedForNotPaid.size > 0 && !isClosed && (
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

      {/* FAB with options */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="fixed bottom-20 right-3 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 transition-colors"
            aria-label="Novo Empréstimo"
          >
            <Plus className="h-6 w-6" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="mb-2">
          <DropdownMenuItem onClick={() => navigate("/new-loan")}>
            Cliente existente
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate("/new-loan?new_client=true")}>
            Cadastrar novo cliente
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
