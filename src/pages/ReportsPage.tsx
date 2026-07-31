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
import {
  emptyReportDetails,
  type ReportDetailsData, type ReportRecord,
} from "@/lib/report-details";
import {
  loadFrozenReportPeriod, emptyFrozenPeriod, type FrozenReportPeriod,
} from "@/lib/frozen-report";
import { RecordSection } from "@/components/reports/RecordSection";
import { computeCoreTotals } from "@/lib/finance-totals";
import {
  loadScopeWorkers, loadWorkersStats, consolidate, groupByCompany,
  type WorkerStats,
} from "@/lib/consolidated-stats";






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
  const [stats, setStats] = useState<WorkerStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
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

  // Empresa (admin) do escopo atual. Admin comum = escopo natural (própria empresa).
  const scopeAdminId = isSuperAdmin && selectedAdmin !== "all" ? selectedAdmin : null;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      if (isSuperAdmin) {
        const aRes = await supabase.rpc("super_admin_list_admins" as any);
        if (aRes.error) throw aRes.error;
        setAdmins(((aRes.data as AdminRow[]) || []).filter((a) => a.active));
      } else {
        setAdmins([]);
      }

      // Trabalhadores do escopo — consulta já escopada (nunca global + filtro depois).
      const scopeWorkers = await loadScopeWorkers(scopeAdminId);
      const ids = scopeWorkers.map((w) => w.id);
      setAllWorkers(scopeWorkers.map((w) => ({
        id: w.id, nome: w.nome, active: w.active,
        archived_at: w.archived_at, parent_admin_id: w.parent_admin_id,
      })));

      if (ids.length === 0) {
        setStats([]); setCashRows([]); setEvents([]); setClients({});
        setLoading(false);
        return;
      }

      // Fonte única de todos os indicadores (trabalhador, equipe, empresa).
      const [statsList, cashRes, evRes, clRes] = await Promise.all([
        loadWorkersStats({ startDate, endDate, label }, { adminId: scopeAdminId, workers: scopeWorkers }),
        supabase
          .from("daily_cash")
          .select("id, cash_date, worker_id, status, opening_balance, expected_closing_balance, counted_closing_balance, closing_difference")
          .gte("cash_date", startDate)
          .lte("cash_date", endDate)
          .in("worker_id", ids),
        supabase
          .from("daily_events" as any)
          .select("id, cash_date, event_type, amount_in, amount_out, client_id, loan_id, worker_id, observation, created_at")
          .gte("cash_date", startDate)
          .lte("cash_date", endDate)
          .in("worker_id", ids)
          .is("reversed_at", null)
          .order("created_at", { ascending: true }),
        supabase.from("clients").select("id, name").in("worker_id", ids),
      ]);
      if (cashRes.error) throw cashRes.error;
      if (evRes.error) throw evRes.error;
      if (clRes.error) throw clRes.error;

      setStats(statsList);
      setCashRows((cashRes.data as DailyCashRow[]) || []);
      setEvents((evRes.data as unknown as DailyEventRow[]) || []);
      const cmap: Record<string, string> = {};
      ((clRes.data as { id: string; name: string }[]) || []).forEach((c) => { cmap[c.id] = c.name; });
      setClients(cmap);
    } catch (err) {
      console.error("[Reports] falha ao carregar dados do escopo", err);
      setLoadError(true);
      setStats([]); setCashRows([]); setEvents([]);
      toast.error("Não foi possível carregar os dados do relatório.");
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, label, isSuperAdmin, scopeAdminId]);

  useEffect(() => { load(); }, [load]);

  /** Visão global do sistema: SuperAdmin com "Todas as empresas". */
  const globalMode = isSuperAdmin && selectedAdmin === "all";

  const workers = allWorkers;
  const activeIds = useMemo(() => new Set(workers.map((w) => w.id)), [workers]);

  const scopedCash = cashRows;
  const scopedEvents = events;

  // Fonte histórica congelada: dias fechados vêm do snapshot oficial; abertos, dos dados atuais.
  const [frozen, setFrozen] = useState<FrozenReportPeriod>(() => emptyFrozenPeriod());
  const details: ReportDetailsData = frozen.details;
  useEffect(() => {
    let alive = true;
    const ids = Array.from(activeIds);
    if (!ids.length) { setFrozen(emptyFrozenPeriod(startDate, endDate)); return; }
    loadFrozenReportPeriod({ startDate, endDate, workerIds: ids })
      .then((f) => { if (alive) setFrozen(f); })
      .catch((err) => {
        console.error("[Reports] falha ao carregar histórico congelado", err);
        if (alive) { setFrozen(emptyFrozenPeriod(startDate, endDate)); setLoadError(true); }
      });
    return () => { alive = false; };
  }, [activeIds, startDate, endDate]);

  const pendentesTotal = useMemo(
    () => Object.values(frozen.pendentesByDate).reduce((s, l: ReportRecord[]) => s + l.length, 0),
    [frozen],
  );
  const atrasadosPeriodo = frozen.atrasados;

  /** Adapta a estrutura única de WorkerStats para os rótulos usados na tela/PDF. */
  const toTotals = (s: WorkerStats) => ({
    caixaInicial: s.caixaInicial,
    caixaFinal: s.caixaFinal,
    diferenca: s.diferenca,
    recebido: s.recebidoPrincipal,
    multas: s.multasRecebidas,
    recebidoTotal: s.recebido,
    emprestado: s.emprestado,
    entradas: s.aporte,
    saidas: s.retirada,
    despesas: s.despesas,
    estornos: s.estornos,
    estornosCount: s.estornosCount,
    caixaDisponivel: s.availableCash,
    previsto: s.previsto,
    faltaReceber: s.faltaReceber,
    valorAtrasado: s.valorAtrasado,
    saldoNaRua: s.saldoNaRua,
    clientesAtivos: s.clientesAtivos,
    emprestimosAtivos: s.emprestimosAtivos,
    atrasados: s.atrasados,
  });

  // Resumo consolidado da equipe = SOMA dos valores já calculados por trabalhador.
  const summary = useMemo(() => {
    const base = toTotals(consolidate(stats));
    // Caixa inicial (1º dia), caixa final (último dia) e diferença vêm do histórico congelado.
    return frozen.days.length
      ? {
          ...base,
          caixaInicial: frozen.totals.opening,
          caixaFinal: frozen.totals.finalCash,
          diferenca: frozen.totals.diff ?? 0,
          recebido: frozen.totals.received,
          multas: frozen.totals.penalties,
          recebidoTotal: frozen.totals.receivedTotal,
          emprestado: frozen.totals.lent,
          entradas: frozen.totals.manualIn,
          saidas: frozen.totals.manualOut,
          despesas: frozen.totals.expenses,
          estornos: frozen.totals.estornos,
          estornosCount: frozen.totals.estornosCount,
          atrasados: frozen.atrasados.length || base.atrasados,
        }
      : base;
  }, [stats, frozen]);

  // Comparativo por trabalhador ativo — exatamente os mesmos valores da linha da equipe.
  const workerRows = useMemo(() => {
    return stats.map((s) => {
      const wCash = scopedCash.filter((c) => c.worker_id === s.worker_id);
      const latest = wCash.slice().sort((a, b) => (a.cash_date < b.cash_date ? 1 : -1))[0];
      let statusLabel: "Aberto" | "Fechado" | "Não aberto" = "Não aberto";
      if (latest) statusLabel = latest.status === "closed" ? "Fechado" : "Aberto";
      return {
        worker: { id: s.worker_id as string, nome: s.worker_name } as WorkerRow,
        statusLabel,
        totals: toTotals(s),
      };
    });
  }, [stats, scopedCash]);

  // Comparativo por empresa: consolida primeiro cada empresa a partir dos seus
  // trabalhadores e só depois soma — sem recontar registros.
  const companyRows = useMemo(() => {
    if (!globalMode) return [];
    const names: Record<string, string> = {};
    admins.forEach((a) => { names[a.id] = a.nome; });
    return groupByCompany(stats, names).map((c) => {
      const ids = new Set(c.workers.map((w) => w.worker_id as string));
      const aCash = scopedCash.filter((x) => x.worker_id && ids.has(x.worker_id));
      const openCount = aCash.filter((x) => x.status !== "closed").length;
      return {
        admin: { id: c.admin_id, nome: c.admin_name, active: true } as AdminRow,
        workersCount: c.workers.length,
        overdueClients: c.totals.atrasados,
        statusLabel: aCash.length === 0
          ? "Sem caixa no período"
          : openCount > 0 ? `${openCount} caixa(s) aberto(s)` : "Todos fechados",
        hasOpen: openCount > 0,
        totals: toTotals(c.totals),
      };
    });
  }, [globalMode, admins, stats, scopedCash]);




  // Detalhamento por dia (equipe) — cada dia com seus próprios valores congelados.
  const dayRows = useMemo(() => {
    const byDate = new Map<string, typeof frozen.days>();
    frozen.days.forEach((d) => {
      const list = byDate.get(d.date) || [];
      list.push(d);
      byDate.set(d.date, list);
    });
    return Array.from(byDate.entries())
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([date, list]) => {
        const sum = (pick: (t: (typeof list)[number]["totals"]) => number) =>
          list.reduce((s, d) => s + pick(d.totals), 0);
        const totals = {
          caixaInicial: sum((t) => t.opening),
          caixaFinal: sum((t) => t.finalCash),
          diferenca: sum((t) => t.diff ?? 0),
          recebido: sum((t) => t.received),
          multas: sum((t) => t.penalties),
          recebidoTotal: sum((t) => t.receivedTotal),
          emprestado: sum((t) => t.lent),
          entradas: sum((t) => t.manualIn),
          saidas: sum((t) => t.manualOut),
          despesas: sum((t) => t.expenses),
          estornos: sum((t) => t.estornos),
          estornosCount: sum((t) => t.estornosCount),
          caixaDisponivel: 0,
        };
        return {
          date,
          openCount: list.filter((d) => d.status === "open").length,
          closedCount: list.filter((d) => d.status === "closed").length,
          totals,
          perWorker: list.map((d) => ({
            worker: { id: d.workerId || "-", nome: d.workerName } as WorkerRow,
            isOpen: d.status === "open",
            statusLabel: d.status === "closed"
              ? (d.incompleteSnapshot ? "Fechado (registro congelado indisponível)" : "Fechado")
              : d.status === "open" ? "Caixa ainda aberto" : "Não aberto",
            totals: {
              caixaInicial: d.totals.opening,
              caixaFinal: d.totals.finalCash,
              diferenca: d.totals.diff ?? 0,
              recebido: d.totals.received,
              multas: d.totals.penalties,
              recebidoTotal: d.totals.receivedTotal,
              emprestado: d.totals.lent,
              entradas: d.totals.manualIn,
              saidas: d.totals.manualOut,
              despesas: d.totals.expenses,
              estornos: d.totals.estornos,
              estornosCount: d.totals.estornosCount,
              caixaDisponivel: 0,
            },
          })),
        };
      });
  }, [frozen]);

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
      ["Caixa disponível da equipe", formatCurrency(summary.caixaDisponivel)],
      ["Caixa inicial da equipe", formatCurrency(summary.caixaInicial)],
      ["Caixa final da equipe", formatCurrency(summary.caixaFinal)],
      ["Recebido principal", formatCurrency(summary.recebido)],
      ["Multas recebidas", formatCurrency(summary.multas)],
      ["Total recebido (com multas)", formatCurrency(summary.recebidoTotal)],
      ["Total emprestado", formatCurrency(summary.emprestado)],
      ["Entradas", formatCurrency(summary.entradas)],
      ["Saídas", formatCurrency(summary.saidas)],
      ["Despesas", formatCurrency(summary.despesas)],
      ["Estornos", formatCurrency(summary.estornos)],
      ["Diferença total de caixa", formatCurrency(summary.diferenca)],
      ["Clientes pendentes de registro", String(pendentesTotal)],
      ["Clientes atrasados", String(summary.atrasados)],
    ], { rightCols: [1] });

    pdf.blockTitle("Comparação dos trabalhadores");
    if (workerRows.length === 0) {
      pdf.text("Nenhum trabalhador ativo no período.");
    }
    pdf.table(
      null,
      ["Trabalhador", "Status", "Cx. disponível", "Cx. inicial", "Cx. final", "Recebido", "Multas", "Emprestado", "Despesas", "Diferença", "Pend.", "Atras."],
      workerRows.map((r) => [
        r.worker.nome, r.statusLabel,
        formatCurrency(r.totals.caixaDisponivel),
        formatCurrency(r.totals.caixaInicial),
        formatCurrency(r.totals.caixaFinal),
        formatCurrency(r.totals.recebido),
        formatCurrency(r.totals.multas),
        formatCurrency(r.totals.emprestado),
        formatCurrency(r.totals.despesas),
        formatCurrency(r.totals.diferenca),
        String(frozen.pendentesByWorker[r.worker.id] || 0),
        String(r.totals.atrasados),
      ]),
      { rightCols: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
    );

    // Detalhamento completo de clientes atrasados (situação atual da carteira)
    if (atrasadosPeriodo.length) {
      pdf.blockTitle("Clientes atrasados");
      pdf.table(
        null,
        ["Cliente", "Trabalhador", "Resumo"],
        atrasadosPeriodo.map((r) => [r.clientName, r.workerName, r.summary]),
      );
    }


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
          ["Clientes pendentes de registro", String((frozen.pendentesByDate[d.date] || []).length)],

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
      ["Recebido principal no período", formatCurrency(summary.recebido)],
      ["Multas recebidas no período", formatCurrency(summary.multas)],
      ["Total recebido (com multas)", formatCurrency(summary.recebidoTotal)],
      ["Emprestado no período", formatCurrency(summary.emprestado)],
      ["Despesas no período", formatCurrency(summary.despesas)],
      ["Caixa disponível da equipe", formatCurrency(summary.caixaDisponivel)],
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
      ) : loadError ? (
        <Card className="border-destructive">
          <CardContent className="p-4 text-sm text-destructive">
            Não foi possível carregar os dados deste relatório. Os valores não podem ser exibidos como confirmados.
          </CardContent>
        </Card>
      ) : loading ? (
        <p className="p-4 text-center text-muted-foreground">Carregando...</p>

      ) : (
        <>
          {frozen.warnings.length > 0 && (
            <Card className="border-warning/50">
              <CardContent className="p-3 text-xs space-y-1">
                <p className="font-medium text-warning">Registro histórico incompleto</p>
                {frozen.warnings.map((w) => (
                  <p key={w} className="text-muted-foreground">{w}</p>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Resumo financeiro do período */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              {globalMode ? "Resumo geral do sistema" : REPORT_SECTIONS.resumo}
            </p>
            <ReportKpiGrid>
              {globalMode && (
                <>
                  <ReportKpiCard icon={<Building2 className="h-4 w-4 text-primary" />} label="Empresas ativas" value={String(admins.length)} />
                  <ReportKpiCard icon={<Users className="h-4 w-4 text-primary" />} label="Trabalhadores ativos" value={String(workers.length)} />
                </>
              )}
              <ReportKpiCard icon={<Wallet className="h-4 w-4 text-primary" />} label={globalMode ? "Caixa disponível consolidado" : "Caixa disponível da equipe"} value={formatCurrency(summary.caixaDisponivel)} />
              <ReportKpiCard icon={<Wallet className="h-4 w-4 text-primary" />} label={globalMode ? "Caixa inicial consolidado" : "Caixa inicial da equipe"} value={formatCurrency(summary.caixaInicial)} />

              <ReportKpiCard icon={<Target className="h-4 w-4 text-primary" />} label={globalMode ? "Caixa final consolidado" : "Caixa final da equipe"} value={formatCurrency(summary.caixaFinal)} />
              <ReportKpiCard icon={<TrendingUp className="h-4 w-4 text-success" />} label="Recebido principal" value={formatCurrency(summary.recebido)} tone="positive" />
              <ReportKpiCard icon={<TrendingUp className="h-4 w-4 text-success" />} label="Multas recebidas" value={formatCurrency(summary.multas)} tone="positive" />
              <ReportKpiCard icon={<TrendingUp className="h-4 w-4 text-success" />} label="Total recebido (com multas)" value={formatCurrency(summary.recebidoTotal)} tone="positive" />
              <ReportKpiCard icon={<ArrowUpCircle className="h-4 w-4 text-warning" />} label="Total emprestado" value={formatCurrency(summary.emprestado)} />
              <ReportKpiCard icon={<ArrowUpCircle className="h-4 w-4 text-success" />} label="Entradas" value={formatCurrency(summary.entradas)} tone="positive" />
              <ReportKpiCard icon={<ArrowDownCircle className="h-4 w-4 text-destructive" />} label="Saídas" value={formatCurrency(summary.saidas)} tone="negative" />
              <ReportKpiCard icon={<ArrowDownCircle className="h-4 w-4 text-destructive" />} label="Despesas" value={formatCurrency(summary.despesas)} tone="negative" />
              <ReportKpiCard icon={<RefreshCw className="h-4 w-4 text-muted-foreground" />} label="Estornos" value={formatCurrency(summary.estornos)} />
              <ReportKpiCard
                icon={summary.diferenca >= 0 ? <TrendingUp className="h-4 w-4 text-success" /> : <AlertTriangle className="h-4 w-4 text-destructive" />}
                label="Diferença total de caixa"
                value={formatCurrency(summary.diferenca)}
                tone={summary.diferenca >= 0 ? "positive" : "negative"}
              />
              <ReportKpiCard
                icon={<AlertTriangle className="h-4 w-4 text-warning" />}
                label="Clientes pendentes de registro"
                value={String(pendentesTotal)}
                tone={pendentesTotal > 0 ? "warning" : "neutral"}
              />
              <ReportKpiCard icon={<Target className="h-4 w-4 text-primary" />} label="Previsto no período" value={formatCurrency(summary.previsto)} />
              <ReportKpiCard icon={<AlertTriangle className="h-4 w-4 text-warning" />} label="Falta receber (previsto)" value={formatCurrency(summary.faltaReceber)} tone={summary.faltaReceber > 0 ? "warning" : "neutral"} />
              <ReportKpiCard icon={<AlertTriangle className="h-4 w-4 text-destructive" />} label="Valor atrasado" value={formatCurrency(summary.valorAtrasado)} tone={summary.valorAtrasado > 0 ? "negative" : "neutral"} />
              <ReportKpiCard icon={<Wallet className="h-4 w-4 text-primary" />} label="Saldo emprestado na rua" value={formatCurrency(summary.saldoNaRua)} />
              <ReportKpiCard icon={<Users className="h-4 w-4 text-primary" />} label="Clientes ativos" value={String(summary.clientesAtivos)} />
              <ReportKpiCard icon={<Users className="h-4 w-4 text-primary" />} label="Empréstimos ativos" value={String(summary.emprestimosAtivos)} />
              <ReportKpiCard
                icon={<AlertTriangle className="h-4 w-4 text-destructive" />}
                label="Clientes atrasados"
                value={String(summary.atrasados)}
                tone={summary.atrasados > 0 ? "negative" : "neutral"}
              />
            </ReportKpiGrid>

          </div>

          {/* Comparação entre empresas (SuperAdmin — todas as empresas) */}
          {globalMode && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Empresas</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {companyRows.length === 0 ? (
                  <ReportEmptyState message="Nenhuma empresa ativa." />
                ) : (
                  <div className="divide-y">
                    {companyRows.map((r) => (
                      <button
                        key={r.admin.id}
                        type="button"
                        onClick={() => { setSelectedAdmin(r.admin.id); setSelectedWorker("all"); }}
                        className="w-full text-left p-3 flex items-center gap-2 hover:bg-muted/40 active:bg-muted/60 transition-colors"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-sm font-medium truncate">{r.admin.nome}</p>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${
                              r.hasOpen ? "text-success border-success/40" : "text-muted-foreground"
                            }`}>{r.statusLabel}</span>
                          </div>
                          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground mt-1">
                            <span>Trabalhadores: <b className="text-foreground">{r.workersCount}</b></span>
                            <span>Cx. disponível: <b className="text-foreground">{formatCurrency(r.totals.caixaDisponivel)}</b></span>
                            <span>Cx. inicial: <b className="text-foreground">{formatCurrency(r.totals.caixaInicial)}</b></span>
                            <span>Cx. final: <b className="text-foreground">{formatCurrency(r.totals.caixaFinal)}</b></span>
                            <span>Recebido: <b className="text-success">{formatCurrency(r.totals.recebido)}</b></span>
                            <span>Multas: <b className="text-success">{formatCurrency(r.totals.multas)}</b></span>
                            <span>Emprestado: <b className="text-foreground">{formatCurrency(r.totals.emprestado)}</b></span>
                            <span>Despesas: <b className="text-destructive">{formatCurrency(r.totals.despesas)}</b></span>
                            <span>Clientes atrasados: <b className="text-destructive">{r.overdueClients}</b></span>
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
          )}

          {/* Comparativo dos trabalhadores ativos */}
          {!globalMode && (
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
                          <span>Cx. disponível: <b className="text-foreground">{formatCurrency(r.totals.caixaDisponivel)}</b></span>
                          <span>Cx. inicial: <b className="text-foreground">{formatCurrency(r.totals.caixaInicial)}</b></span>
                          <span>Cx. final: <b className="text-foreground">{formatCurrency(r.totals.caixaFinal)}</b></span>
                          <span>Recebido: <b className="text-success">{formatCurrency(r.totals.recebido)}</b></span>
                          <span>Multas: <b className="text-success">{formatCurrency(r.totals.multas)}</b></span>
                          <span>Emprestado: <b className="text-foreground">{formatCurrency(r.totals.emprestado)}</b></span>
                          <span>Despesas: <b className="text-destructive">{formatCurrency(r.totals.despesas)}</b></span>
                          <span>
                            Diferença: <b className={r.totals.diferenca >= 0 ? "text-success" : "text-destructive"}>
                              {formatCurrency(r.totals.diferenca)}
                            </b>
                          </span>
                          <span>Pendentes: <b className="text-warning">{frozen.pendentesByWorker[r.worker.id] || 0}</b></span>
                          <span>Atrasados: <b className="text-destructive">{r.totals.atrasados}</b></span>
                        </div>

                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          )}

          {/* Situação atual da carteira da equipe */}
          {!globalMode && (
            <RecordSection title="Clientes atrasados" records={atrasadosPeriodo} showWorker />
          )}



          {/* Detalhamento por dia */}
          {!globalMode && startDate !== endDate && (
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
                                <span>Pendentes de registro: <b className="text-warning">{(frozen.pendentesByDate[d.date] || []).length}</b></span>
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

