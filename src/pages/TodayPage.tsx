import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { formatCurrency, getStatusColor, getStatusLabel, getInstallmentDisplayStatus } from "@/lib/loan-utils";
import { registerPayment, registerPenaltyPayment } from "@/lib/payment-utils";
import { createDailyEvent } from "@/lib/daily-events";
import { CalendarDays, CheckCircle, XCircle, DollarSign, AlertTriangle, Plus, ClipboardList, ChevronDown, Undo2, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import WorkerFilterSelect from "@/components/WorkerFilterSelect";
import { useWorkerFilter } from "@/hooks/useWorkerFilter";

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
    worker_id: string | null;
    clients: { id: string; name: string };
  };
};

type LoanProgress = {
  progress: number;
  total: number;
  remaining: number;
  penaltyTotal: number;
  penaltyPaid: number;
};

export default function TodayPage() {
  const navigate = useNavigate();
  const { selectedWorkerId, selectedAdminId, workers } = useWorkerFilter();
  const [installments, setInstallments] = useState<InstallmentWithLoan[]>([]);
  const [overdueInstallments, setOverdueInstallments] = useState<InstallmentWithLoan[]>([]);
  const [totalOverdueBalance, setTotalOverdueBalance] = useState(0);
  const [overdueClientsCount, setOverdueClientsCount] = useState(0);
  const [loanProgressMap, setLoanProgressMap] = useState<Record<string, LoanProgress>>({});
  const [loading, setLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [payDialogId, setPayDialogId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payPenaltyAmount, setPayPenaltyAmount] = useState("");
  const [payDate, setPayDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [overdueOpen, setOverdueOpen] = useState(false);
  const today = format(new Date(), "yyyy-MM-dd");

  const fetchInstallments = async () => {
    setLoading(true);
    try {
      const { data } = await supabase
        .from("installments")
        .select("*, loans(id, client_id, amount, total_amount, installment_count, payment_type, worker_id, clients(id, name))")
        .eq("due_date", today)
        .neq("status", "paid")
        .eq("is_penalty", false)
        .order("number");

      const adminWorkerIds = selectedAdminId ? new Set(workers.map((w) => w.id)) : null;
      const matchesScope = (wid: string | null | undefined) => {
        if (selectedWorkerId) return wid === selectedWorkerId;
        if (adminWorkerIds) return wid ? adminWorkerIds.has(wid) : false;
        return true;
      };

      let todayInsts = (data as unknown as InstallmentWithLoan[]) || [];
      todayInsts = todayInsts.filter((i) => matchesScope(i.loans?.worker_id));
      setInstallments(todayInsts);

      const { data: overdueData } = await supabase
        .from("installments")
        .select("*, loans(id, client_id, amount, total_amount, installment_count, payment_type, worker_id, clients(id, name))")
        .lt("due_date", today)
        .neq("status", "paid")
        .eq("is_penalty", false)
        .order("due_date");

      let overdueInsts = (overdueData as unknown as InstallmentWithLoan[]) || [];
      overdueInsts = overdueInsts.filter((i) => matchesScope(i.loans?.worker_id));
      setOverdueInstallments(overdueInsts);

      const uniqueOverdueLoanIds = [...new Set(overdueInsts.map((i) => i.loan_id))];
      let overdueBalanceSum = 0;
      if (uniqueOverdueLoanIds.length > 0) {
        const { data: overdueLoans } = await supabase
          .from("loans")
          .select("id, remaining_balance")
          .in("id", uniqueOverdueLoanIds);
        overdueBalanceSum = (overdueLoans || []).reduce((s: number, l: any) => s + Number(l.remaining_balance || 0), 0);
      }
      setTotalOverdueBalance(overdueBalanceSum);
      setOverdueClientsCount(uniqueOverdueLoanIds.length);

      const allInsts = [...todayInsts, ...overdueInsts];
      const uniqueLoanIds = [...new Set(allInsts.map((d) => d.loan_id))];
      const progressMap: Record<string, LoanProgress> = {};

      // Fetch loan remaining_balance (source of truth) for all loans in view
      const { data: loansData } = await supabase
        .from("loans")
        .select("id, total_amount, remaining_balance, installment_count")
        .in("id", uniqueLoanIds);
      const loanById = new Map((loansData || []).map((l: any) => [l.id, l]));

      for (const lid of uniqueLoanIds) {
        const { data: allInst } = await supabase
          .from("installments")
          .select("amount, paid_amount, is_penalty")
          .eq("loan_id", lid);
        if (!allInst) continue;
        const regular = allInst.filter((i: any) => !i.is_penalty);
        const penalties = allInst.filter((i: any) => i.is_penalty);
        const instValue = regular.length > 0 ? Number(regular[0].amount) : 1;
        const loan = loanById.get(lid);
        // Use loan.remaining_balance + total_amount as source of truth (same as ActiveLoansPage)
        const totalAmt = loan ? Number(loan.total_amount) : regular.reduce((s: number, i: any) => s + Number(i.amount), 0);
        const remaining = loan ? Number(loan.remaining_balance) : (totalAmt - regular.reduce((s: number, i: any) => s + Number(i.paid_amount), 0));
        const totalPaid = Math.max(0, totalAmt - remaining);
        progressMap[lid] = {
          progress: totalPaid / instValue,
          total: regular.length,
          remaining,
          penaltyTotal: penalties.reduce((s: number, i: any) => s + Number(i.amount), 0),
          penaltyPaid: penalties.reduce((s: number, i: any) => s + Number(i.paid_amount), 0),
        };
      }
      setLoanProgressMap(progressMap);
    } catch (err) {
      console.error("fetchInstallments error:", err);
      toast.error("Erro ao carregar parcelas");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchInstallments(); }, [selectedWorkerId, selectedAdminId]);

  const handlePay = async (id: string) => {
    if (isSubmitting) return;
    const allInsts = [...installments, ...overdueInstallments];
    const inst = allInsts.find((i) => i.id === id);
    if (!inst) return;

    const parcValue = payAmount ? parseFloat(payAmount) : null;
    const multaValue = payPenaltyAmount ? parseFloat(payPenaltyAmount) : 0;
    if (payAmount && (isNaN(parcValue!) || parcValue! <= 0)) { toast.error("Valor inválido"); return; }
    if (payPenaltyAmount && (isNaN(multaValue) || multaValue < 0)) { toast.error("Valor de multa inválido"); return; }

    setIsSubmitting(true);
    try {
      if (multaValue > 0) {
        await registerPenaltyPayment({
          loanId: inst.loan_id,
          amount: multaValue,
          clientId: inst.loans.client_id,
          clientName: inst.loans.clients.name,
          cashDate: payDate,
          origin: "rota",
        });
        toast.success(`Multa: ${formatCurrency(multaValue)} registrado!`);
      }

      if (parcValue !== null || !payPenaltyAmount) {
        const instRemaining = Number(inst.amount) - Number(inst.paid_amount);
        const paidValue = parcValue ?? instRemaining;
        if (paidValue <= 0) {
          if (multaValue > 0) {
            setPayAmount(""); setPayPenaltyAmount(""); setPayDate(format(new Date(), "yyyy-MM-dd")); setPayDialogId(null);
            fetchInstallments(); return;
          }
          toast.error("Informe um valor válido"); return;
        }

        const { applied } = await registerPayment({
          loanId: inst.loan_id,
          amount: paidValue,
          clientId: inst.loans.client_id,
          clientName: inst.loans.clients.name,
          cashDate: payDate,
          origin: "rota",
          installmentId: inst.id,
          startInstNumber: inst.number,
        });
        toast.success(`Parcela: ${formatCurrency(applied)} registrado!`);
      }
    } catch (err: any) {
      console.error("handlePay error:", err);
      toast.error(err?.message || "Erro ao registrar pagamento");
    } finally {
      setPayAmount(""); setPayPenaltyAmount(""); setPayDate(format(new Date(), "yyyy-MM-dd")); setPayDialogId(null);
      setIsSubmitting(false);
      fetchInstallments();
    }
  };

  const handleNotPaid = async (id: string) => {
    if (isSubmitting) return;
    const allInsts = [...installments, ...overdueInstallments];
    const inst = allInsts.find((i) => i.id === id);
    if (!inst) return;
    setIsSubmitting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      // Operational mark (prevents client coming back as pending same day)
      await supabase.from("not_paid_marks").insert({
        mark_date: today,
        installment_id: inst.id,
        loan_id: inst.loan_id,
        client_id: inst.loans.client_id,
        user_id: session?.user?.id,
      } as any);
      await supabase.from("installments").update({ status: "overdue" }).eq("id", id);
      // Daily ledger entry (no financial amount)
      await createDailyEvent({
        cash_date: today,
        event_type: "nao_pagou",
        client_id: inst.loans.client_id,
        loan_id: inst.loan_id,
        installment_id: inst.id,
        observation: `Não pagou - ${inst.loans.clients.name}`,
        origin: "rota",
      });
      toast.info("Marcada como 'Não Pagou'");
    } catch (err: any) {
      console.error(err);
      toast.error(err?.message || "Erro ao marcar parcela");
    } finally {
      setIsSubmitting(false);
      fetchInstallments();
    }
  };

  const handleUndoOverdue = async (id: string) => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await supabase.from("installments").update({ status: "pending" }).eq("id", id);
      // Remove not_paid_mark for today, if any
      await supabase.from("not_paid_marks").delete()
        .eq("installment_id", id).eq("mark_date", today);
      toast.success("Status restaurado para pendente!");
    } catch (err) {
      console.error(err);
      toast.error("Erro ao restaurar status");
    } finally {
      setIsSubmitting(false);
      fetchInstallments();
    }
  };

  const totalToReceive = installments.reduce((sum, i) => sum + (Number(i.amount) - Number(i.paid_amount)), 0);

  const renderInstCard = (inst: InstallmentWithLoan) => {
    const lp = loanProgressMap[inst.loan_id];
    const instRemaining = Number(inst.amount) - Number(inst.paid_amount);
    const displayStatus = getInstallmentDisplayStatus(inst);
    const penaltyPending = lp ? lp.penaltyTotal - lp.penaltyPaid : 0;
    return (
      <Card key={inst.id} className={`overflow-hidden ${displayStatus === "overdue" ? "bg-card-overdue-bg" : displayStatus === "due_today" ? "bg-card-due-today-bg" : ""}`}>
        <CardContent className="p-4">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <p className="font-semibold">{inst.loans.clients.name}</p>
              <p className="text-sm text-muted-foreground">
                Parcela {inst.number} • {formatCurrency(Number(inst.amount))}
                {lp && (
                  <span className="ml-1 text-xs text-success">
                    • Pago: {formatCurrency(Math.max(0, Number(inst.loans.total_amount) - lp.remaining))}
                  </span>
                )}
              </p>
              {lp && (
                <p className="text-xs text-primary font-medium">
                  {lp.progress % 1 === 0 ? lp.progress : lp.progress.toFixed(1)}/{lp.total} • Resta: {formatCurrency(Math.max(0, lp.remaining))}
                </p>
              )}
              {lp && lp.penaltyTotal > 0 && (
                <p className="text-xs text-destructive">Multa: {formatCurrency(lp.penaltyTotal)}{lp.penaltyPaid > 0 && <span className="text-success"> (pago: {formatCurrency(lp.penaltyPaid)})</span>}</p>
              )}
            </div>
            <Badge className={getStatusColor(displayStatus)}>
              {getStatusLabel(displayStatus)}
            </Badge>
          </div>
          <div className="flex gap-2">
            <Dialog open={payDialogId === inst.id} onOpenChange={(o) => { setPayDialogId(o ? inst.id : null); if (!o) { setPayAmount(""); setPayPenaltyAmount(""); } }}>
              <DialogTrigger asChild>
                <Button size="sm" className="flex-1 bg-success hover:bg-success/90" disabled={isSubmitting}>
                  <Plus className="mr-1 h-4 w-4" /> Pagamento
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>Registrar Pagamento</DialogTitle></DialogHeader>
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    {inst.loans.clients.name} — Parcela {inst.number} — {formatCurrency(Number(inst.amount))}
                  </p>
                  {Number(inst.paid_amount) > 0 && <p className="text-sm text-partial">Já pago: {formatCurrency(Number(inst.paid_amount))} — Resta: {formatCurrency(instRemaining)}</p>}
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
            <Button size="sm" variant="destructive" className="flex-1" onClick={() => handleNotPaid(inst.id)} disabled={isSubmitting}>
              <XCircle className="mr-1 h-4 w-4" /> Não Pagou
            </Button>
          </div>
          {inst.status === "overdue" && (
            <Button size="sm" variant="outline" className="w-full mt-1" onClick={() => handleUndoOverdue(inst.id)} disabled={isSubmitting}>
              <Undo2 className="mr-1 h-3 w-3" /> Desfazer "Não Pagou"
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="w-full mt-1"
            disabled={isSubmitting}
            onClick={() => navigate(`/clients/${inst.loans.client_id}/new-loan?renewFrom=${inst.loan_id}`)}
          >
            <RefreshCw className="mr-1 h-3 w-3" /> Renovar
          </Button>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="mx-auto max-w-lg p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {format(new Date(), "EEEE, dd 'de' MMMM", { locale: ptBR })}
        </p>
        <WorkerFilterSelect className="max-w-[200px]" />
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3">
        <Card className="text-center">
          <CardContent className="p-3">
            <DollarSign className="mx-auto mb-1 h-5 w-5 text-primary" />
            <p className="text-xs text-muted-foreground">A Receber Hoje</p>
            <p className="text-sm font-bold">{formatCurrency(totalToReceive)}</p>
          </CardContent>
        </Card>
        <Card
          className="cursor-pointer text-center hover:border-destructive/50 transition-colors"
          onClick={() => navigate("/overdue")}
        >
          <CardContent className="p-3">
            <AlertTriangle className="mx-auto mb-1 h-5 w-5 text-warning" />
            <p className="text-xs text-muted-foreground">Atrasadas</p>
            <p className="text-sm font-bold text-destructive">{overdueClientsCount} {overdueClientsCount === 1 ? "cliente" : "clientes"}</p>
          </CardContent>
        </Card>
      </div>

      {/* Link to today summary */}
      <Button
        variant="outline"
        className="mb-4 w-full"
        onClick={() => navigate("/today-summary")}
      >
        <ClipboardList className="mr-2 h-4 w-4" /> Resumo do Dia (pagos / não pagos)
      </Button>

      {loading ? (
        <p className="text-center text-muted-foreground">Carregando...</p>
      ) : (
        <>
          {/* Overdue collapsible */}
          {overdueInstallments.length > 0 && (
            <Collapsible open={overdueOpen} onOpenChange={setOverdueOpen} className="mb-4">
              <CollapsibleTrigger asChild>
                <Button variant="outline" className="w-full border-destructive/50 text-destructive">
                  <AlertTriangle className="mr-2 h-4 w-4" />
                  Parcelas Vencidas Não Pagas ({overdueInstallments.length})
                  <ChevronDown className={`ml-auto h-4 w-4 transition-transform ${overdueOpen ? "rotate-180" : ""}`} />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 space-y-3">
                {overdueInstallments.map((inst) => renderInstCard(inst))}
              </CollapsibleContent>
            </Collapsible>
          )}

          {/* Today's installments */}
          {installments.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center p-8">
                <CheckCircle className="mb-2 h-12 w-12 text-success" />
                <p className="text-lg font-semibold">Nenhuma cobrança para hoje!</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {installments.map((inst) => renderInstCard(inst))}
            </div>
          )}
        </>
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
