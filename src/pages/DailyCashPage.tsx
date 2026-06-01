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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatCurrency, calculateOverdueDays, calculateLoanProgress } from "@/lib/loan-utils";
import { isSunday } from "@/lib/utils";
import { updateCashBalance, createCashMovement, recalculateCashBalanceFromLedger, getCurrentDailyCashScope, applyDailyCashScope } from "@/lib/cash-utils";
import { createDailyEvent, deleteDailyEvent, getDailyEvents, getEventTypeLabel, DailyEvent } from "@/lib/daily-events";
import { registerPayment, registerPenaltyPayment, settleLoan, reversePayment } from "@/lib/payment-utils";
import { logAction } from "@/lib/audit-utils";
import { isCashClosed } from "@/lib/cash-lock";
import { Checkbox } from "@/components/ui/checkbox";
import {
  CalendarDays, CheckCircle, XCircle, DollarSign, AlertTriangle,
  Plus, ChevronLeft, ChevronRight, Clock, Lock, LockOpen, MoreVertical, Eye, History, Filter, ChevronDown, RefreshCw, Loader2, Search, CalendarClock
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CardSkeleton, SummarySkeleton } from "@/components/LoadingSkeleton";
import { toast } from "sonner";
import { useConfirm } from "@/hooks/useConfirm";
import { useAuth } from "@/hooks/useAuth";
import WorkerDashboard from "@/components/WorkerDashboard";
import EmptyState from "@/components/EmptyState";
import DateNavigator from "@/components/DateNavigator";
import NoMovementHint from "@/components/NoMovementHint";

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

type DailyEventRow = {
  id: string;
  cash_date: string;
  event_type: string;
  client_id: string | null;
  loan_id: string | null;
  installment_id: string | null;
  amount_in: number;
  amount_out: number;
  observation: string | null;
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

type QueryResult<T> = Promise<{ data: T[] | null; error?: { message?: string } | null }>;

type CashMovementPaymentRow = {
  id: string;
  loan_id: string | null;
  amount: number;
  created_at: string;
};

type PaidLoanRow = {
  id: string;
  client_id: string;
  amount: number;
  total_amount: number;
  remaining_balance: number;
  installment_count: number;
  payment_type: string;
  clients: { id: string; name: string } | null;
};

type PenaltyMovementRow = { amount: number };

type DailyCashPayload = {
  cash_date: string;
  status: string;
  total_received: number;
  total_penalty_received: number;
  total_not_paid_count: number;
  total_items_treated: number;
  closed_at: string;
};

type RouteInstallmentRow = {
  id: string;
  number: number;
  amount: number;
  due_date: string;
  status: string;
  loan_id: string;
  is_penalty: boolean;
  paid_amount: number;
  paid_at: string | null;
  loan_client_id: string;
  loan_amount: number;
  loan_total_amount: number;
  loan_remaining_balance: number;
  loan_installment_count: number;
  loan_payment_type: string;
  client_id: string;
  client_name: string;
};

type RouteRpcClient = {
  rpc: (
    fn: "get_route_installments",
    args: { p_cash_date: string }
  ) => Promise<{ data: RouteInstallmentRow[] | null; error: { message?: string } | null }>;
};

const mapRouteInstallment = (row: RouteInstallmentRow): InstallmentWithLoan => ({
  id: row.id,
  number: row.number,
  amount: row.amount,
  due_date: row.due_date,
  status: row.status,
  loan_id: row.loan_id,
  is_penalty: row.is_penalty,
  paid_amount: row.paid_amount,
  paid_at: row.paid_at,
  loans: {
    id: row.loan_id,
    client_id: row.loan_client_id,
    amount: row.loan_amount,
    total_amount: row.loan_total_amount,
    remaining_balance: row.loan_remaining_balance,
    installment_count: row.loan_installment_count,
    payment_type: row.loan_payment_type,
    clients: { id: row.client_id, name: row.client_name },
  },
});

// Paid group for display
type PaidGroup = {
  movementId: string;
  clientName: string;
  clientId: string;
  loanId: string;
  totalPaid: number;
  accumulatedPaid: number;
  remainingBalance: number;
  instAmount: number;
  installmentIds: string[];
  // Progress tracking (before/after payment)
  totalAmount: number;
  installmentCount: number;
  paidBefore: number;
  paidAfter: number;
  remainingBefore: number;
  remainingAfter: number;
  progressBeforeFormatted: string;
  progressAfterFormatted: string;
  progressDeltaFormatted: string;
};

function formatInstFraction(paid: number, instAmount: number): string {
  if (!instAmount || instAmount <= 0) return "0";
  const frac = paid / instAmount;
  const rounded = Math.round(frac * 10) / 10;
  if (Math.abs(rounded - Math.round(rounded)) < 0.05) return Math.round(rounded).toString();
  return rounded.toFixed(1).replace(".", ",");
}
function formatProgress(paid: number, instAmount: number, count: number): string {
  return `${formatInstFraction(paid, instAmount)}/${count}`;
}
function formatDelta(deltaPaid: number, instAmount: number): string {
  if (!instAmount || instAmount <= 0 || deltaPaid <= 0) return "+0";
  return `+${formatInstFraction(deltaPaid, instAmount)}`;
}

type PendingFilter = "all" | "overdue" | "today";

const NOT_PAID_REASONS = [
  "Não encontrado",
  "Sem dinheiro",
  "Prometeu pagar",
  "Recusou pagar",
  "Outro",
] as const;

function composeNotPaidObservation(reason: string, obs: string): string {
  const r = (reason || "").trim();
  const o = (obs || "").trim();
  if (r && o) return `[${r}] ${o}`;
  if (r) return `[${r}]`;
  return o;
}

export default function DailyCashPage() {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { isAdmin, isSuperAdmin } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const dateParam = searchParams.get("date");
  const [selectedDate, setSelectedDate] = useState(dateParam || format(new Date(), "yyyy-MM-dd"));
  const today = format(new Date(), "yyyy-MM-dd");

  const [pendingFilter, setPendingFilter] = useState<PendingFilter>("all");
  const [pendingInstallments, setPendingInstallments] = useState<InstallmentWithLoan[]>([]);
  const [paidGroups, setPaidGroups] = useState<PaidGroup[]>([]);
  const [notPaidMarks, setNotPaidMarks] = useState<(NotPaidMark & { installment?: InstallmentWithLoan })[]>([]);
  const [newLoans, setNewLoans] = useState<NewLoanInfo[]>([]);
  const [renewalEvents, setRenewalEvents] = useState<DailyEventRow[]>([]);
  const [reversedEvents, setReversedEvents] = useState<DailyEvent[]>([]);
  const [pendingPenalties, setPendingPenalties] = useState<Array<{ id: string; amount: number; loan_id: string; clientName: string; clientId: string; created_at: string }>>([]);
  const [rescheduledInstIds, setRescheduledInstIds] = useState<Set<string>>(new Set());
  const [totalPenaltyPaidToday, setTotalPenaltyPaidToday] = useState(0);
  const [clientSearch, setClientSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [dailyCashStatus, setDailyCashStatus] = useState<string>("open");

  const [payDialogId, setPayDialogId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payPenaltyAmount, setPayPenaltyAmount] = useState("");
  const [payDate, setPayDate] = useState(selectedDate);
  const [notPaidDialogId, setNotPaidDialogId] = useState<string | null>(null);
  const [notPaidObs, setNotPaidObs] = useState("");
  const [showNotPaidObs, setShowNotPaidObs] = useState(false);
  const [notPaidReason, setNotPaidReason] = useState<string>("Não encontrado");
  const [selectedForNotPaid, setSelectedForNotPaid] = useState<Set<string>>(new Set());
  const [batchNotPaidDialogOpen, setBatchNotPaidDialogOpen] = useState(false);
  const [batchNotPaidObs, setBatchNotPaidObs] = useState("");
  const [showBatchNotPaidObs, setShowBatchNotPaidObs] = useState(false);
  const [batchNotPaidReason, setBatchNotPaidReason] = useState<string>("Não encontrado");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [quitarDialogId, setQuitarDialogId] = useState<string | null>(null);
  const [quitarDate, setQuitarDate] = useState(selectedDate);
  const localActionedLoanIds = useRef<Set<string>>(new Set());
  const fetchSeqRef = useRef(0);
  const refreshTimerRef = useRef<number | null>(null);
  const [reopenDialogOpen, setReopenDialogOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const [isReopening, setIsReopening] = useState(false);
  const [closeCashDialogOpen, setCloseCashDialogOpen] = useState(false);
  const [openingBalance, setOpeningBalance] = useState(0);
  const [manualInToday, setManualInToday] = useState(0);
  const [manualOutToday, setManualOutToday] = useState(0);
  const [quickSearch, setQuickSearch] = useState("");

  useEffect(() => {
    const urlDate = dateParam || today;
    setSelectedDate((current) => current === urlDate ? current : urlDate);
  }, [dateParam, today]);

  useEffect(() => { setPayDate(selectedDate); setQuitarDate(selectedDate); localActionedLoanIds.current = new Set(); }, [selectedDate]);

  const handleDateChange = (newDate: string) => {
    setSelectedDate(newDate);
    if (newDate === today) {
      setSearchParams({});
    } else {
      setSearchParams({ date: newDate });
    }
  };

  const changeDate = (offset: number) => {
    const d = new Date(selectedDate + "T12:00:00");
    const newDate = format(addDays(d, offset), "yyyy-MM-dd");
    handleDateChange(newDate);
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
    const base = pendingFilter === "overdue" ? overdueItems
      : pendingFilter === "today" ? todayItems
      : pendingInstallments;
    const q = clientSearch.trim().toLowerCase();
    if (!q) return base;
    return base.filter((i) => i.loans.clients.name.toLowerCase().includes(q));
  }, [pendingFilter, overdueItems, todayItems, pendingInstallments, clientSearch]);

  const filteredOverdue = useMemo(() => {
    const q = clientSearch.trim().toLowerCase();
    return q ? overdueItems.filter((i) => i.loans.clients.name.toLowerCase().includes(q)) : overdueItems;
  }, [overdueItems, clientSearch]);

  const filteredToday = useMemo(() => {
    const q = clientSearch.trim().toLowerCase();
    return q ? todayItems.filter((i) => i.loans.clients.name.toLowerCase().includes(q)) : todayItems;
  }, [todayItems, clientSearch]);

  const fetchData = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    const requestId = ++fetchSeqRef.current;
    const isStale = () => requestId !== fetchSeqRef.current;
    if (!silent) setLoading(true);
    if (silent) setIsRefreshing(true);

    try {
      // Parallel: fetch daily_cash status, daily_events for today, not_paid_marks, new loans
      const [
        { data: dcData },
        eventsData,
        allEventsIncReversed,
        { data: npData },
        { data: newLoanData },
        { data: paidMovementsData },
      ] = await Promise.all([
        applyDailyCashScope(supabase.from("daily_cash").select("*").eq("cash_date", selectedDate), await getCurrentDailyCashScope()).maybeSingle(),
        getDailyEvents(selectedDate),
        getDailyEvents(selectedDate, { includeReversed: true }),
        supabase.from("not_paid_marks").select("*").eq("mark_date", selectedDate),
        supabase.from("loans")
          .select("id, amount, total_amount, installment_count, payment_type, loan_date, renewed_from_loan_id, clients:client_id(id, name)")
          .eq("loan_date", selectedDate) as unknown as QueryResult<NewLoanInfo>,
        supabase.from("cash_movements")
          .select("id, loan_id, amount, created_at")
          .eq("cash_date", selectedDate)
          .eq("type", "recebimento_normal")
          .is("reversed_at", null) as unknown as QueryResult<CashMovementPaymentRow>,
      ]);

      if (isStale()) return;

      const status = dcData?.status || "open";
      setDailyCashStatus(status);
      setNewLoans((newLoanData as NewLoanInfo[]) || []);
      // Opening balance: from yesterday's closed daily_cash for same scope.
      const dcAny = dcData as any;
      if (dcAny?.opening_balance != null) {
        setOpeningBalance(Number(dcAny.opening_balance) || 0);
      } else {
        try {
          const scope = await getCurrentDailyCashScope();
          const { data: prior } = await applyDailyCashScope(
            supabase.from("daily_cash")
              .select("expected_closing_balance, cash_date")
              .lt("cash_date", selectedDate)
              .eq("status", "closed")
              .order("cash_date", { ascending: false })
              .limit(1),
            scope
          );
          const p = (prior || [])[0] as any;
          setOpeningBalance(p ? Number(p.expected_closing_balance) || 0 : 0);
        } catch { setOpeningBalance(0); }
      }
      // Manual in/out totals from events (non-reversed)
      let mIn = 0, mOut = 0;
      for (const e of (eventsData || []) as DailyEventRow[]) {
        if (e.event_type === "entrada_manual") mIn += Number(e.amount_in) || 0;
        if (e.event_type === "saida_manual") mOut += Number(e.amount_out) || 0;
      }
      setManualInToday(mIn);
      setManualOutToday(mOut);

      const allEvents = (eventsData || []) as unknown as DailyEventRow[];
      setRenewalEvents(allEvents.filter((e) => e.event_type === "renovacao"));
      setReversedEvents((allEventsIncReversed || []).filter((e) => e.reversed_at !== null));
      const npMarks = (npData || []) as unknown as NotPaidMark[];

      // Build sets of loan IDs that already have payment or nao_pagou events today
      const paidEventsByLoan = new Map<string, number>();
      const paidLoanIds = new Set<string>();
      const npLoanIds = new Set<string>();
      const npInstIds = new Set<string>();

      for (const ev of allEvents) {
        if (ev.event_type === "pagamento" && ev.loan_id) {
          paidLoanIds.add(ev.loan_id);
          paidEventsByLoan.set(ev.loan_id, (paidEventsByLoan.get(ev.loan_id) || 0) + Number(ev.amount_in));
        }
      }
      const paidMovementsByLoan = new Map<string, CashMovementPaymentRow[]>();
      for (const mov of (paidMovementsData || []) as CashMovementPaymentRow[]) {
        if (mov.loan_id) paidMovementsByLoan.set(mov.loan_id, [...(paidMovementsByLoan.get(mov.loan_id) || []), mov]);
      }
      for (const [loanId, movements] of paidMovementsByLoan) {
        const total = movements.reduce((sum, mov) => sum + Number(mov.amount), 0);
        if (!paidEventsByLoan.has(loanId)) paidEventsByLoan.set(loanId, total);
        paidLoanIds.add(loanId);
      }
      for (const m of npMarks) {
        npLoanIds.add(m.loan_id);
        npInstIds.add(m.installment_id);
      }

      // Build paid groups from daily_events (source of truth for display)
      // We need loan info for display - fetch loans that have payments today
      const paidLoanIdArr = [...paidLoanIds];
      const paidGroupsList: PaidGroup[] = [];
      if (paidLoanIdArr.length > 0) {
        const { data: paidLoansData } = await supabase
          .from("loans")
          .select("id, client_id, amount, total_amount, remaining_balance, installment_count, payment_type, clients:client_id(id, name)")
          .in("id", paidLoanIdArr) as unknown as { data: PaidLoanRow[] | null };

        for (const loan of (paidLoansData || [])) {
          const client = loan.clients;
          const movements = [...(paidMovementsByLoan.get(loan.id) || [])].sort(
            (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
          );
          const totalAmount = Number(loan.total_amount);
          const instCount = Number(loan.installment_count);
          const instAmount = instCount > 0 ? totalAmount / instCount : 0;
          const currentRemaining = Number(loan.remaining_balance);
          const accumulatedPaid = Math.max(0, totalAmount - currentRemaining);

          const baseStatic = {
            clientName: client?.name || "Cliente",
            clientId: loan.client_id,
            loanId: loan.id,
            accumulatedPaid,
            remainingBalance: currentRemaining,
            instAmount,
            installmentIds: [] as string[],
            totalAmount,
            installmentCount: instCount,
          };

          const buildProgress = (totalPaid: number, remainingAfter: number): Partial<PaidGroup> => {
            const remainingBefore = Math.min(totalAmount, remainingAfter + totalPaid);
            const paidBefore = Math.max(0, totalAmount - remainingBefore);
            const paidAfter = Math.max(0, totalAmount - remainingAfter);
            return {
              paidBefore, paidAfter, remainingBefore, remainingAfter,
              progressBeforeFormatted: formatProgress(paidBefore, instAmount, instCount),
              progressAfterFormatted: formatProgress(paidAfter, instAmount, instCount),
              progressDeltaFormatted: formatDelta(paidAfter - paidBefore, instAmount),
            };
          };

          if (movements.length > 0) {
            // Walk forward: remainingBefore for first mov = currentRemaining + sum(all movements today)
            const totalToday = movements.reduce((s, m) => s + Number(m.amount), 0);
            let runningRemaining = Math.min(totalAmount, currentRemaining + totalToday);
            for (const mov of movements) {
              const amt = Number(mov.amount);
              const after = Math.max(0, runningRemaining - amt);
              paidGroupsList.push({
                ...baseStatic,
                movementId: mov.id,
                totalPaid: amt,
                ...buildProgress(amt, after),
              } as PaidGroup);
              runningRemaining = after;
            }
          } else {
            const totalPaid = paidEventsByLoan.get(loan.id) || 0;
            paidGroupsList.push({
              ...baseStatic,
              movementId: "",
              totalPaid,
              ...buildProgress(totalPaid, currentRemaining),
            } as PaidGroup);
          }
        }

        // Get installment IDs for undo capability
        const { data: cmData } = await supabase.from("cash_movements")
          .select("installment_id, loan_id")
          .eq("type", "recebimento_normal")
          .eq("cash_date", selectedDate)
          .in("loan_id", paidLoanIdArr)
          .is("reversed_at", null);
        const instByLoan = new Map<string, string[]>();
        for (const cm of (cmData || [])) {
          if (cm.installment_id && cm.loan_id) {
            if (!instByLoan.has(cm.loan_id)) instByLoan.set(cm.loan_id, []);
            instByLoan.get(cm.loan_id)!.push(cm.installment_id);
          }
        }
        for (const g of paidGroupsList) {
          g.installmentIds = instByLoan.get(g.loanId) || [];
        }
      }
      if (isStale()) return;
      setPaidGroups(paidGroupsList);

      // Penalty payments total today (recebimento_multa)
      const { data: penPayData } = await (supabase
        .from("cash_movements")
        .select("amount")
        .eq("type", "recebimento_multa")
        .eq("cash_date", selectedDate)
        .is("reversed_at", null) as unknown as QueryResult<PenaltyMovementRow>);
      if (isStale()) return;
      setTotalPenaltyPaidToday((penPayData || []).reduce((s, m) => s + Number(m.amount), 0));

      // Not paid marks enrichment
      const npInstIdArr = [...npInstIds];
      let npInstMap: Record<string, InstallmentWithLoan> = {};
      if (npInstIdArr.length > 0) {
        const { data: npInstData } = await supabase
          .from("installments")
          .select("*, loans(id, client_id, amount, total_amount, remaining_balance, installment_count, payment_type, clients(id, name))")
          .in("id", npInstIdArr);
        const npInsts = (npInstData as unknown as InstallmentWithLoan[]) || [];
        npInstMap = Object.fromEntries(npInsts.map(i => [i.id, i]));
      }
      if (isStale()) return;
      const enrichedNpMarks = npMarks.map(m => ({ ...m, installment: npInstMap[m.installment_id] }));
      setNotPaidMarks(enrichedNpMarks);

      if (status === "closed") {
        setPendingInstallments([]);
        setSelectedForNotPaid(new Set());
        return;
      }

      // Fetch only the first pending installment per loan up to the selected date.
      // This avoids loading every overdue installment when switching days.
      const { data: routeRows, error: routeError } = await (supabase as unknown as RouteRpcClient)
        .rpc("get_route_installments", { p_cash_date: selectedDate });
      if (routeError) throw routeError;

      let routeInstallments = ((routeRows || []) as RouteInstallmentRow[]).map(mapRouteInstallment);
      if (isSunday(selectedDate)) {
        routeInstallments = routeInstallments.filter((i) => i.loans.payment_type !== "daily");
      }
      if (isStale()) return;

      // ANTI-REAPPEARANCE: remove any loan that already has payment or not-paid event today
      const allCandidates = routeInstallments.filter(
        i => !paidLoanIds.has(i.loan_id)
          && !npLoanIds.has(i.loan_id)
          && !localActionedLoanIds.current.has(i.loan_id)
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

      // Rescheduled flags for pending installments
      const pendingInstIds = dedupedPending.map((i) => i.id);
      if (pendingInstIds.length > 0) {
        const { data: reschData } = await supabase
          .from("installments")
          .select("id, rescheduled")
          .in("id", pendingInstIds)
          .eq("rescheduled", true);
        if (!isStale()) {
          setRescheduledInstIds(new Set((reschData || []).map((r: any) => r.id)));
        }
      } else {
        setRescheduledInstIds(new Set());
      }

      // Pending penalties (unpaid) for loans the user has scope on
      const { data: penData } = await supabase
        .from("penalties")
        .select("id, amount, loan_id, created_at, loans:loan_id(client_id, clients:client_id(id, name))")
        .eq("paid", false)
        .lte("created_at", selectedDate + "T23:59:59")
        .order("created_at", { ascending: false })
        .limit(100);
      if (!isStale()) {
        setPendingPenalties(((penData as any[]) || []).map((p) => ({
          id: p.id,
          amount: Number(p.amount),
          loan_id: p.loan_id,
          clientId: p.loans?.client_id ?? "",
          clientName: p.loans?.clients?.name ?? "Cliente",
          created_at: p.created_at,
        })));
      }
    } finally {
      if (!isStale()) {
        if (!silent) setLoading(false);
        if (silent) setIsRefreshing(false);
      }
    }
  }, [selectedDate]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const refreshDataInBackground = useCallback(() => {
    void fetchData({ silent: true });
  }, [fetchData]);

  useEffect(() => {
    const scheduleRefresh = () => {
      if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = window.setTimeout(() => fetchData({ silent: true }), 250);
    };

    // Use an opaque, per-session random channel topic so other authenticated
    // users cannot guess and subscribe to this client's realtime topic.
    // Row-level data is already protected by RLS; this hardens topic naming.
    const opaque = (typeof crypto !== "undefined" && "randomUUID" in crypto)
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
    const channel = supabase
      .channel(`rota-${opaque}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "daily_events" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "not_paid_marks" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "installments" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "loans" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "daily_cash" }, scheduleRefresh)
      .subscribe();

    const handleFocus = () => fetchData({ silent: true });
    const handleVisibility = () => { if (document.visibilityState === "visible") handleFocus(); };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current);
      supabase.removeChannel(channel);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [selectedDate, fetchData]);

  // === Payment handler: wait for server confirmation (no premature optimistic UI) ===
  const handlePay = async (id: string) => {
    if (isSubmitting) return;
    if (isClosed) { toast.error("Caixa fechado. Reabra para registrar."); return; }

    const inst = pendingInstallments.find(i => i.id === id);
    if (!inst) return;

    const parcValue = payAmount ? parseFloat(payAmount) : null;
    const multaValue = payPenaltyAmount ? parseFloat(payPenaltyAmount) : 0;
    if (payAmount && (isNaN(parcValue!) || parcValue! <= 0)) { toast.error("Valor inválido"); return; }
    if (payPenaltyAmount && (isNaN(multaValue) || multaValue < 0)) { toast.error("Valor de multa inválido"); return; }

    const instRemaining = Number(inst.amount) - Number(inst.paid_amount);
    const paidValue = parcValue ?? instRemaining;

    setIsSubmitting(true);
    try {
      if (multaValue > 0) {
        try {
          await registerPenaltyPayment({
            loanId: inst.loan_id, amount: multaValue,
            clientId: inst.loans.client_id, clientName: inst.loans.clients.name,
            cashDate: payDate, origin: "rota",
          });
          toast.success(`Multa: ${formatCurrency(multaValue)} registrado!`);
        } catch {
          toast.error("Nenhuma multa registrada para abater");
        }
      }
      if (paidValue > 0) {
        await registerPayment({
          loanId: inst.loan_id, amount: paidValue,
          clientId: inst.loans.client_id, clientName: inst.loans.clients.name,
          cashDate: payDate, origin: "rota",
          installmentId: inst.id, startInstNumber: inst.number,
        });
        toast.success(`Pagamento: ${formatCurrency(paidValue)} registrado!`);
      }
      resetPayDialog();
      await fetchData({ silent: true });
    } catch (err: any) {
      console.error("[handlePay] failed", err);
      toast.error(err?.message || "Erro ao registrar pagamento. O cliente continua em pendentes.");
    } finally {
      setIsSubmitting(false);
    }
  };


  const resetPayDialog = () => {
    setPayAmount(""); setPayPenaltyAmount(""); setPayDate(selectedDate); setPayDialogId(null);
  };

  const handleNotPaid = async (id: string) => {
    if (isSubmitting) return;
    if (isClosed) { toast.error("Caixa fechado. Reabra para registrar."); return; }

    const inst = pendingInstallments.find(i => i.id === id);
    if (!inst) return;

    const obs = composeNotPaidObservation(notPaidReason, notPaidObs);
    setIsSubmitting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const { error: insertErr } = await supabase
        .from("not_paid_marks")
        .upsert({
          mark_date: selectedDate, installment_id: inst.id,
          loan_id: inst.loan_id, client_id: inst.loans.client_id,
          observation: obs || null,
          user_id: session?.user?.id,
        }, { onConflict: "mark_date,installment_id", ignoreDuplicates: true });
      if (insertErr) throw insertErr;
      await createDailyEvent({
        cash_date: selectedDate,
        event_type: "nao_pagou",
        client_id: inst.loans.client_id,
        loan_id: inst.loan_id,
        installment_id: inst.id,
        observation: obs || `Não pagou - ${inst.loans.clients.name}`,
        origin: "rota",
      });
      setSelectedForNotPaid(prev => { const n = new Set(prev); n.delete(id); return n; });
      setNotPaidObs("");
      setShowNotPaidObs(false);
      setNotPaidReason("Não encontrado");
      setNotPaidDialogId(null);
      toast.info("Marcado como 'Não Pagou'");
      await fetchData({ silent: true });
    } catch (err: any) {
      console.error("[handleNotPaid] failed", err);
      toast.error(err?.message || "Erro ao marcar como 'Não Pagou'.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleBatchNotPaid = async () => {
    if (isSubmitting) return;
    if (isClosed) { toast.error("Caixa fechado. Reabra para registrar."); return; }

    const selectedInsts = pendingInstallments.filter(i => selectedForNotPaid.has(i.id));
    if (selectedInsts.length === 0) return;

    const obs = composeNotPaidObservation(batchNotPaidReason, batchNotPaidObs);
    setIsSubmitting(true);
    try {
      const { data: { session: s2 } } = await supabase.auth.getSession();
      const inserts = selectedInsts.map(inst => ({
        mark_date: selectedDate,
        installment_id: inst.id,
        loan_id: inst.loan_id,
        client_id: inst.loans.client_id,
        observation: obs || null,
        user_id: s2?.user?.id,
      }));
      const { error: insertErr } = await supabase
        .from("not_paid_marks")
        .upsert(inserts, { onConflict: "mark_date,installment_id", ignoreDuplicates: true });
      if (insertErr) throw insertErr;
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
      setSelectedForNotPaid(new Set());
      setBatchNotPaidDialogOpen(false);
      setBatchNotPaidObs("");
      setShowBatchNotPaidObs(false);
      setBatchNotPaidReason("Não encontrado");
      toast.info(`${selectedInsts.length} parcela(s) marcada(s) como 'Não Pagou'`);
      await fetchData({ silent: true });
    } catch (err: any) {
      console.error("[handleBatchNotPaid] failed", err);
      toast.error(err?.message || "Erro ao marcar parcelas.");
    } finally {
      setIsSubmitting(false);
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
    const mark = notPaidMarks.find(m => m.id === markId);
    const ok = await confirm({
      title: 'Desfazer marcação "não pagou"?',
      description: "A parcela voltará a aparecer como pendente na rota.",
      affected: mark ? [{ label: "Cliente", value: (mark as any).installment?.loans?.clients?.name || "—" }] : undefined,
      confirmText: "Desfazer", destructive: true,
    });
    if (!ok) return;
    setIsSubmitting(true);

    // 'mark' já calculado acima
    // Optimistic: remove from not-paid (will come back to pending on refresh)
    setNotPaidMarks(prev => prev.filter(m => m.id !== markId));
    if (mark) localActionedLoanIds.current.delete(mark.loan_id);

    try {
      const { error: delErr } = await supabase.from("not_paid_marks").delete().eq("id", markId);
      if (delErr) throw delErr;
      if (mark) {
        const { data: events } = await (supabase.from("daily_events")
          .select("id").eq("event_type", "nao_pagou")
          .eq("installment_id", mark.installment_id)
          .eq("cash_date", selectedDate) as unknown as QueryResult<{ id: string }>);
        for (const ev of (events || [])) {
          await deleteDailyEvent(ev.id);
        }
      }
      toast.success("Marcação desfeita!");
    } catch (err) {
      console.error("[handleUndoNotPaid] failed", err);
      toast.error("Não foi possível desfazer. Recarregando dados...");
    } finally {
      setIsSubmitting(false);
      refreshDataInBackground();
    }
  };

  const handleUndoPayment = async (loanId: string, movementId: string) => {
    if (isSubmitting) return;
    if (isClosed) { toast.error("Caixa fechado. Reabra para desfazer."); return; }
    if (!movementId) { toast.error("Aguarde a sincronização antes de desfazer."); refreshDataInBackground(); return; }
    const group = paidGroups.find(g => g.loanId === loanId);
    const ok = await confirm({
      title: "Desfazer pagamento?",
      description: "O valor sairá do caixa e a parcela voltará a ficar pendente.",
      affected: group ? [
        { label: "Cliente", value: (group as any).clientName || "—" },
        { label: "Valor", value: formatCurrency(group.totalPaid) },
      ] : undefined,
      confirmText: "Desfazer", destructive: true,
    });
    if (!ok) return;
    setIsSubmitting(true);

    // Optimistic: remove from paid
    setPaidGroups(prev => prev.filter(g => g.loanId !== loanId));
    localActionedLoanIds.current.delete(loanId);

    try {
      await reversePayment({ movementId });
      toast.success("Pagamento desfeito!");
    } catch (err) {
      console.error("[handleUndoPayment] failed", err);
      toast.error("Não foi possível desfazer o pagamento. Recarregando dados...");
    } finally {
      setIsSubmitting(false);
      refreshDataInBackground();
    }
  };

  const handleCloseCash = () => {
    if (dailyCashStatus === "closed") {
      toast.info("Caixa já está fechado.");
      return;
    }
    setCloseCashDialogOpen(true);
  };

  const handleCloseCashConfirm = async () => {
    if (isSubmitting) return;
    if (dailyCashStatus === "closed") {
      toast.info("Caixa já está fechado.");
      setCloseCashDialogOpen(false);
      return;
    }
    const totalReceived = paidGroups.reduce((s, g) => s + g.totalPaid, 0);
    setIsSubmitting(true);

    try {
      const { data: penaltyMovements, error: pmErr } = await (supabase
        .from("cash_movements")
        .select("amount")
        .eq("type", "recebimento_multa")
        .eq("cash_date", selectedDate)
        .is("reversed_at", null) as unknown as QueryResult<PenaltyMovementRow>);
      if (pmErr) throw pmErr;
      const totalPenaltyReceived = (penaltyMovements || []).reduce((s: number, m: PenaltyMovementRow) => s + Number(m.amount), 0);

      const { data: { session: s3 } } = await supabase.auth.getSession();
      const scope = await getCurrentDailyCashScope();
      const { data: existing, error: selErr } = await applyDailyCashScope(
        supabase.from("daily_cash").select("id").eq("cash_date", selectedDate),
        scope
      ).maybeSingle();
      if (selErr) throw selErr;

      const payload: DailyCashPayload = {
        cash_date: selectedDate, status: "closed", total_received: totalReceived,
        total_penalty_received: totalPenaltyReceived, total_not_paid_count: notPaidMarks.length,
        total_items_treated: paidGroups.length + notPaidMarks.length, closed_at: new Date().toISOString(),
      };

      let dailyCashId: string | null = null;
      if (existing) {
        const { error: updErr } = await supabase.from("daily_cash").update(payload).eq("id", existing.id);
        if (updErr) throw updErr;
        dailyCashId = existing.id;
      } else {
        const { data: inserted, error: insErr } = await supabase.from("daily_cash").insert({
          ...payload,
          user_id: s3?.user?.id,
          worker_id: scope.worker_id,
          admin_id: scope.admin_id,
        } as any).select("id").maybeSingle();
        if (insErr) throw insErr;
        dailyCashId = inserted?.id ?? null;
      }

      await logAction(
        "fechar_caixa",
        "cash",
        dailyCashId,
        null,
        { cash_date: selectedDate, total_received: totalReceived, total_not_paid: notPaidMarks.length },
        `Caixa fechado - ${selectedDate}`,
      );

      toast.success("Caixa do dia fechado!");
      setDailyCashStatus("closed");
      setPendingInstallments([]);
      setCloseCashDialogOpen(false);
    } catch (err) {
      console.error("[handleCloseCash] failed", err);
      toast.error("Não foi possível fechar o caixa. Tente novamente.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReopenCash = async () => {
    if (!isAdmin && !isSuperAdmin) {
      toast.error("Apenas administradores podem reabrir o caixa.");
      return;
    }
    setReopenReason("");
    setReopenDialogOpen(true);
  };

  const confirmReopenCash = async () => {
    if (reopenReason.trim().length < 5) return;
    setIsReopening(true);
    try {
      const { data: existing, error: selErr } = await applyDailyCashScope(
        supabase.from("daily_cash").select("id").eq("cash_date", selectedDate),
        await getCurrentDailyCashScope()
      ).maybeSingle();
      if (selErr) throw selErr;
      if (existing) {
        const { error: updErr } = await supabase
          .from("daily_cash")
          .update({ status: "open", closed_at: null })
          .eq("id", existing.id);
        if (updErr) throw updErr;
      }
      const { data: { session: s } } = await supabase.auth.getSession();
      await logAction(
        "reabrir_caixa",
        "cash",
        existing?.id ?? null,
        null,
        { cash_date: selectedDate },
        `Reabertura de caixa (${selectedDate}): ${reopenReason.trim()}`,
      );
      toast.success("Caixa reaberto!");
      setDailyCashStatus("open");
      setReopenDialogOpen(false);
      setReopenReason("");
      refreshDataInBackground();
    } catch (err) {
      console.error("[confirmReopenCash] failed", err);
      toast.error("Não foi possível reabrir o caixa. Tente novamente.");
    } finally {
      setIsReopening(false);
    }
  };

  const handleQuitarEmprestimo = async (instId: string) => {
    if (isSubmitting) return;
    if (isClosed) { toast.error("Caixa fechado. Reabra para registrar."); return; }

    const inst = pendingInstallments.find(i => i.id === instId);
    if (!inst) return;

    setIsSubmitting(true);
    try {
      await settleLoan({
        loanId: inst.loan_id,
        clientId: inst.loans.client_id,
        clientName: inst.loans.clients.name,
        cashDate: quitarDate,
        origin: "rota",
        installmentId: inst.id,
      });
      setQuitarDialogId(null);
      toast.success("Empréstimo quitado!");
      await fetchData({ silent: true });
    } catch (err: any) {
      console.error("[handleQuitarEmprestimo] failed", err);
      toast.error(err?.message || "Erro ao quitar empréstimo.");
    } finally {
      setIsSubmitting(false);
    }
  };


  // Summary values
  const totalPaidValue = paidGroups.reduce((s, g) => s + g.totalPaid, 0);
  const totalTodayValue = todayItems.reduce((s, i) => s + Math.max(0, Number(i.amount) - Number(i.paid_amount)), 0);
  const totalOverdueValue = overdueItems.reduce((s, i) => s + Math.max(0, Number(i.amount) - Number(i.paid_amount)), 0);
  const totalTreated = paidGroups.length + notPaidMarks.length;
  const totalAll = totalTreated + pendingInstallments.length;

  // === Compact pending row ===
  const renderPendingRow = (inst: InstallmentWithLoan) => {
    const remainingBalance = Number(inst.loans.remaining_balance);
    const instAmount = Number(inst.amount);
    const overdueDays = getOverdueDays(inst);
    const isOverdue = overdueDays > 0;
    const isSelected = selectedForNotPaid.has(inst.id);
    const progress = calculateLoanProgress({
      totalAmount: Number(inst.loans.total_amount),
      remainingBalance,
      installmentCount: inst.loans.installment_count,
    });
    const accumulatedPaid = progress.totalPaid;

    return (
      <div
        key={inst.id}
        className={`rounded-lg border overflow-hidden transition-all ${isOverdue ? "bg-card-overdue-bg border-destructive/30" : "bg-card-due-today-bg border-border"} ${isSelected ? "ring-2 ring-primary/40" : ""}`}
      >
        <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => toggleSelectForNotPaid(inst.id)}
            className="shrink-0 h-4 w-4"
          />
          <div className="flex-1 min-w-0">
            <span className="font-bold text-base truncate block">{inst.loans.clients.name}</span>
            <div className="flex items-center justify-between gap-2 mt-1">
              <span className="text-sm font-extrabold tabular-nums text-foreground">
                Saldo: {formatCurrency(remainingBalance)}
              </span>
              {rescheduledInstIds.has(inst.id) && (
                <TooltipProvider delayDuration={100}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 leading-none font-semibold border-blue-500/50 text-blue-600 bg-blue-500/10 cursor-help">
                        <CalendarClock className="h-2.5 w-2.5 mr-0.5" /> Reagendada
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="text-xs">Esta parcela teve sua data de vencimento alterada.</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              {isOverdue && (
                <Badge
                  variant="outline"
                  className="text-[10px] px-1.5 py-0 h-4 leading-none font-semibold border-destructive/50 text-destructive bg-destructive/10"
                >
                  Atraso {overdueDays}d
                </Badge>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 mt-0.5">
              <span className="min-w-0 text-[11px] text-muted-foreground tabular-nums">
                {progress.progressFormatted} • Parcela: {formatCurrency(instAmount)} • Pago: {formatCurrency(accumulatedPaid)}
              </span>
              <span className={`text-[11px] font-medium tabular-nums ${isOverdue ? "text-destructive" : "text-muted-foreground"}`}>
                Vence: {format(new Date(inst.due_date + "T12:00:00"), "dd/MM")}
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
                <Plus className="mr-2 h-4 w-4" /> Renovar
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
                  {inst.loans.clients.name} — Saldo: {formatCurrency(remainingBalance)} — Parcela: {formatCurrency(instAmount)}
                </p>
                <div>
                  <Label>Valor recebido</Label>
                  <Input type="number" placeholder={`Padrão: ${instAmount.toFixed(2)}`} value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
                </div>
                <div>
                  <Label>Multa a cobrar hoje (R$)</Label>
                  <Input type="number" placeholder="0.00" value={payPenaltyAmount} onChange={(e) => setPayPenaltyAmount(e.target.value)} />
                  <p className="text-[10px] text-muted-foreground mt-0.5">Opcional — registrado separado da parcela</p>
                </div>
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

          <Dialog open={notPaidDialogId === inst.id} onOpenChange={(o) => { setNotPaidDialogId(o ? inst.id : null); if (!o) { setNotPaidObs(""); setShowNotPaidObs(false); setNotPaidReason("Não encontrado"); } }}>
            <DialogTrigger asChild>
              <button type="button" className="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-semibold text-destructive hover:bg-destructive/5 transition-colors">
                <XCircle className="h-3.5 w-3.5" /> NÃO PAGOU
              </button>
            </DialogTrigger>
            <DialogContent onOpenAutoFocus={(e) => e.preventDefault()}>
              <DialogHeader><DialogTitle>Marcar Não Pagou</DialogTitle></DialogHeader>
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  {inst.loans.clients.name} — Parcela {inst.number} — {formatCurrency(instAmount)}
                </p>
                <div>
                  <Label>Motivo</Label>
                  <Select value={notPaidReason} onValueChange={setNotPaidReason}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {NOT_PAID_REASONS.map((r) => (
                        <SelectItem key={r} value={r}>{r}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {showNotPaidObs ? (
                  <div>
                    <Label>Observação (opcional)</Label>
                    <Textarea placeholder="Ex: Cliente não atendeu..." value={notPaidObs} onChange={(e) => setNotPaidObs(e.target.value)} />
                  </div>
                ) : (
                  <button type="button" className="text-sm text-primary hover:underline" onClick={() => setShowNotPaidObs(true)}>
                    + adicionar observação
                  </button>
                )}
                <Button onClick={() => handleNotPaid(inst.id)} variant="destructive" className="w-full" disabled={isSubmitting}>
                  {isSubmitting ? "Salvando..." : "Confirmar Não Pagou"}
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
                <div className="flex justify-between"><span className="text-muted-foreground">Saldo restante:</span><span className="font-bold text-foreground">{formatCurrency(remainingBalance)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Parcela:</span><span className="text-muted-foreground">{formatCurrency(instAmount)}</span></div>
                <div className="border-t pt-1 mt-1 flex justify-between"><span className="font-semibold">Total a quitar:</span><span className="font-bold text-primary">{formatCurrency(remainingBalance)}</span></div>
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

  // === Paid row ===
  const renderPaidRow = (group: PaidGroup) => {
    const isSettled = group.remainingAfter <= 0.01;
    return (
      <div key={`${group.clientId}-${group.loanId}-${group.movementId || "opt"}`} className="rounded-lg border border-success/30 bg-card px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold text-sm truncate">{group.clientName}</span>
          <div className="flex items-center gap-2">
            {isSettled && (
              <Badge className="bg-success text-success-foreground text-[10px] px-1.5 py-0">Quitado</Badge>
            )}
            <span className="font-bold text-sm text-success shrink-0">+{formatCurrency(group.totalPaid)}</span>
            {!isClosed && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="p-1 rounded-md hover:bg-muted shrink-0">
                    <MoreVertical className="h-4 w-4 text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => handleUndoPayment(group.loanId, group.movementId)} className="text-destructive">
                    Desfazer pagamento
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navigate(`/loans/${group.loanId}`)}>
                    <Eye className="mr-2 h-4 w-4" /> Ver detalhes
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground tabular-nums leading-tight">
          <div>
            Parcelas: <span className="text-foreground font-medium">{group.progressBeforeFormatted} → {group.progressAfterFormatted}</span>
            <span className="ml-1 text-success">({group.progressDeltaFormatted} parcela{group.progressDeltaFormatted === "+1" ? "" : "s"})</span>
          </div>
          <div>
            Pago: {formatCurrency(group.paidBefore)} → <span className="text-foreground font-medium">{formatCurrency(group.paidAfter)}</span>
            <span className="mx-1">•</span>
            Saldo: {formatCurrency(group.remainingBefore)} → <span className="text-foreground font-medium">{formatCurrency(group.remainingAfter)}</span>
          </div>
        </div>
      </div>
    );
  };

  // === Not-paid row ===
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
          {filteredToday.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between border-b border-primary/20 pb-1.5 mb-1">
                <h3 className="text-xs font-bold text-primary uppercase tracking-wider flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" /> HOJE ({filteredToday.length})
                </h3>
                <button className="text-[10px] text-primary hover:underline" onClick={selectAllToday}>
                  Selecionar todos
                </button>
              </div>
              {filteredToday.map(renderPendingRow)}
            </div>
          )}
          {filteredOverdue.length > 0 && (
            <div className="space-y-1.5 mt-3">
              <div className="flex items-center justify-between border-b border-destructive/20 pb-1.5 mb-1">
                <h3 className="text-xs font-bold text-destructive uppercase tracking-wider flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5" /> ATRASADOS ({filteredOverdue.length})
                </h3>
                <button className="text-[10px] text-primary hover:underline" onClick={selectAllOverdue}>
                  Selecionar todos
                </button>
              </div>
              {filteredOverdue.map(renderPendingRow)}
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
        <DateNavigator date={selectedDate} onChange={handleDateChange} origin="rota" />
        {isClosed && (
          <div className="mt-1.5 rounded-md bg-success/10 border border-success/30 p-1.5 text-center">
            <p className="text-xs font-medium text-success flex items-center justify-center gap-1">
              <Lock className="h-3 w-3" /> Caixa Fechado
            </p>
          </div>
        )}
        <NoMovementHint
          date={selectedDate}
          hasMovement={pendingInstallments.length > 0 || paidGroups.length > 0 || notPaidMarks.length > 0 || newLoans.length > 0 || renewalEvents.length > 0}
          onChange={handleDateChange}
        />
      </div>

      {/* Painel de produção do trabalhador */}
      <div className="mb-3">
        <WorkerDashboard
          data={{
            cashStatus: isClosed ? "closed" : "open",
            treatedCount: totalTreated,
            paidCount: paidGroups.length,
            notPaidCount: notPaidMarks.length,
            remainingPending: pendingInstallments.length,
            totalReceived: totalPaidValue,
            totalLent: newLoans.reduce((s, l) => s + Number(l.amount || 0), 0),
            totalPenaltyReceived: totalPenaltyPaidToday,
            expectedBalance: openingBalance + manualInToday - manualOutToday + totalPaidValue + totalPenaltyPaidToday - newLoans.reduce((s, l) => s + Number(l.amount || 0), 0),
          }}
        />
      </div>

      {/* Top summary */}
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
        <div className="border-t border-border pt-2 space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-xs text-success flex items-center gap-1">💵 Recebimentos de empréstimo</span>
            <span className="text-sm font-semibold text-success tabular-nums">{formatCurrency(totalPaidValue)}</span>
          </div>
          {totalPenaltyPaidToday > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-amber-600 flex items-center gap-1">⚠️ Multas recebidas</span>
              <span className="text-sm font-semibold text-amber-600 tabular-nums">{formatCurrency(totalPenaltyPaidToday)}</span>
            </div>
          )}
          <div className="flex items-center justify-between pt-1 border-t border-border">
            <span className="text-xs font-bold">Total do dia</span>
            <span className="text-base font-extrabold tabular-nums">{formatCurrency(totalPaidValue + totalPenaltyPaidToday)}</span>
          </div>
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

      {loading ? (
        <div className="flex flex-col items-center py-12 gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Carregando rota...</p>
        </div>
      ) : (
        <>
          {isRefreshing && (
            <div className="mb-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-center text-xs text-muted-foreground flex items-center justify-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" /> Atualizando...
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
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    placeholder="Buscar cliente..."
                    value={clientSearch}
                    onChange={(e) => setClientSearch(e.target.value)}
                    className="h-8 pl-7 text-xs"
                  />
                </div>
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
                    <button className="text-[11px] text-muted-foreground hover:underline" onClick={() => setSelectedForNotPaid(new Set())}>
                      Limpar ({selectedForNotPaid.size})
                    </button>
                  )}
                </div>

                {renderPendingSections()}
              </>
            )}
          </div>

          {/* PAGOS DO DIA */}
          {paidGroups.length > 0 && (
            <div className="space-y-1.5 mb-4">
              <h2 className="text-xs font-semibold text-success flex items-center gap-1 uppercase tracking-wider">
                <CheckCircle className="h-3 w-3" /> Pagos do Dia ({paidGroups.length})
              </h2>
              {paidGroups.map(renderPaidRow)}
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

          {/* MULTAS PENDENTES */}
          {pendingPenalties.length > 0 && (
            <div className="space-y-1.5 mb-4">
              <h2 className="text-xs font-semibold text-amber-600 flex items-center gap-1 uppercase tracking-wider">
                <AlertTriangle className="h-3 w-3" /> Multas Pendentes ({pendingPenalties.length})
              </h2>
              {pendingPenalties.map((p) => (
                <div key={p.id} className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <button
                        type="button"
                        onClick={() => navigate(`/loans/${p.loan_id}`)}
                        className="font-semibold text-sm truncate block text-left hover:underline"
                      >
                        {p.clientName}
                      </button>
                      <p className="text-[10px] text-muted-foreground">
                        Aplicada em {format(new Date(p.created_at), "dd/MM/yyyy")}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-sm text-amber-600 tabular-nums">{formatCurrency(p.amount)}</span>
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 border-amber-500/50 text-amber-600">Pendente</Badge>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* NOVOS EMPRÉSTIMOS */}
          {newLoans.filter(r => !r.renewed_from_loan_id).length > 0 && (
            <Collapsible className="mb-4">
              <CollapsibleTrigger asChild>
                <button className="flex items-center gap-1 text-xs font-semibold text-success uppercase tracking-wider w-full">
                  <Plus className="h-3 w-3" /> Novos Empréstimos do Dia ({newLoans.filter(r => !r.renewed_from_loan_id).length})
                  <ChevronDown className="ml-auto h-3.5 w-3.5" />
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 space-y-2">
                {newLoans.filter(r => !r.renewed_from_loan_id).map(r => {
                  const paymentLabel = r.payment_type === "daily" ? "Diário" : r.payment_type === "weekly" ? "Semanal" : r.payment_type === "monthly" ? "Mensal" : r.payment_type;
                  return (
                    <div key={r.id} className="rounded-lg border border-success/30 bg-card p-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-semibold text-sm">{r.clients?.name || "Cliente"}</p>
                          <p className="text-xs text-muted-foreground">
                            {r.installment_count}x de {formatCurrency(Number(r.total_amount) / r.installment_count)} • {paymentLabel}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-bold text-success">{formatCurrency(Number(r.amount))}</p>
                          <Badge className="text-[9px] px-1.5 py-0 h-3.5 bg-success/10 text-success">Novo</Badge>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </CollapsibleContent>
            </Collapsible>
          )}

          {/* RENOVAÇÕES DO DIA */}
          {newLoans.filter(r => !!r.renewed_from_loan_id).length > 0 && (
            <Collapsible className="mb-4">
              <CollapsibleTrigger asChild>
                <button className="flex items-center gap-1 text-xs font-semibold text-primary uppercase tracking-wider w-full">
                  <RefreshCw className="h-3 w-3" /> Renovações do Dia ({newLoans.filter(r => !!r.renewed_from_loan_id).length})
                  <ChevronDown className="ml-auto h-3.5 w-3.5" />
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 space-y-2">
                {newLoans.filter(r => !!r.renewed_from_loan_id).map(r => {
                  const paymentLabel = r.payment_type === "daily" ? "Diário" : r.payment_type === "weekly" ? "Semanal" : r.payment_type === "monthly" ? "Mensal" : r.payment_type;
                  // Find the renovacao daily_event for this loan to extract paid/liberado from observation
                  const renewEvt = renewalEvents.find((e) => e.event_type === "renovacao" && e.loan_id === r.id);
                  const liberado = renewEvt ? Number(renewEvt.amount_out) : Number(r.amount);
                  // Try parse Pago / Faltava from observation
                  const obs = renewEvt?.observation || "";
                  const pagoMatch = obs.match(/Pago:\s*R\$\s*([\d.,]+)/);
                  const faltavaMatch = obs.match(/Faltava:\s*R\$\s*([\d.,]+)/);
                  const parseBR = (s: string) => Number(s.replace(/\./g, "").replace(",", "."));
                  const pago = pagoMatch ? parseBR(pagoMatch[1]) : 0;
                  const faltava = faltavaMatch ? parseBR(faltavaMatch[1]) : 0;
                  return (
                    <div key={r.id} className="rounded-lg border border-primary/30 bg-card p-3">
                      <div className="flex items-center justify-between mb-1.5">
                        <p className="font-semibold text-sm">{r.clients?.name || "Cliente"}</p>
                        <Badge className="text-[9px] px-1.5 py-0 h-3.5 bg-primary/10 text-primary">Renovação</Badge>
                      </div>
                      <div className="grid grid-cols-2 gap-1 text-xs">
                        {pago > 0 && (
                          <div className="flex justify-between col-span-2">
                            <span className="text-muted-foreground">Pago na renovação:</span>
                            <span className="font-semibold text-success">{formatCurrency(pago)}</span>
                          </div>
                        )}
                        {faltava > 0 && (
                          <div className="flex justify-between col-span-2">
                            <span className="text-muted-foreground">Faltava quitar:</span>
                            <span className="font-semibold">{formatCurrency(faltava)}</span>
                          </div>
                        )}
                        <div className="flex justify-between col-span-2">
                          <span className="text-muted-foreground">Novo empréstimo:</span>
                          <span className="font-semibold">{formatCurrency(Number(r.amount))} ({r.installment_count}x • {paymentLabel})</span>
                        </div>
                        <div className="flex justify-between col-span-2 border-t pt-1 mt-1">
                          <span className="font-medium">Liberado ao cliente:</span>
                          <span className="font-bold text-primary">{formatCurrency(liberado)}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </CollapsibleContent>
            </Collapsible>
          )}

          {isClosed ? (
            (isAdmin || isSuperAdmin) ? (
              <Button onClick={handleReopenCash} className="w-full mt-4" variant="outline" size="sm" disabled={isSubmitting || isReopening}>
                <LockOpen className="mr-2 h-4 w-4" /> Reabrir Caixa
              </Button>
            ) : (
              <p className="text-center text-xs text-muted-foreground mt-4">
                Caixa fechado. Solicite a reabertura ao seu administrador.
              </p>
            )
          ) : (
            <Button onClick={handleCloseCash} className="w-full mt-4" variant="default" size="sm" disabled={isSubmitting}>
              <Lock className="mr-2 h-4 w-4" /> {isSubmitting ? "Fechando..." : "Fechar Caixa do Dia"}
            </Button>
          )}

          <Button
            onClick={() => navigate(`/daily-report?date=${selectedDate}`)}
            variant="outline"
            size="sm"
            className="w-full mt-2"
          >
            Ver Relatório do Dia
          </Button>

          <Dialog open={reopenDialogOpen} onOpenChange={(o) => { setReopenDialogOpen(o); if (!o) setReopenReason(""); }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Reabrir caixa do dia</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <div>
                  <Label>Motivo da reabertura <span className="text-destructive">*</span></Label>
                  <Textarea
                    value={reopenReason}
                    onChange={(e) => setReopenReason(e.target.value)}
                    placeholder="Descreva o motivo (mínimo 5 caracteres)..."
                    rows={3}
                  />
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Esta ação ficará registrada no histórico de auditoria.
                  </p>
                </div>
                <Button
                  onClick={confirmReopenCash}
                  disabled={reopenReason.trim().length < 5 || isReopening}
                  className="w-full"
                >
                  {isReopening ? "Reabrindo..." : "Confirmar Reabertura"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </>
      )}

      {/* Batch not-paid floating bar */}
      {selectedForNotPaid.size > 0 && !isClosed && (
        <div className="fixed bottom-20 left-0 right-0 z-40 flex items-center justify-center gap-2 px-4">
          <div className="flex items-center gap-2 rounded-xl border bg-card shadow-lg px-4 py-2.5 max-w-lg w-full">
            <Dialog open={batchNotPaidDialogOpen} onOpenChange={(o) => { setBatchNotPaidDialogOpen(o); if (!o) { setBatchNotPaidObs(""); setShowBatchNotPaidObs(false); setBatchNotPaidReason("Não encontrado"); } }}>
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
                  <div>
                    <Label>Motivo</Label>
                    <Select value={batchNotPaidReason} onValueChange={setBatchNotPaidReason}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {NOT_PAID_REASONS.map((r) => (
                          <SelectItem key={r} value={r}>{r}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {showBatchNotPaidObs ? (
                    <div>
                      <Label>Observação (opcional)</Label>
                      <Textarea placeholder="Ex: Dia de chuva..." value={batchNotPaidObs} onChange={(e) => setBatchNotPaidObs(e.target.value)} />
                    </div>
                  ) : (
                    <button type="button" className="text-sm text-primary hover:underline" onClick={() => setShowBatchNotPaidObs(true)}>
                      + adicionar observação
                    </button>
                  )}
                  <Button onClick={handleBatchNotPaid} variant="destructive" className="w-full" disabled={isSubmitting}>
                    {isSubmitting ? "Salvando..." : `Confirmar Não Pagou (${selectedForNotPaid.size})`}
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

      {/* ESTORNOS DO DIA */}
      {reversedEvents.length > 0 && (
        <Collapsible className="mt-4 mb-4">
          <CollapsibleTrigger asChild>
            <button className="flex items-center gap-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider w-full">
              <Lock className="h-3 w-3" /> Estornos do dia ({reversedEvents.length})
              <ChevronDown className="ml-auto h-3.5 w-3.5" />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 space-y-1.5">
            {reversedEvents.map((ev) => {
              const valor = Number(ev.amount_in) || Number(ev.amount_out) || 0;
              return (
                <div key={ev.id} className="rounded-lg border border-border bg-muted/30 px-3 py-2">
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-muted-foreground">{getEventTypeLabel(ev.event_type)}</p>
                      {ev.observation && <p className="text-[10px] text-muted-foreground truncate max-w-[220px]">{ev.observation}</p>}
                    </div>
                    <div className="flex items-center gap-2">
                      {valor > 0 && (
                        <span className="text-xs font-bold tabular-nums text-muted-foreground line-through">
                          {formatCurrency(valor)}
                        </span>
                      )}
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4">Estornado</Badge>
                    </div>
                  </div>
                </div>
              );
            })}
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* FAB */}
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
