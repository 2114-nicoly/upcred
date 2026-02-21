import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCurrency, getLoanStatusColor, getStatusLabel, getPaymentTypeLabel } from "@/lib/loan-utils";
import { Landmark, Filter, Flame, Plus, DollarSign, XCircle, Undo2 } from "lucide-react";
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
  const [filterCravos, setFilterCravos] = useState(false);
  const [todayLoanIds, setTodayLoanIds] = useState<Set<string>>(new Set());
  const [progressMap, setProgressMap] = useState<Record<string, LoanProgress>>({});

  // Payment dialog state
  const [payLoanId, setPayLoanId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payPenaltyAmount, setPayPenaltyAmount] = useState("");
  const [payDate, setPayDate] = useState(format(new Date(), "yyyy-MM-dd"));

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

  let displayedLoans = loans;
  if (filterToday) displayedLoans = displayedLoans.filter((l) => todayLoanIds.has(l.id));
  if (filterCravos) displayedLoans = displayedLoans.filter((l) => l.is_cravo);

  return (
    <div className="mx-auto max-w-lg p-4">
      <h1 className="mb-4 text-2xl font-bold">
        <Landmark className="mr-2 inline h-6 w-6 text-primary" /> Empréstimos Ativos
      </h1>

      <div className="mb-4 space-y-2">
        <div className="flex items-center justify-between rounded-lg bg-accent p-3">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Vencimentos de hoje</span>
          </div>
          <Switch checked={filterToday} onCheckedChange={setFilterToday} />
        </div>
        <div className="flex items-center justify-between rounded-lg bg-accent p-3">
          <div className="flex items-center gap-2">
            <Flame className="h-4 w-4 text-destructive" />
            <span className="text-sm font-medium">Apenas Cravos</span>
          </div>
          <Switch checked={filterCravos} onCheckedChange={setFilterCravos} />
        </div>
      </div>

      {loading ? (
        <p className="text-center text-muted-foreground">Carregando...</p>
      ) : displayedLoans.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center p-8">
            <p className="text-muted-foreground">
              {filterCravos ? "Nenhum cravo marcado" : filterToday ? "Nenhum empréstimo com vencimento hoje" : "Nenhum empréstimo ativo"}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {displayedLoans.map((loan) => {
            const lp = progressMap[loan.id];
            return (
              <Card key={loan.id} className={`overflow-hidden transition-colors hover:bg-accent/50 ${loan.is_cravo ? "border-destructive/50" : ""}`}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
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
    </div>
  );
}
