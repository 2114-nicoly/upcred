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
} from "@/lib/cash-utils";
import { getDailyEvents, createDailyEvent, undoDailyEvent, getEventTypeLabel, getEventTypeColor, DailyEvent } from "@/lib/daily-events";
import {
  Wallet, TrendingUp, TrendingDown, AlertTriangle, Plus, Minus, Settings,
  History, ChevronLeft, ChevronRight, CheckCircle, XCircle, RefreshCw,
  DollarSign, ArrowDownCircle, ArrowUpCircle, Undo2
} from "lucide-react";
import { EmptyState } from "@/components/LoadingSkeleton";
import { format, addDays } from "date-fns";
import { ptBR } from "date-fns/locale";
import { toast } from "sonner";
import { useConfirm } from "@/hooks/useConfirm";

type ActiveSection = "resumo" | "pagos" | "naopagos" | "novos" | "movimentos";

export default function CaixaPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const confirm = useConfirm();
  const today = format(new Date(), "yyyy-MM-dd");
  const [selectedDate, setSelectedDate] = useState(searchParams.get("date") || today);
  const [balance, setBalance] = useState<CashBalance | null>(null);
  const [events, setEvents] = useState<DailyEvent[]>([]);
  const [clientNames, setClientNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [activeSection, setActiveSection] = useState<ActiveSection>("resumo");

  // Manual movement dialog
  const [manualType, setManualType] = useState<"entrada_manual" | "saida_manual" | "ajuste_manual" | null>(null);
  const [manualAmount, setManualAmount] = useState("");
  const [manualObs, setManualObs] = useState("");

  const changeDate = (offset: number) => {
    const d = new Date(selectedDate + "T12:00:00");
    setSelectedDate(format(addDays(d, offset), "yyyy-MM-dd"));
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [bal, dayEvents] = await Promise.all([
        getCashBalance(),
        getDailyEvents(selectedDate),
      ]);
      setBalance(bal);
      setEvents(dayEvents);

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
      setLoading(false);
    }
  }, [selectedDate]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Computed totals from daily_events
  const totalIn = events.reduce((s, e) => s + Number(e.amount_in), 0);
  const totalOut = events.reduce((s, e) => s + Number(e.amount_out), 0);
  const saldoDia = totalIn - totalOut;

  const pagamentos = events.filter(e => e.event_type === "pagamento" || e.event_type === "recebimento_multa");
  const naoPagos = events.filter(e => e.event_type === "nao_pagou");
  const novos = events.filter(e => e.event_type === "emprestimo_novo" || e.event_type === "renovacao");
  const movimentos = events.filter(e => ["entrada_manual", "saida_manual", "ajuste_manual", "saida"].includes(e.event_type));

  const handleManualMovement = async () => {
    if (!manualType) return;
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
    }

    toast.success("Movimentação registrada!");
    setManualType(null);
    setManualAmount("");
    setManualObs("");
    fetchData();
  };

  const handleRecalculate = async () => {
    await recalculateCashBalanceFromLedger();
    toast.success("Caixa recalculado com sucesso!");
    fetchData();
  };

  const handleUndoEvent = async (event: DailyEvent) => {
    const valor = Number(event.amount_in) || Number(event.amount_out) || 0;
    const ok = await confirm({
      title: "Desfazer lançamento?",
      description: "O saldo do caixa será revertido conforme este evento.",
      affected: [
        { label: "Tipo", value: getEventTypeLabel(event.event_type) },
        ...(valor > 0 ? [{ label: "Valor", value: formatCurrency(valor) }] : []),
        ...(event.client_id && clientNames[event.client_id] ? [{ label: "Cliente", value: clientNames[event.client_id] }] : []),
      ],
      confirmText: "Desfazer", destructive: true,
    });
    if (!ok) return;
    try {
      await undoDailyEvent(event);
      toast.success("Lançamento desfeito!");
      fetchData();
    } catch {
      toast.error("Erro ao desfazer lançamento");
    }
  };

  if (loading) return <p className="p-4 text-center text-muted-foreground">Carregando...</p>;

  return (
    <div className="mx-auto max-w-lg p-3 pb-36 space-y-3">
      {/* Date navigation */}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => changeDate(-1)}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 text-center">
          <p className="text-xs font-medium capitalize">
            {format(new Date(selectedDate + "T12:00:00"), "EEE, dd 'de' MMMM", { locale: ptBR })}
          </p>
          {selectedDate !== today && (
            <button className="text-[10px] text-primary underline" onClick={() => setSelectedDate(today)}>
              Voltar para hoje
            </button>
          )}
        </div>
        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => changeDate(1)}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

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
              <p className="text-[10px] text-muted-foreground">Dinheiro Emprestado</p>
              <p className="text-sm font-bold">{formatCurrency(Number(balance.money_lent))}</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Daily summary card */}
      <Card>
        <CardContent className="p-3 space-y-1.5">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Resumo do Dia</p>
          <div className="flex items-center justify-between">
            <span className="text-xs text-success flex items-center gap-1"><ArrowDownCircle className="h-3 w-3" /> Entradas</span>
            <span className="text-sm font-bold text-success tabular-nums">+{formatCurrency(totalIn)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-destructive flex items-center gap-1"><ArrowUpCircle className="h-3 w-3" /> Saídas</span>
            <span className="text-sm font-bold text-destructive tabular-nums">-{formatCurrency(totalOut)}</span>
          </div>
          <div className="flex items-center justify-between border-t pt-1.5">
            <span className="text-xs font-semibold">Saldo do Dia</span>
            <span className={`text-sm font-bold tabular-nums ${saldoDia >= 0 ? "text-success" : "text-destructive"}`}>
              {saldoDia >= 0 ? "+" : ""}{formatCurrency(saldoDia)}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Section tabs */}
      <div className="grid grid-cols-4 gap-1.5">
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
          onClick={() => setActiveSection("movimentos")}
          className={`rounded-lg border p-1.5 text-center transition-colors ${activeSection === "movimentos" ? "border-border bg-accent/50" : "bg-card"}`}
        >
          <p className="text-[10px] text-muted-foreground">Manual</p>
          <p className="text-base font-bold">{movimentos.length}</p>
        </button>
      </div>

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
                    <button onClick={() => handleUndoEvent(ev)} className="p-1 rounded hover:bg-destructive/10" title="Desfazer">
                      <Undo2 className="h-3.5 w-3.5 text-destructive" />
                    </button>
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
                    <button onClick={() => handleUndoEvent(ev)} className="p-1 rounded hover:bg-destructive/10" title="Desfazer">
                      <Undo2 className="h-3.5 w-3.5 text-destructive" />
                    </button>
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
            <div className="flex flex-col items-center py-8">
              <DollarSign className="mb-2 h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Nenhum empréstimo neste dia</p>
            </div>
          ) : (
            novos.map(ev => {
              const isRenewal = ev.event_type === "renovacao";
              return (
                <div key={ev.id} className={`rounded-lg border bg-card p-2.5 ${isRenewal ? "border-primary/30" : "border-success/30"}`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold">{ev.client_id ? clientNames[ev.client_id] || "Cliente" : "—"}</p>
                      {ev.observation && <p className="text-[10px] text-muted-foreground">{ev.observation}</p>}
                    </div>
                    <div className="text-right">
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

      {activeSection === "movimentos" && (
        <div className="space-y-2">
          <h2 className="text-xs font-semibold text-muted-foreground flex items-center gap-1 uppercase tracking-wider">
            Movimentações Manuais
          </h2>
          {movimentos.length === 0 ? (
            <div className="flex flex-col items-center py-8">
              <Settings className="mb-2 h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Nenhuma movimentação manual</p>
            </div>
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
                    <button onClick={() => handleUndoEvent(ev)} className="p-1 rounded hover:bg-destructive/10" title="Desfazer">
                      <Undo2 className="h-3.5 w-3.5 text-destructive" />
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {activeSection === "resumo" && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground text-center">Selecione uma aba acima para ver os detalhes do dia.</p>
          {/* All events timeline */}
          {events.length > 0 && (
            <Card>
              <CardHeader className="pb-1.5 pt-3 px-3">
                <CardTitle className="text-xs">Todos os Lançamentos ({events.length})</CardTitle>
              </CardHeader>
              <CardContent className="px-3 pb-3 space-y-1.5">
                {events.map(ev => (
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
                      <button onClick={() => handleUndoEvent(ev)} className="p-0.5 rounded hover:bg-destructive/10" title="Desfazer">
                        <Undo2 className="h-3 w-3 text-destructive" />
                      </button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="grid grid-cols-3 gap-2">
        <Button variant="outline" className="text-success border-success/50 text-xs h-9" onClick={() => setManualType("entrada_manual")}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Entrada
        </Button>
        <Button variant="outline" className="text-destructive border-destructive/50 text-xs h-9" onClick={() => setManualType("saida_manual")}>
          <Minus className="mr-1 h-3.5 w-3.5" /> Saída
        </Button>
        <Button variant="outline" className="text-xs h-9" onClick={() => setManualType("ajuste_manual")}>
          <Settings className="mr-1 h-3.5 w-3.5" /> Ajuste
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" className="w-full text-xs h-9" onClick={() => navigate("/daily-cash-history")}>
          <History className="mr-1.5 h-3.5 w-3.5" /> Histórico
        </Button>
        <Button variant="outline" className="w-full text-xs h-9" onClick={handleRecalculate}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Recalcular
        </Button>
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
            <Button onClick={handleManualMovement} className="w-full">Confirmar</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
