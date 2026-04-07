import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { formatCurrency, getLoanStatusColor, getStatusLabel, getPaymentTypeLabel, calculateOverdueDays } from "@/lib/loan-utils";
import { Checkbox } from "@/components/ui/checkbox";
import { Landmark, Filter, Flame, Plus, DollarSign, XCircle, Undo2, Search, Trash2, MoreVertical, Eye, Clock, AlertTriangle } from "lucide-react";
import { CardSkeleton, EmptyState } from "@/components/LoadingSkeleton";
import { updateCashBalance, createCashMovement, recalculateCashBalanceFromLedger } from "@/lib/cash-utils";
import { format } from "date-fns";
import { toast } from "sonner";

type LoanWithClient = {
  id: string;
  amount: number;
  total_amount: number;
  status: string;
  payment_type: string;
  first_due_date: string | null;
  loan_date: string;
  installment_count: number;
  is_cravo: boolean;
  clients: { id: string; name: string };
};

type LoanProgress = {
  progress: number;
  total: number;
  remaining: number;
  penaltyTotal: number;
  penaltyPaid: number;
  nextDueDate: string | null;
};

export default function ActiveLoansPage() {
  const navigate = useNavigate();
  const [loans, setLoans] = useState<LoanWithClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterToday, setFilterToday] = useState(false);
  const [filterPaymentType, setFilterPaymentType] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [showCravos, setShowCravos] = useState(false);
  const [todayLoanIds, setTodayLoanIds] = useState<Set<string>>(new Set());
  const [progressMap, setProgressMap] = useState<Record<string, LoanProgress>>({});

  // Multi-select state
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");

  // Payment dialog state
  const [payLoanId, setPayLoanId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payPenaltyAmount, setPayPenaltyAmount] = useState("");
  const [payDate, setPayDate] = useState(format(new Date(), "yyyy-MM-dd"));

  // Quitar dialog state
  const [quitarLoanId, setQuitarLoanId] = useState<string | null>(null);
  const [quitarDate, setQuitarDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [isSubmitting, setIsSubmitting] = useState(false);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleBulkDelete = async () => {
    if (deletePassword !== "0000") {
      toast.error("Senha incorreta!");
      return;
    }
    for (const loanId of selectedIds) {
      await supabase.from("not_paid_marks").delete().eq("loan_id", loanId);
      await supabase.from("cash_movements").delete().eq("loan_id", loanId);
      await supabase.from("penalties").delete().eq("loan_id", loanId);
      await supabase.from("installments").delete().eq("loan_id", loanId);
      await supabase.from("loans").delete().eq("id", loanId);
    }
    // Recalculate cash balance after bulk deletion
    await recalculateCashBalanceFromLedger();
    toast.success(`${selectedIds.size} empréstimo(s) excluído(s)!`);
    setSelectedIds(new Set());
    setSelectMode(false);
    setShowDeleteDialog(false);
    setDeletePassword("");
    fetchData();
  };

  const fetchData = async () => {
    setLoading(true);
    const { data: loansData } = await supabase
      .from("loans")
      .select("*, clients(id, name)")
      .neq("status", "paid")
      .order("loan_date", { ascending: false });

    const loansList = (loansData as unknown as LoanWithClient[]) || [];
    setLoans(loansList);

    const today = format(new Date(), "yyyy-MM-dd");
    const loanIds = loansList.map((l) => l.id);
    if (loanIds.length > 0) {
      const { data: todayInst } = await supabase
        .from("installments")
        .select("loan_id")
        .in("loan_id", loanIds)
        .eq("due_date", today)
        .neq("status", "paid");
      setTodayLoanIds(new Set((todayInst || []).map((i) => i.loan_id)));

      const { data: allInst } = await supabase
        .from("installments")
        .select("loan_id, amount, paid_amount, is_penalty, due_date, status")
        .in("loan_id", loanIds);

      const pm: Record<string, LoanProgress> = {};
      for (const lid of loanIds) {
        const insts = (allInst || []).filter((i: any) => i.loan_id === lid);
        const regular = insts.filter((i: any) => !i.is_penalty);
        const penalties = insts.filter((i: any) => i.is_penalty);
        const totalPaid = regular.reduce((s: number, i: any) => s + Number(i.paid_amount), 0);
        const instValue = regular.length > 0 ? Number(regular[0].amount) : 1;

        // Next due date: earliest unpaid regular installment
        const unpaidRegular = regular
          .filter((i: any) => i.status !== "paid")
          .sort((a: any, b: any) => a.due_date.localeCompare(b.due_date));
        const nextDueDate = unpaidRegular.length > 0 ? unpaidRegular[0].due_date : null;

        pm[lid] = {
          progress: totalPaid / instValue,
          total: regular.length,
          remaining: regular.reduce((s: number, i: any) => s + Number(i.amount), 0) - totalPaid,
          penaltyTotal: penalties.reduce((s: number, i: any) => s + Number(i.amount), 0),
          penaltyPaid: penalties.reduce((s: number, i: any) => s + Number(i.paid_amount), 0),
          nextDueDate,
        };
      }
      setProgressMap(pm);
    }
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, []);

  const handleToggleCravo = async (loanId: string, current: boolean) => {
    await supabase.from("loans").update({ is_cravo: !current }).eq("id", loanId);
    setLoans((prev) => prev.map((l) => l.id === loanId ? { ...l, is_cravo: !current } : l));
  };

  // --- Not Paid from list ---
  const handleNotPaidFromList = async (loanId: string) => {
    // Mark the next unpaid installment as overdue
    const { data: unpaid } = await supabase
      .from("installments")
      .select("id")
      .eq("loan_id", loanId)
      .neq("status", "paid")
      .eq("is_penalty", false)
      .order("number")
      .limit(1);
    if (unpaid && unpaid.length > 0) {
      await supabase.from("installments").update({ status: "overdue" }).eq("id", unpaid[0].id);
      await supabase.from("loans").update({ status: "overdue" }).eq("id", loanId);
      toast.info("Parcela marcada como atrasada");
      fetchData();
    }
  };

  // --- Undo Not Paid (restore last overdue to pending) ---
  const handleUndoNotPaid = async (loanId: string) => {
    const { data: overdueInsts } = await supabase
      .from("installments")
      .select("id")
      .eq("loan_id", loanId)
      .eq("status", "overdue")
      .eq("is_penalty", false)
      .order("number", { ascending: false })
      .limit(1);
    if (overdueInsts && overdueInsts.length > 0) {
      await supabase.from("installments").update({ status: "pending" }).eq("id", overdueInsts[0].id);
      // Update loan status
      const { data: allInst } = await supabase.from("installments").select("status, due_date").eq("loan_id", loanId);
      if (allInst) {
        const todayStr = format(new Date(), "yyyy-MM-dd");
        const hasOverdue = allInst.some((i: any) => i.id !== overdueInsts[0].id && i.status === "overdue" && i.due_date < todayStr);
        await supabase.from("loans").update({ status: hasOverdue ? "overdue" : "open" }).eq("id", loanId);
      }
      toast.success("Status restaurado para pendente!");
      fetchData();
    }
  };

  // --- Payment from list ---
  const handlePayFromList = async () => {
    if (!payLoanId) return;
    const parcValue = payAmount ? parseFloat(payAmount) : null;
    const multaValue = payPenaltyAmount ? parseFloat(payPenaltyAmount) : 0;
    if (payAmount && (isNaN(parcValue!) || parcValue! <= 0)) { toast.error("Valor inválido"); return; }
    if (payPenaltyAmount && (isNaN(multaValue) || multaValue < 0)) { toast.error("Valor de multa inválido"); return; }

    // Fetch installments for this loan
    const { data: allInst } = await supabase
      .from("installments")
      .select("*")
      .eq("loan_id", payLoanId)
      .order("number");
    if (!allInst) return;

    // Handle penalty payment
    if (multaValue > 0) {
      const penaltyInst = allInst.find((i: any) => i.is_penalty);
      if (penaltyInst) {
        const newPaid = Number(penaltyInst.paid_amount) + multaValue;
        const fullyPaid = newPaid >= Number(penaltyInst.amount) - 0.01;
        await supabase.from("installments").update({
          paid_amount: Math.min(newPaid, Number(penaltyInst.amount)),
          status: fullyPaid ? "paid" : penaltyInst.status,
          paid_at: fullyPaid ? new Date(payDate + "T12:00:00").toISOString() : penaltyInst.paid_at,
        }).eq("id", penaltyInst.id);
        toast.success(`Multa: ${formatCurrency(multaValue)} registrado!`);
      } else {
        toast.error("Nenhuma multa registrada para abater");
      }
    }

    // Handle regular payment (sequential abatement)
    if (parcValue !== null && parcValue > 0) {
      const unpaid = allInst
        .filter((i: any) => i.status !== "paid" && !i.is_penalty)
        .sort((a: any, b: any) => a.number - b.number);

      let remaining = parcValue;
      for (const inst of unpaid) {
        if (remaining <= 0) break;
        const instRemaining = Number(inst.amount) - Number(inst.paid_amount);
        const applying = Math.min(remaining, instRemaining);
        const newPaidAmount = Number(inst.paid_amount) + applying;
        const fullyPaid = newPaidAmount >= Number(inst.amount) - 0.01;
        await supabase.from("installments").update({
          paid_amount: newPaidAmount,
          status: fullyPaid ? "paid" : inst.status,
          paid_at: fullyPaid ? new Date(payDate + "T12:00:00").toISOString() : inst.paid_at,
        }).eq("id", inst.id);
        remaining -= applying;
      }
      const totalApplied = parcValue - remaining;
      toast.success(`Parcela: ${formatCurrency(totalApplied)} registrado!`);
      if (remaining > 0) toast.info(`Sobra de ${formatCurrency(remaining)}`);
    }

    // Update loan status
    const { data: updatedInst } = await supabase.from("installments").select("status, due_date").eq("loan_id", payLoanId);
    if (updatedInst) {
      const todayStr = format(new Date(), "yyyy-MM-dd");
      const allPaid = updatedInst.every((i: any) => i.status === "paid");
      const hasOverdue = updatedInst.some((i: any) => i.status === "overdue" && i.due_date < todayStr);
      let newStatus = "open";
      if (allPaid) newStatus = "paid";
      else if (hasOverdue) newStatus = "overdue";
      await supabase.from("loans").update({ status: newStatus }).eq("id", payLoanId);
    }

    setPayLoanId(null);
    setPayAmount("");
    setPayPenaltyAmount("");
    setPayDate(format(new Date(), "yyyy-MM-dd"));
    fetchData();
  };

  // --- Quitar Empréstimo from list ---
  const handleQuitarFromList = async () => {
    if (!quitarLoanId || isSubmitting) return;
    setIsSubmitting(true);

    const loan = loans.find((l) => l.id === quitarLoanId);
    if (!loan) { setIsSubmitting(false); return; }

    try {
      const { data: allUnpaid } = await supabase
        .from("installments").select("*")
        .eq("loan_id", quitarLoanId).neq("status", "paid").order("number");

      if (!allUnpaid || allUnpaid.length === 0) { setIsSubmitting(false); setQuitarLoanId(null); fetchData(); return; }

      const regularUnpaid = allUnpaid.filter((i: any) => !i.is_penalty);
      const penaltyUnpaid = allUnpaid.filter((i: any) => i.is_penalty);

      let totalRegularPaying = 0;
      let totalPenaltyPaying = 0;

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

      await supabase.from("loans").update({ status: "paid" }).eq("id", quitarLoanId);

      if (totalRegularPaying > 0) {
        const loanInterest = Number(loan.total_amount) - Number(loan.amount);
        const { data: allLoanInsts } = await supabase
          .from("installments").select("paid_amount")
          .eq("loan_id", quitarLoanId).eq("is_penalty", false);
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
          client_id: loan.clients.id, loan_id: quitarLoanId,
          observation: `Quitação empréstimo - ${loan.clients.name}`,
          cash_date: quitarDate,
        });
      }

      if (totalPenaltyPaying > 0) {
        await updateCashBalance({ available_cash: totalPenaltyPaying, penalty_receivable: -totalPenaltyPaying });
        await createCashMovement({
          type: "recebimento_multa", amount: totalPenaltyPaying,
          client_id: loan.clients.id, loan_id: quitarLoanId,
          observation: `Quitação multa - ${loan.clients.name}`,
        });
      }

      toast.success("Empréstimo quitado!");
    } catch {
      toast.error("Erro ao quitar, recarregando...");
    } finally {
      setIsSubmitting(false);
      setQuitarLoanId(null);
      setQuitarDate(format(new Date(), "yyyy-MM-dd"));
      fetchData();
    }
  };

  // Removed local paymentTypeLabel — using getPaymentTypeLabel from loan-utils

  const todayStr = format(new Date(), "yyyy-MM-dd");

  // Filter: exclude cravos from main list, show separately
  let displayedLoans = showCravos
    ? loans.filter((l) => l.is_cravo)
    : loans.filter((l) => !l.is_cravo);

  if (filterToday && !showCravos) displayedLoans = displayedLoans.filter((l) => todayLoanIds.has(l.id));
  if (filterPaymentType !== "all" && !showCravos) displayedLoans = displayedLoans.filter((l) => l.payment_type === filterPaymentType);
  if (searchQuery.trim()) displayedLoans = displayedLoans.filter((l) => l.clients.name.toLowerCase().includes(searchQuery.toLowerCase()));

  // Separate loans into sections
  const dueTodayLoans: LoanWithClient[] = [];
  const overdueLoans: LoanWithClient[] = [];
  const otherLoans: LoanWithClient[] = [];

  for (const loan of displayedLoans) {
    const ndd = progressMap[loan.id]?.nextDueDate;
    if (ndd === todayStr) dueTodayLoans.push(loan);
    else if (loan.status === "overdue" || (ndd && ndd < todayStr)) overdueLoans.push(loan);
    else otherLoans.push(loan);
  }

  // Sort each group by next due date
  const sortByNdd = (a: LoanWithClient, b: LoanWithClient) => {
    const nddA = progressMap[a.id]?.nextDueDate || "9999";
    const nddB = progressMap[b.id]?.nextDueDate || "9999";
    return nddA.localeCompare(nddB);
  };
  dueTodayLoans.sort(sortByNdd);
  overdueLoans.sort(sortByNdd);
  otherLoans.sort(sortByNdd);

  // Compute overdue days for a loan
  const getLoanOverdueDays = (loan: LoanWithClient) => {
    const ndd = progressMap[loan.id]?.nextDueDate;
    if (!ndd || ndd >= todayStr) return 0;
    return calculateOverdueDays(ndd, loan.payment_type);
  };

  // Summary totals
  const totalDueTodayValue = dueTodayLoans.reduce((s, l) => s + Math.max(0, progressMap[l.id]?.remaining ?? 0), 0);
  const totalOverdueValue = overdueLoans.reduce((s, l) => s + Math.max(0, progressMap[l.id]?.remaining ?? 0), 0);

  const renderLoanCard = (loan: LoanWithClient) => {
    const lp = progressMap[loan.id];
    const progressPct = lp && lp.total > 0 ? (Math.floor(lp.progress) / lp.total) * 100 : 0;
    const isDueToday = lp?.nextDueDate === todayStr;
    const isOverdue = !isDueToday && (loan.status === "overdue" || (lp?.nextDueDate && lp.nextDueDate < todayStr));
    const cardBg = isDueToday ? "bg-card-due-today-bg" : isOverdue ? "bg-card-overdue-bg" : "bg-card";
    const overdueDays = getLoanOverdueDays(loan);
    const remaining = Math.max(0, lp?.remaining ?? Number(loan.total_amount));
    const paidCount = lp ? Math.floor(lp.progress) : 0;
    const totalCount = lp?.total ?? loan.installment_count;

    return (
      <div
        key={loan.id}
        className={`rounded-lg border overflow-hidden transition-colors ${cardBg} ${loan.is_cravo ? "border-destructive/30" : "border-border"} ${selectedIds.has(loan.id) ? "ring-2 ring-primary" : ""}`}
      >
        <div className="flex items-center gap-2 px-3 py-2.5">
          {selectMode && (
            <Checkbox checked={selectedIds.has(loan.id)} onCheckedChange={() => toggleSelect(loan.id)} className="shrink-0 h-4 w-4" />
          )}
          <div className="flex-1 min-w-0 cursor-pointer" onClick={() => navigate(`/loans/${loan.id}`)}>
            {/* Row 1: Client name + cravo icon */}
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="font-bold text-base truncate">{loan.clients.name}</span>
              {loan.is_cravo && <Flame className="h-3.5 w-3.5 text-destructive shrink-0" />}
            </div>

            {/* Row 2: Remaining value (main highlight) */}
            <div className="flex items-center justify-between gap-2 mt-1">
              <span className="text-sm font-extrabold tabular-nums text-foreground">
                Restante: {formatCurrency(remaining)}
              </span>
              {overdueDays > 0 && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 leading-none font-semibold border-destructive/50 text-destructive bg-destructive/10">
                  Atraso de {overdueDays} dia{overdueDays > 1 ? "s" : ""}
                </Badge>
              )}
            </div>

            {/* Row 3: Secondary info */}
            <div className="flex items-center justify-between gap-2 mt-0.5">
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {paidCount}/{totalCount} parcelas • {getPaymentTypeLabel(loan.payment_type, loan.first_due_date)}
              </span>
              {lp?.nextDueDate && (
                <span className={`text-[11px] font-medium tabular-nums ${isDueToday ? "text-primary" : isOverdue ? "text-destructive" : "text-muted-foreground"}`}>
                  Vence em: {format(new Date(lp.nextDueDate + "T12:00:00"), "dd/MM")}
                </span>
              )}
            </div>

            {/* Progress bar */}
            {lp && (
              <div className="flex items-center gap-2 mt-1.5">
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
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="p-1.5 -mr-1 rounded-md hover:bg-muted shrink-0" onClick={(e) => e.stopPropagation()}>
                <MoreVertical className="h-4 w-4 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => navigate(`/loans/${loan.id}`)}>
                <Eye className="mr-2 h-4 w-4" /> Ver detalhes
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setPayLoanId(loan.id)}>
                <DollarSign className="mr-2 h-4 w-4" /> Pagar
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setQuitarLoanId(loan.id)}>
                <DollarSign className="mr-2 h-4 w-4" /> Quitar Empréstimo
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleNotPaidFromList(loan.id)}>
                <XCircle className="mr-2 h-4 w-4" /> Não Pagou
              </DropdownMenuItem>
              {loan.status === "overdue" && (
                <DropdownMenuItem onClick={() => handleUndoNotPaid(loan.id)}>
                  <Undo2 className="mr-2 h-4 w-4" /> Desfazer Atraso
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => handleToggleCravo(loan.id, loan.is_cravo)}>
                <Flame className="mr-2 h-4 w-4" /> {loan.is_cravo ? "Desmarcar Cravo" : "Marcar Cravo"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  };

  return (
    <div className="mx-auto max-w-lg p-4">

      {/* Summary card */}
      {!loading && !showCravos && displayedLoans.length > 0 && (
        <div className="mb-3 rounded-lg border bg-card p-3 space-y-2">
          {totalDueTodayValue > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Vence hoje ({dueTodayLoans.length})</span>
              <span className="text-sm font-bold tabular-nums">{formatCurrency(totalDueTodayValue)}</span>
            </div>
          )}
          {totalOverdueValue > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-destructive">Total atrasado ({overdueLoans.length})</span>
              <span className="text-sm font-bold text-destructive tabular-nums">{formatCurrency(totalOverdueValue)}</span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Empréstimos ativos</span>
            <span className="text-sm font-bold tabular-nums">{displayedLoans.length}</span>
          </div>
        </div>
      )}
      {showCravos && (
        <p className="mb-3 text-sm font-semibold text-destructive">🔥 Modo Cravos</p>
      )}

      {/* Select mode + Cravos toggle */}
      <div className="mb-3 flex gap-2">
        <Button
          variant={selectMode ? "secondary" : "outline"}
          className="flex-1"
          onClick={() => { setSelectMode(!selectMode); setSelectedIds(new Set()); }}
        >
          {selectMode ? "Cancelar Seleção" : "Selecionar"}
        </Button>
        {selectMode && selectedIds.size > 0 && (
          <Button variant="destructive" onClick={() => setShowDeleteDialog(true)}>
            <Trash2 className="mr-1 h-4 w-4" /> Excluir ({selectedIds.size})
          </Button>
        )}
        <Button
          variant={showCravos ? "destructive" : "outline"}
          className="flex-1"
          onClick={() => setShowCravos(!showCravos)}
        >
          <Flame className="mr-1 h-4 w-4" />
          {showCravos ? "Voltar para Ativos" : `Cravos (${loans.filter((l) => l.is_cravo).length})`}
        </Button>
      </div>

      {/* Search */}
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" placeholder="Buscar por nome do cliente..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
      </div>

      {/* Filters (only when not showing cravos) */}
      {!showCravos && (
        <div className="mb-4 space-y-2">
          <div className="flex items-center justify-between rounded-lg bg-accent p-3">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Vence hoje</span>
            </div>
            <Switch checked={filterToday} onCheckedChange={setFilterToday} />
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-accent p-3">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium flex-1">Tipo</span>
            <Select value={filterPaymentType} onValueChange={setFilterPaymentType}>
              <SelectTrigger className="w-40 h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="daily">Diário</SelectItem>
                <SelectItem value="weekly">Semanal</SelectItem>
                <SelectItem value="biweekly">Quinzenal</SelectItem>
                <SelectItem value="monthly">Mensal</SelectItem>
                <SelectItem value="fixed_dates">Data Fixa</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {loading ? (
        <CardSkeleton count={5} />
      ) : displayedLoans.length === 0 ? (
        <EmptyState
          icon={showCravos ? Flame : Landmark}
          message={showCravos ? "Nenhum cravo marcado" : filterToday ? "Nenhum empréstimo com vencimento hoje" : "Nenhum empréstimo ativo"}
          actionLabel={!showCravos && !filterToday ? "Criar empréstimo" : undefined}
          onAction={!showCravos && !filterToday ? () => navigate("/new-loan") : undefined}
        />
      ) : (
        <div className="space-y-2">
          {dueTodayLoans.length > 0 && (
            <div className="space-y-1.5">
              <div className="border-b border-primary/20 pb-1.5 mb-1">
                <h3 className="text-xs font-bold text-primary uppercase tracking-wider flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" /> HOJE ({dueTodayLoans.length})
                </h3>
              </div>
              {dueTodayLoans.map(renderLoanCard)}
            </div>
          )}
          {overdueLoans.length > 0 && (
            <div className="space-y-1.5 mt-3">
              <div className="border-b border-destructive/20 pb-1.5 mb-1">
                <h3 className="text-xs font-bold text-destructive uppercase tracking-wider flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5" /> ATRASADOS ({overdueLoans.length})
                </h3>
              </div>
              {overdueLoans.map(renderLoanCard)}
            </div>
          )}
          {otherLoans.length > 0 && (
            <div className="space-y-1.5 mt-3">
              {(dueTodayLoans.length > 0 || overdueLoans.length > 0) && (
                <div className="border-b border-border pb-1.5 mb-1">
                  <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
                    PRÓXIMOS ({otherLoans.length})
                  </h3>
                </div>
              )}
              {otherLoans.map(renderLoanCard)}
            </div>
          )}
        </div>
      )}

      {/* Payment Dialog */}
      <Dialog open={!!payLoanId} onOpenChange={(o) => { if (!o) { setPayLoanId(null); setPayAmount(""); setPayPenaltyAmount(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adicionar Pagamento</DialogTitle>
          </DialogHeader>
          {payLoanId && (() => {
            const loan = loans.find((l) => l.id === payLoanId);
            const lp = progressMap[payLoanId];
            return (
              <div className="space-y-3">
                <p className="text-sm font-medium">{loan?.clients.name}</p>
                {lp && (
                  <div className="rounded-lg bg-muted/50 p-3 text-sm space-y-1">
                    <div className="flex justify-between"><span>Resta (parcelas):</span><span>{formatCurrency(Math.max(0, lp.remaining))}</span></div>
                    {lp.penaltyTotal > 0 && (
                      <div className="flex justify-between"><span className="text-destructive">Multa pendente:</span><span className="text-destructive">{formatCurrency(lp.penaltyTotal - lp.penaltyPaid)}</span></div>
                    )}
                  </div>
                )}
                <div>
                  <Label>Valor recebido (parcelas)</Label>
                  <Input type="number" placeholder="Valor para abater parcelas" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
                </div>
                {lp && lp.penaltyTotal - lp.penaltyPaid > 0.01 && (
                  <div className="rounded-lg border border-warning/50 p-3 space-y-2">
                    <p className="text-xs font-medium text-warning">Multa pendente: {formatCurrency(lp.penaltyTotal - lp.penaltyPaid)}</p>
                    <Label>Valor destinado à multa (opcional)</Label>
                    <Input type="number" placeholder="0.00" value={payPenaltyAmount} onChange={(e) => setPayPenaltyAmount(e.target.value)} />
                  </div>
                )}
                <div>
                  <Label>Data do pagamento</Label>
                  <Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
                </div>
                <p className="text-xs text-muted-foreground">💡 Valor excedente abate parcelas seguintes na ordem.</p>
                <Button onClick={handlePayFromList} className="w-full bg-success hover:bg-success/90">Confirmar Pagamento</Button>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Bulk Delete Password Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={(o) => { if (!o) { setShowDeleteDialog(false); setDeletePassword(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirmar Exclusão em Massa</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Você está prestes a excluir <span className="font-bold text-destructive">{selectedIds.size}</span> empréstimo(s) e todos os registros associados. Esta ação não pode ser desfeita.
            </p>
            <div>
              <Label>Digite a senha para confirmar:</Label>
              <Input type="password" placeholder="Senha" value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} />
            </div>
            <Button variant="destructive" className="w-full" onClick={handleBulkDelete}>
              <Trash2 className="mr-1 h-4 w-4" /> Excluir {selectedIds.size} empréstimo(s)
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Quitar Dialog */}
      <Dialog open={!!quitarLoanId} onOpenChange={(o) => { if (!o) { setQuitarLoanId(null); setQuitarDate(format(new Date(), "yyyy-MM-dd")); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Quitar Empréstimo</DialogTitle>
          </DialogHeader>
          {quitarLoanId && (() => {
            const loan = loans.find((l) => l.id === quitarLoanId);
            const lp = progressMap[quitarLoanId];
            const penaltyPending = lp ? Math.max(0, lp.penaltyTotal - lp.penaltyPaid) : 0;
            return (
              <div className="space-y-3">
                <p className="text-sm font-medium">{loan?.clients.name}</p>
                <div className="rounded-lg border p-3 space-y-1 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground">Parcelas restantes:</span><span className="font-semibold">{lp ? lp.total - Math.floor(lp.progress) : "..."}/{lp?.total ?? loan?.installment_count}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Valor restante parcelas:</span><span className="font-bold text-foreground">{formatCurrency(lp?.remaining ?? 0)}</span></div>
                  {penaltyPending > 0.01 && (
                    <div className="flex justify-between"><span className="text-muted-foreground">Multa pendente:</span><span className="font-bold text-warning">{formatCurrency(penaltyPending)}</span></div>
                  )}
                  <div className="border-t pt-1 mt-1 flex justify-between"><span className="font-semibold">Total a quitar:</span><span className="font-bold text-primary">{formatCurrency((lp?.remaining ?? 0) + penaltyPending)}</span></div>
                </div>
                <div>
                  <Label>Data do pagamento</Label>
                  <Input type="date" value={quitarDate} onChange={(e) => setQuitarDate(e.target.value)} />
                </div>
                <Button onClick={handleQuitarFromList} className="w-full bg-success hover:bg-success/90" disabled={isSubmitting}>
                  {isSubmitting ? "Processando..." : "Confirmar Quitação"}
                </Button>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
