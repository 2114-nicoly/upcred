import { useEffect, useState, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/loan-utils";
import {
  getCashBalance,
  updateCashBalance,
  createCashMovement,
  recalculateCashBalanceFromLedger,
  CashBalance,
  getCurrentDailyCashScope,
  applyDailyCashScope,
} from "@/lib/cash-utils";
import { getDailyEvents, createDailyEvent, undoDailyEvent, getEventTypeLabel, getEventTypeColor, isFinancialEvent, isReversalEvent, DailyEvent } from "@/lib/daily-events";
import { assertCashOpen } from "@/lib/cash-lock";
import { logAction, getCurrentActorIdentity } from "@/lib/audit-utils";
import {
  Wallet, TrendingUp, TrendingDown, AlertTriangle, Plus, Minus, Settings,
  History, ChevronLeft, ChevronRight, CheckCircle, XCircle, RefreshCw, Lock, Unlock,
  DollarSign, ArrowDownCircle, ArrowUpCircle, Undo2, FileText
} from "lucide-react";
import { EmptyState, CardSkeleton } from "@/components/LoadingSkeleton";
import { format, addDays } from "date-fns";
import { ptBR } from "date-fns/locale";
import { toast } from "sonner";
import { useConfirm } from "@/hooks/useConfirm";
import { useAuth } from "@/hooks/useAuth";
import { useWorkerFilter } from "@/hooks/useWorkerFilter";
import WorkerFilterSelect from "@/components/WorkerFilterSelect";
import DateNavigator from "@/components/DateNavigator";
import NoMovementHint from "@/components/NoMovementHint";
import OpenCashBanner from "@/components/OpenCashBanner";
import { computeDailyTotals, getDailyCollectionSummary } from "@/lib/daily-totals";

type ActiveSection = "resumo" | "pagos" | "naopagos" | "novos" | "importados" | "movimentos";

export default function CaixaPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const confirm = useConfirm();
  const { isAdmin, isSuperAdmin } = useAuth();
  const { selectedAdminId, selectedWorkerId, workers } = useWorkerFilter();
  const today = format(new Date(), "yyyy-MM-dd");
  const [selectedDate, setSelectedDate] = useState(searchParams.get("date") || today);
  const [balance, setBalance] = useState<CashBalance | null>(null);
  const [events, setEvents] = useState<DailyEvent[]>([]);
  const [clientNames, setClientNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [activeSection, setActiveSection] = useState<ActiveSection>("resumo");
  const [dailyCashStatus, setDailyCashStatus] = useState<string>("open");
  const [dailyCashRow, setDailyCashRow] = useState<any | null>(null);
  const [inheritedOpening, setInheritedOpening] = useState<number>(0);
  const [collectionSummary, setCollectionSummary] = useState<{ expectedToReceiveToday: number; receivedToday: number; pendingToReceiveToday: number; cashExpectedForClosing: number }>({ expectedToReceiveToday: 0, receivedToday: 0, pendingToReceiveToday: 0, cashExpectedForClosing: 0 });
  const [summaryLoading, setSummaryLoading] = useState(true);
  const expectedToReceiveToday = collectionSummary.expectedToReceiveToday;
  const receivedToday = collectionSummary.receivedToday;
  const pendingToReceiveToday = collectionSummary.pendingToReceiveToday;
  const [submitting, setSubmitting] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const [undoTarget, setUndoTarget] = useState<DailyEvent | null>(null);
  const [undoReason, setUndoReason] = useState("");

  // Manual movement dialog
  const [manualType, setManualType] = useState<"entrada_manual" | "saida_manual" | "ajuste_manual" | null>(null);
  const [manualAmount, setManualAmount] = useState("");
  const [manualObs, setManualObs] = useState("");

  // Close cash dialog
  const [closeOpen, setCloseOpen] = useState(false);
  const [countedAmount, setCountedAmount] = useState("");
  const [closeNote, setCloseNote] = useState("");

  // sync URL ↔ state
  useEffect(() => {
    const urlDate = searchParams.get("date") || today;
    setSelectedDate((current) => (current === urlDate ? current : urlDate));
  }, [searchParams, today]);

  const handleDateChange = (newDate: string) => {
    setSelectedDate(newDate);
    if (newDate === today) setSearchParams({});
    else setSearchParams({ date: newDate });
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [bal, dayEvents, dcRes] = await Promise.all([
        getCashBalance(),
        getDailyEvents(selectedDate),
        applyDailyCashScope(supabase.from("daily_cash").select("*").eq("cash_date", selectedDate), await getCurrentDailyCashScope()).maybeSingle(),
      ]);
      setBalance(bal);
      setEvents(dayEvents);
      const dc = (dcRes?.data as any) || null;
      setDailyCashRow(dc);
      setDailyCashStatus(
        dc && dc.status !== "cancelled_empty" && dc.status !== "void"
          ? (dc.status || "open")
          : "sem_caixa"
      );

      // Inherit opening balance from last closed daily_cash if current row is open/missing.
      const currentOpening = Number(dc?.opening_balance || 0);
      const currentClosed = dc?.status === "closed";
      if (!currentClosed && currentOpening <= 0.001) {
        try {
          const scope = await getCurrentDailyCashScope();
          const prevQ = applyDailyCashScope(
            supabase.from("daily_cash")
              .select("expected_closing_balance, counted_closing_balance, cash_date, status")
              .lt("cash_date", selectedDate)
              .eq("status", "closed")
              .order("cash_date", { ascending: false })
              .limit(1),
            scope
          );
          const { data: prev } = await prevQ;
          const prevRow = (prev?.[0] as any) || null;
          if (prevRow) {
            const inh = Number(prevRow.counted_closing_balance ?? prevRow.expected_closing_balance ?? 0);
            setInheritedOpening(isFinite(inh) ? inh : 0);
          } else {
            setInheritedOpening(0);
          }
        } catch {
          setInheritedOpening(0);
        }
      } else {
        setInheritedOpening(0);
      }

      // Fetch client names for all events
      const clientIds = [...new Set(dayEvents.filter(e => e.client_id).map(e => e.client_id!))];
      if (clientIds.length > 0) {
        const { data: clients } = await supabase.from("clients").select("id, name").in("id", clientIds);
        const names: Record<string, string> = {};
        for (const c of (clients || [])) names[c.id] = c.name;
        setClientNames(names);
      }
    } catch (err) {
      console.error("Error in CaixaPage fetchData:", err);
      toast.error("Erro ao carregar dados do caixa");
    } finally {
      // Resumo unificado dentro do mesmo ciclo — atualização atômica para não piscar.
      try {
        setSummaryLoading(true);
        const summary = await getDailyCollectionSummary(selectedDate, {
          workerId: selectedWorkerId || null,
          adminId: selectedAdminId || null,
        });
        setCollectionSummary(summary);
      } catch {
        // mantém valores anteriores
      } finally {
        setSummaryLoading(false);
      }
      setLoading(false);
    }
  }, [selectedDate, selectedAdminId, selectedWorkerId]);

  useEffect(() => { fetchData(); }, [fetchData]);


  const cashState: "sem_caixa" | "open" | "closed" =
    dailyCashStatus === "closed" ? "closed" : dailyCashStatus === "sem_caixa" || !dailyCashRow ? "sem_caixa" : "open";
  const isClosed = cashState === "closed";
  const isNotStarted = cashState === "sem_caixa";
  // Block financial actions when closed OR not yet opened.
  const cashLocked = isClosed || isNotStarted;
  const workerIsClosed = !isAdmin && !isSuperAdmin && isClosed;

  // Apply hierarchical scope filter to events list
  let scopedEvents = events;
  if (isAdmin && selectedAdminId) scopedEvents = scopedEvents.filter((e: any) => e.admin_id === selectedAdminId);
  if (isAdmin && selectedWorkerId) scopedEvents = scopedEvents.filter((e: any) => e.worker_id === selectedWorkerId);

  // Unified totals from daily_events (live, used when not yet closed).
  const liveTotals = computeDailyTotals(scopedEvents as any, 0);
  const saldoDia = liveTotals.entradas - liveTotals.saidas;

  // When closed, prefer authoritative totals stored in daily_cash.
  const summary = isClosed && dailyCashRow ? {
    opening: Number(dailyCashRow.opening_balance || 0),
    totalIn: Number(dailyCashRow.total_in || 0),
    totalOut: Number(dailyCashRow.total_out || 0),
    received: Number(dailyCashRow.total_received || 0),
    penalty: Number(dailyCashRow.total_penalty_received || 0),
    lent: Number(dailyCashRow.total_lent || 0),
    manualIn: Number(dailyCashRow.total_manual_in || 0),
    manualOut: Number(dailyCashRow.total_manual_out || 0),
    expected: Number(dailyCashRow.expected_closing_balance || 0),
    notPaidCount: Number(dailyCashRow.total_not_paid_count || 0),
    eventsCount: Number(dailyCashRow.total_events_count || scopedEvents.length),
  } : {
    opening: inheritedOpening,
    totalIn: liveTotals.entradas,
    totalOut: liveTotals.saidas,
    received: liveTotals.pagamentos,
    penalty: liveTotals.multas,
    lent: liveTotals.emprestimosLiberados + liveTotals.renovacoes + liveTotals.renegociacoes,
    manualIn: liveTotals.entradasManuais,
    manualOut: liveTotals.saidasManuais,
    // Valor Esperado no Caixa = opening + pagamentos + multas + entradas manuais - emprestimos - saidas manuais.
    // (Sem emprestimo_importado, sem saldo a receber futuro.)
    expected: collectionSummary.cashExpectedForClosing,
    notPaidCount: liveTotals.naoPagos,
    eventsCount: scopedEvents.length,
  };
  const expectedDisplay = Math.max(0, summary.expected);
  const expectedNegative = summary.expected < -0.005;

  const pagamentos = scopedEvents.filter(e => e.event_type === "pagamento" || e.event_type === "recebimento_multa");
  const naoPagos = scopedEvents.filter(e => e.event_type === "nao_pagou");
  const novos = scopedEvents.filter(e => ["emprestimo_novo","renovacao","renegociacao"].includes(e.event_type));
  const importados = scopedEvents.filter(e => e.event_type === "emprestimo_importado");
  const movimentos = scopedEvents.filter(e => ["entrada_manual", "saida_manual", "ajuste_manual", "saida"].includes(e.event_type));

  const handleManualMovement = async () => {
    if (!manualType || submitting) return;
    if (manualType === "ajuste_manual" && !isAdmin && !isSuperAdmin) { setManualType(null); return; }
    const amount = parseFloat(manualAmount);
    if (isNaN(amount)) { toast.error("Informe um valor válido"); return; }
    if (manualType !== "ajuste_manual" && amount <= 0) { toast.error("Informe um valor maior que zero"); return; }

    const labelMap = { entrada_manual: "Aportar dinheiro na rota?", saida_manual: "Retirar dinheiro da rota?", ajuste_manual: "Ajustar saldo do caixa?" } as const;
    const descMap = {
      entrada_manual: "O valor será somado ao caixa disponível.",
      saida_manual: "O valor será descontado do caixa disponível.",
      ajuste_manual: "O saldo do caixa será definido para o valor informado, gerando um lançamento de ajuste.",
    } as const;
    const ok = await confirm({
      title: labelMap[manualType],
      description: descMap[manualType],
      affected: [
        { label: "Valor", value: formatCurrency(Math.abs(amount)) },
        ...(manualObs ? [{ label: "Obs.", value: manualObs }] : []),
      ],
      confirmText: "Confirmar", destructive: manualType === "saida_manual",
    });
    if (!ok) return;

    setSubmitting(true);
    try {
      await assertCashOpen(selectedDate);

      if (manualType === "ajuste_manual") {
        const current = await getCashBalance();
        if (!current) { toast.error("Erro ao obter saldo"); return; }
        const diff = amount - Number(current.available_cash);
        await updateCashBalance({ available_cash: diff });
        await createCashMovement({
          type: "ajuste_manual",
          amount: diff,
          observation: manualObs || `Ajuste: saldo definido para ${amount.toFixed(2)}`,
          cash_date: selectedDate,
        });
        await createDailyEvent({
          cash_date: selectedDate,
          event_type: "ajuste_manual",
          amount_in: diff >= 0 ? diff : 0,
          amount_out: diff < 0 ? Math.abs(diff) : 0,
          observation: manualObs || `Ajuste: saldo definido para ${amount.toFixed(2)}`,
          origin: "geral",
        });
        await logAction("ajuste_caixa", "cash", null, null, { amount, diff }, manualObs || null);
      } else {
        const cashChange = manualType === "saida_manual" ? -amount : amount;
        await updateCashBalance({ available_cash: cashChange });
        await createCashMovement({
          type: manualType,
          amount: manualType === "saida_manual" ? -amount : amount,
          observation: manualObs || null,
          cash_date: selectedDate,
        });
        await createDailyEvent({
          cash_date: selectedDate,
          event_type: manualType,
          amount_in: manualType === "entrada_manual" ? amount : 0,
          amount_out: manualType === "saida_manual" ? amount : 0,
          observation: manualObs || null,
          origin: "geral",
        });
        await logAction(manualType === "entrada_manual" ? "aporte" : "retirada", "cash", null, null, { amount }, manualObs || null);
      }

      toast.success("Movimentação registrada!");
      setManualType(null);
      setManualAmount("");
      setManualObs("");
      await fetchData();
    } catch (err: any) {
      console.error("[caixa] manual movement failed", err);
      toast.error(err?.message || "Erro ao registrar movimentação");
    } finally {
      setSubmitting(false);
    }
  };

  const openCloseDialog = () => {
    if (isClosed) return;
    setCountedAmount(Math.max(0, summary.expected).toFixed(2));
    setCloseNote("");
    setCloseOpen(true);
  };

  const handleCloseCash = async () => {
    if (submitting || isClosed) return;
    const counted = parseFloat(countedAmount);
    if (!isFinite(counted)) { toast.error("Informe o valor contado no caixa"); return; }
    const diff = counted - summary.expected;
    if (Math.abs(diff) > 0.01 && closeNote.trim().length < 3) {
      toast.error("Informe a observação para justificar a diferença"); return;
    }
    setSubmitting(true);
    try {
      const { error } = await supabase.rpc(
        "close_daily_cash_v2" as any,
        { p_cash_date: selectedDate, p_counted: counted, p_note: closeNote.trim() || null } as any
      );
      if (error) throw error;
      toast.success(`Caixa fechado! Diferença: ${formatCurrency(diff)}`);
      setCloseOpen(false);
      await fetchData();
    } catch (err: any) {
      console.error("[caixa] close failed", err);
      toast.error(err?.message || "Erro ao fechar caixa");
    } finally {
      setSubmitting(false);
    }
  };

  const handleReopenCash = async () => {
    if (submitting) return;
    if (!isAdmin && !isSuperAdmin) { toast.error("Apenas administradores podem reabrir o caixa."); return; }
    if (reopenReason.trim().length < 3) { toast.error("Informe o motivo da reabertura."); return; }
    setSubmitting(true);
    try {
      const { error } = await supabase.rpc("reopen_daily_cash" as any, { p_cash_date: selectedDate, p_reason: reopenReason.trim() } as any);
      if (error) throw error;
      const actor = await getCurrentActorIdentity();
      await logAction(
        "reabrir_caixa",
        "cash",
        null,
        null,
        {
          cash_date: selectedDate,
          reopened_by: actor.id,
          reopened_by_name: actor.name,
          reopened_by_role: actor.role,
          reason: reopenReason.trim(),
          reopened_at: new Date().toISOString(),
        },
        `Reabertura de caixa (${selectedDate}): ${reopenReason.trim()}`,
      );
      toast.success("Caixa reaberto!");
      setReopenOpen(false);
      setReopenReason("");
      await fetchData();
    } catch (err: any) {
      console.error("[caixa] reopen failed", err);
      toast.error(err?.message || "Erro ao reabrir caixa");
    } finally {
      setSubmitting(false);
    }
  };


  const handleRecalculate = async () => {
    await recalculateCashBalanceFromLedger();
    toast.success("Caixa recalculado com sucesso!");
    fetchData();
  };

  const handleUndoEvent = (event: DailyEvent) => {
    if (cashLocked) { toast.error("Caixa fechado. Reabra o caixa antes de desfazer lançamentos."); return; }
    setUndoReason("");
    setUndoTarget(event);
  };

  const confirmUndoEvent = async () => {
    if (!undoTarget || submitting) return;
    if (undoReason.trim().length < 3) {
      toast.error("Informe o motivo do estorno (mínimo 3 caracteres).");
      return;
    }
    setSubmitting(true);
    try {
      await undoDailyEvent(undoTarget, undoReason.trim());
      await logAction(
        undoTarget.event_type === "pagamento" || undoTarget.event_type === "recebimento_multa"
          ? "desfazer_pagamento"
          : "ajuste_caixa",
        "cash",
        undoTarget.id,
        { event_type: undoTarget.event_type, amount_in: undoTarget.amount_in, amount_out: undoTarget.amount_out },
        { reversed: true, reason: undoReason.trim() },
        `Estorno: ${undoReason.trim()}`,
      );
      toast.success("Lançamento desfeito!");
      setUndoTarget(null);
      setUndoReason("");
      await fetchData();
    } catch (err: any) {
      toast.error(err?.message || "Erro ao desfazer lançamento");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="mx-auto max-w-lg p-3 space-y-3"><CardSkeleton count={3} /></div>;

  const showAjuste = isAdmin || isSuperAdmin;

  return (
    <div className="mx-auto max-w-lg p-3 pb-36 space-y-3">
      {isAdmin && (
        <div className="sticky top-0 z-20 -mx-3 -mt-3 px-3 pt-3 pb-2 bg-background/95 backdrop-blur border-b">
          <Card>
            <CardContent className="p-3 space-y-2">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase">1. Trabalhador/equipe</p>
              <WorkerFilterSelect />
              {!selectedWorkerId && !selectedAdminId && isSuperAdmin && (
                <p className="text-[10px] text-warning">Selecione um trabalhador ou administrador para escopo correto.</p>
              )}
              {(selectedAdminId || selectedWorkerId) && (
                <p className="text-[10px] text-muted-foreground">
                  Mostrando {scopedEvents.length} de {events.length} eventos do dia
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}
      {/* Date navigation */}
      <DateNavigator date={selectedDate} onChange={handleDateChange} origin="caixa" />
      <NoMovementHint
        date={selectedDate}
        hasMovement={events.length > 0 || !!dailyCashRow}
        onChange={handleDateChange}
      />

      <div className="flex justify-center">
        <Badge
          className={
            isClosed
              ? "bg-destructive text-destructive-foreground"
              : isNotStarted
                ? "bg-warning text-warning-foreground"
                : "bg-success text-success-foreground"
          }
        >
          {isClosed ? "Caixa Fechado" : isNotStarted ? "Caixa do dia ainda não iniciado" : "Caixa Aberto"}
        </Badge>
      </div>

      {isNotStarted && (
        <OpenCashBanner cashDate={selectedDate} onOpened={fetchData} />
      )}

      {/* Global balance cards */}
      {balance && (
        <div className="grid grid-cols-2 gap-2">
          <Card>
            <CardContent className="p-2.5 text-center">
              <Wallet className="mx-auto mb-0.5 h-4 w-4 text-primary" />
              <p className="text-[10px] text-muted-foreground">Caixa Disponível</p>
              <p className={`text-sm font-bold ${Number(balance.available_cash) < 0 ? "text-destructive" : "text-primary"}`}>
                {formatCurrency(Number(balance.available_cash))}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-2.5 text-center">
              <TrendingUp className="mx-auto mb-0.5 h-4 w-4 text-warning" />
              <p className="text-[10px] text-muted-foreground">A Receber</p>
              <p className="text-sm font-bold">{formatCurrency(Number(balance.money_lent) + Number(balance.interest_receivable))}</p>
              <p className="text-[9px] text-muted-foreground leading-tight">
                Princ.: {formatCurrency(Number(balance.money_lent))} · Juros: {formatCurrency(Number(balance.interest_receivable))}
              </p>
              {Number(balance.penalty_receivable) > 0 && (
                <p className="text-[10px] text-warning font-semibold mt-0.5">
                  Multas: {formatCurrency(Number(balance.penalty_receivable))}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Bloco: Cobranças do Dia (mesma fonte da Rota do Dia) */}
      {(loading || summaryLoading) ? (
        <Card>
          <CardContent className="p-3 space-y-2">
            <div className="h-3 w-32 rounded bg-muted animate-pulse" />
            <div className="h-4 w-full rounded bg-muted animate-pulse" />
            <div className="h-4 w-full rounded bg-muted animate-pulse" />
            <div className="h-4 w-2/3 rounded bg-muted animate-pulse" />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-3 space-y-1.5">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Cobranças do Dia</p>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Saldo Esperado</span>
              <span className="text-sm font-bold tabular-nums text-warning">{formatCurrency(expectedToReceiveToday)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Recebido Hoje</span>
              <span className="text-sm font-bold tabular-nums text-success">{formatCurrency(receivedToday)}</span>
            </div>
            <div className="flex items-center justify-between border-t pt-1.5">
              <span className="text-xs font-semibold">Falta Receber</span>
              <span className={`text-sm font-bold tabular-nums ${pendingToReceiveToday > 0 ? "text-destructive" : "text-muted-foreground"}`}>
                {formatCurrency(pendingToReceiveToday)}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Bloco: Conferência do Caixa */}
      {(loading || summaryLoading) ? (
        <Card>
          <CardContent className="p-3 space-y-2">
            <div className="h-3 w-40 rounded bg-muted animate-pulse" />
            <div className="h-4 w-full rounded bg-muted animate-pulse" />
            <div className="h-4 w-full rounded bg-muted animate-pulse" />
            <div className="h-4 w-3/4 rounded bg-muted animate-pulse" />
            <div className="h-4 w-1/2 rounded bg-muted animate-pulse" />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-3 space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Conferência do Caixa</p>
              <span className="text-[10px] text-muted-foreground">{summary.eventsCount} atividade{summary.eventsCount === 1 ? "" : "s"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground">Saldo Inicial</span>
              <span className="text-xs font-medium tabular-nums">{formatCurrency(summary.opening)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-success flex items-center gap-1"><ArrowDownCircle className="h-3 w-3" /> Entradas</span>
              <span className="text-sm font-bold text-success tabular-nums">+{formatCurrency(summary.totalIn)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-destructive flex items-center gap-1"><ArrowUpCircle className="h-3 w-3" /> Saídas</span>
              <span className="text-sm font-bold text-destructive tabular-nums">-{formatCurrency(summary.totalOut)}</span>
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1.5 border-t text-[11px]">
              <div className="flex justify-between"><span className="text-muted-foreground">Pagamentos</span><span className="text-success tabular-nums">{formatCurrency(summary.received)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Multas</span><span className="text-warning tabular-nums">{formatCurrency(summary.penalty)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Emprestado</span><span className="text-primary tabular-nums">{formatCurrency(summary.lent)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Não pagou</span><span className="text-destructive tabular-nums">{summary.notPaidCount}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Entr. manual</span><span className="text-success tabular-nums">{formatCurrency(summary.manualIn)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Saída manual</span><span className="text-destructive tabular-nums">{formatCurrency(summary.manualOut)}</span></div>
            </div>
            <div className="flex items-center justify-between border-t pt-1.5">
              <span className="text-xs font-semibold">Valor Esperado no Caixa</span>
              <span className="text-sm font-bold tabular-nums">
                {formatCurrency(expectedDisplay)}
              </span>
            </div>
            {expectedNegative && !isClosed && (
              <p className="text-[10px] text-warning leading-tight">
                Valor esperado no caixa ficou negativo ({formatCurrency(summary.expected)}). Verifique saldo inicial ou saídas lançadas.
              </p>
            )}
            {isClosed && dailyCashRow?.counted_closing_balance != null && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Saldo Contado</span>
                  <span className="text-sm font-bold tabular-nums">{formatCurrency(Number(dailyCashRow.counted_closing_balance))}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Diferença</span>
                  <span className={`text-sm font-bold tabular-nums ${(Number(dailyCashRow.counted_closing_balance) - summary.expected) === 0 ? "text-muted-foreground" : (Number(dailyCashRow.counted_closing_balance) - summary.expected) < 0 ? "text-destructive" : "text-success"}`}>
                    {formatCurrency(Number(dailyCashRow.counted_closing_balance) - summary.expected)}
                  </span>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}


      {/* Close / Reopen cash actions */}
      {!isNotStarted && (
        <div className="grid grid-cols-2 gap-2">
          {!isClosed ? (
            <Button onClick={openCloseDialog} disabled={submitting} variant="outline" className="text-xs h-9 col-span-2 border-primary/40 text-primary">
              <Lock className="mr-1.5 h-3.5 w-3.5" /> Fechar caixa do dia
            </Button>
          ) : (
            <Button
              onClick={() => setReopenOpen(true)}
              disabled={submitting || (!isAdmin && !isSuperAdmin)}
              variant="outline"
              className="text-xs h-9 col-span-2 border-warning/40 text-warning"
            >
              <Unlock className="mr-1.5 h-3.5 w-3.5" /> {(!isAdmin && !isSuperAdmin) ? "Caixa fechado — solicite reabertura" : "Reabrir caixa"}
            </Button>
          )}
        </div>
      )}


      {/* Section tabs */}
      <div className="grid grid-cols-5 gap-1.5">
        <button
          onClick={() => setActiveSection("pagos")}
          className={`rounded-lg border p-1.5 text-center transition-colors ${activeSection === "pagos" ? "border-success/50 bg-success/5" : "bg-card"}`}
        >
          <p className="text-[10px] text-muted-foreground">Pagos</p>
          <p className="text-base font-bold text-success">{pagamentos.length}</p>
        </button>
        <button
          onClick={() => setActiveSection("naopagos")}
          className={`rounded-lg border p-1.5 text-center transition-colors ${activeSection === "naopagos" ? "border-destructive/50 bg-destructive/5" : "bg-card"}`}
        >
          <p className="text-[10px] text-muted-foreground">Não Pagos</p>
          <p className="text-base font-bold text-destructive">{naoPagos.length}</p>
        </button>
        <button
          onClick={() => setActiveSection("novos")}
          className={`rounded-lg border p-1.5 text-center transition-colors ${activeSection === "novos" ? "border-primary/50 bg-primary/5" : "bg-card"}`}
        >
          <p className="text-[10px] text-muted-foreground">Novos</p>
          <p className="text-base font-bold text-primary">{novos.length}</p>
        </button>
        <button
          onClick={() => setActiveSection("importados")}
          className={`rounded-lg border p-1.5 text-center transition-colors ${activeSection === "importados" ? "border-muted-foreground/50 bg-muted/40" : "bg-card"}`}
        >
          <p className="text-[10px] text-muted-foreground">Importados</p>
          <p className="text-base font-bold">{importados.length}</p>
        </button>
        <button
          onClick={() => setActiveSection("movimentos")}
          className={`rounded-lg border p-1.5 text-center transition-colors ${activeSection === "movimentos" ? "border-border bg-accent/50" : "bg-card"}`}
        >
          <p className="text-[10px] text-muted-foreground">Movim.</p>
          <p className="text-base font-bold">{movimentos.length}</p>
        </button>
      </div>


      {activeSection === "resumo" && events.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-4">Nenhum lançamento neste dia. Selecione uma aba acima para registrar.</p>
      )}

      {/* Section content */}
      {activeSection === "pagos" && (
        <div className="space-y-2">
          <h2 className="text-xs font-semibold text-success flex items-center gap-1 uppercase tracking-wider">
            <CheckCircle className="h-3 w-3" /> Pagos do Dia
          </h2>
          {pagamentos.length === 0 ? (
            <EmptyState icon={DollarSign} message="Nenhum pagamento neste dia" description="Os pagamentos do dia aparecerão aqui." compact />
          ) : (
            pagamentos.map(ev => (
              <div key={ev.id} className="rounded-lg border bg-card p-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold">{ev.client_id ? clientNames[ev.client_id] || "Cliente" : "—"}</p>
                    <p className={`text-[11px] font-medium ${getEventTypeColor(ev.event_type)}`}>
                      {getEventTypeLabel(ev.event_type)}
                    </p>
                    {ev.observation && <p className="text-[10px] text-muted-foreground truncate max-w-[200px]">{ev.observation}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-success tabular-nums">+{formatCurrency(Number(ev.amount_in))}</span>
                    {!workerIsClosed && (
                      <button onClick={() => handleUndoEvent(ev)} className="p-1 rounded hover:bg-destructive/10" title="Desfazer">
                        <Undo2 className="h-3.5 w-3.5 text-destructive" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {activeSection === "naopagos" && (
        <div className="space-y-2">
          <h2 className="text-xs font-semibold text-destructive flex items-center gap-1 uppercase tracking-wider">
            <XCircle className="h-3 w-3" /> Não Pagos do Dia
          </h2>
          {naoPagos.length === 0 ? (
            <EmptyState icon={CheckCircle} message="Nenhuma marcação neste dia" description="Nenhum cliente foi marcado como não pago." compact />
          ) : (
            naoPagos.map(ev => (
              <div key={ev.id} className="rounded-lg border border-destructive/30 bg-card p-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold">{ev.client_id ? clientNames[ev.client_id] || "Cliente" : "—"}</p>
                    {ev.observation && <p className="text-[10px] text-muted-foreground truncate max-w-[200px]">{ev.observation}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge className="bg-destructive text-destructive-foreground text-[9px] px-1.5 py-0 h-3.5">Não Pagou</Badge>
                    {!workerIsClosed && (
                      <button onClick={() => handleUndoEvent(ev)} className="p-1 rounded hover:bg-destructive/10" title="Desfazer">
                        <Undo2 className="h-3.5 w-3.5 text-destructive" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {activeSection === "novos" && (
        <div className="space-y-2">
          <h2 className="text-xs font-semibold text-primary flex items-center gap-1 uppercase tracking-wider">
            <Plus className="h-3 w-3" /> Empréstimos Novos / Renovações
          </h2>
          {novos.length === 0 ? (
            <EmptyState icon={DollarSign} message="Nenhum empréstimo neste dia" description="Empréstimos novos e renovações aparecerão aqui." compact />
          ) : (
            novos.map(ev => {
              const isRenewal = ev.event_type === "renovacao";
              const m = (ev as any).metadata as Record<string, any> | null;
              const title = isRenewal ? "Renovação de Empréstimo" : "Empréstimo Liberado";
              const dt = new Date(ev.created_at);
              const dtLabel = `${dt.toLocaleDateString("pt-BR")} ${dt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
              return (
                <div key={ev.id} className={`rounded-lg border bg-card p-2.5 ${isRenewal ? "border-primary/30" : "border-success/30"}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">{title}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {ev.client_id ? clientNames[ev.client_id] || m?.client_name || "Cliente" : (m?.client_name || "—")}
                        {m?.worker_name ? <> · <span className="text-muted-foreground">por {m.worker_name}</span></> : null}
                      </p>
                      <div className="text-[10px] text-muted-foreground mt-1 space-y-0.5">
                        {m?.principal_amount != null && <p>Valor emprestado: <span className="font-medium">{formatCurrency(Number(m.principal_amount))}</span></p>}
                        {m?.total_amount != null && <p>Total com juros: <span className="font-medium">{formatCurrency(Number(m.total_amount))}</span></p>}
                        {m?.installments != null && m?.installment_amount != null && (
                          <p>Parcelas: <span className="font-medium">{Number(m.installments)}x {formatCurrency(Number(m.installment_amount))}</span></p>
                        )}
                        {m?.first_due_date && <p>Primeira cobrança: <span className="font-medium">{m.first_due_date}</span></p>}
                        {m?.receivable_created != null && <p>A Receber criado: <span className="font-medium">{formatCurrency(Number(m.receivable_created))}</span></p>}
                        <p className="text-muted-foreground/70">{dtLabel}</p>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Liberado</p>
                      <span className={`text-sm font-bold ${isRenewal ? "text-primary" : "text-success"}`}>
                        {formatCurrency(Number(ev.amount_out))}
                      </span>
                      <Badge className={`block mt-0.5 text-[9px] px-1.5 py-0 h-3.5 ${isRenewal ? "bg-primary/10 text-primary" : "bg-success/10 text-success"}`}>
                        {isRenewal ? "Renovação" : "Novo"}
                      </Badge>
                    </div>
                  </div>
                  {ev.loan_id && (
                    <Button variant="outline" size="sm" className="h-6 text-[10px] mt-1.5" onClick={() => navigate(`/loans/${ev.loan_id}`)}>
                      Ver empréstimo
                    </Button>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {activeSection === "importados" && (
        <div className="space-y-2">
          <h2 className="text-xs font-semibold text-muted-foreground flex items-center gap-1 uppercase tracking-wider">
            Empréstimos Importados
          </h2>
          <p className="text-[10px] text-muted-foreground">
            Empréstimos em andamento adicionados ao A Receber. Não afetam o caixa disponível.
          </p>
          {importados.length === 0 ? (
            <EmptyState icon={DollarSign} message="Nenhum empréstimo importado neste dia" description="Empréstimos em andamento aparecerão aqui." compact />
          ) : (
            importados.map(ev => {
              const m = (ev as any).metadata as Record<string, any> | null;
              const remaining = Number(m?.remaining_balance ?? 0);
              return (
                <div key={ev.id} className="rounded-lg border border-muted-foreground/20 bg-muted/30 p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">Empréstimo Importado</p>
                      <p className="text-[11px] text-muted-foreground">
                        {ev.client_id ? clientNames[ev.client_id] || m?.client_name || "Cliente" : (m?.client_name || "—")}
                        {m?.worker_name ? <> · <span className="text-muted-foreground">por {m.worker_name}</span></> : null}
                      </p>
                      {m && (
                        <div className="text-[10px] text-muted-foreground mt-1 space-y-0.5">
                          {m.original_amount != null && <p>Valor original: <span className="font-medium">{formatCurrency(Number(m.original_amount))}</span></p>}
                          {m.total_amount != null && <p>Total com juros: <span className="font-medium">{formatCurrency(Number(m.total_amount))}</span></p>}
                          {Number(m.amount_already_paid) > 0 && <p>Já pago antes do cadastro: <span className="font-medium">{formatCurrency(Number(m.amount_already_paid))}</span></p>}
                          {m.remaining_balance != null && <p>Saldo restante importado: <span className="font-medium">{formatCurrency(Number(m.remaining_balance))}</span></p>}
                          {m.principal_receivable != null && <p>Principal a receber: <span className="font-medium">{formatCurrency(Number(m.principal_receivable))}</span></p>}
                          {m.interest_receivable != null && <p>Juros a receber: <span className="font-medium">{formatCurrency(Number(m.interest_receivable))}</span></p>}
                          {m.pending_installments_count != null && <p>Parcelas pendentes: <span className="font-medium">{Number(m.pending_installments_count)}</span></p>}
                          {m.next_due_date && <p>Próxima cobrança: <span className="font-medium">{m.next_due_date}</span></p>}
                          {m.original_loan_date && <p>Data original: <span className="font-medium">{m.original_loan_date}</span></p>}
                          <p className="text-muted-foreground/70">
                            {(() => { const dt = new Date(ev.created_at); return `${dt.toLocaleDateString("pt-BR")} ${dt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`; })()}
                          </p>
                        </div>
                      )}
                    </div>
                    <div className="text-right">
                      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">A Receber +</p>
                      <span className="text-sm font-bold tabular-nums">
                        {formatCurrency(remaining)}
                      </span>
                      <Badge variant="outline" className="block mt-0.5 text-[9px] px-1.5 py-0 h-3.5">
                        Importado
                      </Badge>
                    </div>
                  </div>
                  {ev.loan_id && (
                    <Button variant="outline" size="sm" className="h-6 text-[10px] mt-1.5" onClick={() => navigate(`/loans/${ev.loan_id}`)}>
                      Ver empréstimo
                    </Button>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}


      {activeSection === "movimentos" && (
        <div className="space-y-2">
          <h2 className="text-xs font-semibold text-muted-foreground flex items-center gap-1 uppercase tracking-wider">
            Movimentações Manuais
          </h2>
          {movimentos.length === 0 ? (
            <EmptyState icon={Settings} message="Nenhuma movimentação manual" description="Aportes, retiradas e ajustes manuais aparecerão aqui." compact />
          ) : (
            movimentos.map(ev => (
              <div key={ev.id} className="rounded-lg border bg-card p-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <p className={`text-xs font-medium ${getEventTypeColor(ev.event_type)}`}>
                      {getEventTypeLabel(ev.event_type)}
                    </p>
                    {ev.observation && <p className="text-[10px] text-muted-foreground truncate max-w-[200px]">{ev.observation}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-bold tabular-nums ${Number(ev.amount_in) > 0 ? "text-success" : "text-destructive"}`}>
                      {Number(ev.amount_in) > 0 ? `+${formatCurrency(Number(ev.amount_in))}` : `-${formatCurrency(Number(ev.amount_out))}`}
                    </span>
                    {!workerIsClosed && (
                      <button onClick={() => handleUndoEvent(ev)} className="p-1 rounded hover:bg-destructive/10" title="Desfazer">
                        <Undo2 className="h-3.5 w-3.5 text-destructive" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {activeSection === "resumo" && (
        <div className="space-y-2">
          {/* Resumo serve as overview - the 4 counters above already act as navigation */}
          {/* All events timeline */}
          {events.length > 0 && (
            <Card>
              <CardHeader className="pb-1.5 pt-3 px-3">
                <CardTitle className="text-xs">Últimos lançamentos</CardTitle>
              </CardHeader>
              <CardContent className="px-3 pb-3 space-y-1.5">
                {events.slice(-5).reverse().map(ev => (
                  <div key={ev.id} className="flex items-center justify-between rounded-lg bg-accent px-2.5 py-1.5">
                    <div className="flex-1 min-w-0">
                      <p className={`text-[11px] font-medium ${getEventTypeColor(ev.event_type)}`}>
                        {getEventTypeLabel(ev.event_type)}
                      </p>
                      {ev.client_id && <p className="text-[10px] text-muted-foreground">{clientNames[ev.client_id] || "Cliente"}</p>}
                      {ev.observation && <p className="text-[10px] text-muted-foreground truncate max-w-[180px]">{ev.observation}</p>}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className={`text-xs font-bold tabular-nums ${Number(ev.amount_in) > 0 ? "text-success" : Number(ev.amount_out) > 0 ? "text-destructive" : "text-muted-foreground"}`}>
                        {Number(ev.amount_in) > 0 ? `+${formatCurrency(Number(ev.amount_in))}` : Number(ev.amount_out) > 0 ? `-${formatCurrency(Number(ev.amount_out))}` : "—"}
                      </span>
                      {!workerIsClosed && (
                        <button onClick={() => handleUndoEvent(ev)} className="p-0.5 rounded hover:bg-destructive/10" title="Desfazer">
                          <Undo2 className="h-3 w-3 text-destructive" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setActiveSection("pagos")}
                  className="w-full text-center text-[11px] text-primary hover:underline pt-1"
                >
                  Ver todos os lançamentos →
                </button>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className={`grid gap-2 ${showAjuste ? "grid-cols-3" : "grid-cols-2"}`}>
        <Button disabled={cashLocked || submitting} variant="outline" className="text-success border-success/50 text-xs h-9" onClick={() => setManualType("entrada_manual")}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Entrada
        </Button>
        <Button disabled={cashLocked || submitting} variant="outline" className="text-destructive border-destructive/50 text-xs h-9" onClick={() => setManualType("saida_manual")}>
          <Minus className="mr-1 h-3.5 w-3.5" /> Saída
        </Button>
        {showAjuste && (
          <Button disabled={cashLocked || submitting} variant="outline" className="text-xs h-9" onClick={() => setManualType("ajuste_manual")}>
            <Settings className="mr-1 h-3.5 w-3.5" /> Ajuste
          </Button>
        )}
      </div>

      <div className={`grid gap-2 ${showAjuste ? "grid-cols-2" : "grid-cols-1"}`}>
        <Button variant="outline" className="w-full text-xs h-9" onClick={() => navigate("/daily-cash-history")}>
          <History className="mr-1.5 h-3.5 w-3.5" /> Histórico
        </Button>
        {showAjuste && (
          <Button variant="outline" className="w-full text-xs h-9" onClick={handleRecalculate}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Recalcular
          </Button>
        )}
      </div>

      {/* Manual movement dialog */}
      <Dialog open={manualType !== null} onOpenChange={(o) => { if (!o) setManualType(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {manualType === "entrada_manual" && "Entrada Manual"}
              {manualType === "saida_manual" && "Saída Manual"}
              {manualType === "ajuste_manual" && "Ajuste Manual"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Valor (R$)</Label>
              <Input type="number" value={manualAmount} onChange={(e) => setManualAmount(e.target.value)} placeholder="0.00" />
            </div>
            <div>
              <Label>Observação (opcional)</Label>
              <Textarea value={manualObs} onChange={(e) => setManualObs(e.target.value)} placeholder="Descrição..." />
            </div>
            <Button onClick={handleManualMovement} disabled={submitting} className="w-full">Confirmar</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Reopen cash dialog */}
      <Dialog open={reopenOpen} onOpenChange={(o) => { if (!o) { setReopenOpen(false); setReopenReason(""); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Reabrir caixa</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Informe o motivo da reabertura. A ação será registrada no histórico de auditoria.</p>
            <div>
              <Label>Motivo <span className="text-destructive">*</span></Label>
              <Textarea value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} placeholder="Ex.: ajuste de pagamento recebido após fechamento" />
            </div>
            <Button onClick={handleReopenCash} disabled={submitting || reopenReason.trim().length < 3} className="w-full">
              Confirmar reabertura
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Close cash dialog */}
      <Dialog open={closeOpen} onOpenChange={(o) => { if (!o) setCloseOpen(false); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Fechar caixa do dia</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="rounded-md border bg-muted/30 p-2.5 text-xs space-y-1">
              <div className="flex justify-between"><span className="text-muted-foreground">Saldo inicial</span><span className="tabular-nums">{formatCurrency(summary.opening)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Entradas</span><span className="text-success tabular-nums">+{formatCurrency(summary.totalIn)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Saídas</span><span className="text-destructive tabular-nums">-{formatCurrency(summary.totalOut)}</span></div>
              <div className="flex justify-between font-semibold border-t pt-1"><span>Valor Esperado no Caixa</span><span className="tabular-nums">{formatCurrency(summary.expected)}</span></div>
            </div>
            <div>
              <Label>Valor contado no caixa (R$) <span className="text-destructive">*</span></Label>
              <Input type="number" step="0.01" value={countedAmount} onChange={(e) => setCountedAmount(e.target.value)} placeholder="0.00" />
            </div>
            {(() => {
              const counted = parseFloat(countedAmount);
              if (!isFinite(counted)) return null;
              const diff = counted - summary.expected;
              const hasDiff = Math.abs(diff) > 0.01;
              return (
                <div className={`rounded-md border p-2 text-xs ${hasDiff ? "border-destructive/40 bg-destructive/5" : "border-success/40 bg-success/5"}`}>
                  <div className="flex justify-between font-semibold">
                    <span>Diferença</span>
                    <span className={`tabular-nums ${hasDiff ? "text-destructive" : "text-success"}`}>
                      {diff >= 0 ? "+" : ""}{formatCurrency(diff)}
                    </span>
                  </div>
                  {hasDiff && <p className="text-[10px] mt-1 text-muted-foreground">Observação obrigatória quando há diferença.</p>}
                </div>
              );
            })()}
            <div>
              <Label>Observação {(() => {
                const counted = parseFloat(countedAmount);
                const diff = isFinite(counted) ? counted - summary.expected : 0;
                return Math.abs(diff) > 0.01 ? <span className="text-destructive">*</span> : <span className="text-muted-foreground">(opcional)</span>;
              })()}</Label>
              <Textarea value={closeNote} onChange={(e) => setCloseNote(e.target.value)} placeholder="Motivo da diferença, observações..." />
            </div>
            <Button onClick={handleCloseCash} disabled={submitting} className="w-full">
              {submitting ? "Salvando..." : "Confirmar fechamento"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Undo reason dialog */}
      <Dialog open={!!undoTarget} onOpenChange={(o) => { if (!o) { setUndoTarget(null); setUndoReason(""); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <Undo2 className="h-4 w-4" /> Desfazer lançamento
            </DialogTitle>
          </DialogHeader>
          {undoTarget && (
            <div className="space-y-2 text-xs">
              <div className="rounded border bg-muted/30 p-2 space-y-0.5">
                <p><span className="text-muted-foreground">Tipo:</span> <span className="font-medium">{getEventTypeLabel(undoTarget.event_type)}</span></p>
                {(Number(undoTarget.amount_in) > 0 || Number(undoTarget.amount_out) > 0) && (
                  <p>
                    <span className="text-muted-foreground">Valor:</span>{" "}
                    <span className="font-medium tabular-nums">{formatCurrency(Number(undoTarget.amount_in) || Number(undoTarget.amount_out))}</span>
                  </p>
                )}
                {undoTarget.client_id && clientNames[undoTarget.client_id] && (
                  <p><span className="text-muted-foreground">Cliente:</span> <span className="font-medium">{clientNames[undoTarget.client_id]}</span></p>
                )}
              </div>
              <div>
                <Label className="text-xs">Motivo do estorno <span className="text-destructive">*</span></Label>
                <Textarea
                  value={undoReason}
                  onChange={(e) => setUndoReason(e.target.value)}
                  placeholder="Ex.: lançado no cliente errado, valor incorreto..."
                  className="text-xs"
                  rows={3}
                />
                <p className="text-[10px] text-muted-foreground mt-1">Mínimo 3 caracteres. Será registrado no histórico e no contra-lançamento.</p>
              </div>
              <div className="flex gap-2 pt-1">
                <Button variant="outline" className="flex-1" onClick={() => { setUndoTarget(null); setUndoReason(""); }} disabled={submitting}>
                  Cancelar
                </Button>
                <Button variant="destructive" className="flex-1" onClick={confirmUndoEvent} disabled={submitting || undoReason.trim().length < 3}>
                  {submitting ? "Estornando..." : "Confirmar estorno"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
