import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatCurrency, getStatusColor, getStatusLabel, calculateOverdueDays } from "@/lib/loan-utils";
import { registerPayment, registerPenaltyPayment } from "@/lib/payment-utils";
import { createDailyEvent } from "@/lib/daily-events";
import { getCurrentDailyCashScope, applyDailyCashScope } from "@/lib/cash-utils";
import { INSTALLMENT_COLLECTIBLE_STATUSES, LOAN_ACTIVE_STATUSES } from "@/lib/status-constants";
import { ArrowLeft, ChevronDown, Plus, AlertTriangle, XCircle, Undo2 } from "lucide-react";
import { format } from "date-fns";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { useWorkerFilter } from "@/hooks/useWorkerFilter";
import WorkerFilterSelect from "@/components/WorkerFilterSelect";
import { useActiveCash } from "@/hooks/useActiveCash";
import { getTodayCashDate, assertCashOpen } from "@/lib/cash-lock";

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
  penalty_amount: number;
  loans: {
    id: string;
    client_id: string;
    amount: number;
    total_amount: number;
    installment_count: number;
    payment_type: string;
    worker_id: string | null;
    admin_id: string | null;
    clients: { id: string; name: string };
  };
};

type LoanGroup = {
  loanId: string;
  clientId: string;
  clientName: string;
  paymentType: string;
  totalAmount: number;
  workerId: string | null;
  adminId: string | null;
  installments: InstallmentWithLoan[];
  totalOverdue: number;
  overdueDays: number;
  penaltyTotal: number;
  penaltyPaid: number;
};

/** Agrupamento de apresentação: um card por CLIENTE (client_id + worker_id). */
type ClientGroup = {
  key: string;
  clientId: string;
  clientName: string;
  workerId: string | null;
  adminId: string | null;
  loans: LoanGroup[];
  installmentCount: number;
  totalOverdue: number;
  overdueDays: number;
  penaltyTotal: number;
  penaltyPaid: number;
};

export default function OverdueLoansPage() {

  const navigate = useNavigate();
  const { isAdmin, isSuperAdmin, workerId } = useAuth();
  const { selectedAdminId, selectedWorkerId, workers, admins } = useWorkerFilter();
  const [groups, setGroups] = useState<ClientGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedClient, setExpandedClient] = useState<string | null>(null);

  const [payDialogId, setPayDialogId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payPenaltyAmount, setPayPenaltyAmount] = useState("");
  const [payDate, setPayDate] = useState("");
  const [penaltyDialogId, setPenaltyDialogId] = useState<string | null>(null);
  const [penaltyAmount, setPenaltyAmount] = useState("");
  const [penaltyObservation, setPenaltyObservation] = useState("");

  // --- Escopo por empréstimo: o caixa é sempre o do trabalhador dono ---
  const allInstallments = groups.flatMap((g) => g.loans.flatMap((l) => l.installments));
  const scopeOfInstallment = (instId: string | null): CashScope | null => {
    if (!instId) return null;
    const inst: any = allInstallments.find((i) => i.id === instId);
    if (!inst) return null;
    return {
      workerId: inst.loans?.worker_id ?? null,
      adminId: inst.loans?.admin_id ?? null,
    };
  };
  const actionInstId = payDialogId ?? penaltyDialogId;
  const scopedCash = useScopedActiveCash(scopeOfInstallment(actionInstId));
  const opDate = scopedCash.cashDate ?? "";

  useEffect(() => {
    setPayDate(scopedCash.cashDate ?? "");
  }, [scopedCash.cashDate, actionInstId]);


  const today = format(new Date(), "yyyy-MM-dd");

  const fetchData = async () => {
    try {
      const collectibleStatuses = [...INSTALLMENT_COLLECTIBLE_STATUSES];
      const activeLoanStatuses = [...LOAN_ACTIVE_STATUSES];
      let q = supabase
        .from("installments")
        .select("*, loans!inner(id, client_id, amount, total_amount, installment_count, payment_type, worker_id, admin_id, status, clients(id, name))")
        .lt("due_date", today)
        .in("status", collectibleStatuses)
        .in("loans.status", activeLoanStatuses)
        .gt("loans.remaining_balance", 0.01)
        .eq("is_penalty", false);
      // Worker scope: explicit filter on top of RLS for double protection
      if (!isAdmin && !isSuperAdmin && workerId) q = q.eq("loans.worker_id", workerId);
      const { data } = await q.order("due_date");

      const insts = (data as unknown as InstallmentWithLoan[]) || [];

      // Fetch penalty info per loan
      const loanIds = [...new Set(insts.map((i) => i.loan_id))];
      const penaltyMap: Record<string, { total: number; paid: number }> = {};
      if (loanIds.length > 0) {
        const { data: penaltyInsts } = await supabase
          .from("installments")
          .select("loan_id, amount, paid_amount")
          .in("loan_id", loanIds)
          .eq("is_penalty", true);
        for (const p of penaltyInsts || []) {
          penaltyMap[p.loan_id] = { total: Number(p.amount), paid: Number(p.paid_amount) };
        }
      }

      const grouped: Record<string, LoanGroup> = {};
      for (const inst of insts) {
        const instRemaining = Math.max(Number(inst.amount) - Number(inst.paid_amount), 0);
        if (instRemaining <= 0.01) continue;
        if (!grouped[inst.loan_id]) {
          const oldestDueDate = inst.due_date;
          const pm = penaltyMap[inst.loan_id] || { total: 0, paid: 0 };
          grouped[inst.loan_id] = {
            loanId: inst.loan_id,
            clientId: inst.loans.client_id,
            clientName: (inst.loans?.clients?.name ?? "Cliente removido"),
            paymentType: inst.loans.payment_type,
            totalAmount: Number(inst.loans.total_amount),
            workerId: (inst.loans as any).worker_id ?? null,
            adminId: (inst.loans as any).admin_id ?? null,
            installments: [],
            totalOverdue: 0,
            overdueDays: calculateOverdueDays(oldestDueDate, inst.loans.payment_type),
            penaltyTotal: pm.total,
            penaltyPaid: pm.paid,
          };
        }
        grouped[inst.loan_id].installments.push(inst);
        grouped[inst.loan_id].totalOverdue += instRemaining;
      }

      // Um card por CLIENTE (client_id + worker_id), nunca por parcela/empréstimo
      const byClient: Record<string, ClientGroup> = {};
      for (const lg of Object.values(grouped)) {
        const key = `${lg.clientId}|${lg.workerId ?? "-"}`;
        const cg = (byClient[key] ||= {
          key,
          clientId: lg.clientId,
          clientName: lg.clientName,
          workerId: lg.workerId,
          adminId: lg.adminId,
          loans: [],
          installmentCount: 0,
          totalOverdue: 0,
          overdueDays: 0,
          penaltyTotal: 0,
          penaltyPaid: 0,
        });
        cg.loans.push(lg);
        cg.installmentCount += lg.installments.length;
        cg.totalOverdue += lg.totalOverdue;
        cg.overdueDays = Math.max(cg.overdueDays, lg.overdueDays);
        cg.penaltyTotal += lg.penaltyTotal;
        cg.penaltyPaid += lg.penaltyPaid;
      }

      setGroups(Object.values(byClient).sort((a, b) => b.overdueDays - a.overdueDays));

    } catch (err) {
      console.error("Error in OverdueLoansPage fetchData:", err);
      toast.error("Erro ao carregar parcelas atrasadas");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const handlePay = async (id: string) => {
    try {
      await assertScopedCashOpen(payDate, scopeOfInstallment(id) ?? { workerId: null, adminId: null });
    } catch (err: any) {
      toast.error(err?.message || "Não há caixa aberto nesta data.");
      return;
    }

    const allInsts = groups.flatMap((g) => g.loans.flatMap((l) => l.installments));
    const inst = allInsts.find((i) => i.id === id);
    if (!inst) return;

    const parcValue = payAmount ? parseFloat(payAmount) : null;
    const multaValue = payPenaltyAmount ? parseFloat(payPenaltyAmount) : 0;
    if (payAmount && (parcValue === null || isNaN(parcValue) || parcValue <= 0)) { toast.error("Valor inválido"); return; }
    if (payPenaltyAmount && (isNaN(multaValue) || multaValue < 0)) { toast.error("Valor de multa inválido"); return; }

    try {
      if (multaValue > 0) {
        await registerPenaltyPayment({
          loanId: inst.loan_id,
          amount: multaValue,
          clientId: inst.loans.client_id,
          clientName: (inst.loans?.clients?.name ?? "Cliente removido"),
          cashDate: payDate,
          origin: "atrasadas",
        });
        toast.success(`Multa: ${formatCurrency(multaValue)} registrado!`);
      }

      if (parcValue !== null || !payPenaltyAmount) {
      const instRemaining = Number(inst.amount) - Number(inst.paid_amount);
      const paidValue = parcValue ?? instRemaining;
      if (paidValue <= 0) {
        if (multaValue > 0) {
          setPayAmount(""); setPayPenaltyAmount(""); setPayDate(opDate); setPayDialogId(null);
          fetchData(); return;
        }
        toast.error("Valor inválido"); return;
      }

        const { applied } = await registerPayment({
          loanId: inst.loan_id,
          amount: paidValue,
          clientId: inst.loans.client_id,
          clientName: (inst.loans?.clients?.name ?? "Cliente removido"),
          cashDate: payDate,
          origin: "atrasadas",
          installmentId: inst.id,
          startInstNumber: inst.number,
        });
        toast.success(`Parcela: ${formatCurrency(applied)} registrado!`);
      }
    } catch (err: any) {
      console.error("Overdue handlePay error:", err);
      toast.error(err?.message || "Erro ao registrar pagamento");
    }

    setPayAmount(""); setPayPenaltyAmount(""); setPayDate(opDate); setPayDialogId(null);
    fetchData();
  };

  const handleNotPaid = async (id: string) => {
    await supabase.from("installments").update({ status: "overdue" }).eq("id", id);
    toast.info("Parcela marcada como atrasada");
    fetchData();
  };

  const handleUndoOverdue = async (id: string) => {
    await supabase.from("installments").update({ status: "pending" }).eq("id", id);
    toast.success("Status restaurado para pendente!");
    fetchData();
  };

  const handleAddPenalty = async (inst: InstallmentWithLoan) => {
    const amount = parseFloat(penaltyAmount);
    if (!amount || amount <= 0) { toast.error("Valor inválido"); return; }

    const { data: { session } } = await supabase.auth.getSession();
    await supabase.from("penalties").insert({
      loan_id: inst.loan_id,
      installment_id: inst.id,
      amount,
      observation: penaltyObservation || null,
      user_id: session?.user?.id,
    } as any);

    await supabase.from("installments").update({
      penalty_amount: Number(inst.penalty_amount) + amount,
    }).eq("id", inst.id);

    const { data: penaltyInsts } = await supabase
      .from("installments")
      .select("*")
      .eq("loan_id", inst.loan_id)
      .eq("is_penalty", true);

    if (penaltyInsts && penaltyInsts.length > 0) {
      await supabase.from("installments").update({
        amount: Number(penaltyInsts[0].amount) + amount,
      }).eq("id", penaltyInsts[0].id);
    } else {
      const { data: maxInst } = await supabase
        .from("installments")
        .select("number")
        .eq("loan_id", inst.loan_id)
        .order("number", { ascending: false })
        .limit(1);
      const maxNum = maxInst?.[0]?.number ?? 0;
      await supabase.from("installments").insert({
        loan_id: inst.loan_id,
        number: maxNum + 1,
        amount,
        due_date: opDate,
        is_penalty: true,
        status: "pending",
      });
    }

    try {
      await createDailyEvent({
        cash_date: opDate,
        event_type: "multa_adicionada",
        client_id: inst.loans?.client_id || null,
        loan_id: inst.loan_id,
        installment_id: inst.id,
        amount_in: 0,
        amount_out: 0,
        observation: `Multa adicionada ${formatCurrency(amount)}${penaltyObservation ? ` - ${penaltyObservation}` : ""}`,
        origin: "atrasados",
      });
    } catch (err) { console.warn("[daily_event multa_adicionada] failed", err); }

    toast.success("Multa adicionada!");
    setPenaltyAmount(""); setPenaltyObservation(""); setPenaltyDialogId(null);
    fetchData();
  };

  let displayed = groups;
  if (isAdmin && selectedAdminId) displayed = displayed.filter((g) => g.adminId === selectedAdminId);
  if (isAdmin && selectedWorkerId) displayed = displayed.filter((g) => g.workerId === selectedWorkerId);

  const workerLabel = (id: string | null) => workers.find((w) => w.id === id)?.nome ?? "—";
  const adminLabel = (id: string | null) => admins.find((a) => a.id === id)?.nome ?? "—";

  return (
    <div className="mx-auto max-w-lg p-4">
      {isAdmin && (
        <Card className="mb-3">
          <CardContent className="p-3 space-y-2">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase">Filtro hierárquico</p>
            <WorkerFilterSelect />
          </CardContent>
        </Card>
      )}

      {loading ? (
        <p className="text-center text-muted-foreground">Carregando...</p>
      ) : displayed.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center p-8">
            <p className="text-lg font-semibold">Nenhum cliente atrasado! 🎉</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {displayed.map((client) => (
            <Collapsible
              key={client.key}
              open={expandedClient === client.key}
              onOpenChange={(o) => setExpandedClient(o ? client.key : null)}
            >
              <CollapsibleTrigger asChild>
                <Card className="cursor-pointer border-destructive/30 hover:border-destructive/60 transition-colors">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-semibold">{client.clientName}</p>
                        <p className="text-sm text-muted-foreground">
                          {client.installmentCount} parcela{client.installmentCount > 1 ? "s" : ""} vencida{client.installmentCount > 1 ? "s" : ""}
                          {client.loans.length > 1 && <> · {client.loans.length} empréstimos atrasados</>}
                        </p>
                        <p className="text-sm font-medium text-destructive">
                          {client.overdueDays} dia{client.overdueDays !== 1 ? "s" : ""} em atraso
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Total: {formatCurrency(client.totalOverdue)}
                        </p>
                        {client.penaltyTotal > 0 && (
                          <p className="text-xs text-destructive">
                            Multa: {formatCurrency(client.penaltyTotal)}
                            {client.penaltyPaid > 0 && <span className="text-success"> (pago: {formatCurrency(client.penaltyPaid)})</span>}
                          </p>
                        )}
                        {isAdmin && (
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            Trab.: {workerLabel(client.workerId)}
                            {isSuperAdmin && <> · Adm.: {adminLabel(client.adminId)}</>}
                          </p>
                        )}
                      </div>
                      <ChevronDown className={`h-5 w-5 text-muted-foreground transition-transform ${expandedClient === client.key ? "rotate-180" : ""}`} />
                    </div>
                  </CardContent>
                </Card>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 space-y-3 pl-2">
                {client.loans.map((group) => (
                  <div key={group.loanId} className="space-y-2">
                    {client.loans.length > 1 && (
                      <p className="text-[11px] font-semibold text-muted-foreground uppercase">
                        Empréstimo · {group.installments.length} parcela{group.installments.length > 1 ? "s" : ""} vencida{group.installments.length > 1 ? "s" : ""} · {formatCurrency(group.totalOverdue)}
                      </p>
                    )}
                {group.installments.map((inst) => {
                  const instRemaining = Number(inst.amount) - Number(inst.paid_amount);
                  const days = calculateOverdueDays(inst.due_date, group.paymentType);
                  const penaltyPending = group.penaltyTotal - group.penaltyPaid;
                  return (
                    <Card key={inst.id}>
                      <CardContent className="p-3">
                        <div className="mb-2 flex items-center justify-between">
                          <div>
                            <p className="font-semibold">Parcela {inst.number}</p>
                            <p className="text-sm text-muted-foreground">
                              Venc: {format(new Date(inst.due_date + "T12:00:00"), "dd/MM/yyyy")} • {formatCurrency(Number(inst.amount))}
                            </p>
                            <p className="text-xs text-destructive font-medium">
                              {days} dia{days !== 1 ? "s" : ""} de atraso
                            </p>
                            {Number(inst.paid_amount) > 0 && (
                              <p className="text-xs text-muted-foreground">Pago: {formatCurrency(Number(inst.paid_amount))} / Resta: {formatCurrency(instRemaining)}</p>
                            )}
                          </div>
                          <Badge className={getStatusColor("overdue")}>{getStatusLabel("overdue")}</Badge>
                        </div>
                        <div className="flex gap-2">
                          <Dialog open={payDialogId === inst.id} onOpenChange={(o) => { setPayDialogId(o ? inst.id : null); if (!o) { setPayAmount(""); setPayPenaltyAmount(""); } }}>
                            <DialogTrigger asChild>
                              <Button size="sm" className="flex-1 bg-success hover:bg-success/90">
                                <Plus className="mr-1 h-3 w-3" /> Pagamento
                              </Button>
                            </DialogTrigger>
                            <DialogContent>
                              <DialogHeader><DialogTitle>Registrar Pagamento</DialogTitle></DialogHeader>
                              <div className="space-y-3">
                                <p className="text-sm text-muted-foreground">
                                  {group.clientName} — Parcela {inst.number} — {formatCurrency(Number(inst.amount))}
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
                                <Button onClick={() => handlePay(inst.id)} className="w-full bg-success hover:bg-success/90">Confirmar Pagamento</Button>
                              </div>
                            </DialogContent>
                          </Dialog>
                          <Button size="sm" variant="destructive" className="flex-1" onClick={() => handleNotPaid(inst.id)}>
                            <XCircle className="mr-1 h-3 w-3" /> Não Pagou
                          </Button>
                          <Dialog open={penaltyDialogId === inst.id} onOpenChange={(o) => { setPenaltyDialogId(o ? inst.id : null); if (!o) { setPenaltyAmount(""); setPenaltyObservation(""); } }}>

                            <DialogTrigger asChild>
                              <Button size="sm" variant="outline" className="px-2">
                                <AlertTriangle className="h-3 w-3" />
                              </Button>
                            </DialogTrigger>
                            <DialogContent>
                              <DialogHeader><DialogTitle>Adicionar Multa</DialogTitle></DialogHeader>
                              <div className="space-y-3">
                                <p className="text-sm text-muted-foreground">{group.clientName} — Parcela {inst.number}</p>
                                <div>
                                  <Label>Valor da multa</Label>
                                  <Input type="number" placeholder="Valor" value={penaltyAmount} onChange={(e) => setPenaltyAmount(e.target.value)} />
                                </div>
                                <div>
                                  <Label>Observação (opcional)</Label>
                                  <Textarea placeholder="Motivo da multa..." value={penaltyObservation} onChange={(e) => setPenaltyObservation(e.target.value)} />
                                </div>
                                <Button onClick={() => handleAddPenalty(inst)} className="w-full">Adicionar Multa</Button>
                              </div>
                            </DialogContent>
                          </Dialog>
                        </div>
                        <Button size="sm" variant="outline" className="w-full mt-1" onClick={() => handleUndoOverdue(inst.id)}>
                          <Undo2 className="mr-1 h-3 w-3" /> Desfazer "Não Pagou"
                        </Button>
                      </CardContent>
                    </Card>
                  );
                })}
                    <Button
                      variant="link"
                      size="sm"
                      className="w-full text-primary"
                      onClick={() => navigate(`/loans/${group.loanId}`)}
                    >
                      Ver empréstimo completo →
                    </Button>
                  </div>
                ))}
              </CollapsibleContent>
            </Collapsible>
          ))}
        </div>
      )}
    </div>
  );
}
