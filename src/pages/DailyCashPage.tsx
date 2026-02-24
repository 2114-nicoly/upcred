import { useEffect, useState, useCallback } from "react";
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatCurrency, getStatusColor, getStatusLabel, calculateOverdueDays } from "@/lib/loan-utils";
import { updateCashBalance, createCashMovement } from "@/lib/cash-utils";
import {
  CalendarDays, CheckCircle, XCircle, DollarSign, AlertTriangle,
  Plus, ChevronDown, Undo2, Lock, ChevronLeft, ChevronRight, Clock
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

export default function DailyCashPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const dateParam = searchParams.get("date");
  const [selectedDate, setSelectedDate] = useState(dateParam || format(new Date(), "yyyy-MM-dd"));
  const today = format(new Date(), "yyyy-MM-dd");

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

  // Section states
  const [paidOpen, setPaidOpen] = useState(true);
  const [notPaidOpen, setNotPaidOpen] = useState(true);

  useEffect(() => {
    setPayDate(selectedDate);
  }, [selectedDate]);

  const changeDate = (offset: number) => {
    const d = new Date(selectedDate + "T12:00:00");
    const newDate = format(addDays(d, offset), "yyyy-MM-dd");
    setSelectedDate(newDate);
    setSearchParams({ date: newDate });
  };

  const fetchData = useCallback(async () => {
    setLoading(true);

    // 1) Get daily cash status
    const { data: dcData } = await supabase
      .from("daily_cash")
      .select("*")
      .eq("cash_date", selectedDate)
      .maybeSingle();
    setDailyCashStatus(dcData?.status || "open");

    // 2) Parcelas que vencem na data selecionada (não pagas)
    const { data: dueTodayData } = await supabase
      .from("installments")
      .select("*, loans(id, client_id, amount, total_amount, installment_count, payment_type, clients(id, name))")
      .eq("due_date", selectedDate)
      .neq("status", "paid")
      .eq("is_penalty", false)
      .order("number");

    // 3) Parcelas atrasadas: próxima parcela vencida não quitada de cada empréstimo
    const { data: overdueData } = await supabase
      .from("installments")
      .select("*, loans(id, client_id, amount, total_amount, installment_count, payment_type, clients(id, name))")
      .lt("due_date", selectedDate)
      .neq("status", "paid")
      .eq("is_penalty", false)
      .order("number");

    // Group overdue by loan_id, pick first (lowest number) per loan
    const overdueByLoan: Record<string, InstallmentWithLoan> = {};
    const overdueInsts = (overdueData as unknown as InstallmentWithLoan[]) || [];
    for (const inst of overdueInsts) {
      // Only include if remaining > 0
      if (Number(inst.amount) - Number(inst.paid_amount) <= 0.01) continue;
      if (!overdueByLoan[inst.loan_id] || inst.number < overdueByLoan[inst.loan_id].number) {
        overdueByLoan[inst.loan_id] = inst;
      }
    }

    const dueToday = (dueTodayData as unknown as InstallmentWithLoan[]) || [];
    
    // Combine: due today + overdue (1 per loan, exclude loans already in dueToday)
    const dueTodayLoanIds = new Set(dueToday.map(i => i.loan_id));
    const overdueItems = Object.values(overdueByLoan).filter(i => !dueTodayLoanIds.has(i.loan_id));
    
    // 4) Parcelas pagas na data selecionada (paid_at matches selected date)
    const { data: paidData } = await supabase
      .from("installments")
      .select("*, loans(id, client_id, amount, total_amount, installment_count, payment_type, clients(id, name))")
      .eq("is_penalty", false)
      .gte("paid_at", selectedDate + "T00:00:00")
      .lt("paid_at", format(addDays(new Date(selectedDate + "T12:00:00"), 1), "yyyy-MM-dd") + "T00:00:00")
      .order("number");

    const paidInsts = (paidData as unknown as InstallmentWithLoan[]) || [];
    setPaidInstallments(paidInsts);

    // 5) Not paid marks for the selected date
    const { data: npData } = await supabase
      .from("not_paid_marks")
      .select("*")
      .eq("mark_date", selectedDate);

    const npMarks = (npData || []) as unknown as NotPaidMark[];
    
    // Fetch installment details for not-paid marks
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

    // Filter out from pending: items already paid today or marked as not-paid today
    const paidInstIds = new Set(paidInsts.map(i => i.id));
    const npMarkInstIds = new Set(npMarks.map(m => m.installment_id));
    
    const allPending = [...dueToday, ...overdueItems].filter(
      i => !paidInstIds.has(i.id) && !npMarkInstIds.has(i.id)
    );
    setPendingInstallments(allPending);

    // 6) Progress for all unique loans
    const allLoanIds = new Set([
      ...allPending.map(i => i.loan_id),
      ...paidInsts.map(i => i.loan_id),
      ...enrichedNpMarks.filter(m => m.installment).map(m => m.loan_id),
    ]);
    
    const progressMap: Record<string, LoanProgress> = {};
    for (const lid of allLoanIds) {
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
  }, [selectedDate]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // === Payment handler ===
  const handlePay = async (id: string) => {
    const allInsts = [...pendingInstallments, ...paidInstallments];
    const inst = allInsts.find(i => i.id === id);
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
          resetPayDialog(); fetchData(); return;
        }
        toast.error("Informe um valor válido"); return;
      }

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
      if (totalApplied > 0) {
        await updateCashBalance({ available_cash: totalApplied });
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

    resetPayDialog();
    fetchData();
  };

  const resetPayDialog = () => {
    setPayAmount(""); setPayPenaltyAmount(""); setPayDate(selectedDate); setPayDialogId(null);
  };

  // === Not Paid handler ===
  const handleNotPaid = async (id: string) => {
    const inst = pendingInstallments.find(i => i.id === id);
    if (!inst) return;

    await supabase.from("not_paid_marks").insert({
      mark_date: selectedDate,
      installment_id: inst.id,
      loan_id: inst.loan_id,
      client_id: inst.loans.client_id,
      observation: notPaidObs || null,
    });

    setNotPaidObs("");
    setNotPaidDialogId(null);
    toast.info("Marcado como 'Não Pagou'");
    fetchData();
  };

  // === Undo not paid ===
  const handleUndoNotPaid = async (markId: string) => {
    await supabase.from("not_paid_marks").delete().eq("id", markId);
    toast.success("Marcação desfeita!");
    fetchData();
  };

  // === Undo payment ===
  const handleUndoPayment = async (id: string) => {
    await supabase.from("installments").update({ status: "pending", paid_at: null, paid_amount: 0 }).eq("id", id);
    toast.success("Pagamento desfeito!");
    fetchData();
  };

  // === Close daily cash ===
  const handleCloseCash = async () => {
    const totalReceived = paidInstallments.reduce((s, i) => s + Number(i.paid_amount), 0);
    
    // Calculate penalty received on this date
    const { data: penaltyMovements } = await supabase
      .from("cash_movements")
      .select("amount")
      .eq("type", "recebimento_multa")
      .gte("created_at", selectedDate + "T00:00:00")
      .lt("created_at", format(addDays(new Date(selectedDate + "T12:00:00"), 1), "yyyy-MM-dd") + "T00:00:00");
    
    const totalPenaltyReceived = (penaltyMovements || []).reduce((s: number, m: any) => s + Number(m.amount), 0);

    const { data: existing } = await supabase
      .from("daily_cash")
      .select("id")
      .eq("cash_date", selectedDate)
      .maybeSingle();

    const payload = {
      cash_date: selectedDate,
      status: "closed",
      total_received: totalReceived,
      total_penalty_received: totalPenaltyReceived,
      total_not_paid_count: notPaidMarks.length,
      total_items_treated: paidInstallments.length + notPaidMarks.length,
      closed_at: new Date().toISOString(),
    };

    if (existing) {
      await supabase.from("daily_cash").update(payload).eq("id", existing.id);
    } else {
      await supabase.from("daily_cash").insert(payload);
    }

    toast.success("Caixa do dia fechado!");
    setDailyCashStatus("closed");
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
      <Card key={inst.id} className={`overflow-hidden ${isOverdue ? "border-destructive/50" : ""}`}>
        <CardContent className="p-4">
          <div className="mb-2 flex items-center justify-between">
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
              <DialogContent>
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
              <DialogContent>
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
    return (
      <Card key={inst.id} className="overflow-hidden border-success/30">
        <CardContent className="p-4">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <p className="font-semibold">{inst.loans.clients.name}</p>
              <p className="text-sm text-muted-foreground">
                Parcela {inst.number}/{inst.loans.installment_count}
              </p>
              <p className="text-sm text-success font-medium">Pago: {formatCurrency(Number(inst.paid_amount))}</p>
              {lp && (
                <p className="text-xs text-muted-foreground">
                  {lp.progress % 1 === 0 ? lp.progress : lp.progress.toFixed(1)}/{lp.total} pagas • Resta: {formatCurrency(Math.max(0, lp.remaining))}
                </p>
              )}
            </div>
            <Badge className="bg-paid text-paid-foreground">Pago</Badge>
          </div>
          <Button size="sm" variant="outline" className="w-full" onClick={() => handleUndoPayment(inst.id)}>
            <Undo2 className="mr-1 h-3 w-3" /> Desfazer Pagamento
          </Button>
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
          <Button size="sm" variant="outline" className="w-full" onClick={() => handleUndoNotPaid(mark.id)}>
            <Undo2 className="mr-1 h-3 w-3" /> Desfazer
          </Button>
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
        {dailyCashStatus === "closed" && (
          <div className="mt-2 rounded-lg bg-success/10 border border-success/30 p-2 text-center">
            <p className="text-sm font-medium text-success flex items-center justify-center gap-1">
              <Lock className="h-4 w-4" /> Caixa Fechado
            </p>
          </div>
        )}
      </div>

      {/* Summary cards */}
      <div className="mb-4 grid grid-cols-3 gap-2">
        <Card className="text-center">
          <CardContent className="p-2">
            <AlertTriangle className="mx-auto mb-1 h-4 w-4 text-warning" />
            <p className="text-[10px] text-muted-foreground">Pendentes</p>
            <p className="text-sm font-bold">{pendingInstallments.length}</p>
            <p className="text-[10px] text-muted-foreground">{formatCurrency(totalPendingValue)}</p>
          </CardContent>
        </Card>
        <Card className="text-center">
          <CardContent className="p-2">
            <CheckCircle className="mx-auto mb-1 h-4 w-4 text-success" />
            <p className="text-[10px] text-muted-foreground">Pagos</p>
            <p className="text-sm font-bold text-success">{paidInstallments.length}</p>
            <p className="text-[10px] text-success">{formatCurrency(totalPaidValue)}</p>
          </CardContent>
        </Card>
        <Card className="text-center">
          <CardContent className="p-2">
            <XCircle className="mx-auto mb-1 h-4 w-4 text-destructive" />
            <p className="text-[10px] text-muted-foreground">Não Pagos</p>
            <p className="text-sm font-bold text-destructive">{notPaidMarks.length}</p>
          </CardContent>
        </Card>
      </div>

      {loading ? (
        <p className="text-center text-muted-foreground">Carregando...</p>
      ) : (
        <>
          {/* A) Pendentes */}
          <div className="mb-4">
            <h2 className="text-lg font-semibold mb-2 flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-warning" /> Pendentes ({pendingInstallments.length})
            </h2>
            {pendingInstallments.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center p-6">
                  <CheckCircle className="mb-2 h-10 w-10 text-success" />
                  <p className="text-sm font-medium">Tudo tratado!</p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {pendingInstallments.map(renderPendingCard)}
              </div>
            )}
          </div>

          {/* B) Pagos */}
          {paidInstallments.length > 0 && (
            <Collapsible open={paidOpen} onOpenChange={setPaidOpen} className="mb-4">
              <CollapsibleTrigger asChild>
                <Button variant="outline" className="w-full border-success/50 text-success">
                  <CheckCircle className="mr-2 h-4 w-4" />
                  Pagos do Dia ({paidInstallments.length}) — {formatCurrency(totalPaidValue)}
                  <ChevronDown className={`ml-auto h-4 w-4 transition-transform ${paidOpen ? "rotate-180" : ""}`} />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 space-y-3">
                {paidInstallments.map(renderPaidCard)}
              </CollapsibleContent>
            </Collapsible>
          )}

          {/* C) Não Pagos */}
          {notPaidMarks.length > 0 && (
            <Collapsible open={notPaidOpen} onOpenChange={setNotPaidOpen} className="mb-4">
              <CollapsibleTrigger asChild>
                <Button variant="outline" className="w-full border-destructive/50 text-destructive">
                  <XCircle className="mr-2 h-4 w-4" />
                  Não Pagos ({notPaidMarks.length})
                  <ChevronDown className={`ml-auto h-4 w-4 transition-transform ${notPaidOpen ? "rotate-180" : ""}`} />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 space-y-3">
                {notPaidMarks.map(renderNotPaidCard)}
              </CollapsibleContent>
            </Collapsible>
          )}

          {/* Close cash button */}
          {dailyCashStatus !== "closed" && (
            <Button
              onClick={handleCloseCash}
              className="w-full mt-2"
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
