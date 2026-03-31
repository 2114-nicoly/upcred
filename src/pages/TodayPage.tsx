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
import { updateCashBalance, createCashMovement, recalculateCashBalanceFromLedger } from "@/lib/cash-utils";
import { CalendarDays, CheckCircle, XCircle, DollarSign, AlertTriangle, Plus, ClipboardList, ChevronDown, Undo2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
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

type LoanProgress = {
  progress: number;
  total: number;
  remaining: number;
  penaltyTotal: number;
  penaltyPaid: number;
};

export default function TodayPage() {
  const navigate = useNavigate();
  const [installments, setInstallments] = useState<InstallmentWithLoan[]>([]);
  const [overdueInstallments, setOverdueInstallments] = useState<InstallmentWithLoan[]>([]);
  const [loanProgressMap, setLoanProgressMap] = useState<Record<string, LoanProgress>>({});
  const [loading, setLoading] = useState(true);
  const [payDialogId, setPayDialogId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payPenaltyAmount, setPayPenaltyAmount] = useState("");
  const [payDate, setPayDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [overdueOpen, setOverdueOpen] = useState(false);
  const today = format(new Date(), "yyyy-MM-dd");

  const fetchInstallments = async () => {
    // Today's installments
    const { data } = await supabase
      .from("installments")
      .select("*, loans(id, client_id, amount, total_amount, installment_count, payment_type, clients(id, name))")
      .eq("due_date", today)
      .neq("status", "paid")
      .eq("is_penalty", false)
      .order("number");

    const todayInsts = (data as unknown as InstallmentWithLoan[]) || [];
    setInstallments(todayInsts);

    // Overdue installments (not paid, before today)
    const { data: overdueData } = await supabase
      .from("installments")
      .select("*, loans(id, client_id, amount, total_amount, installment_count, payment_type, clients(id, name))")
      .lt("due_date", today)
      .neq("status", "paid")
      .eq("is_penalty", false)
      .order("due_date");

    const overdueInsts = (overdueData as unknown as InstallmentWithLoan[]) || [];
    setOverdueInstallments(overdueInsts);

    // Progress for all unique loan ids
    const allInsts = [...todayInsts, ...overdueInsts];
    const uniqueLoanIds = [...new Set(allInsts.map((d) => d.loan_id))];
    const progressMap: Record<string, LoanProgress> = {};
    for (const lid of uniqueLoanIds) {
      const { data: allInst } = await supabase
        .from("installments")
        .select("amount, paid_amount, is_penalty")
        .eq("loan_id", lid);
      if (!allInst) continue;
      const regular = allInst.filter((i: any) => !i.is_penalty);
      const penalties = allInst.filter((i: any) => i.is_penalty);
      const totalPaid = regular.reduce((s: number, i: any) => s + Number(i.paid_amount), 0);
      const instValue = regular.length > 0 ? Number(regular[0].amount) : 1;
      progressMap[lid] = {
        progress: totalPaid / instValue,
        total: regular.length,
        remaining: regular.reduce((s: number, i: any) => s + Number(i.amount), 0) - totalPaid,
        penaltyTotal: penalties.reduce((s: number, i: any) => s + Number(i.amount), 0),
        penaltyPaid: penalties.reduce((s: number, i: any) => s + Number(i.paid_amount), 0),
      };
    }
    setLoanProgressMap(progressMap);
    setLoading(false);
  };

  useEffect(() => { fetchInstallments(); }, []);

  const handlePay = async (id: string) => {
    const allInsts = [...installments, ...overdueInstallments];
    const inst = allInsts.find((i) => i.id === id);
    if (!inst) return;

    const parcValue = payAmount ? parseFloat(payAmount) : null;
    const multaValue = payPenaltyAmount ? parseFloat(payPenaltyAmount) : 0;
    if (payAmount && (isNaN(parcValue!) || parcValue! <= 0)) { toast.error("Valor inválido"); return; }
    if (payPenaltyAmount && (isNaN(multaValue) || multaValue < 0)) { toast.error("Valor de multa inválido"); return; }

    // Handle penalty payment
    if (multaValue > 0) {
      const { data: penaltyInsts } = await supabase
        .from("installments")
        .select("*")
        .eq("loan_id", inst.loan_id)
        .eq("is_penalty", true);
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
          type: "recebimento_multa",
          amount: multaValue,
          client_id: inst.loans.client_id,
          loan_id: inst.loan_id,
          observation: `Pagamento de multa - ${inst.loans.clients.name}`,
        });
        toast.success(`Multa: ${formatCurrency(multaValue)} registrado!`);
      } else {
        toast.error("Nenhuma multa registrada para abater");
      }
    }

    // Handle regular payment (sequential)
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

      // Fetch all unpaid installments for sequential abatement
      const { data: allUnpaid } = await supabase
        .from("installments")
        .select("*")
        .eq("loan_id", inst.loan_id)
        .neq("status", "paid")
        .eq("is_penalty", false)
        .order("number");

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
      // Cash movement with interest/principal split
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
          type: "recebimento_normal",
          amount: totalApplied,
          client_id: inst.loans.client_id,
          loan_id: inst.loan_id,
          installment_id: inst.id,
          observation: `Parcela ${inst.number} - ${inst.loans.clients.name}`,
        });
      }
      toast.success(`Parcela: ${formatCurrency(totalApplied)} registrado!`);
      if (remaining > 0) toast.info(`Sobra de ${formatCurrency(remaining)}`);
    }

    setPayAmount(""); setPayPenaltyAmount(""); setPayDate(format(new Date(), "yyyy-MM-dd")); setPayDialogId(null);
    fetchInstallments();
  };

  const handleNotPaid = async (id: string) => {
    await supabase.from("installments").update({ status: "overdue" }).eq("id", id);
    toast.info("Parcela marcada como atrasada");
    fetchInstallments();
  };

  const handleUndoOverdue = async (id: string) => {
    await supabase.from("installments").update({ status: "pending" }).eq("id", id);
    toast.success("Status restaurado para pendente!");
    fetchInstallments();
  };

  const handleUndoPayment = async (id: string) => {
    const allInsts = [...installments, ...overdueInstallments];
    const inst = allInsts.find((i) => i.id === id);
    if (!inst) return;
    // Delete cash movements linked to this installment
    await supabase.from("cash_movements").delete().eq("installment_id", id);
    // Revert installment
    await supabase.from("installments").update({ status: "pending", paid_at: null, paid_amount: 0 }).eq("id", id);
    // Recalculate cash balance from ledger
    await recalculateCashBalanceFromLedger();
    toast.success("Pagamento desfeito!");
    fetchInstallments();
  };

  const totalToReceive = installments.reduce((sum, i) => sum + (Number(i.amount) - Number(i.paid_amount)), 0);
  const totalOverdue = overdueInstallments.reduce((s, i) => s + (Number(i.amount) - Number(i.paid_amount)), 0);

  const renderInstCard = (inst: InstallmentWithLoan) => {
    const lp = loanProgressMap[inst.loan_id];
    const instRemaining = Number(inst.amount) - Number(inst.paid_amount);
    const displayStatus = getInstallmentDisplayStatus(inst);
    const penaltyPending = lp ? lp.penaltyTotal - lp.penaltyPaid : 0;
    return (
      <Card key={inst.id} className="overflow-hidden">
        <CardContent className="p-4">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <p className="font-semibold">{inst.loans.clients.name}</p>
              <p className="text-sm text-muted-foreground">
                Parcela {inst.number} • {formatCurrency(Number(inst.amount))}
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
                <Button size="sm" className="flex-1 bg-success hover:bg-success/90">
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
                  <Button onClick={() => handlePay(inst.id)} className="w-full bg-success hover:bg-success/90">
                    Confirmar Pagamento
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
            <Button size="sm" variant="destructive" className="flex-1" onClick={() => handleNotPaid(inst.id)}>
              <XCircle className="mr-1 h-4 w-4" /> Não Pagou
            </Button>
          </div>
          {inst.status === "overdue" && (
            <Button size="sm" variant="outline" className="w-full mt-1" onClick={() => handleUndoOverdue(inst.id)}>
              <Undo2 className="mr-1 h-3 w-3" /> Desfazer "Não Pagou"
            </Button>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="mx-auto max-w-lg p-4">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">
          <CalendarDays className="mr-2 inline h-6 w-6 text-primary" /> Hoje
        </h1>
        <p className="text-sm text-muted-foreground">
          {format(new Date(), "EEEE, dd 'de' MMMM", { locale: ptBR })}
        </p>
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
            <p className="text-sm font-bold text-destructive">{overdueInstallments.length}</p>
            {totalOverdue > 0 && <p className="text-xs text-destructive">{formatCurrency(totalOverdue)}</p>}
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
                  Parcelas Vencidas Não Pagas ({overdueInstallments.length}) — {formatCurrency(totalOverdue)}
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
