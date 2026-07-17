import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { formatCurrency } from "@/lib/loan-utils";
import {
  RefreshCw, FileDown, Wallet, TrendingUp, ArrowDownCircle,
  ArrowUpCircle, Target, AlertTriangle, ChevronDown, ChevronRight,
} from "lucide-react";
import {
  format, subDays, startOfWeek, endOfWeek, startOfMonth, endOfMonth, parseISO,
} from "date-fns";
import { ptBR } from "date-fns/locale";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  ReportHeader, ReportKpiGrid, ReportKpiCard, ReportEmptyState,
  AuditLink, formatEventLabel, REPORT_SECTIONS,
} from "@/components/reports/ReportUI";

type PeriodMode = "today" | "yesterday" | "week" | "month" | "custom";

type DailyCashRow = {
  id: string;
  cash_date: string;
  worker_id: string | null;
  status: string;
  opening_balance: number;
  expected_closing_balance: number;
  counted_closing_balance: number | null;
  closing_difference: number | null;
};

type DailyEventRow = {
  id: string;
  cash_date: string;
  event_type: string;
  amount_in: number;
  amount_out: number;
  client_id: string | null;
  loan_id: string | null;
  worker_id: string | null;
  observation: string | null;
  created_at: string;
};

type WorkerRow = { id: string; nome: string; active: boolean; archived_at: string | null };

const todayISO = () => format(new Date(), "yyyy-MM-dd");

function computeRange(mode: PeriodMode, cs: string, ce: string) {
  const today = new Date();
  let s: Date, e: Date;
  if (mode === "today") { s = today; e = today; }
  else if (mode === "yesterday") { s = subDays(today, 1); e = subDays(today, 1); }
  else if (mode === "week") { s = startOfWeek(today, { weekStartsOn: 1 }); e = endOfWeek(today, { weekStartsOn: 1 }); }
  else if (mode === "month") { s = startOfMonth(today); e = endOfMonth(today); }
  else { s = parseISO(cs + "T12:00:00"); e = parseISO(ce + "T12:00:00"); }
  const startDate = format(s, "yyyy-MM-dd");
  const endDate = format(e, "yyyy-MM-dd");
  const label = startDate === endDate
    ? format(s, "dd/MM/yyyy")
    : `${format(s, "dd/MM/yyyy")} a ${format(e, "dd/MM/yyyy")}`;
  return { startDate, endDate, label };
}

// Nomes amigáveis vêm de formatEventLabel (compartilhado).

export default function ReportsPage() {
  const [mode, setMode] = useState<PeriodMode>("today");
  const [customStart, setCustomStart] = useState(todayISO());
  const [customEnd, setCustomEnd] = useState(todayISO());
  const [selectedWorker, setSelectedWorker] = useState<string>("all");

  const [workers, setWorkers] = useState<WorkerRow[]>([]);
  const [cashRows, setCashRows] = useState<DailyCashRow[]>([]);
  const [events, setEvents] = useState<DailyEventRow[]>([]);
  const [clients, setClients] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const { startDate, endDate, label } = useMemo(
    () => computeRange(mode, customStart, customEnd),
    [mode, customStart, customEnd],
  );

  const load = useCallback(async () => {
    setLoading(true);
    const wRes = await supabase.rpc("admin_list_workers" as any, { p_include_archived: false });
    const allWorkers = ((wRes.data as WorkerRow[]) || []).filter((w) => w.active && !w.archived_at);
    setWorkers(allWorkers);

    const [cashRes, evRes, clRes] = await Promise.all([
      supabase
        .from("daily_cash")
        .select("id, cash_date, worker_id, status, opening_balance, expected_closing_balance, counted_closing_balance, closing_difference")
        .gte("cash_date", startDate)
        .lte("cash_date", endDate),
      supabase
        .from("daily_events" as any)
        .select("id, cash_date, event_type, amount_in, amount_out, client_id, loan_id, worker_id, observation, created_at")
        .gte("cash_date", startDate)
        .lte("cash_date", endDate)
        .is("reversed_at", null)
        .order("created_at", { ascending: true }),
      supabase.from("clients").select("id, name"),
    ]);
    setCashRows((cashRes.data as DailyCashRow[]) || []);
    setEvents((evRes.data as unknown as DailyEventRow[]) || []);
    const cmap: Record<string, string> = {};
    ((clRes.data as { id: string; name: string }[]) || []).forEach((c) => { cmap[c.id] = c.name; });
    setClients(cmap);
    setLoading(false);
  }, [startDate, endDate]);

  useEffect(() => { load(); }, [load]);

  const filterWorker = <T extends { worker_id: string | null }>(rows: T[]): T[] =>
    selectedWorker === "all" ? rows : rows.filter((r) => r.worker_id === selectedWorker);

  const scopedCash = useMemo(() => filterWorker(cashRows), [cashRows, selectedWorker]);
  const scopedEvents = useMemo(() => filterWorker(events), [events, selectedWorker]);

  // Summary totals
  const summary = useMemo(() => {
    const sumEv = (types: string[], field: "amount_in" | "amount_out") =>
      scopedEvents.filter((e) => types.includes(e.event_type))
        .reduce((s, e) => s + Number(e[field] || 0), 0);

    const caixaInicial = scopedCash.reduce((s, c) => s + Number(c.opening_balance || 0), 0);
    const caixaFinalPrevisto = scopedCash.reduce((s, c) => s + Number(c.expected_closing_balance || 0), 0);
    const caixaFinalContado = scopedCash.reduce((s, c) => s + Number(c.counted_closing_balance || 0), 0);
    const diferenca = scopedCash.reduce((s, c) => s + Number(c.closing_difference || 0), 0);

    const recebido = sumEv(["pagamento", "recebimento_multa"], "amount_in");
    const emprestado = sumEv(["emprestimo_novo", "renovacao"], "amount_out");
    const entradasManuais = sumEv(["entrada_manual"], "amount_in");
    const saidasManuais = sumEv(["saida_manual", "saida", "despesa"], "amount_out");

    return { caixaInicial, caixaFinalPrevisto, caixaFinalContado, diferenca, recebido, emprestado, entradasManuais, saidasManuais };
  }, [scopedCash, scopedEvents]);

  // Per-worker table
  const workerRows = useMemo(() => {
    const list = selectedWorker === "all" ? workers : workers.filter((w) => w.id === selectedWorker);
    return list.map((w) => {
      const wCash = cashRows.filter((c) => c.worker_id === w.id);
      const wEvents = events.filter((e) => e.worker_id === w.id);

      // status: last row in range for the worker
      const latest = wCash.slice().sort((a, b) => (a.cash_date < b.cash_date ? 1 : -1))[0];
      let statusLabel: "Aberto" | "Fechado" | "Não aberto" = "Não aberto";
      if (latest) statusLabel = latest.status === "closed" ? "Fechado" : "Aberto";

      const opening = wCash.reduce((s, c) => s + Number(c.opening_balance || 0), 0);
      const expected = wCash.reduce((s, c) => s + Number(c.expected_closing_balance || 0), 0);
      const counted = wCash.reduce((s, c) => s + Number(c.counted_closing_balance || 0), 0);
      const diff = wCash.reduce((s, c) => s + Number(c.closing_difference || 0), 0);

      const recebimentos = wEvents.filter((e) => e.event_type === "pagamento" || e.event_type === "recebimento_multa")
        .reduce((s, e) => s + Number(e.amount_in || 0), 0);
      const novos = wEvents.filter((e) => e.event_type === "emprestimo_novo")
        .reduce((s, e) => s + Number(e.amount_out || 0), 0);
      const renov = wEvents.filter((e) => e.event_type === "renovacao")
        .reduce((s, e) => s + Number(e.amount_out || 0), 0);
      const pagamentos = wEvents.filter((e) => e.event_type === "pagamento")
        .reduce((s, e) => s + Number(e.amount_in || 0), 0);
      const naoPagos = wEvents.filter((e) => e.event_type === "nao_pagou").length;
      const entMan = wEvents.filter((e) => e.event_type === "entrada_manual")
        .reduce((s, e) => s + Number(e.amount_in || 0), 0);
      const saiMan = wEvents.filter((e) => e.event_type === "saida_manual" || e.event_type === "saida" || e.event_type === "despesa")
        .reduce((s, e) => s + Number(e.amount_out || 0), 0);
      const canc = wEvents.filter((e) => e.event_type === "cancelamento").length;

      return {
        worker: w,
        statusLabel,
        opening, expected, counted, diff,
        totals: { recebimentos, novos, renov, pagamentos, naoPagos, entMan, saiMan, canc },
        movements: wEvents.slice().sort((a, b) => a.created_at.localeCompare(b.created_at)),
      };
    });
  }, [workers, cashRows, events, selectedWorker]);

  const toggleExpanded = (id: string) => setExpanded((p) => ({ ...p, [id]: !p[id] }));

  const exportPDF = () => {
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const workerName = selectedWorker === "all" ? "Todos os trabalhadores" : (workers.find((w) => w.id === selectedWorker)?.nome || "-");
    doc.setFontSize(14);
    doc.text("Relatório Administrativo", 40, 40);
    doc.setFontSize(10);
    doc.text(`Período: ${label}`, 40, 58);
    doc.text(`Trabalhador: ${workerName}`, 40, 72);

    autoTable(doc, {
      startY: 90,
      head: [["Resumo do período", "Valor"]],
      body: [
        ["Caixa inicial", formatCurrency(summary.caixaInicial)],
        ["Total recebido", formatCurrency(summary.recebido)],
        ["Total emprestado", formatCurrency(summary.emprestado)],
        ["Entradas manuais", formatCurrency(summary.entradasManuais)],
        ["Saídas manuais", formatCurrency(summary.saidasManuais)],
        ["Caixa final previsto", formatCurrency(summary.caixaFinalPrevisto)],
        ["Caixa final contado", formatCurrency(summary.caixaFinalContado)],
        ["Diferença de caixa", formatCurrency(summary.diferenca)],
      ],
      styles: { fontSize: 9 },
      headStyles: { fillColor: [30, 41, 59] },
    });

    autoTable(doc, {
      head: [["Trabalhador", "Status", "Cx. Inicial", "Recebido", "Emprestado", "Diferença"]],
      body: workerRows.map((r) => [
        r.worker.nome, r.statusLabel,
        formatCurrency(r.opening),
        formatCurrency(r.totals.recebimentos),
        formatCurrency(r.totals.novos + r.totals.renov),
        formatCurrency(r.diff),
      ]),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [30, 41, 59] },
    });

    // Expanded worker details
    workerRows.forEach((r) => {
      if (!expanded[r.worker.id]) return;
      doc.addPage();
      doc.setFontSize(12);
      doc.text(`Detalhes — ${r.worker.nome}`, 40, 40);
      autoTable(doc, {
        startY: 55,
        head: [["Indicador", "Valor"]],
        body: [
          ["Caixa inicial", formatCurrency(r.opening)],
          ["Caixa final previsto", formatCurrency(r.expected)],
          ["Caixa final contado", formatCurrency(r.counted)],
          ["Recebimentos", formatCurrency(r.totals.recebimentos)],
          ["Novos empréstimos", formatCurrency(r.totals.novos)],
          ["Renovações", formatCurrency(r.totals.renov)],
          ["Pagamentos", formatCurrency(r.totals.pagamentos)],
          ["Não pagamentos", String(r.totals.naoPagos)],
          ["Entradas manuais", formatCurrency(r.totals.entMan)],
          ["Saídas manuais", formatCurrency(r.totals.saiMan)],
          ["Cancelamentos", String(r.totals.canc)],
        ],
        styles: { fontSize: 9 },
      });
      autoTable(doc, {
        head: [["Data/Hora", "Tipo", "Cliente/Obs", "Entrada", "Saída"]],
        body: r.movements.map((m) => [
          format(new Date(m.created_at), "dd/MM HH:mm"),
          formatEventLabel(m.event_type),
          (m.client_id ? clients[m.client_id] : "") || m.observation || "—",
          Number(m.amount_in) > 0 ? formatCurrency(Number(m.amount_in)) : "",
          Number(m.amount_out) > 0 ? formatCurrency(Number(m.amount_out)) : "",
        ]),
        styles: { fontSize: 8 },
      });
    });

    doc.save(`relatorio_${startDate}_${endDate}.pdf`);
  };

  return (
    <div className="mx-auto max-w-4xl p-4 pb-24">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h1 className="text-xl font-bold">Relatórios</h1>
          <p className="text-sm text-muted-foreground">{label}</p>
        </div>
      </div>

      {/* Filters */}
      <Card className="mb-4">
        <CardContent className="p-3 space-y-3">
          <div>
            <Label className="text-xs mb-1 block">Período</Label>
            <div className="flex flex-wrap gap-1">
              {([
                ["today", "Hoje"], ["yesterday", "Ontem"], ["week", "Semana"],
                ["month", "Mês"], ["custom", "Personalizado"],
              ] as [PeriodMode, string][]).map(([v, l]) => (
                <Button key={v} size="sm" variant={mode === v ? "default" : "outline"} onClick={() => setMode(v)}>
                  {l}
                </Button>
              ))}
            </div>
          </div>

          {mode === "custom" && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">Início</Label>
                <Input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
              </div>
              <div>
                <Label className="text-xs">Fim</Label>
                <Input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
              </div>
            </div>
          )}

          <div>
            <Label className="text-xs mb-1 block">Trabalhador</Label>
            <Select value={selectedWorker} onValueChange={setSelectedWorker}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                {workers.map((w) => (
                  <SelectItem key={w.id} value={w.id}>{w.nome}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex gap-2 pt-1">
            <Button size="sm" variant="outline" onClick={load} disabled={loading}>
              <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} /> Atualizar
            </Button>
            <Button size="sm" onClick={exportPDF} disabled={loading}>
              <FileDown className="h-4 w-4 mr-1" /> Baixar PDF
            </Button>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <p className="p-4 text-center text-muted-foreground">Carregando...</p>
      ) : (
        <>
          {/* Summary cards */}
          <div className="mb-4 grid grid-cols-2 gap-2">
            <KpiCard icon={<Wallet className="h-4 w-4 text-primary" />} label="Caixa inicial" value={formatCurrency(summary.caixaInicial)} />
            <KpiCard icon={<TrendingUp className="h-4 w-4 text-success" />} label="Total recebido" value={formatCurrency(summary.recebido)} valueClass="text-success" />
            <KpiCard icon={<ArrowUpCircle className="h-4 w-4 text-warning" />} label="Total emprestado" value={formatCurrency(summary.emprestado)} />
            <KpiCard icon={<ArrowUpCircle className="h-4 w-4 text-success" />} label="Entradas manuais" value={formatCurrency(summary.entradasManuais)} />
            <KpiCard icon={<ArrowDownCircle className="h-4 w-4 text-destructive" />} label="Saídas manuais" value={formatCurrency(summary.saidasManuais)} valueClass="text-destructive" />
            <KpiCard icon={<Target className="h-4 w-4 text-primary" />} label="Caixa final previsto" value={formatCurrency(summary.caixaFinalPrevisto)} />
            <KpiCard icon={<Wallet className="h-4 w-4 text-primary" />} label="Caixa final contado" value={formatCurrency(summary.caixaFinalContado)} />
            <KpiCard
              icon={summary.diferenca >= 0 ? <TrendingUp className="h-4 w-4 text-success" /> : <AlertTriangle className="h-4 w-4 text-destructive" />}
              label="Diferença de caixa"
              value={formatCurrency(summary.diferenca)}
              valueClass={summary.diferenca >= 0 ? "text-success" : "text-destructive"}
            />
          </div>

          {/* Team table */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Resumo da Equipe</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {workerRows.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground text-center">Nenhum trabalhador para o filtro.</p>
              ) : (
                <div className="divide-y">
                  {workerRows.map((r) => {
                    const isOpen = !!expanded[r.worker.id];
                    return (
                      <div key={r.worker.id}>
                        <div className="p-3 flex items-center gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium truncate">{r.worker.nome}</p>
                            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground mt-0.5">
                              <span>
                                Status: <b className={
                                  r.statusLabel === "Aberto" ? "text-success" :
                                  r.statusLabel === "Fechado" ? "text-muted-foreground" : "text-destructive"
                                }>{r.statusLabel}</b>
                              </span>
                              <span>Cx.Inicial: <b>{formatCurrency(r.opening)}</b></span>
                              <span className="text-success">Rec: <b>{formatCurrency(r.totals.recebimentos)}</b></span>
                              <span>Empr: <b>{formatCurrency(r.totals.novos + r.totals.renov)}</b></span>
                              <span className={r.diff >= 0 ? "text-success" : "text-destructive"}>
                                Dif: <b>{formatCurrency(r.diff)}</b>
                              </span>
                            </div>
                          </div>
                          <Button size="sm" variant="ghost" onClick={() => toggleExpanded(r.worker.id)}>
                            {isOpen ? <ChevronDown className="h-4 w-4 mr-1" /> : <ChevronRight className="h-4 w-4 mr-1" />}
                            Ver detalhes
                          </Button>
                        </div>
                        {isOpen && (
                          <div className="px-3 pb-3 bg-muted/20">
                            <div className="grid grid-cols-2 gap-2 mb-3">
                              <DetailPair label="Caixa inicial" value={formatCurrency(r.opening)} />
                              <DetailPair label="Cx. final previsto" value={formatCurrency(r.expected)} />
                              <DetailPair label="Cx. final contado" value={formatCurrency(r.counted)} />
                              <DetailPair label="Recebimentos" value={formatCurrency(r.totals.recebimentos)} />
                              <DetailPair label="Novos empréstimos" value={formatCurrency(r.totals.novos)} />
                              <DetailPair label="Renovações" value={formatCurrency(r.totals.renov)} />
                              <DetailPair label="Pagamentos" value={formatCurrency(r.totals.pagamentos)} />
                              <DetailPair label="Não pagamentos" value={String(r.totals.naoPagos)} />
                              <DetailPair label="Entradas manuais" value={formatCurrency(r.totals.entMan)} />
                              <DetailPair label="Saídas manuais" value={formatCurrency(r.totals.saiMan)} />
                              <DetailPair label="Cancelamentos" value={String(r.totals.canc)} />
                            </div>
                            <div>
                              <p className="text-xs font-semibold mb-1">Movimentações do período</p>
                              {r.movements.length === 0 ? (
                                <p className="text-xs text-muted-foreground">Sem movimentações.</p>
                              ) : (
                                <ul className="divide-y border rounded bg-background">
                                  {r.movements.map((m) => (
                                    <li key={m.id} className="p-2 flex items-center justify-between text-xs gap-2">
                                      <div className="min-w-0 flex-1">
                                        <p className="font-medium truncate">
                                          {formatEventLabel(m.event_type)}
                                        </p>
                                        <p className="text-[11px] text-muted-foreground truncate">
                                          {format(new Date(m.created_at), "dd/MM HH:mm", { locale: ptBR })}
                                          {" · "}
                                          {(m.client_id && clients[m.client_id]) || m.observation || "—"}
                                        </p>
                                      </div>
                                      <div className="text-right shrink-0">
                                        {Number(m.amount_in) > 0 && (
                                          <p className="text-success font-medium">+{formatCurrency(Number(m.amount_in))}</p>
                                        )}
                                        {Number(m.amount_out) > 0 && (
                                          <p className="text-destructive font-medium">-{formatCurrency(Number(m.amount_out))}</p>
                                        )}
                                      </div>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
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

function DetailPair({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border bg-background p-2">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold">{value}</p>
    </div>
  );
}
