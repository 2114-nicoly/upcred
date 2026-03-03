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
import { formatCurrency, getLoanStatusColor, getStatusLabel, getPaymentTypeLabel } from "@/lib/loan-utils";
import { Checkbox } from "@/components/ui/checkbox";
import { Landmark, Filter, Flame, Plus, DollarSign, XCircle, Undo2, Search, Trash2 } from "lucide-react";
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

  // Removed local paymentTypeLabel — using getPaymentTypeLabel from loan-utils

  // Filter: exclude cravos from main list, show separately
  let displayedLoans = showCravos
    ? loans.filter((l) => l.is_cravo)
    : loans.filter((l) => !l.is_cravo);

  if (filterToday && !showCravos) displayedLoans = displayedLoans.filter((l) => todayLoanIds.has(l.id));
  if (filterPaymentType !== "all" && !showCravos) displayedLoans = displayedLoans.filter((l) => l.payment_type === filterPaymentType);
  if (searchQuery.trim()) displayedLoans = displayedLoans.filter((l) => l.clients.name.toLowerCase().includes(searchQuery.toLowerCase()));

  const cravosCount = loans.filter((l) => l.is_cravo).length;

  return (
    <div className="mx-auto max-w-lg p-4">
      <h1 className="mb-4 text-2xl font-bold">
        <Landmark className="mr-2 inline h-6 w-6 text-primary" /> {showCravos ? "Cravos 🔥" : "Empréstimos Ativos"}
      </h1>

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
          {showCravos ? "Voltar para Ativos" : `Cravos (${cravosCount})`}
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
        <p className="text-center text-muted-foreground">Carregando...</p>
      ) : displayedLoans.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center p-8">
            <p className="text-muted-foreground">
              {showCravos ? "Nenhum cravo marcado" : filterToday ? "Nenhum empréstimo com vencimento hoje" : "Nenhum empréstimo ativo"}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {displayedLoans.map((loan) => {
            const lp = progressMap[loan.id];
            return (
              <Card key={loan.id} className={`overflow-hidden transition-colors hover:bg-accent/50 ${loan.is_cravo ? "border-destructive/50" : ""} ${selectedIds.has(loan.id) ? "ring-2 ring-primary" : ""}`}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    {selectMode && (
                      <div className="mr-3 flex items-center">
                        <Checkbox checked={selectedIds.has(loan.id)} onCheckedChange={() => toggleSelect(loan.id)} />
                      </div>
                    )}
                    <div className="flex-1 cursor-pointer" onClick={() => navigate(`/loans/${loan.id}`)}>
                      <div className="flex items-center gap-2">
                        <p className="font-semibold">{loan.clients.name}</p>
                        {loan.is_cravo && <Flame className="h-4 w-4 text-destructive" />}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {formatCurrency(Number(loan.total_amount))} • <span className="font-medium text-primary">{getPaymentTypeLabel(loan.payment_type, loan.first_due_date)}</span>
                      </p>
                      {lp && (
                        <>
                          <p className="text-xs text-primary font-medium">
                            {lp.progress % 1 === 0 ? lp.progress : lp.progress.toFixed(1)}/{lp.total} • Resta: {formatCurrency(Math.max(0, lp.remaining))}
                          </p>
                          {lp.nextDueDate && (
                            <p className="text-xs text-muted-foreground">
                              Próx. vencimento: <span className="font-medium">{format(new Date(lp.nextDueDate + "T12:00:00"), "dd/MM/yyyy")}</span>
                            </p>
                          )}
                        </>
                      )}
                      {lp && lp.penaltyTotal > 0 && (
                        <p className="text-xs text-destructive">
                          Multa: {formatCurrency(lp.penaltyTotal)}
                          {lp.penaltyPaid > 0 && <span className="text-success"> (pago: {formatCurrency(lp.penaltyPaid)})</span>}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {format(new Date(loan.loan_date + "T12:00:00"), "dd/MM/yyyy")}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <Badge className={getLoanStatusColor(loan.status)}>{getStatusLabel(loan.status)}</Badge>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={(e) => { e.stopPropagation(); setPayLoanId(loan.id); }}
                      >
                        <DollarSign className="mr-1 h-3 w-3" /> Pagar
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-7 text-xs"
                        onClick={(e) => { e.stopPropagation(); handleNotPaidFromList(loan.id); }}
                      >
                        <XCircle className="mr-1 h-3 w-3" /> Não Pagou
                      </Button>
                      {loan.status === "overdue" && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={(e) => { e.stopPropagation(); handleUndoNotPaid(loan.id); }}
                        >
                          <Undo2 className="mr-1 h-3 w-3" /> Desfazer
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant={loan.is_cravo ? "destructive" : "outline"}
                        className="h-7 text-xs"
                        onClick={() => handleToggleCravo(loan.id, loan.is_cravo)}
                      >
                        <Flame className="mr-1 h-3 w-3" />
                        {loan.is_cravo ? "Cravo" : "Marcar"}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
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
    </div>
  );
}
