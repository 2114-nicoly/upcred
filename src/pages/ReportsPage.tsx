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
  Building2, Users,
} from "lucide-react";
import {
  format, subDays, startOfWeek, endOfWeek, startOfMonth, endOfMonth, parseISO,
} from "date-fns";
import { ptBR } from "date-fns/locale";
import { toast } from "sonner";
import { Share2, Loader2 } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { createReportPdf, downloadReportPdf, shareReportPdf } from "@/lib/report-pdf";
import {
  ReportHeader, ReportKpiGrid, ReportKpiCard, ReportEmptyState,
  AuditLink, formatEventLabel, REPORT_SECTIONS,
} from "@/components/reports/ReportUI";
import DailyReportPage from "@/pages/DailyReportPage";




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

type WorkerRow = {
  id: string; nome: string; active: boolean;
  archived_at: string | null; parent_admin_id: string | null;
};

type AdminRow = { id: string; nome: string; active: boolean };


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
  const [selectedAdmin, setSelectedAdmin] = useState<string>("all");

  const [allWorkers, setAllWorkers] = useState<WorkerRow[]>([]);
  const [admins, setAdmins] = useState<AdminRow[]>([]);
  const [cashRows, setCashRows] = useState<DailyCashRow[]>([]);
  const [events, setEvents] = useState<DailyEventRow[]>([]);
  const [clients, setClients] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [adminName, setAdminName] = useState<string>("");
  const { adminId, isSuperAdmin } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  // Empresa vinda de link externo (ex.: painel do SuperAdmin) — sem criar nova rota.
  useEffect(() => {
    if (!isSuperAdmin) return;
    const qp = searchParams.get("admin");
    if (qp) {
      setSelectedAdmin(qp);
      searchParams.delete("admin");
      setSearchParams(searchParams, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuperAdmin]);

  useEffect(() => {
    if (!adminId) return;
    supabase.from("admins" as any).select("nome").eq("id", adminId).maybeSingle()
      .then(({ data }) => setAdminName(((data as any)?.nome as string) || ""));
  }, [adminId]);


  const { startDate, endDate, label } = useMemo(
    () => computeRange(mode, customStart, customEnd),
    [mode, customStart, customEnd],
  );

  const load = useCallback(async () => {
    setLoading(true);
    const wRes = await supabase.rpc("admin_list_workers" as any, { p_include_archived: false });
    setAllWorkers(((wRes.data as WorkerRow[]) || []).filter((w) => w.active && !w.archived_at));

    if (isSuperAdmin) {
      const aRes = await supabase.rpc("super_admin_list_admins" as any);
      setAdmins(((aRes.data as AdminRow[]) || []).filter((a) => a.active));
    } else {
      setAdmins([]);
    }

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
  }, [startDate, endDate, isSuperAdmin]);

  useEffect(() => { load(); }, [load]);

  /** Visão global do sistema: SuperAdmin com "Todas as empresas". */
  const globalMode = isSuperAdmin && selectedAdmin === "all";

  // Trabalhadores visíveis conforme a empresa selecionada.
  const workers = useMemo(
    () => (isSuperAdmin && selectedAdmin !== "all"
      ? allWorkers.filter((w) => w.parent_admin_id === selectedAdmin)
      : allWorkers),
    [allWorkers, isSuperAdmin, selectedAdmin],
  );

  const activeIds = useMemo(() => new Set(workers.map((w) => w.id)), [workers]);

  // Escopo: apenas trabalhadores ativos vinculados ao administrador
  const scopedCash = useMemo(
    () => cashRows.filter((c) => c.worker_id && activeIds.has(c.worker_id)),
    [cashRows, activeIds],
  );
  const scopedEvents = useMemo(
    () => events.filter((e) => e.worker_id && activeIds.has(e.worker_id)),
    [events, activeIds],
  );


  const sumTotals = (cash: DailyCashRow[], evs: DailyEventRow[]) => {
    const sumEv = (types: string[], field: "amount_in" | "amount_out") =>
      evs.filter((e) => types.includes(e.event_type)).reduce((s, e) => s + Number(e[field] || 0), 0);

    const caixaInicial = cash.reduce((s, c) => s + Number(c.opening_balance || 0), 0);
    const caixaFinal = cash.reduce(
      (s, c) => s + Number(c.counted_closing_balance ?? c.expected_closing_balance ?? 0),
      0,
    );
    const diferenca = cash.reduce((s, c) => s + Number(c.closing_difference || 0), 0);

    const recebido = sumEv(["pagamento"], "amount_in");
    const multas = sumEv(["recebimento_multa"], "amount_in");
    const emprestado = sumEv(["emprestimo_novo", "renovacao", "renegociacao"], "amount_out");
    const entradas = sumEv(["entrada_manual"], "amount_in");
    const saidas = sumEv(["saida_manual", "saida"], "amount_out");
    const despesas = sumEv(["despesa"], "amount_out");
    const estornoEvs = evs.filter((e) => e.event_type.startsWith("estorno"));
    const estornos = estornoEvs.reduce((s, e) => s + Number(e.amount_in || 0) + Number(e.amount_out || 0), 0);

    return {
      caixaInicial, caixaFinal, diferenca, recebido, multas, emprestado,
      entradas, saidas, despesas, estornos, estornosCount: estornoEvs.length,
    };
  };

  // Resumo consolidado da equipe
  const summary = useMemo(() => sumTotals(scopedCash, scopedEvents), [scopedCash, scopedEvents]);

  // Comparativo por trabalhador ativo
  const workerRows = useMemo(() => {
    return workers.map((w) => {
      const wCash = scopedCash.filter((c) => c.worker_id === w.id);
      const wEvents = scopedEvents.filter((e) => e.worker_id === w.id);

      const latest = wCash.slice().sort((a, b) => (a.cash_date < b.cash_date ? 1 : -1))[0];
      let statusLabel: "Aberto" | "Fechado" | "Não aberto" = "Não aberto";
      if (latest) statusLabel = latest.status === "closed" ? "Fechado" : "Aberto";

      return { worker: w, statusLabel, totals: sumTotals(wCash, wEvents) };
    });
  }, [workers, scopedCash, scopedEvents]);

  // Comparativo por empresa (SuperAdmin — "Todas as empresas")
  const companyRows = useMemo(() => {
    if (!globalMode) return [];
    return admins.map((a) => {
      const aWorkers = workers.filter((w) => w.parent_admin_id === a.id);
      const ids = new Set(aWorkers.map((w) => w.id));
      const aCash = scopedCash.filter((c) => c.worker_id && ids.has(c.worker_id));
      const aEvents = scopedEvents.filter((e) => e.worker_id && ids.has(e.worker_id));
      const openCount = aCash.filter((c) => c.status !== "closed").length;
      const statusLabel = aCash.length === 0
        ? "Sem caixa no período"
        : openCount > 0 ? `${openCount} caixa(s) aberto(s)` : "Todos fechados";
      return {
        admin: a,
        workersCount: aWorkers.length,
        statusLabel,
        hasOpen: openCount > 0,
        totals: sumTotals(aCash, aEvents),
      };
    });
  }, [globalMode, admins, workers, scopedCash, scopedEvents]);



  // Detalhamento por dia (equipe) — sem misturar datas
  const dayRows = useMemo(() => {
    const dates = new Set<string>();
    scopedCash.forEach((c) => dates.add(c.cash_date));
    scopedEvents.forEach((e) => dates.add(e.cash_date));
    return Array.from(dates)
      .sort((a, b) => (a < b ? 1 : -1))
      .map((date) => {
        const dCash = scopedCash.filter((c) => c.cash_date === date);
        const dEvents = scopedEvents.filter((e) => e.cash_date === date);
        const openCount = dCash.filter((c) => c.status !== "closed").length;
        const closedCount = dCash.filter((c) => c.status === "closed").length;

        const perWorker = workers
          .map((w) => {
            const wCash = dCash.filter((c) => c.worker_id === w.id);
            const wEvents = dEvents.filter((e) => e.worker_id === w.id);
            if (wCash.length === 0 && wEvents.length === 0) return null;
            const cash = wCash[0];
            const isOpen = !!cash && cash.status !== "closed";
            return {
              worker: w,
              isOpen,
              statusLabel: !cash ? "Não aberto" : isOpen ? "Caixa ainda aberto" : "Fechado",
              totals: sumTotals(wCash, wEvents),
            };
          })
          .filter(Boolean) as {
            worker: WorkerRow; isOpen: boolean; statusLabel: string;
            totals: ReturnType<typeof sumTotals>;
          }[];

        return { date, openCount, closedCount, totals: sumTotals(dCash, dEvents), perWorker };
      });
  }, [scopedCash, scopedEvents, workers]);

  const openWorkerOnDay = (workerId: string, date: string) => {
    setMode("custom");
    setCustomStart(date);
    setCustomEnd(date);
    setSelectedWorker(workerId);
  };


  // Único gerador de PDF do Administrador — mesmo padrão do Relatório do Trabalhador,
  // usando exatamente os dados já exibidos na tela.
  const buildPdf = () => {
    const pdf = createReportPdf({
      title: "UpCredit — Relatório da Equipe",
      metaLines: [
        `Administrador: ${adminName || "—"}`,
        `Escopo: Todos os trabalhadores`,
        `Período: ${label}`,
      ],
    });

    const hasMovement =
      scopedCash.length > 0 || scopedEvents.length > 0;

    pdf.blockTitle("Resumo financeiro da equipe");
    if (!hasMovement) {
      pdf.text("Nenhuma movimentação registrada no período selecionado.");
    }
    pdf.table(null, ["Indicador", "Valor"], [
      ["Caixa inicial da equipe", formatCurrency(summary.caixaInicial)],
      ["Caixa final da equipe", formatCurrency(summary.caixaFinal)],
      ["Total recebido", formatCurrency(summary.recebido)],
      ["Total emprestado", formatCurrency(summary.emprestado)],
      ["Entradas", formatCurrency(summary.entradas)],
      ["Saídas", formatCurrency(summary.saidas)],
      ["Despesas", formatCurrency(summary.despesas)],
      ["Multas", formatCurrency(summary.multas)],
      ["Estornos", formatCurrency(summary.estornos)],
      ["Diferença total de caixa", formatCurrency(summary.diferenca)],
    ], { rightCols: [1] });

    pdf.blockTitle("Comparação dos trabalhadores");
    if (workerRows.length === 0) {
      pdf.text("Nenhum trabalhador ativo no período.");
    }
    pdf.table(
      null,
      ["Trabalhador", "Status", "Cx. inicial", "Cx. final", "Recebido", "Emprestado", "Despesas", "Diferença"],
      workerRows.map((r) => [
        r.worker.nome, r.statusLabel,
        formatCurrency(r.totals.caixaInicial),
        formatCurrency(r.totals.caixaFinal),
        formatCurrency(r.totals.recebido),
        formatCurrency(r.totals.emprestado),
        formatCurrency(r.totals.despesas),
        formatCurrency(r.totals.diferenca),
      ]),
      { rightCols: [2, 3, 4, 5, 6, 7] },
    );

    if (startDate !== endDate) {
      pdf.blockTitle("Detalhamento por dia");
      if (dayRows.length === 0) {
        pdf.text("Nenhuma movimentação no período.");
      }
      dayRows.forEach((d) => {
        const dayLabel = format(parseISO(d.date + "T12:00:00"), "dd/MM/yyyy (EEEE)", { locale: ptBR });
        pdf.table(dayLabel, ["Indicador", "Valor"], [
          ["Caixa inicial", formatCurrency(d.totals.caixaInicial)],
          ["Caixa final", formatCurrency(d.totals.caixaFinal)],
          ["Total recebido", formatCurrency(d.totals.recebido)],
          ["Total emprestado", formatCurrency(d.totals.emprestado)],
          ["Despesas", formatCurrency(d.totals.despesas)],
          ["Diferença total de caixa", formatCurrency(d.totals.diferenca)],
          ["Caixas abertos", String(d.openCount)],
          ["Caixas fechados", String(d.closedCount)],
        ], { rightCols: [1] });

        pdf.table(
          null,
          ["Trabalhador", "Recebido", "Emprestado", "Despesas", "Cx. final", "Diferença", "Status"],
          d.perWorker.map((r) => [
            r.worker.nome,
            formatCurrency(r.totals.recebido),
            formatCurrency(r.totals.emprestado),
            formatCurrency(r.totals.despesas),
            formatCurrency(r.totals.caixaFinal),
            formatCurrency(r.totals.diferenca),
            r.statusLabel,
          ]),
          { rightCols: [1, 2, 3, 4, 5] },
        );
      });
    }

    pdf.blockTitle("Totais finais");
    pdf.table(null, ["Total", "Valor"], [
      ["Recebido no período", formatCurrency(summary.recebido)],
      ["Emprestado no período", formatCurrency(summary.emprestado)],
      ["Despesas no período", formatCurrency(summary.despesas)],
      ["Caixa final da equipe", formatCurrency(summary.caixaFinal)],
      ["Diferença total de caixa", formatCurrency(summary.diferenca)],
    ], { rightCols: [1] });

    const filename = `relatorio-equipe-${startDate}_a_${endDate}.pdf`;
    return { doc: pdf.doc, filename };
  };

  const handleDownloadPDF = async () => {
    if (generatingPdf) return;
    setGeneratingPdf(true);
    try {
      const { doc, filename } = buildPdf();
      downloadReportPdf(doc, filename);
    } catch (err: any) {
      console.error("[Reports PDF] erro:", err);
      toast.error("Não foi possível gerar o PDF: " + (err?.message || "erro desconhecido"));
    } finally {
      setGeneratingPdf(false);
    }
  };

  const handleSharePDF = async () => {
    if (generatingPdf) return;
    setGeneratingPdf(true);
    try {
      const { doc, filename } = buildPdf();
      await shareReportPdf(doc, filename, `Relatório UpCredit — Equipe — ${label}`);
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        console.error("[Reports share] erro:", err);
        toast.error("Não foi possível compartilhar: " + (err?.message || "erro desconhecido"));
      }
    } finally {
      setGeneratingPdf(false);
    }
  };



  const companyLabel =
    !isSuperAdmin ? undefined
      : selectedAdmin === "all"
        ? "Todas as empresas"
        : (admins.find((a) => a.id === selectedAdmin)?.nome || "—");

  const workerLabel =
    selectedWorker === "all"
      ? "Todos os trabalhadores"
      : (workers.find((w) => w.id === selectedWorker)?.nome || "—");

  return (
    <div className="mx-auto max-w-4xl p-4 pb-24 space-y-3">
      <ReportHeader
        title="Relatórios"
        subject={companyLabel ? `${companyLabel} · ${globalMode ? "Visão global do sistema" : workerLabel}` : workerLabel}
        period={label}
        right={<AuditLink />}
      />



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

          {isSuperAdmin && (
            <div>
              <Label className="text-xs mb-1 block">Empresa (Administrador)</Label>
              <Select
                value={selectedAdmin}
                onValueChange={(v) => { setSelectedAdmin(v); setSelectedWorker("all"); }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas as empresas</SelectItem>
                  {admins.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.nome}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {!globalMode && (
            <div>
              <Label className="text-xs mb-1 block">Trabalhador</Label>
              <Select value={selectedWorker} onValueChange={setSelectedWorker}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os trabalhadores</SelectItem>
                  {workers.map((w) => (
                    <SelectItem key={w.id} value={w.id}>{w.nome}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}


          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" variant="outline" onClick={load} disabled={loading}>
              <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} /> Atualizar
            </Button>
            {selectedWorker === "all" && !globalMode && (
              <>
                <Button size="sm" onClick={handleDownloadPDF} disabled={loading || generatingPdf}>
                  {generatingPdf
                    ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Gerando…</>
                    : <><FileDown className="h-4 w-4 mr-1" /> Baixar PDF</>}
                </Button>
                <Button size="sm" variant="outline" onClick={handleSharePDF} disabled={loading || generatingPdf}>
                  <Share2 className="h-4 w-4 mr-1" /> Compartilhar
                </Button>
              </>
            )}
          </div>

        </CardContent>
      </Card>

      {selectedWorker !== "all" ? (
        <DailyReportPage
          embeddedWorkerId={selectedWorker}
          embeddedStart={startDate}
          embeddedEnd={endDate}
        />
      ) : loading ? (
        <p className="p-4 text-center text-muted-foreground">Carregando...</p>

      ) : (
        <>
          {/* Resumo financeiro do período */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              {REPORT_SECTIONS.resumo}
            </p>
            <ReportKpiGrid>
              <ReportKpiCard icon={<Wallet className="h-4 w-4 text-primary" />} label="Caixa inicial da equipe" value={formatCurrency(summary.caixaInicial)} />
              <ReportKpiCard icon={<Target className="h-4 w-4 text-primary" />} label="Caixa final da equipe" value={formatCurrency(summary.caixaFinal)} />
              <ReportKpiCard icon={<TrendingUp className="h-4 w-4 text-success" />} label="Total recebido" value={formatCurrency(summary.recebido)} tone="positive" />
              <ReportKpiCard icon={<ArrowUpCircle className="h-4 w-4 text-warning" />} label="Total emprestado" value={formatCurrency(summary.emprestado)} />
              <ReportKpiCard icon={<ArrowUpCircle className="h-4 w-4 text-success" />} label="Entradas" value={formatCurrency(summary.entradas)} tone="positive" />
              <ReportKpiCard icon={<ArrowDownCircle className="h-4 w-4 text-destructive" />} label="Saídas" value={formatCurrency(summary.saidas)} tone="negative" />
              <ReportKpiCard icon={<ArrowDownCircle className="h-4 w-4 text-destructive" />} label="Despesas" value={formatCurrency(summary.despesas)} tone="negative" />
              <ReportKpiCard icon={<TrendingUp className="h-4 w-4 text-success" />} label="Multas" value={formatCurrency(summary.multas)} tone="positive" />
              <ReportKpiCard icon={<RefreshCw className="h-4 w-4 text-muted-foreground" />} label="Estornos" value={formatCurrency(summary.estornos)} />
              <ReportKpiCard
                icon={summary.diferenca >= 0 ? <TrendingUp className="h-4 w-4 text-success" /> : <AlertTriangle className="h-4 w-4 text-destructive" />}
                label="Diferença total de caixa"
                value={formatCurrency(summary.diferenca)}
                tone={summary.diferenca >= 0 ? "positive" : "negative"}
              />
            </ReportKpiGrid>
          </div>

          {/* Comparativo dos trabalhadores ativos */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Trabalhadores ativos</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {workerRows.length === 0 ? (
                <p className="p-6 text-sm text-muted-foreground text-center">Nenhum trabalhador ativo.</p>
              ) : (
                <div className="divide-y">
                  {workerRows.map((r) => (
                    <button
                      key={r.worker.id}
                      type="button"
                      onClick={() => setSelectedWorker(r.worker.id)}
                      className="w-full text-left p-3 flex items-center gap-2 hover:bg-muted/40 active:bg-muted/60 transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium truncate">{r.worker.nome}</p>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${
                            r.statusLabel === "Aberto" ? "text-success border-success/40" :
                            r.statusLabel === "Fechado" ? "text-muted-foreground" : "text-destructive border-destructive/40"
                          }`}>{r.statusLabel}</span>
                        </div>
                        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground mt-1">
                          <span>Cx. inicial: <b className="text-foreground">{formatCurrency(r.totals.caixaInicial)}</b></span>
                          <span>Cx. final: <b className="text-foreground">{formatCurrency(r.totals.caixaFinal)}</b></span>
                          <span>Recebido: <b className="text-success">{formatCurrency(r.totals.recebido)}</b></span>
                          <span>Emprestado: <b className="text-foreground">{formatCurrency(r.totals.emprestado)}</b></span>
                          <span>Despesas: <b className="text-destructive">{formatCurrency(r.totals.despesas)}</b></span>
                          <span>
                            Diferença: <b className={r.totals.diferenca >= 0 ? "text-success" : "text-destructive"}>
                              {formatCurrency(r.totals.diferenca)}
                            </b>
                          </span>
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Detalhamento por dia */}
          {startDate !== endDate && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Detalhamento por dia</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {dayRows.length === 0 ? (
                  <ReportEmptyState message="Nenhuma movimentação no período." />
                ) : (
                  <div className="divide-y">
                    {dayRows.map((d) => {
                      const isOpen = !!expanded[d.date];
                      return (
                        <div key={d.date}>
                          <button
                            type="button"
                            onClick={() => setExpanded((p) => ({ ...p, [d.date]: !p[d.date] }))}
                            className="w-full text-left p-3 flex items-center gap-2 hover:bg-muted/40 active:bg-muted/60 transition-colors"
                          >
                            {isOpen
                              ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                              : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium">
                                {format(parseISO(d.date + "T12:00:00"), "dd/MM/yyyy (EEEE)", { locale: ptBR })}
                              </p>
                              <p className="text-[11px] text-muted-foreground">
                                {d.openCount} aberto(s) · {d.closedCount} fechado(s)
                              </p>
                            </div>
                            <span className="text-xs text-success shrink-0">{formatCurrency(d.totals.recebido)}</span>
                          </button>

                          {isOpen && (
                            <div className="px-3 pb-3 space-y-3">
                              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-muted-foreground rounded-md bg-muted/40 p-2">
                                <span>Caixa inicial: <b className="text-foreground">{formatCurrency(d.totals.caixaInicial)}</b></span>
                                <span>Caixa final: <b className="text-foreground">{formatCurrency(d.totals.caixaFinal)}</b></span>
                                <span>Recebido: <b className="text-success">{formatCurrency(d.totals.recebido)}</b></span>
                                <span>Emprestado: <b className="text-foreground">{formatCurrency(d.totals.emprestado)}</b></span>
                                <span>Despesas: <b className="text-destructive">{formatCurrency(d.totals.despesas)}</b></span>
                                <span>
                                  Diferença: <b className={d.totals.diferenca >= 0 ? "text-success" : "text-destructive"}>
                                    {formatCurrency(d.totals.diferenca)}
                                  </b>
                                </span>
                                <span>Caixas abertos: <b className="text-foreground">{d.openCount}</b></span>
                                <span>Caixas fechados: <b className="text-foreground">{d.closedCount}</b></span>
                              </div>

                              {d.perWorker.length === 0 ? (
                                <p className="text-[11px] text-muted-foreground">Nenhum trabalhador com movimentação.</p>
                              ) : (
                                <div className="divide-y rounded-md border">
                                  {d.perWorker.map((r) => (
                                    <button
                                      key={r.worker.id}
                                      type="button"
                                      onClick={() => openWorkerOnDay(r.worker.id, d.date)}
                                      className="w-full text-left p-2.5 flex items-center gap-2 hover:bg-muted/40 active:bg-muted/60 transition-colors"
                                    >
                                      <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2">
                                          <p className="text-sm font-medium truncate">{r.worker.nome}</p>
                                          <span className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${
                                            r.isOpen ? "text-success border-success/40" :
                                            r.statusLabel === "Fechado" ? "text-muted-foreground" : "text-destructive border-destructive/40"
                                          }`}>{r.statusLabel}</span>
                                        </div>
                                        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground mt-1">
                                          <span>Recebido: <b className="text-success">{formatCurrency(r.totals.recebido)}</b></span>
                                          <span>Emprestado: <b className="text-foreground">{formatCurrency(r.totals.emprestado)}</b></span>
                                          <span>Despesas: <b className="text-destructive">{formatCurrency(r.totals.despesas)}</b></span>
                                          <span>Cx. final: <b className="text-foreground">{formatCurrency(r.totals.caixaFinal)}</b></span>
                                          <span>
                                            Diferença: <b className={r.totals.diferenca >= 0 ? "text-success" : "text-destructive"}>
                                              {formatCurrency(r.totals.diferenca)}
                                            </b>
                                          </span>
                                        </div>
                                      </div>
                                      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </>

      )}
    </div>
  );
}

