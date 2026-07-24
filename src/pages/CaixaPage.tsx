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
  CashBalance,
  getCurrentDailyCashScope,
  applyDailyCashScope,
} from "@/lib/cash-utils";
import { getDailyEvents, createDailyEvent, undoDailyEvent, getEventTypeLabel, getEventTypeColor, isFinancialEvent, isReversalEvent, DailyEvent, EXPENSE_CATEGORIES, type ExpenseCategory } from "@/lib/daily-events";
import { assertCashOpen } from "@/lib/cash-lock";
import { logAction, getCurrentActorIdentity } from "@/lib/audit-utils";
import {
  Wallet, TrendingUp, TrendingDown, AlertTriangle, Plus, Minus, Settings,
  History, ChevronLeft, ChevronRight, CheckCircle, XCircle, RefreshCw, Lock, Unlock,
  DollarSign, ArrowDownCircle, ArrowUpCircle, Undo2, FileText, Receipt
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
import { loadDailyCashSnapshot, buildDailyCashSnapshotPayload, saveDailyCashSnapshot, listDailyCashSnapshotVersions, type DailyCashSnapshotPayload, type DailyCashSnapshotVersion } from "@/lib/daily-snapshot";

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
  const [snapshot, setSnapshot] = useState<DailyCashSnapshotPayload | null>(null);
  const [inheritedOpening, setInheritedOpening] = useState<number>(0);
  const [collectionSummary, setCollectionSummary] = useState<{ expectedToReceiveToday: number; receivedToday: number; pendingToReceiveToday: number; cashExpectedForClosing: number; hasError: boolean }>({ expectedToReceiveToday: 0, receivedToday: 0, pendingToReceiveToday: 0, cashExpectedForClosing: 0, hasError: false });
  const [summaryLoading, setSummaryLoading] = useState(true);
  const expectedToReceiveToday = collectionSummary.expectedToReceiveToday;
  const receivedToday = collectionSummary.receivedToday;
  const pendingToReceiveToday = collectionSummary.pendingToReceiveToday;
  const [submitting, setSubmitting] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState<DailyCashSnapshotVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [undoTarget, setUndoTarget] = useState<DailyEvent | null>(null);
  const [undoReason, setUndoReason] = useState("");
  const [reopenRequests, setReopenRequests] = useState<any[]>([]);
  const [reviewTarget, setReviewTarget] = useState<{ req: any; action: "approve" | "reject" } | null>(null);
  const [reviewNote, setReviewNote] = useState("");

  // Manual movement dialog
  const [manualType, setManualType] = useState<"entrada_manual" | "saida_manual" | "ajuste_manual" | null>(null);
  const [manualAmount, setManualAmount] = useState("");
  const [manualObs, setManualObs] = useState("");

  // Expense dialog
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseCategory, setExpenseCategory] = useState<ExpenseCategory>("Gasolina/Transporte");
  const [expenseDescription, setExpenseDescription] = useState("");
  const [expenseDate, setExpenseDate] = useState<string>(today);
  const [expenseReceipt, setExpenseReceipt] = useState<File | null>(null);

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
      const dc = (dcRes?.data as any) || null;
      setDailyCashRow(dc);
      const status =
        dc && dc.status !== "cancelled_empty" && dc.status !== "void"
          ? (dc.status || "open")
          : "sem_caixa";
      setDailyCashStatus(status);

      // Saldo inicial = opening_balance salvo na abertura (nunca herda de dias anteriores,
      // nunca fica negativo). Se ainda não existe daily_cash, exibe 0.
      const rawOpening = Number(dc?.opening_balance ?? 0);
      const safeOpening = isFinite(rawOpening) && rawOpening > 0 ? rawOpening : 0;
      if (rawOpening < 0) {
        console.warn("[CaixaPage] opening_balance negativo, exibindo 0:", rawOpening);
      }
      setInheritedOpening(safeOpening);

      // Se o caixa está FECHADO e existe snapshot, congelar os dados exibidos
      // usando o snapshot ao invés dos dados vivos. Por padrão exibe a versão
      // mais recente; se o usuário selecionou uma versão específica, a lista
      // carregada em `versions` sobrepõe via `applySnapshot` mais abaixo.
      let snap: DailyCashSnapshotPayload | null = null;
      if (status === "closed") {
        try { snap = await loadDailyCashSnapshot(selectedDate); } catch { snap = null; }
      } else {
        // Ao voltar a estar aberto (reabertura), limpa seleção de versão.
        setSelectedVersionId(null);
      }
      setSnapshot(snap);

      const effectiveEvents = snap?.events ?? dayEvents;
      setEvents(effectiveEvents);

      // Fetch client names for all events
      const namesFromSnapshot: Record<string, string> = { ...(snap?.client_names || {}) };
      const clientIds = [...new Set(effectiveEvents.filter(e => e.client_id).map(e => e.client_id!))]
        .filter(id => !namesFromSnapshot[id]);
      if (clientIds.length > 0) {
        const { data: clients } = await supabase.from("clients").select("id, name").in("id", clientIds);
        for (const c of (clients || [])) namesFromSnapshot[c.id] = c.name;
      }
      setClientNames(namesFromSnapshot);
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

  // Summary: quando fechado, usa valores gravados no fechamento (snapshot imutável).
  // Detalhamentos (novos vs renovações) são derivados dos eventos, que também são imutáveis.
  const summary = (() => {
    const useSnapshot = isClosed && !!dailyCashRow;
    const opening = useSnapshot ? Number(dailyCashRow.opening_balance || 0) : inheritedOpening;
    const received = useSnapshot ? Number(dailyCashRow.total_received || 0) : liveTotals.pagamentos;
    const penalty = useSnapshot ? Number(dailyCashRow.total_penalty_received || 0) : liveTotals.multas;
    const manualIn = useSnapshot ? Number(dailyCashRow.total_manual_in || 0) : liveTotals.entradasManuais;
    const manualOut = useSnapshot ? Number(dailyCashRow.total_manual_out || 0) : liveTotals.saidasManuais;
    const expenses = useSnapshot ? Number((dailyCashRow as any).total_expenses || 0) : liveTotals.despesas;
    // Split (novo vs renovação) sempre a partir dos eventos — histórico imutável.
    const newLoans = liveTotals.emprestimosLiberados;
    const renewals = liveTotals.renovacoes + liveTotals.renegociacoes;
    const lent = useSnapshot ? Number(dailyCashRow.total_lent || 0) : (newLoans + renewals);
    const totalIn = received + penalty + manualIn;
    const totalOut = lent + manualOut + expenses;
    // Dinheiro do trabalhador esperado = totalIn - totalOut (calculado automaticamente).
    const expected = totalIn - totalOut;
    // Dinheiro contado no caixa = valor digitado pelo trabalhador ao fechar. Quando aberto,
    // por padrão é igual ao esperado (o input do modal pré-preenche com esse valor).
    const counted = useSnapshot
      ? Number(dailyCashRow.counted_closing_balance ?? expected)
      : expected;
    // Caixa Disponível no Final do Dia = Caixa disponível inicial + esperado (auto).
    const finalCash = opening + expected;
    return {
      opening, received, penalty, manualIn, manualOut, expenses,
      newLoans, renewals, lent,
      totalIn, totalOut,
      expected,
      counted,
      finalCash,
      notPaidCount: useSnapshot ? Number(dailyCashRow.total_not_paid_count || 0) : liveTotals.naoPagos,
      eventsCount: useSnapshot ? Number(dailyCashRow.total_events_count || scopedEvents.length) : scopedEvents.length,
    };
  })();
  const availableNow = Number(balance?.available_cash ?? 0);


  const pagamentos = scopedEvents.filter(e => e.event_type === "pagamento" || e.event_type === "recebimento_multa");
  const naoPagos = scopedEvents.filter(e => e.event_type === "nao_pagou");
  const novos = scopedEvents.filter(e => ["emprestimo_novo","renovacao","renegociacao"].includes(e.event_type));
  const importados = scopedEvents.filter(e => e.event_type === "emprestimo_importado");
  const despesas = scopedEvents.filter(e => e.event_type === "despesa");
  const movimentos = scopedEvents.filter(e => ["entrada_manual", "saida_manual", "ajuste_manual", "saida", "despesa"].includes(e.event_type));
  const despesasTotal = despesas.reduce((s, e) => s + Number(e.amount_out || 0), 0);
  const despesasPorCategoria = despesas.reduce<Record<string, number>>((acc, e) => {
    const cat = (e.metadata?.category as string) || "Outros";
    acc[cat] = (acc[cat] || 0) + Number(e.amount_out || 0);
    return acc;
  }, {});

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

  const handleExpense = async () => {
    if (submitting) return;
    const amount = parseFloat(expenseAmount);
    if (!isFinite(amount) || amount <= 0) { toast.error("Informe um valor maior que zero"); return; }
    if (!expenseCategory) { toast.error("Selecione uma categoria"); return; }
    const desc = expenseDescription.trim();
    if (desc.length < 3) { toast.error("Descrição obrigatória (mín. 3 caracteres)"); return; }
    const cashDate = expenseDate || selectedDate;

    if (expenseReceipt) {
      const okType = /^image\//.test(expenseReceipt.type) || expenseReceipt.type === "application/pdf";
      if (!okType) { toast.error("Comprovante deve ser imagem ou PDF"); return; }
      if (expenseReceipt.size > 10 * 1024 * 1024) { toast.error("Comprovante acima de 10 MB"); return; }
    }

    const ok = await confirm({
      title: "Registrar despesa?",
      description: "O valor será descontado do Caixa Disponível.",
      affected: [
        { label: "Valor", value: formatCurrency(amount) },
        { label: "Categoria", value: expenseCategory },
        { label: "Descrição", value: desc },
        { label: "Data", value: cashDate },
        ...(expenseReceipt ? [{ label: "Comprovante", value: expenseReceipt.name }] : []),
      ],
      confirmText: "Confirmar", destructive: true,
    });
    if (!ok) return;

    setSubmitting(true);
    try {
      // 1) atomic RPC: cash_movement + daily_event + balance + audit (all-or-nothing for financials)
      const { data: rpcData, error: rpcErr } = await supabase.rpc("register_expense" as any, {
        p_cash_date: cashDate,
        p_amount: amount,
        p_category: expenseCategory,
        p_description: desc,
      });
      if (rpcErr) throw rpcErr;
      const result: any = rpcData || {};
      const dailyEventId: string | null = result.daily_event_id ?? null;
      const auditOk: boolean = result.audit_ok !== false;

      // 2) optional receipt upload — never rolls back the expense
      let receiptStatus: "none" | "ok" | "failed" = "none";
      if (expenseReceipt && dailyEventId) {
        receiptStatus = "failed";
        try {
          const { data: { user } } = await supabase.auth.getUser();
          const safeName = (expenseReceipt.name || `comprovante-${Date.now()}`).replace(/[^\w.\-]/g, "_");
          const path = `expenses/${user?.id || "anon"}/${dailyEventId}/${crypto.randomUUID()}-${safeName}`;
          const { error: upErr } = await supabase.storage
            .from("client-attachments")
            .upload(path, expenseReceipt, { contentType: expenseReceipt.type || undefined, upsert: false });
          if (upErr) throw upErr;
          const receiptMeta = {
            storage_path: path,
            file_name: expenseReceipt.name,
            file_type: expenseReceipt.type,
            file_size: expenseReceipt.size,
            uploaded_at: new Date().toISOString(),
          };
          const { error: linkErr } = await supabase.rpc("attach_expense_receipt" as any, {
            p_daily_event_id: dailyEventId,
            p_receipt: receiptMeta,
          });
          if (linkErr) throw linkErr;
          receiptStatus = "ok";
          logAction("anexar_arquivo" as any, "cash", dailyEventId, null, {
            context: "despesa",
            daily_event_id: dailyEventId,
            file_name: expenseReceipt.name,
            storage_path: path,
          }).catch(() => {});
        } catch (recErr: any) {
          console.error("[caixa] receipt upload failed", recErr);
        }
      }

      // 3) user-facing feedback — expense already saved even if audit/receipt failed
      if (!auditOk) {
        toast.warning("Despesa registrada com sucesso, porém houve falha ao registrar a auditoria. Avise o administrador.");
      } else if (receiptStatus === "failed") {
        toast.warning("Despesa registrada. Falha ao anexar o comprovante — tente novamente pelo histórico.");
      } else {
        toast.success("Despesa registrada!");
      }

      setExpenseOpen(false);
      setExpenseAmount("");
      setExpenseDescription("");
      setExpenseCategory("Gasolina/Transporte");
      setExpenseDate(today);
      setExpenseReceipt(null);
      await fetchData();
    } catch (err: any) {
      console.error("[caixa] expense failed", err);
      toast.error(err?.message || "Erro ao registrar despesa");
    } finally {
      setSubmitting(false);
    }
  };

  const openCloseDialog = () => {
    if (isClosed) return;
    setCloseNote("");
    setCountedAmount(summary.expected.toFixed(2));
    setCloseOpen(true);
  };

  const handleCloseCash = async () => {
    if (submitting || isClosed) return;
    const expected = Number(summary.expected.toFixed(2));
    const parsed = parseFloat((countedAmount || "").replace(",", "."));
    if (isNaN(parsed)) { toast.error("Informe o dinheiro contado no caixa."); return; }
    const counted = Number(parsed.toFixed(2));
    const differs = Math.abs(counted - expected) > 0.005;
    if (differs && closeNote.trim().length < 3) {
      toast.error("O valor contado difere do esperado. Observação é obrigatória.");
      return;
    }
    setSubmitting(true);
    try {
      const { error } = await supabase.rpc(
        "close_daily_cash_v2" as any,
        { p_cash_date: selectedDate, p_counted: counted, p_note: closeNote.trim() || null } as any
      );
      if (error) throw error;
      try {
        await logAction(
          "fechar_caixa",
          "cash",
          null,
          null,
          {
            cash_date: selectedDate,
            caixa_inicio_dia: Number(summary.opening.toFixed(2)),
            pagamentos_recebidos: Number(summary.received.toFixed(2)),
            multas_recebidas: Number(summary.penalty.toFixed(2)),
            entradas_manuais: Number(summary.manualIn.toFixed(2)),
            total_entradas: Number(summary.totalIn.toFixed(2)),
            novos_emprestimos: Number(summary.newLoans.toFixed(2)),
            renovacoes_dinheiro_novo: Number(summary.renewals.toFixed(2)),
            despesas: Number(summary.expenses.toFixed(2)),
            saidas_manuais: Number(summary.manualOut.toFixed(2)),
            total_saidas: Number(summary.totalOut.toFixed(2)),
            dinheiro_trabalhador_esperado: expected,
            dinheiro_contado: counted,
            caixa_disponivel_final: Number(summary.finalCash.toFixed(2)),
          },
          closeNote.trim() || null,
        );
      } catch (e) { console.warn("[caixa] audit log failed", e); }

      // Snapshot: congela o estado exato do dia no momento do fechamento.
      try {
        const payload = await buildDailyCashSnapshotPayload(selectedDate, {
          opening_balance: Number(summary.opening.toFixed(2)),
          expected_worker_cash: expected,
          counted_cash: counted,
          final_cash: Number(summary.finalCash.toFixed(2)),
          received: Number(summary.received.toFixed(2)),
          penalty: Number(summary.penalty.toFixed(2)),
          manual_in: Number(summary.manualIn.toFixed(2)),
          manual_out: Number(summary.manualOut.toFixed(2)),
          expenses: Number(summary.expenses.toFixed(2)),
          new_loans: Number(summary.newLoans.toFixed(2)),
          renewals: Number(summary.renewals.toFixed(2)),
          lent: Number(summary.lent.toFixed(2)),
          total_in: Number(summary.totalIn.toFixed(2)),
          total_out: Number(summary.totalOut.toFixed(2)),
          not_paid_count: Number(summary.notPaidCount || 0),
          events_count: Number(summary.eventsCount || 0),
          observation: closeNote.trim() || null,
        });
        await saveDailyCashSnapshot(selectedDate, payload);
      } catch (e) {
        console.warn("[caixa] snapshot save failed", e);
        toast.warning("Caixa fechado, mas o snapshot não foi salvo. Contate o administrador.");
      }

      toast.success("Caixa fechado!");
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



  // Fetch pending reopen requests (admin only).
  const fetchReopenRequests = useCallback(async () => {
    if (!isAdmin && !isSuperAdmin) { setReopenRequests([]); return; }
    let q: any = supabase.from("cash_reopen_requests" as any).select("*").eq("status", "pending").order("requested_at", { ascending: false });
    const { data } = await q;
    setReopenRequests((data as any[]) || []);
  }, [isAdmin, isSuperAdmin]);
  useEffect(() => { void fetchReopenRequests(); }, [fetchReopenRequests, dailyCashStatus, selectedDate]);

  // Worker: submit reopen request (creates a row in cash_reopen_requests).
  const submitReopenRequest = async () => {
    if (submitting) return;
    if (reopenReason.trim().length < 3) { toast.error("Informe o motivo (mínimo 3 caracteres)."); return; }
    setSubmitting(true);
    try {
      const { data: { session: s } } = await supabase.auth.getSession();
      const uid = s?.user?.id ?? null;
      let workerName: string | null = null;
      let workerId: string | null = null;
      let adminId: string | null = null;
      if (uid) {
        const { data: w } = await supabase.from("workers").select("id, nome, parent_admin_id").eq("auth_user_id", uid).maybeSingle();
        if (w) { workerId = (w as any).id ?? null; workerName = (w as any).nome ?? null; adminId = (w as any).parent_admin_id ?? null; }
      }
      const { error } = await supabase.from("cash_reopen_requests" as any).insert({
        cash_date: selectedDate,
        worker_id: workerId,
        worker_name: workerName,
        admin_id: adminId,
        reason: reopenReason.trim(),
        status: "pending",
        requested_by: uid,
      } as any);
      if (error) throw error;
      await logAction(
        "solicitar_reabertura_caixa" as any, "cash", null, null,
        { cash_date: selectedDate, worker_id: workerId, worker_name: workerName, reason: reopenReason.trim(), status: "pending", requested_at: new Date().toISOString() },
        `Solicitação de reabertura (${selectedDate}): ${reopenReason.trim()}`, workerId ?? undefined,
      );
      toast.success("Solicitação enviada ao administrador");
      setReopenOpen(false);
      setReopenReason("");
    } catch (err: any) {
      console.error("[caixa] submit reopen request failed", err);
      toast.error(err?.message || "Erro ao enviar solicitação");
    } finally {
      setSubmitting(false);
    }
  };

  // Snapshot versions: open modal + hydrate selected version.
  const openVersionsDialog = async () => {
    setVersionsOpen(true);
    setVersionsLoading(true);
    try {
      const list = await listDailyCashSnapshotVersions(selectedDate);
      setVersions(list);
      const latestId = list[0]?.id ?? null;
      setSelectedVersionId((prev) => prev ?? latestId);
    } catch (err: any) {
      console.error("[caixa] list versions failed", err);
      toast.error(err?.message || "Erro ao carregar versões");
    } finally {
      setVersionsLoading(false);
    }
  };

  const pickVersion = async (v: DailyCashSnapshotVersion) => {
    setSelectedVersionId(v.id);
    const snap = v.payload as DailyCashSnapshotPayload;
    setSnapshot(snap);
    setEvents(snap.events || []);
    const names: Record<string, string> = { ...(snap.client_names || {}) };
    const missing = [...new Set((snap.events || []).filter(e => e.client_id).map(e => e.client_id!))]
      .filter(id => !names[id]);
    if (missing.length > 0) {
      const { data: cs } = await supabase.from("clients").select("id, name").in("id", missing);
      for (const c of (cs || [])) names[c.id] = c.name;
    }
    setClientNames(names);
    setVersionsOpen(false);
    toast.success(`Exibindo Versão ${v.version}`);
  };

  const handleReviewRequest = async () => {
    if (!reviewTarget || submitting) return;
    setSubmitting(true);
    try {
      const rpc = reviewTarget.action === "approve" ? "approve_cash_reopen_request" : "reject_cash_reopen_request";
      const { error } = await supabase.rpc(rpc as any, { p_request_id: reviewTarget.req.id, p_note: reviewNote.trim() || null } as any);
      if (error) throw error;
      toast.success(reviewTarget.action === "approve" ? "Solicitação aprovada e caixa reaberto" : "Solicitação recusada");
      setReviewTarget(null); setReviewNote("");
      await fetchReopenRequests();
      await fetchData();
    } catch (err: any) {
      console.error("[caixa] review request failed", err);
      toast.error(err?.message || "Erro ao processar solicitação");
    } finally {
      setSubmitting(false);
    }
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
            {collectionSummary.hasError && (
              <p className="text-[11px] text-destructive font-medium">Não foi possível carregar os totais.</p>
            )}
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

      {/* Bloco: Conferência do Caixa (referência = Caixa Disponível Atual) */}
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
              <span className="text-[10px] text-muted-foreground">
                {isClosed ? "Snapshot do fechamento" : `${summary.eventsCount} atividade${summary.eventsCount === 1 ? "" : "s"}`}
              </span>
            </div>

            {/* Caixa disponível no início do dia */}
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground">Caixa Disponível no Início do Dia</span>
              <span className="text-xs font-medium tabular-nums">{formatCurrency(summary.opening)}</span>
            </div>

            {/* Entradas */}
            <div className="pt-1.5 border-t space-y-0.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-success">Entradas</p>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground pl-2">Pagamentos recebidos</span>
                <span className="text-xs font-medium text-success tabular-nums">+{formatCurrency(summary.received)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground pl-2">Multas recebidas</span>
                <span className="text-xs font-medium text-success tabular-nums">+{formatCurrency(summary.penalty)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground pl-2">Entradas manuais</span>
                <span className="text-xs font-medium text-success tabular-nums">+{formatCurrency(summary.manualIn)}</span>
              </div>
              <div className="flex items-center justify-between border-t pt-1 mt-1">
                <span className="text-xs font-semibold">Total de entradas</span>
                <span className="text-sm font-bold text-success tabular-nums">+{formatCurrency(summary.totalIn)}</span>
              </div>
            </div>

            {/* Saídas */}
            <div className="pt-1.5 border-t space-y-0.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-destructive">Saídas</p>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground pl-2">Novos empréstimos liberados</span>
                <span className="text-xs font-medium text-primary tabular-nums">-{formatCurrency(summary.newLoans)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground pl-2">Dinheiro adicional em renovações</span>
                <span className="text-xs font-medium text-primary tabular-nums">-{formatCurrency(summary.renewals)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground pl-2">Despesas</span>
                <span className="text-xs font-medium text-destructive tabular-nums">-{formatCurrency(summary.expenses)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground pl-2">Saídas manuais</span>
                <span className="text-xs font-medium text-destructive tabular-nums">-{formatCurrency(summary.manualOut)}</span>
              </div>
              <div className="flex items-center justify-between border-t pt-1 mt-1">
                <span className="text-xs font-semibold">Total de saídas</span>
                <span className="text-sm font-bold text-destructive tabular-nums">-{formatCurrency(summary.totalOut)}</span>
              </div>
            </div>

            {/* Dinheiro do trabalhador esperado (auto = totalIn - totalOut) */}
            <div className="flex items-center justify-between border-t pt-1.5">
              <span className="text-xs font-semibold">Dinheiro do trabalhador esperado</span>
              <span className={`text-sm font-bold tabular-nums ${summary.expected >= 0 ? "text-success" : "text-destructive"}`}>
                {summary.expected >= 0 ? "+" : ""}{formatCurrency(summary.expected)}
              </span>
            </div>

            {/* Dinheiro contado no caixa (input do trabalhador — só após fechar) */}
            {isClosed && dailyCashRow && (
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold">Dinheiro contado no caixa</span>
                <span className={`text-sm font-bold tabular-nums ${summary.counted >= 0 ? "text-success" : "text-destructive"}`}>
                  {summary.counted >= 0 ? "+" : ""}{formatCurrency(summary.counted)}
                </span>
              </div>
            )}

            {/* Caixa Disponível no Final do Dia */}
            <div className="flex items-center justify-between border-t pt-1.5">
              <span className="text-xs font-semibold">Caixa Disponível no Final do Dia</span>
              <span className={`text-sm font-bold tabular-nums ${summary.finalCash < 0 ? "text-destructive" : "text-primary"}`}>
                {formatCurrency(summary.finalCash)}
              </span>
            </div>


            {isClosed && dailyCashRow && (
              <div className="pt-1.5 border-t space-y-0.5">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Fechamento</p>
                  {snapshot?.version != null && (
                    <span className="text-[10px] font-semibold text-primary">Versão {(snapshot as any).version ?? 1}</span>
                  )}
                </div>
                {dailyCashRow.closed_at && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">Data/hora do fechamento</span>
                    <span className="text-xs tabular-nums">{new Date(dailyCashRow.closed_at).toLocaleString("pt-BR")}</span>
                  </div>
                )}
                {(dailyCashRow as any).closed_by_name && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">Trabalhador responsável</span>
                    <span className="text-xs font-medium">{(dailyCashRow as any).closed_by_name}</span>
                  </div>
                )}
                {(dailyCashRow as any).closing_note && (
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs text-muted-foreground shrink-0">Observação</span>
                    <span className="text-xs text-right whitespace-pre-wrap break-words">{(dailyCashRow as any).closing_note}</span>
                  </div>
                )}
                <div className="flex items-center justify-between border-t pt-1 mt-1">
                  <span className="text-xs font-semibold">Caixa Disponível no Final do Dia</span>
                  <span className="text-sm font-bold text-primary tabular-nums">{formatCurrency(summary.finalCash)}</span>
                </div>
              </div>
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
            <>
              <Button
                onClick={() => setReopenOpen(true)}
                disabled={submitting}
                variant="outline"
                className="text-xs h-9 col-span-2 border-warning/40 text-warning"
              >
                <Unlock className="mr-1.5 h-3.5 w-3.5" /> {(!isAdmin && !isSuperAdmin) ? "Solicitar reabertura" : "Reabrir caixa"}
              </Button>
              <Button
                onClick={openVersionsDialog}
                variant="ghost"
                className="text-[11px] h-8 col-span-2 text-muted-foreground hover:text-foreground"
              >
                <History className="mr-1.5 h-3.5 w-3.5" /> Ver versões
              </Button>
            </>
          )}
        </div>
      )}

      {/* Admin: solicitações pendentes de reabertura */}
      {(isAdmin || isSuperAdmin) && reopenRequests.length > 0 && (
        <Card className="border-warning/40 bg-warning/5">
          <CardContent className="p-3 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-warning">
              Solicitações de reabertura pendentes ({reopenRequests.length})
            </p>
            <div className="space-y-2">
              {reopenRequests.map((r) => (
                <div key={r.id} className="rounded-md border bg-background p-2 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-medium truncate">{r.worker_name || "—"}</p>
                      <p className="text-[10px] text-muted-foreground">
                        Caixa de {format(new Date(r.cash_date + "T12:00:00"), "dd/MM/yyyy", { locale: ptBR })}
                        {" · "}Solicitado {format(new Date(r.requested_at), "dd/MM HH:mm", { locale: ptBR })}
                      </p>
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground whitespace-pre-wrap break-words">
                    <span className="font-medium text-foreground">Motivo:</span> {r.reason}
                  </p>
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <Button
                      size="sm" variant="outline"
                      className="h-7 text-[11px] border-destructive/40 text-destructive"
                      onClick={() => { setReviewNote(""); setReviewTarget({ req: r, action: "reject" }); }}
                    >
                      <XCircle className="mr-1 h-3 w-3" /> Recusar
                    </Button>
                    <Button
                      size="sm" variant="outline"
                      className="h-7 text-[11px] border-success/40 text-success"
                      onClick={() => { setReviewNote(""); setReviewTarget({ req: r, action: "approve" }); }}
                    >
                      <CheckCircle className="mr-1 h-3 w-3" /> Aprovar
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
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
                        {isRenewal && (
                          <div className="mt-1 pt-1 border-t border-primary/20 space-y-0.5">
                            {m?.renew_paid_amount != null && (
                              <p>Valor pago no contrato anterior: <span className="font-medium text-success">{formatCurrency(Number(m.renew_paid_amount))}</span></p>
                            )}
                            {m?.renew_absorbed_amount != null && Number(m.renew_absorbed_amount) > 0 && (
                              <p>Saldo absorvido (sem caixa): <span className="font-medium text-muted-foreground">{formatCurrency(Number(m.renew_absorbed_amount))}</span></p>
                            )}
                            {m?.renew_additional_cash != null && (
                              <p>Dinheiro adicional entregue: <span className="font-medium text-primary">{formatCurrency(Number(m.renew_additional_cash))}</span></p>
                            )}
                          </div>
                        )}
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

      {/* Despesas do dia */}
      {despesas.length > 0 && (
        <Card className="border-destructive/30">
          <CardHeader className="pb-1.5 pt-3 px-3">
            <CardTitle className="text-xs flex items-center justify-between">
              <span className="flex items-center gap-1"><Receipt className="h-3.5 w-3.5 text-destructive" /> Despesas Hoje</span>
              <span className="text-sm font-bold text-destructive tabular-nums">-{formatCurrency(despesasTotal)}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3 space-y-2">
            {Object.keys(despesasPorCategoria).length > 0 && (
              <div className="flex flex-wrap gap-1">
                {Object.entries(despesasPorCategoria).map(([cat, val]) => (
                  <span key={cat} className="text-[10px] rounded-md border bg-muted/40 px-1.5 py-0.5">
                    {cat}: <span className="font-semibold tabular-nums">{formatCurrency(val)}</span>
                  </span>
                ))}
              </div>
            )}
            <div className="space-y-1">
              {despesas.slice(0, 5).map(ev => {
                const m = (ev.metadata || {}) as any;
                return (
                  <div key={ev.id} className="flex items-center justify-between rounded-md bg-accent/40 px-2 py-1">
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-medium truncate">{m.category || "Sem categoria"}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{m.description || ev.observation || "—"}</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-bold text-destructive tabular-nums">-{formatCurrency(Number(ev.amount_out))}</span>
                      {!workerIsClosed && (
                        <button onClick={() => handleUndoEvent(ev)} className="p-1 rounded hover:bg-destructive/10" title="Estornar despesa">
                          <Undo2 className="h-3 w-3 text-destructive" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {despesas.length > 5 && (
                <button type="button" onClick={() => setActiveSection("movimentos")} className="w-full text-[11px] text-primary hover:underline pt-0.5">
                  Ver todas ({despesas.length}) →
                </button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Action buttons */}
      <div className={`grid gap-2 ${showAjuste ? "grid-cols-4" : "grid-cols-3"}`}>
        <Button disabled={cashLocked || submitting} variant="outline" className="text-success border-success/50 text-xs h-9" onClick={() => setManualType("entrada_manual")}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Entrada
        </Button>
        <Button disabled={cashLocked || submitting} variant="outline" className="text-destructive border-destructive/50 text-xs h-9" onClick={() => setManualType("saida_manual")}>
          <Minus className="mr-1 h-3.5 w-3.5" /> Saída
        </Button>
        <Button disabled={cashLocked || submitting} variant="outline" className="text-destructive border-destructive/50 text-xs h-9" onClick={() => { setExpenseDate(selectedDate); setExpenseOpen(true); }}>
          <Receipt className="mr-1 h-3.5 w-3.5" /> Despesa
        </Button>
        {showAjuste && (
          <Button disabled={cashLocked || submitting} variant="outline" className="text-xs h-9" onClick={() => setManualType("ajuste_manual")}>
            <Settings className="mr-1 h-3.5 w-3.5" /> Ajuste
          </Button>
        )}
      </div>

      <div className="grid gap-2 grid-cols-1">
        <Button variant="outline" className="w-full text-xs h-9" onClick={() => navigate("/daily-cash-history")}>
          <History className="mr-1.5 h-3.5 w-3.5" /> Histórico
        </Button>
      </div>

      {/* Expense dialog */}
      <Dialog open={expenseOpen} onOpenChange={(o) => { if (!o) setExpenseOpen(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Receipt className="h-4 w-4 text-destructive" /> Nova Despesa</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Valor (R$) <span className="text-destructive">*</span></Label>
              <Input type="number" step="0.01" min="0" value={expenseAmount} onChange={(e) => setExpenseAmount(e.target.value)} placeholder="0.00" />
            </div>
            <div>
              <Label>Categoria <span className="text-destructive">*</span></Label>
              <select
                value={expenseCategory}
                onChange={(e) => setExpenseCategory(e.target.value as ExpenseCategory)}
                className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
              >
                {EXPENSE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <Label>Descrição <span className="text-destructive">*</span></Label>
              <Textarea value={expenseDescription} onChange={(e) => setExpenseDescription(e.target.value)} placeholder="Ex.: Combustível moto — posto Shell" />
            </div>
            <div>
              <Label>Data</Label>
              <Input type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} />
            </div>
            <div>
              <Label>Anexar comprovante <span className="text-muted-foreground text-xs">(opcional — imagem ou PDF)</span></Label>
              <Input
                type="file"
                accept="image/*,application/pdf"
                onChange={(e) => setExpenseReceipt(e.target.files?.[0] ?? null)}
              />
              {expenseReceipt && (
                <p className="text-[11px] text-muted-foreground mt-1 truncate">
                  {expenseReceipt.name} — {(expenseReceipt.size / 1024).toFixed(0)} KB
                </p>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              O valor será descontado do Caixa Disponível uma única vez e ficará separado das saídas manuais.
            </p>
            <Button onClick={handleExpense} disabled={submitting} className="w-full">Confirmar despesa</Button>
          </div>
        </DialogContent>
      </Dialog>


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
          <DialogHeader><DialogTitle>{(isAdmin || isSuperAdmin) ? "Reabrir caixa" : "Solicitar reabertura do caixa"}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {(isAdmin || isSuperAdmin)
                ? "Informe o motivo da reabertura. A ação será registrada no histórico de auditoria."
                : "Informe o motivo. A solicitação será enviada ao administrador."}
            </p>
            <div>
              <Label>Motivo <span className="text-destructive">*</span></Label>
              <Textarea value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} placeholder="Ex.: ajuste de pagamento recebido após fechamento" />
            </div>
            <Button
              onClick={(isAdmin || isSuperAdmin) ? handleReopenCash : submitReopenRequest}
              disabled={submitting || reopenReason.trim().length < 3}
              className="w-full"
            >
              {(isAdmin || isSuperAdmin) ? "Confirmar reabertura" : "Enviar solicitação"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Admin: review reopen request dialog */}
      <Dialog open={!!reviewTarget} onOpenChange={(o) => { if (!o) { setReviewTarget(null); setReviewNote(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reviewTarget?.action === "approve" ? "Aprovar reabertura" : "Recusar solicitação"}
            </DialogTitle>
          </DialogHeader>
          {reviewTarget && (
            <div className="space-y-3 text-xs">
              <div className="rounded border bg-muted/30 p-2 space-y-0.5">
                <p><span className="text-muted-foreground">Trabalhador:</span> <span className="font-medium">{reviewTarget.req.worker_name || "—"}</span></p>
                <p><span className="text-muted-foreground">Caixa de:</span> <span className="font-medium">{format(new Date(reviewTarget.req.cash_date + "T12:00:00"), "dd/MM/yyyy", { locale: ptBR })}</span></p>
                <p><span className="text-muted-foreground">Motivo:</span> <span className="whitespace-pre-wrap">{reviewTarget.req.reason}</span></p>
              </div>
              <div>
                <Label className="text-xs">Observação {reviewTarget.action === "reject" ? <span className="text-destructive">*</span> : <span className="text-muted-foreground">(opcional)</span>}</Label>
                <Textarea value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} rows={3} placeholder="Justificativa da decisão..." />
              </div>
              <Button
                onClick={handleReviewRequest}
                disabled={submitting || (reviewTarget.action === "reject" && reviewNote.trim().length < 3)}
                className="w-full"
                variant={reviewTarget.action === "approve" ? "default" : "destructive"}
              >
                {submitting ? "Processando..." : reviewTarget.action === "approve" ? "Aprovar e reabrir" : "Confirmar recusa"}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Close cash dialog */}
      <Dialog open={closeOpen} onOpenChange={(o) => { if (!o) setCloseOpen(false); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Fechar caixa do dia</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="rounded-md border bg-muted/30 p-2.5 text-xs space-y-1">
              <div className="flex justify-between"><span className="text-muted-foreground">Caixa Disponível no Início do Dia</span><span className="tabular-nums">{formatCurrency(summary.opening)}</span></div>
              <div className="pt-1 border-t space-y-0.5">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-success">Entradas</p>
                <div className="flex justify-between"><span className="text-muted-foreground pl-2">Pagamentos recebidos</span><span className="text-success tabular-nums">+{formatCurrency(summary.received)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground pl-2">Multas recebidas</span><span className="text-success tabular-nums">+{formatCurrency(summary.penalty)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground pl-2">Entradas manuais</span><span className="text-success tabular-nums">+{formatCurrency(summary.manualIn)}</span></div>
                <div className="flex justify-between font-semibold"><span>Total de entradas</span><span className="text-success tabular-nums">+{formatCurrency(summary.totalIn)}</span></div>
              </div>
              <div className="pt-1 border-t space-y-0.5">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-destructive">Saídas</p>
                <div className="flex justify-between"><span className="text-muted-foreground pl-2">Novos empréstimos liberados</span><span className="text-primary tabular-nums">-{formatCurrency(summary.newLoans)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground pl-2">Dinheiro adicional em renovações</span><span className="text-primary tabular-nums">-{formatCurrency(summary.renewals)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground pl-2">Despesas</span><span className="text-destructive tabular-nums">-{formatCurrency(summary.expenses)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground pl-2">Saídas manuais</span><span className="text-destructive tabular-nums">-{formatCurrency(summary.manualOut)}</span></div>
                <div className="flex justify-between font-semibold"><span>Total de saídas</span><span className="text-destructive tabular-nums">-{formatCurrency(summary.totalOut)}</span></div>
              </div>
              <div className="flex justify-between border-t pt-1 font-semibold"><span>Dinheiro do trabalhador esperado</span><span className={`tabular-nums ${summary.expected >= 0 ? "text-success" : "text-destructive"}`}>{summary.expected >= 0 ? "+" : ""}{formatCurrency(summary.expected)}</span></div>
              <div className="flex justify-between font-semibold border-t pt-1"><span>Caixa Disponível no Final do Dia</span><span className="tabular-nums text-primary">{formatCurrency(summary.finalCash)}</span></div>
              
            </div>
            {(() => {
              const parsed = parseFloat((countedAmount || "").replace(",", "."));
              const differs = !isNaN(parsed) && Math.abs(Number(parsed.toFixed(2)) - Number(summary.expected.toFixed(2))) > 0.005;
              return (
                <>
                  <div>
                    <Label>Dinheiro contado no caixa <span className="text-destructive">*</span></Label>
                    <Input
                      type="number" inputMode="decimal" step="0.01"
                      value={countedAmount}
                      onChange={(e) => setCountedAmount(e.target.value)}
                      placeholder="0,00"
                    />
                    <p className="text-[10px] text-muted-foreground mt-1">
                      Pré-preenchido com o esperado. Ajuste conforme o dinheiro real em mãos.
                    </p>
                  </div>
                  <div>
                    <Label>
                      Observação {differs ? <span className="text-destructive">* (obrigatória)</span> : <span className="text-muted-foreground">(opcional)</span>}
                    </Label>
                    <Textarea value={closeNote} onChange={(e) => setCloseNote(e.target.value)} placeholder={differs ? "Explique por que o valor contado difere do esperado..." : "Observações do fechamento..."} />
                  </div>
                  <Button
                    onClick={handleCloseCash}
                    disabled={submitting || isNaN(parsed) || (differs && closeNote.trim().length < 3)}
                    className="w-full"
                  >
                    {submitting ? "Salvando..." : "Confirmar fechamento"}
                  </Button>
                </>
              );
            })()}
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
