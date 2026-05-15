import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/loan-utils";
import {
  TrendingUp, TrendingDown, AlertTriangle, DollarSign, ArrowDownCircle,
  ArrowUpCircle, Wallet, ChevronRight, Target,
} from "lucide-react";
import {
  format, startOfWeek, endOfWeek, startOfMonth, endOfMonth, eachDayOfInterval, parseISO,
} from "date-fns";
import { ptBR } from "date-fns/locale";

type PeriodMode = "day" | "week" | "month" | "custom";

type Installment = {
  id: string;
  amount: number;
  paid_amount: number;
  due_date: string;
  status: string;
  is_penalty: boolean;
  loan_id: string;
};

type DailyEventRow = {
  id: string;
  cash_date: string;
  event_type: string;
  amount_in: number;
  amount_out: number;
  client_id: string | null;
  loan_id: string | null;
  observation: string | null;
};

type ClientRow = { id: string; name: string };

const todayISO = () => format(new Date(), "yyyy-MM-dd");

export default function ReportsPage() {
  const [mode, setMode] = useState<PeriodMode>("day");
  const [customStart, setCustomStart] = useState(todayISO());
  const [customEnd, setCustomEnd] = useState(todayISO());

  const [installments, setInstallments] = useState<Installment[]>([]);
  const [events, setEvents] = useState<DailyEventRow[]>([]);
  const [clients, setClients] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [drillDay, setDrillDay] = useState<string | null>(null);

  // Period range
  const { startDate, endDate, label } = useMemo(() => {
    const today = new Date();
    let s: Date, e: Date;
    if (mode === "day") { s = today; e = today; }
    else if (mode === "week") { s = startOfWeek(today, { weekStartsOn: 1 }); e = endOfWeek(today, { weekStartsOn: 1 }); }
    else if (mode === "month") { s = startOfMonth(today); e = endOfMonth(today); }
    else { s = parseISO(customStart + "T12:00:00"); e = parseISO(customEnd + "T12:00:00"); }
    const sIso = format(s, "yyyy-MM-dd");
    const eIso = format(e, "yyyy-MM-dd");
    const lbl = sIso === eIso
      ? `Relatório de ${format(s, "dd/MM/yyyy")}`
      : `Relatório de ${format(s, "dd/MM/yyyy")} a ${format(e, "dd/MM/yyyy")}`;
    return { startDate: sIso, endDate: eIso, label: lbl };
  }, [mode, customStart, customEnd]);

  useEffect(() => {
    let cancel = false;
    async function load() {
      setLoading(true);
      const [insRes, evRes, clRes] = await Promise.all([
        supabase
          .from("installments")
          .select("id, amount, paid_amount, due_date, status, is_penalty, loan_id")
          .gte("due_date", startDate)
          .lte("due_date", endDate),
        supabase
          .from("daily_events" as any)
          .select("id, cash_date, event_type, amount_in, amount_out, client_id, loan_id, observation")
          .gte("cash_date", startDate)
          .lte("cash_date", endDate),
        supabase.from("clients").select("id, name"),
      ]);
      if (cancel) return;
      setInstallments((insRes.data as Installment[]) || []);
      setEvents((evRes.data as unknown as DailyEventRow[]) || []);
      const cmap: Record<string, string> = {};
      ((clRes.data as ClientRow[]) || []).forEach((c) => { cmap[c.id] = c.name; });
      setClients(cmap);
      setLoading(false);
    }
    load();
    return () => { cancel = true; };
  }, [startDate, endDate]);

  // Aggregations
  const totals = useMemo(() => {
    const regularInst = installments.filter((i) => !i.is_penalty);
    const previsto = regularInst.reduce((s, i) => s + Number(i.amount), 0);

    const sum = (filter: (e: DailyEventRow) => boolean, field: "amount_in" | "amount_out") =>
      events.filter(filter).reduce((s, e) => s + Number(e[field] || 0), 0);

    const recebido = sum((e) => e.event_type === "pagamento", "amount_in");
    const recebidoMulta = sum((e) => e.event_type === "recebimento_multa", "amount_in");
    const emprestado = sum((e) => e.event_type === "emprestimo_novo" || e.event_type === "renovacao", "amount_out");
    const retirada = sum((e) => e.event_type === "saida_manual" || e.event_type === "saida", "amount_out");
    const aporte = sum((e) => e.event_type === "entrada_manual", "amount_in");

    const naoPagosEvents = events.filter((e) => e.event_type === "nao_pagou");
    const naoPagosCount = naoPagosEvents.length;
    const naoPagosValor = naoPagosEvents.reduce((s, e) => s + Number(e.amount_out || 0), 0);

    const totalRecebido = recebido + recebidoMulta;
    const faltaReceber = Math.max(0, previsto - totalRecebido);
    const percentual = previsto > 0 ? (totalRecebido / previsto) * 100 : 0;
    const saldoLiquido = totalRecebido + aporte - emprestado - retirada;
    const totalSaidas = emprestado + retirada;

    return {
      previsto, recebido, recebidoMulta, totalRecebido, faltaReceber, percentual,
      emprestado, retirada, aporte, totalSaidas, saldoLiquido, naoPagosCount, naoPagosValor,
    };
  }, [installments, events]);

  // Per-day breakdown
  const days = useMemo(() => {
    const start = parseISO(startDate + "T12:00:00");
    const end = parseISO(endDate + "T12:00:00");
    const list = eachDayOfInterval({ start, end });
    return list.map((d) => {
      const iso = format(d, "yyyy-MM-dd");
      const dayEvents = events.filter((e) => e.cash_date === iso);
      const dayInst = installments.filter((i) => !i.is_penalty && i.due_date === iso);
      const previsto = dayInst.reduce((s, i) => s + Number(i.amount), 0);
      const recebido = dayEvents
        .filter((e) => e.event_type === "pagamento" || e.event_type === "recebimento_multa")
        .reduce((s, e) => s + Number(e.amount_in || 0), 0);
      const emprestado = dayEvents
        .filter((e) => e.event_type === "emprestimo_novo" || e.event_type === "renovacao")
        .reduce((s, e) => s + Number(e.amount_out || 0), 0);
      const retirada = dayEvents
        .filter((e) => e.event_type === "saida_manual" || e.event_type === "saida")
        .reduce((s, e) => s + Number(e.amount_out || 0), 0);
      const aporte = dayEvents
        .filter((e) => e.event_type === "entrada_manual")
        .reduce((s, e) => s + Number(e.amount_in || 0), 0);
      const pagos = dayEvents.filter((e) => e.event_type === "pagamento").length;
      const naoPagos = dayEvents.filter((e) => e.event_type === "nao_pagou").length;
      const saldo = recebido + aporte - emprestado - retirada;
      return { iso, previsto, recebido, emprestado, retirada, aporte, saldo, pagos, naoPagos };
    });
  }, [startDate, endDate, events, installments]);

  const drillEvents = useMemo(
    () => (drillDay ? events.filter((e) => e.cash_date === drillDay) : []),
    [drillDay, events]
  );

  if (loading) return <p className="p-4 text-center text-muted-foreground">Carregando...</p>;

  return (
    <div className="mx-auto max-w-2xl p-4 pb-24">
      <h1 className="text-xl font-bold mb-1">Relatórios</h1>
      <p className="mb-3 text-sm text-muted-foreground">{label}</p>

      {/* Period selector */}
      <Tabs value={mode} onValueChange={(v) => setMode(v as PeriodMode)} className="mb-3">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="day">Dia</TabsTrigger>
          <TabsTrigger value="week">Semana</TabsTrigger>
          <TabsTrigger value="month">Mês</TabsTrigger>
          <TabsTrigger value="custom">Período</TabsTrigger>
        </TabsList>
      </Tabs>

      {mode === "custom" && (
        <Card className="mb-4">
          <CardContent className="p-3 grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Início</Label>
              <Input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">Fim</Label>
              <Input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Main KPIs */}
      <div className="mb-3 grid grid-cols-2 gap-2">
        <KpiCard icon={<Target className="h-4 w-4 text-primary" />} label="Previsto" value={formatCurrency(totals.previsto)} />
        <KpiCard icon={<TrendingUp className="h-4 w-4 text-success" />} label="Recebido" value={formatCurrency(totals.totalRecebido)} valueClass="text-success" />
        <KpiCard icon={<AlertTriangle className="h-4 w-4 text-destructive" />} label="Falta receber" value={formatCurrency(totals.faltaReceber)} valueClass="text-destructive" />
        <KpiCard icon={<TrendingUp className="h-4 w-4 text-primary" />} label="% Recebido" value={`${totals.percentual.toFixed(1)}%`} />
        <KpiCard icon={<ArrowUpCircle className="h-4 w-4 text-warning" />} label="Emprestado" value={formatCurrency(totals.emprestado)} />
        <KpiCard icon={<ArrowDownCircle className="h-4 w-4 text-destructive" />} label="Retirado da rota" value={formatCurrency(totals.retirada)} />
        <KpiCard icon={<ArrowUpCircle className="h-4 w-4 text-success" />} label="Aporte na rota" value={formatCurrency(totals.aporte)} />
        <KpiCard icon={<TrendingDown className="h-4 w-4 text-destructive" />} label="Total saídas" value={formatCurrency(totals.totalSaidas)} />
      </div>

      <Card className="mb-4">
        <CardContent className="p-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Wallet className="h-5 w-5 text-primary" />
            <div>
              <p className="text-xs text-muted-foreground">Saldo líquido do período</p>
              <p className={`text-lg font-bold ${totals.saldoLiquido >= 0 ? "text-success" : "text-destructive"}`}>
                {formatCurrency(totals.saldoLiquido)}
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Não pagos</p>
            <p className="text-sm font-bold text-destructive">{totals.naoPagosCount}</p>
            <p className="text-[11px] text-muted-foreground">{formatCurrency(totals.naoPagosValor)}</p>
          </div>
        </CardContent>
      </Card>

      {/* Per-day breakdown */}
      {days.length > 1 && (
        <Card className="mb-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Quebra por dia</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y">
              {days.map((d) => {
                const dt = parseISO(d.iso + "T12:00:00");
                const isFuture = d.iso > todayISO();
                return (
                  <button
                    key={d.iso}
                    onClick={() => setDrillDay(d.iso)}
                    className="w-full flex items-center justify-between p-3 hover:bg-muted/40 text-left"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {format(dt, "EEE dd/MM", { locale: ptBR })}
                        {isFuture && <span className="ml-1 text-[10px] text-muted-foreground">(futuro)</span>}
                      </p>
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground mt-0.5">
                        <span>Prev: <b>{formatCurrency(d.previsto)}</b></span>
                        <span className="text-success">Rec: <b>{formatCurrency(d.recebido)}</b></span>
                        <span>Empr: <b>{formatCurrency(d.emprestado)}</b></span>
                        <span className="text-destructive">Ret: <b>{formatCurrency(d.retirada)}</b></span>
                        <span className="text-success">Apt: <b>{formatCurrency(d.aporte)}</b></span>
                      </div>
                      <div className="text-[11px] mt-0.5">
                        <span className="text-success">{d.pagos} pagos</span>
                        <span className="mx-1 text-muted-foreground">·</span>
                        <span className="text-destructive">{d.naoPagos} não pagos</span>
                        <span className="mx-1 text-muted-foreground">·</span>
                        <span className={d.saldo >= 0 ? "text-success" : "text-destructive"}>
                          Saldo: <b>{formatCurrency(d.saldo)}</b>
                        </span>
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Drill-down dialog */}
      <Dialog open={!!drillDay} onOpenChange={(o) => !o && setDrillDay(null)}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {drillDay && format(parseISO(drillDay + "T12:00:00"), "EEEE, dd/MM/yyyy", { locale: ptBR })}
            </DialogTitle>
          </DialogHeader>
          <DrillSection title="Pagamentos" items={drillEvents.filter((e) => e.event_type === "pagamento" || e.event_type === "recebimento_multa")} clients={clients} amountKey="amount_in" emptyText="Nenhum pagamento" />
          <DrillSection title="Não pagos" items={drillEvents.filter((e) => e.event_type === "nao_pagou")} clients={clients} amountKey="amount_out" emptyText="Nenhum não pago" />
          <DrillSection title="Empréstimos novos" items={drillEvents.filter((e) => e.event_type === "emprestimo_novo")} clients={clients} amountKey="amount_out" emptyText="Nenhum empréstimo" />
          <DrillSection title="Renovações" items={drillEvents.filter((e) => e.event_type === "renovacao")} clients={clients} amountKey="amount_out" emptyText="Nenhuma renovação" />
          <DrillSection title="Retiradas da rota" items={drillEvents.filter((e) => e.event_type === "saida_manual" || e.event_type === "saida")} clients={clients} amountKey="amount_out" emptyText="Nenhuma retirada" />
          <DrillSection title="Aportes na rota" items={drillEvents.filter((e) => e.event_type === "entrada_manual")} clients={clients} amountKey="amount_in" emptyText="Nenhum aporte" />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function KpiCard({ icon, label, value, valueClass }: { icon: React.ReactNode; label: string; value: string; valueClass?: string }) {
  return (
    <Card>
      <CardContent className="p-2.5">
        <div className="flex items-center gap-1.5 mb-0.5">
          {icon}
          <p className="text-[11px] text-muted-foreground">{label}</p>
        </div>
        <p className={`text-sm font-bold ${valueClass || ""}`}>{value}</p>
      </CardContent>
    </Card>
  );
}

function DrillSection({
  title, items, clients, amountKey, emptyText,
}: {
  title: string;
  items: DailyEventRow[];
  clients: Record<string, string>;
  amountKey: "amount_in" | "amount_out";
  emptyText: string;
}) {
  const total = items.reduce((s, e) => s + Number(e[amountKey] || 0), 0);
  return (
    <div className="border-t pt-2 mt-2 first:border-t-0 first:mt-0 first:pt-0">
      <div className="flex justify-between items-center mb-1">
        <h4 className="text-sm font-semibold">{title} <span className="text-xs text-muted-foreground">({items.length})</span></h4>
        {items.length > 0 && <span className="text-xs font-medium">{formatCurrency(total)}</span>}
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="space-y-1">
          {items.map((e) => (
            <li key={e.id} className="flex justify-between text-xs">
              <span className="truncate flex-1 mr-2">{e.client_id ? clients[e.client_id] || "—" : (e.observation || "—")}</span>
              <span className="font-medium">{formatCurrency(Number(e[amountKey] || 0))}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
