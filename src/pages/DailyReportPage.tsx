import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/loan-utils";
import { getEventTypeLabel, DailyEvent } from "@/lib/daily-events";
import { computeDailyTotals } from "@/lib/daily-totals";
import { useAuth } from "@/hooks/useAuth";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, Download, FileText, Loader2, Share2 } from "lucide-react";
import { toast } from "sonner";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { downloadReportPdf, shareReportPdf } from "@/lib/report-pdf";
import { fetchReportDetails, emptyReportDetails, type ReportDetailsData, type ReportRecord } from "@/lib/report-details";
import { RecordSection } from "@/components/reports/RecordSection";



type AuditRow = {
  id: string;
  created_at: string;
  action_type: string;
  entity_type: string;
  entity_id: string | null;
  observation: string | null;
  user_id: string | null;
  worker_id: string | null;
  admin_id: string | null;
};

type WorkerOpt = { id: string; nome: string; parent_admin_id: string | null };
type AdminOpt = { id: string; nome: string };

const INCOME_TYPES = new Set(["pagamento", "recebimento_multa", "entrada_manual"]);
const OUT_TYPES = new Set(["emprestimo_novo", "renovacao", "renegociacao", "saida", "saida_manual", "despesa"]);

type DailyReportPageProps = {
  /** Quando definido, a página roda em modo "embutido": filtros próprios ocultos e escopo controlado pelo pai. */
  embeddedWorkerId?: string | null;
  embeddedStart?: string;
  embeddedEnd?: string;
};

export default function DailyReportPage({
  embeddedWorkerId,
  embeddedStart,
  embeddedEnd,
}: DailyReportPageProps = {}) {
  const embedded = embeddedWorkerId !== undefined;
  const { workerId: myWorkerId, adminId: myAdminId, isAdmin, isSuperAdmin } = useAuth();
  const [searchParams] = useSearchParams();

  const today = format(new Date(), "yyyy-MM-dd");
  const initialDate = searchParams.get("date") || today;
  type Preset = "hoje" | "ontem" | "semana" | "mes" | "custom";
  const [preset, setPreset] = useState<Preset>(initialDate === today ? "hoje" : "custom");
  const [startDate, setStartDate] = useState<string>(embeddedStart || initialDate);
  const [endDate, setEndDate] = useState<string>(embeddedEnd || initialDate);
  // Usado pelo PDF/cabeçalho (dia de referência = fim do período)
  const date = endDate;
  const [selectedAdminId, setSelectedAdminId] = useState<string | null>(null);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(
    embedded ? (embeddedWorkerId ?? null) : (isSuperAdmin || isAdmin ? searchParams.get("worker") : myWorkerId)
  );

  // Sincroniza escopo quando embutido (filtros do pai)
  useEffect(() => {
    if (!embedded) return;
    setSelectedWorkerId(embeddedWorkerId ?? null);
    if (embeddedStart) setStartDate(embeddedStart);
    if (embeddedEnd) setEndDate(embeddedEnd);
  }, [embedded, embeddedWorkerId, embeddedStart, embeddedEnd]);


  const applyPreset = (p: Preset) => {
    setPreset(p);
    const now = new Date();
    const fmt = (d: Date) => format(d, "yyyy-MM-dd");
    if (p === "hoje") { setStartDate(fmt(now)); setEndDate(fmt(now)); }
    else if (p === "ontem") {
      const y = new Date(now); y.setDate(now.getDate() - 1);
      setStartDate(fmt(y)); setEndDate(fmt(y));
    } else if (p === "semana") {
      const s = new Date(now); s.setDate(now.getDate() - now.getDay());
      setStartDate(fmt(s)); setEndDate(fmt(now));
    } else if (p === "mes") {
      const s = new Date(now.getFullYear(), now.getMonth(), 1);
      setStartDate(fmt(s)); setEndDate(fmt(now));
    }
  };

  const [admins, setAdmins] = useState<AdminOpt[]>([]);
  const [workers, setWorkers] = useState<WorkerOpt[]>([]);

  const [events, setEvents] = useState<DailyEvent[]>([]);
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [clientNames, setClientNames] = useState<Record<string, string>>({});
  const [workerName, setWorkerName] = useState<string>("");
  const [cashStatus, setCashStatus] = useState<string | null>(null);
  const [cashSummary, setCashSummary] = useState<{
    opening: number; expected: number; counted: number | null; diff: number | null;
    closingObs: string | null;
  } | null>(null);
  const [cashRows, setCashRows] = useState<any[]>([]);
  const [currentAvailableCash, setCurrentAvailableCash] = useState<number | null>(null);
  const [details, setDetails] = useState<ReportDetailsData>(() => emptyReportDetails());
  const [loading, setLoading] = useState(false);
  const [generatingPdf, setGeneratingPdf] = useState(false);



  // Load admins (super_admin only)
  useEffect(() => {
    if (!isSuperAdmin) return;
    (async () => {
      const { data } = await supabase.rpc("super_admin_list_admins");
      setAdmins(((data as any[]) || []).map((a) => ({ id: a.id, nome: a.nome })));
    })();
  }, [isSuperAdmin]);

  // Load workers (admin sees own team; super_admin sees by selected admin)
  useEffect(() => {
    if (!isAdmin && !isSuperAdmin) return;
    (async () => {
      const { data } = await supabase.rpc("list_workers_by_admin", {
        p_admin_id: isSuperAdmin ? selectedAdminId : null,
      } as any);
      const list = ((data as any[]) || []).map((w) => ({
        id: w.id, nome: w.nome, parent_admin_id: w.parent_admin_id,
      }));
      setWorkers(list);
    })();
  }, [isAdmin, isSuperAdmin, selectedAdminId]);

  // Default worker for worker user
  useEffect(() => {
    if (!isAdmin && !isSuperAdmin && myWorkerId && !selectedWorkerId) {
      setSelectedWorkerId(myWorkerId);
    }
  }, [isAdmin, isSuperAdmin, myWorkerId, selectedWorkerId]);

  // Worker name
  useEffect(() => {
    if (!selectedWorkerId) { setWorkerName(""); return; }
    const w = workers.find((x) => x.id === selectedWorkerId);
    if (w) { setWorkerName(w.nome); return; }
    (async () => {
      const { data } = await supabase.from("workers").select("nome").eq("id", selectedWorkerId).maybeSingle();
      setWorkerName((data as any)?.nome || "");
    })();
  }, [selectedWorkerId, workers]);

  // Fetch report data
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        // daily_events (período selecionado)
        let eq: any = supabase.from("daily_events" as any).select("*")
          .gte("cash_date", startDate).lte("cash_date", endDate);
        if (selectedWorkerId) eq = eq.eq("worker_id", selectedWorkerId);
        else if (isSuperAdmin && selectedAdminId) eq = eq.eq("admin_id", selectedAdminId).is("worker_id", null);
        else if (isAdmin && !isSuperAdmin && myAdminId) eq = eq.eq("admin_id", myAdminId).is("worker_id", null);
        const { data: evs } = await eq.order("created_at", { ascending: true });
        const eventList = (evs as unknown as DailyEvent[]) || [];
        setEvents(eventList);

        // audit_logs do período
        const dayStart = `${startDate}T00:00:00`;
        const dayEnd = `${endDate}T23:59:59`;
        let aq: any = supabase.from("audit_logs").select("*")
          .gte("created_at", dayStart).lte("created_at", dayEnd)
          .in("entity_type", ["client", "loan", "installment", "penalty", "transfer", "payment", "cash"]);
        if (selectedWorkerId) aq = aq.eq("worker_id", selectedWorkerId);
        else if (isSuperAdmin && selectedAdminId) aq = aq.eq("admin_id", selectedAdminId);
        else if (isAdmin && !isSuperAdmin && myAdminId) aq = aq.eq("admin_id", myAdminId);
        const { data: audits } = await aq.order("created_at", { ascending: true });
        setAuditRows((audits as unknown as AuditRow[]) || []);

        // client names
        const cids = new Set<string>();
        eventList.forEach((e) => e.client_id && cids.add(e.client_id));
        (audits || []).forEach((a: any) => {
          if (a.entity_type === "client" && a.entity_id) cids.add(a.entity_id);
        });
        if (cids.size > 0) {
          const { data: cs } = await supabase.from("clients").select("id, name").in("id", Array.from(cids));
          const map: Record<string, string> = {};
          (cs || []).forEach((c: any) => { map[c.id] = c.name; });
          setClientNames(map);
        } else {
          setClientNames({});
        }

        // daily_cash do período (dados salvos no fechamento — não recalculados)
        let dcList: any[] = [];
        if (selectedWorkerId) {
          const { data: dc } = await supabase.from("daily_cash").select("*")
            .gte("cash_date", startDate).lte("cash_date", endDate)
            .eq("worker_id", selectedWorkerId).order("cash_date", { ascending: false });
          dcList = dc || [];
        } else if (isSuperAdmin && selectedAdminId) {
          const { data: dc } = await supabase.from("daily_cash").select("*")
            .gte("cash_date", startDate).lte("cash_date", endDate)
            .eq("admin_id", selectedAdminId).is("worker_id", null).order("cash_date", { ascending: false });
          dcList = dc || [];
        }
        setCashRows(dcList);

        const dcRow: any = dcList.find((r) => r.cash_date === endDate) || null;
        if (dcRow) {
          setCashStatus(dcRow.status || null);
          const opening = Number(dcRow.opening_balance || 0);
          const expected = Number(dcRow.expected_closing_balance ?? (opening + Number(dcRow.total_in || 0) - Number(dcRow.total_out || 0)));
          const counted = dcRow.counted_closing_balance != null ? Number(dcRow.counted_closing_balance) : null;
          const diff = counted != null ? counted - expected : null;
          setCashSummary({ opening, expected, counted, diff, closingObs: dcRow.closing_note || null });
        } else {
          setCashStatus(null);
          setCashSummary(null);
        }

        // Current available cash (dynamic — does NOT overwrite historical opening/closing snapshots)
        let cbRow: any = null;
        if (selectedWorkerId) {
          const { data } = await supabase.from("cash_balance").select("available_cash").eq("worker_id", selectedWorkerId).maybeSingle();
          cbRow = data;
        } else if (isSuperAdmin && selectedAdminId) {
          const { data } = await supabase.from("cash_balance").select("available_cash").eq("admin_id", selectedAdminId).is("worker_id", null).maybeSingle();
          cbRow = data;
        }
        setCurrentAvailableCash(cbRow ? Number(cbRow.available_cash || 0) : null);

        // Detalhamento (somente leitura) — pagamentos, empréstimos, renovações,
        // renegociações, atrasos e clientes pendentes de registro.
        try {
          const det = await fetchReportDetails({
            events: eventList,
            startDate,
            endDate,
            workerId: selectedWorkerId,
            adminId: selectedWorkerId ? null : (isSuperAdmin ? selectedAdminId : myAdminId),
          });
          setDetails(det);
        } catch (detErr) {
          console.warn("[DailyReport] detalhamento indisponível", detErr);
          setDetails(emptyReportDetails());
        }

      } catch (err: any) {
        console.error(err);
        toast.error("Erro ao carregar relatório");
      } finally {
        setLoading(false);
      }
    })();
  }, [startDate, endDate, selectedWorkerId, selectedAdminId, isAdmin, isSuperAdmin, myAdminId]);


  // Build rows from events + audits
  type Row = {
    time: string;
    type: string;
    typeLabel: string;
    clientName: string;
    amountIn: number;
    amountOut: number;
    observation: string;
    reversed: boolean;
    createdAt: string;
  };

  const rows = useMemo<Row[]>(() => {
    const evRows: Row[] = events.map((e) => ({
      time: format(new Date(e.created_at), "HH:mm"),
      type: e.event_type,
      typeLabel: getEventTypeLabel(e.event_type),
      clientName: e.client_id ? (clientNames[e.client_id] || "—") : "—",
      amountIn: Number(e.amount_in || 0),
      amountOut: Number(e.amount_out || 0),
      observation: e.observation || "",
      reversed: !!e.reversed_at,
      createdAt: e.created_at,
    }));
    const auditRowsMapped: Row[] = auditRows
      .filter((a) => {
        // include client/loan create/edit, but skip ones that already have a matching daily_event
        if (a.entity_type === "client") return true;
        if (a.entity_type === "loan" && (a.action_type.includes("editar") || a.action_type.includes("update"))) return true;
        return false;
      })
      .map((a) => {
        const isClient = a.entity_type === "client";
        const cname = isClient && a.entity_id ? (clientNames[a.entity_id] || "—") : "—";
        return {
          time: format(new Date(a.created_at), "HH:mm"),
          type: `audit_${a.entity_type}`,
          typeLabel: `${isClient ? "Cliente" : "Empréstimo"}: ${a.action_type}`,
          clientName: cname,
          amountIn: 0,
          amountOut: 0,
          observation: a.observation || "",
          reversed: false,
          createdAt: a.created_at,
        };
      });
    return [...evRows, ...auditRowsMapped].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [events, auditRows, clientNames]);

  const totals = useMemo(() => {
    const t = computeDailyTotals(events as any, 0);
    return {
      totalIn: t.entradas,
      totalOut: t.saidas,
      payments: t.pagamentos,
      loans: t.emprestimosLiberados,
      renewals: t.renovacoes + t.renegociacoes,
      penalties: t.multas,
      manualIn: t.entradasManuais,
      manualOut: t.saidasManuais,
      expenses: t.despesas,
      expensesByCategory: t.despesasPorCategoria,
      notPaidCount: t.naoPagos,
      balance: t.entradas - t.saidas,
    };
  }, [events]);

  // Agrupamento de registros por tipo (somente apresentação — não altera cálculos)
  const groups = useMemo(() => buildGroups(events), [events]);

  // Registros detalhados (mesmos eventos, com todos os detalhes disponíveis)
  const recordGroups = useMemo(
    () => buildRecordGroups(events, details.recordFor),
    [events, details],
  );


  const estornosTotal = useMemo(
    () => groups.estornos.reduce((s, e) => s + Number(e.amount_in || 0) + Number(e.amount_out || 0), 0),
    [groups.estornos]
  );

  const isMultiDay = startDate !== endDate;

  // Dias do período (mais recente → mais antigo), cada um com seus próprios registros
  const days = useMemo(() => {
    const set = new Set<string>();
    events.forEach((e) => set.add(String((e as any).cash_date)));
    cashRows.forEach((r) => set.add(String(r.cash_date)));
    return Array.from(set)
      .sort((a, b) => b.localeCompare(a))
      .map((d) => {
        const dayEvents = events.filter((e) => String((e as any).cash_date) === d);
        const dc = cashRows.find((r) => r.cash_date === d) || null;
        const closed = dc?.status === "closed";
        const reopened = !!(dc?.reopened_at || (dc?.reopen_count ?? 0) > 0);
        const opening = dc ? Number(dc.opening_balance || 0) : 0;
        const savedExpected = dc?.expected_closing_balance != null ? Number(dc.expected_closing_balance) : null;
        const counted = dc?.counted_closing_balance != null ? Number(dc.counted_closing_balance) : null;
        const t = computeDailyTotals(dayEvents as any, 0);
        return {
          date: d,
          events: dayEvents,
          groups: buildGroups(dayEvents),
          recordGroups: buildRecordGroups(dayEvents, details.recordFor),
          pendentes: details.pendentesByDate[d] || [],

          status: closed ? "closed" : dc ? "open" : null,
          reopened,
          opening,
          // Dias fechados: valores salvos no fechamento (sem recálculo). Dias abertos: previsão do dia.
          finalCash: closed
            ? (counted ?? savedExpected ?? 0)
            : (savedExpected ?? (opening + t.pagamentos + t.multas + t.entradasManuais - (t.emprestimosLiberados + t.renovacoes + t.renegociacoes) - t.saidasManuais - t.despesas)),
          diff: closed && counted != null ? counted - (savedExpected ?? 0) : null,
          received: closed ? Number(dc.total_in ?? t.pagamentos) : t.pagamentos,
          out: closed ? Number(dc.total_out ?? 0) : (t.emprestimosLiberados + t.renovacoes + t.renegociacoes),
          closingObs: dc?.closing_note || null,
        };
      });
  }, [events, cashRows, details]);

  const periodDiff = useMemo(
    () => days.reduce((s, d) => s + (d.diff ?? 0), 0),
    [days]
  );

  const dateLabel = useMemo(() => format(new Date(date + "T12:00:00"), "dd 'de' MMMM 'de' yyyy", { locale: ptBR }), [date]);
  const periodLabel = useMemo(() => {
    const f = (d: string) => format(new Date(d + "T12:00:00"), "dd/MM/yyyy");
    return isMultiDay ? `${f(startDate)} — ${f(endDate)}` : dateLabel;
  }, [isMultiDay, startDate, endDate, dateLabel]);



  // Único gerador de PDF — usa exatamente os mesmos valores exibidos na tela.
  const buildPdf = (): { doc: jsPDF; filename: string } => {
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const issuedAt = format(new Date(), "dd/MM/yyyy HH:mm", { locale: ptBR });
    const cashLabel = isMultiDay
      ? `${days.length} dia(s) no período`
      : cashStatus === "closed"
        ? "Fechado"
        : cashStatus === "open"
          ? "Aberto"
          : "Sem caixa";

    const HEADER_BOTTOM = 42;
    const PAGE_BOTTOM = pageHeight - 16;

    const drawHeader = () => {
      doc.setFontSize(15);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(0, 0, 0);
      doc.text("UpCredit — Relatório do Trabalhador", 14, 16);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.text(`Emitido em ${issuedAt}`, pageWidth - 14, 16, { align: "right" });
      doc.setFontSize(10);
      doc.text(`Trabalhador: ${workerName || "—"}`, 14, 24);
      doc.text(`Período: ${periodLabel}`, 14, 30);
      doc.text(`Caixa: ${cashLabel}`, 14, 36);
      doc.setDrawColor(200);
      doc.line(14, 38, pageWidth - 14, 38);
    };

    drawHeader();
    (doc as any).lastAutoTable = { finalY: HEADER_BOTTOM };

    const cursorY = () => (doc as any).lastAutoTable?.finalY ?? HEADER_BOTTOM;

    const ensureSpace = (needed: number) => {
      if (cursorY() + needed > PAGE_BOTTOM) {
        doc.addPage();
        drawHeader();
        (doc as any).lastAutoTable = { finalY: HEADER_BOTTOM };
      }
    };

    const writeBlockTitle = (title: string) => {
      ensureSpace(16);
      const y = cursorY() + 9;
      doc.setFillColor(59, 130, 246);
      doc.rect(14, y - 5, pageWidth - 28, 8, "F");
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(11);
      doc.setFont("helvetica", "bold");
      doc.text(title, 16, y);
      doc.setTextColor(0, 0, 0);
      doc.setFont("helvetica", "normal");
      (doc as any).lastAutoTable = { finalY: y + 3 };
    };

    const writeText = (text: string, size = 9) => {
      ensureSpace(10);
      const y = cursorY() + 6;
      doc.setFontSize(size);
      doc.text(text, 14, y);
      (doc as any).lastAutoTable = { finalY: y };
    };

    const addTable = (
      title: string | null,
      head: string[],
      body: (string | number)[][],
      opts: { rightCols?: number[] } = {}
    ) => {
      if (body.length === 0) return;
      ensureSpace(22);
      let startY = cursorY() + 6;
      if (title) {
        doc.setFontSize(10);
        doc.setFont("helvetica", "bold");
        doc.text(title, 14, startY);
        doc.setFont("helvetica", "normal");
        startY += 2;
      }
      const columnStyles: any = {};
      (opts.rightCols || []).forEach((c) => { columnStyles[c] = { halign: "right" }; });
      autoTable(doc, {
        startY,
        head: [head],
        body,
        styles: { fontSize: 8 },
        headStyles: { fillColor: [59, 130, 246] },
        columnStyles,
        margin: { top: HEADER_BOTTOM, left: 14, right: 14, bottom: 16 },
        didDrawPage: () => drawHeader(),
      });
    };

    const nameOf = (cid: string | null) => (cid ? clientNames[cid] || "—" : "—");

    // Linhas de eventos, no mesmo formato das seções da tela.
    const eventLines = (list: DailyEvent[]) =>
      list.map((e) => [
        format(new Date(e.created_at), "HH:mm"),
        e.client_id ? nameOf(e.client_id) : getEventTypeLabel(e.event_type),
        getEventTypeLabel(e.event_type) + (e.reversed_at ? " (estornado)" : ""),
        Number(e.amount_in || 0) > 0 ? `+ ${formatCurrency(Number(e.amount_in))}` : "",
        Number(e.amount_out || 0) > 0 ? `- ${formatCurrency(Number(e.amount_out))}` : "",
        e.observation || "",
      ]);
    const EVENT_HEAD = ["Hora", "Cliente", "Tipo", "Entrada", "Saída", "Obs."];

    const GROUP_ORDER: { key: keyof DayGroups; label: string }[] = [
      { key: "pagamentos", label: "Pagamentos" },
      { key: "naoPagamentos", label: "Não pagamentos" },
      { key: "novosEmprestimos", label: "Novos empréstimos" },
      { key: "renovacoes", label: "Renovações e renegociações" },
      { key: "movimentacoes", label: "Entradas e saídas" },
      { key: "despesas", label: "Despesas" },
      { key: "estornos", label: "Estornos" },
    ];

    const writeGroups = (g: DayGroups) => {
      GROUP_ORDER.forEach(({ key, label }) => {
        const list = g[key];
        if (!list.length) return;
        const total = list.reduce((s, e) => s + Number(e.amount_in || 0) + Number(e.amount_out || 0), 0);
        addTable(
          `${label} (${list.length})${total > 0 ? ` — ${formatCurrency(total)}` : ""}`,
          EVENT_HEAD,
          eventLines(list),
          { rightCols: [3, 4] }
        );
      });
    };

    // ===== 1. Resumo financeiro (mesmos cards da tela) =====
    writeBlockTitle("1. Resumo Financeiro");
    addTable(
      null,
      ["Indicador", "Valor"],
      [
        [isMultiDay ? "Caixa inicial (1º dia)" : "Caixa inicial", formatCurrency(periodOpening)],
        [
          isMultiDay
            ? "Caixa final (último dia)"
            : cashSummary?.counted != null ? "Caixa final (fechado)" : "Caixa final (previsto)",
          formatCurrency(periodFinal),
        ],
        ["Total recebido", formatCurrency(totals.payments)],
        ["Total emprestado", formatCurrency(totals.loans + totals.renewals)],
        ["Entradas", formatCurrency(totals.manualIn)],
        ["Saídas", formatCurrency(totals.manualOut)],
        ["Despesas", formatCurrency(totals.expenses)],
        ["Multas", formatCurrency(totals.penalties)],
        ["Estornos", `${formatCurrency(estornosTotal)} (${groups.estornos.length})`],
        ["Diferença de caixa", formatCurrency(periodDiffValue)],
      ],
      { rightCols: [1] }
    );

    // ===== 2. Indicadores operacionais =====
    writeBlockTitle("2. Indicadores Operacionais");
    addTable(
      null,
      ["Indicador", "Quantidade"],
      [
        ["Pagamentos registrados", String(groups.pagamentos.length)],
        ["Não pagamentos", String(groups.naoPagamentos.length)],
        ["Novos empréstimos", String(groups.novosEmprestimos.length)],
        ["Renovações e renegociações", String(groups.renovacoes.length)],
        ["Entradas e saídas", String(groups.movimentacoes.length)],
        ["Despesas", String(groups.despesas.length)],
        ["Estornos", String(groups.estornos.length)],
        ["Total de registros", String(events.length)],
      ],
      { rightCols: [1] }
    );

    // ===== 3. Detalhamento =====
    writeBlockTitle("3. Detalhamento");

    if (events.length === 0) {
      writeText("Não houve movimentações no período selecionado.", 10);
    } else if (isMultiDay) {
      days.forEach((d) => {
        const dayLabel = format(new Date(d.date + "T12:00:00"), "EEEE, dd/MM/yyyy", { locale: ptBR });
        const statusLabel =
          d.status === "closed" ? (d.reopened ? "Reaberto e fechado" : "Fechado")
          : d.status === "open" ? "Caixa ainda aberto" : "Sem caixa";
        ensureSpace(18);
        const y = cursorY() + 8;
        doc.setFontSize(10);
        doc.setFont("helvetica", "bold");
        doc.text(`${dayLabel} — ${statusLabel}`, 14, y);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8);
        doc.text(
          `Caixa inicial ${formatCurrency(d.opening)} · Recebido ${formatCurrency(d.received)} · Caixa final ${formatCurrency(d.finalCash)}${d.diff != null ? ` · Diferença ${formatCurrency(d.diff)}` : ""}`,
          14,
          y + 5
        );
        (doc as any).lastAutoTable = { finalY: y + 6 };
        if (d.closingObs) writeText(`Obs. fechamento: ${d.closingObs}`, 8);
        if (d.events.length === 0) writeText("Sem movimentações neste dia.", 8);
        else writeGroups(d.groups);
      });
    } else {
      if (cashSummary?.closingObs) writeText(`Obs. fechamento: ${cashSummary.closingObs}`, 8);
      if (!isMultiDay && cashStatus !== "closed") writeText("Caixa ainda aberto — valores do dia podem mudar.", 8);
      writeGroups(groups);
    }

    // ===== 4. Totais finais =====
    writeBlockTitle("4. Totais Finais");
    addTable(
      null,
      ["Total", "Valor"],
      [
        ["Entradas do período", formatCurrency(totals.totalIn)],
        ["Saídas do período", formatCurrency(totals.totalOut)],
        ["Saldo do período (entradas - saídas)", formatCurrency(totals.balance)],
        ["Caixa final do período", formatCurrency(periodFinal)],
      ],
      { rightCols: [1] }
    );

    // Assinaturas
    ensureSpace(35);
    const sigY = cursorY() + 25;
    doc.setDrawColor(120);
    doc.line(20, sigY, 90, sigY);
    doc.line(pageWidth - 90, sigY, pageWidth - 20, sigY);
    doc.setFontSize(9);
    doc.text("Assinatura do trabalhador", 55, sigY + 5, { align: "center" });
    doc.text("Assinatura do administrador", pageWidth - 55, sigY + 5, { align: "center" });

    const slug = (workerName || "trabalhador").replace(/\s+/g, "_");
    const filename = isMultiDay
      ? `relatorio-${slug}-${startDate}_a_${endDate}.pdf`
      : `relatorio-${slug}-${date}.pdf`;
    return { doc, filename };
  };


  const handleDownloadPDF = async () => {
    if (generatingPdf) return;
    setGeneratingPdf(true);
    try {
      const { doc, filename } = buildPdf();
      downloadReportPdf(doc, filename);
    } catch (err: any) {
      console.error("[DailyReport PDF] erro:", err);
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
      await shareReportPdf(doc, filename, `Relatório UpCredit — ${workerName || "trabalhador"} — ${periodLabel}`);
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        console.error("[DailyReport share] erro:", err);
        toast.error("Não foi possível compartilhar: " + (err?.message || "erro desconhecido"));
      }
    } finally {
      setGeneratingPdf(false);
    }
  };


  const finalCash = cashSummary?.counted != null
    ? cashSummary.counted
    : (cashSummary?.expected ?? ((cashSummary?.opening ?? 0) + totals.payments + totals.penalties + totals.manualIn - (totals.loans + totals.renewals) - totals.manualOut - totals.expenses));

  const oldestDay = days.length ? days[days.length - 1] : null;
  const newestDay = days.length ? days[0] : null;
  const periodOpening = isMultiDay ? (oldestDay?.opening ?? 0) : (cashSummary?.opening ?? 0);
  const periodFinal = isMultiDay ? (newestDay?.finalCash ?? 0) : finalCash;
  const periodDiffValue = isMultiDay ? periodDiff : (cashSummary?.diff ?? 0);

  const PRESETS: { key: Preset; label: string }[] = [
    { key: "hoje", label: "Hoje" },
    { key: "ontem", label: "Ontem" },
    { key: "semana", label: "Esta semana" },
    { key: "mes", label: "Este mês" },
    { key: "custom", label: "Personalizado" },
  ];

  return (
    <div className={embedded ? "w-full space-y-4 overflow-x-hidden" : "mx-auto w-full max-w-3xl p-4 space-y-4 overflow-x-hidden"}>
      {/* Filtros */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <FileText className="h-5 w-5 text-primary shrink-0" />
              <div className="min-w-0">
                <h2 className="text-lg font-semibold leading-tight">Relatório Diário</h2>
                <p className="text-xs text-muted-foreground truncate">
                  {(workerName || (selectedWorkerId ? "—" : "Selecione um trabalhador"))} · {periodLabel}
                </p>
              </div>
            </div>
            {!isMultiDay && cashStatus && (
              <Badge variant={cashStatus === "closed" ? "secondary" : "default"} className="shrink-0">
                Caixa {cashStatus === "closed" ? "Fechado" : "Aberto"}
              </Badge>
            )}
          </div>

          {!embedded && (
            <>
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((p) => (
                  <Button
                    key={p.key}
                    size="sm"
                    variant={preset === p.key ? "default" : "outline"}
                    className="h-8 text-xs"
                    onClick={() => applyPreset(p.key)}
                  >
                    {p.label}
                  </Button>
                ))}
              </div>

              {preset === "custom" ? (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs">Data inicial</Label>
                    <Input type="date" value={startDate} max={endDate} onChange={(e) => setStartDate(e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs">Data final</Label>
                    <Input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Período: {periodLabel}</p>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {isSuperAdmin && (
                  <div>
                    <Label className="text-xs">Administrador</Label>
                    <select
                      className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
                      value={selectedAdminId || ""}
                      onChange={(e) => { setSelectedAdminId(e.target.value || null); setSelectedWorkerId(null); }}
                    >
                      <option value="">Todos / Geral</option>
                      {admins.map((a) => <option key={a.id} value={a.id}>{a.nome}</option>)}
                    </select>
                  </div>
                )}
                {(isAdmin || isSuperAdmin) && (
                  <div>
                    <Label className="text-xs">Trabalhador</Label>
                    <select
                      className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
                      value={selectedWorkerId || ""}
                      onChange={(e) => setSelectedWorkerId(e.target.value || null)}
                    >
                      <option value="">— Selecione —</option>
                      {workers.map((w) => <option key={w.id} value={w.id}>{w.nome}</option>)}
                    </select>
                  </div>
                )}
              </div>
            </>
          )}

        </CardContent>
      </Card>

      {/* Indicadores — resumo do período selecionado */}
      {isMultiDay && (
        <p className="text-xs font-semibold text-muted-foreground uppercase">Resumo total do período</p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <StatCard label={isMultiDay ? "Caixa inicial (1º dia)" : "Caixa inicial"} value={formatCurrency(periodOpening)} />
        <StatCard
          label={isMultiDay ? "Caixa final (último dia)" : (cashSummary?.counted != null ? "Caixa final (fechado)" : "Caixa final (previsto)")}
          value={formatCurrency(periodFinal)}
        />
        <StatCard label="Total recebido" value={formatCurrency(totals.payments)} tone="positive" />
        <StatCard label="Total emprestado" value={formatCurrency(totals.loans + totals.renewals)} tone="negative" />
        <StatCard label="Entradas" value={formatCurrency(totals.manualIn)} tone="positive" />
        <StatCard label="Saídas" value={formatCurrency(totals.manualOut)} tone="negative" />
        <StatCard label="Despesas" value={formatCurrency(totals.expenses)} tone="negative" />
        <StatCard label="Multas" value={formatCurrency(totals.penalties)} tone="positive" />
        <StatCard label="Estornos" value={formatCurrency(estornosTotal)} sub={`${groups.estornos.length} registro(s)`} />
        <StatCard
          label="Diferença de caixa"
          value={formatCurrency(periodDiffValue)}
          tone={periodDiffValue === 0 ? undefined : periodDiffValue > 0 ? "positive" : "negative"}
          sub={isMultiDay ? "soma dos dias fechados" : (cashSummary?.counted == null ? "aguardando fechamento" : undefined)}
        />
      </div>

      {!isMultiDay && cashStatus !== "closed" && (
        <p className="text-xs text-muted-foreground">Caixa ainda aberto — valores do dia podem mudar.</p>
      )}

      {!isMultiDay && cashSummary?.closingObs && (
        <Card>
          <CardContent className="p-3 text-xs">
            <p className="text-muted-foreground mb-1">Observação do fechamento</p>
            <p className="whitespace-pre-wrap break-words">{cashSummary.closingObs}</p>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Button onClick={handleDownloadPDF} disabled={loading || generatingPdf} variant="default">
          {generatingPdf
            ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Gerando…</>
            : <><Download className="mr-2 h-4 w-4" /> Baixar PDF</>}
        </Button>
        <Button onClick={handleSharePDF} disabled={loading || generatingPdf} variant="outline">
          <Share2 className="mr-2 h-4 w-4" /> Compartilhar
        </Button>
      </div>

      {/* Contagens do período */}
      {!loading && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <CountCard label="Pagamentos" value={recordGroups.pagamentos.length} />
          <CountCard label="Pagamentos parciais" value={recordGroups.pagamentosParciais.length} />
          <CountCard label="Novos empréstimos" value={recordGroups.novosEmprestimos.length} />
          <CountCard label="Renovações" value={recordGroups.renovacoes.length} />
          <CountCard label="Renegociações" value={recordGroups.renegociacoes.length} />
          <CountCard label="Clientes não pagos" value={recordGroups.naoPagos.length} />
          <CountCard label="Clientes pendentes" value={pendentesPeriodo.length} />
          <CountCard label="Clientes atrasados" value={details.atrasados.length} />
        </div>
      )}

      {/* Registros */}
      {loading ? (
        <div className="flex items-center justify-center py-10"><Loader2 className="h-5 w-5 animate-spin" /></div>
      ) : isMultiDay ? (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase">Registros por dia</p>
          {days.length === 0 && (
            <p className="text-center text-sm text-muted-foreground py-8">Nenhuma movimentação no período.</p>
          )}
          {days.map((d) => (
            <DaySection key={d.date} day={d} />
          ))}
          <p className="text-xs font-semibold text-muted-foreground uppercase pt-2">Situação atual da carteira</p>
          <RecordSection title="Clientes atrasados" records={details.atrasados} />
        </div>
      ) : (
        <RecordGroupSections
          groups={recordGroups}
          pendentes={details.pendentesByDate[endDate] || []}
          atrasados={details.atrasados}
        />
      )}

    </div>
  );
}

type DayGroups = ReturnType<typeof buildGroups>;

function buildGroups(list: DailyEvent[]) {
  const active = (t: string | string[]) =>
    list.filter((e) => (Array.isArray(t) ? t.includes(e.event_type) : e.event_type === t) && !e.reversed_at);
  return {
    pagamentos: active(["pagamento", "recebimento_multa"]),
    naoPagamentos: active("nao_pagou"),
    novosEmprestimos: active("emprestimo_novo"),
    renovacoes: active(["renovacao", "renegociacao"]),
    movimentacoes: active(["entrada_manual", "saida_manual", "saida"]),
    despesas: active("despesa"),
    estornos: list.filter((e) => !!e.reversed_at),
  };
}

type RecordGroups = ReturnType<typeof buildRecordGroups>;

/**
 * Agrupa os registros detalhados por tipo de movimentação (apresentação apenas).
 * Não altera valores, saldos nem regras financeiras.
 */
function buildRecordGroups(list: DailyEvent[], recordFor: (e: DailyEvent) => ReportRecord) {
  const recs = list.map(recordFor);
  const of = (kinds: string[], filter?: (r: ReportRecord) => boolean) =>
    recs.filter((r) => kinds.includes(r.kind) && !r.reversed && (!filter || filter(r)));

  const pagamentosAll = of(["pagamento", "recebimento_multa"]);
  const parciais = pagamentosAll.filter((r) => r.title === "Pagamento parcial");
  const pagamentos = pagamentosAll.filter((r) => r.title !== "Pagamento parcial");
  const known = new Set([
    "pagamento", "recebimento_multa", "nao_pagou", "emprestimo_novo", "emprestimo_importado",
    "renovacao", "renovacao_absorvida", "renegociacao", "despesa",
  ]);
  return {
    pagamentos,
    pagamentosParciais: parciais,
    novosEmprestimos: of(["emprestimo_novo", "emprestimo_importado"]),
    renovacoes: of(["renovacao", "renovacao_absorvida"]),
    renegociacoes: of(["renegociacao"]),
    naoPagos: of(["nao_pagou"]),
    despesas: of(["despesa"]),
    outras: recs.filter((r) => !r.reversed && !known.has(r.kind)),
    estornos: recs.filter((r) => r.reversed),
  };
}

const RECORD_GROUP_ORDER: { key: keyof RecordGroups; label: string }[] = [
  { key: "pagamentos", label: "Pagamentos" },
  { key: "pagamentosParciais", label: "Pagamentos parciais" },
  { key: "novosEmprestimos", label: "Novos empréstimos" },
  { key: "renovacoes", label: "Renovações" },
  { key: "renegociacoes", label: "Renegociações" },
  { key: "naoPagos", label: "Clientes não pagos" },
  { key: "despesas", label: "Despesas" },
  { key: "outras", label: "Outras movimentações" },
  { key: "estornos", label: "Estornos" },
];

/** Seções detalhadas de um dia/período (mesma ordem na tela e no PDF). */
function RecordGroupSections({
  groups,
  pendentes,
  atrasados,
  showWorker,
}: {
  groups: RecordGroups;
  pendentes: ReportRecord[];
  atrasados?: ReportRecord[];
  showWorker?: boolean;
}) {
  return (
    <div className="space-y-2">
      {RECORD_GROUP_ORDER.slice(0, 6).map((g) => (
        <RecordSection key={g.key} title={g.label} records={groups[g.key]} showWorker={showWorker} />
      ))}
      <RecordSection title="Clientes pendentes de registro" records={pendentes} showWorker={showWorker} />
      {atrasados && <RecordSection title="Clientes atrasados" records={atrasados} showWorker={showWorker} />}
      {RECORD_GROUP_ORDER.slice(6).map((g) => (
        <RecordSection key={g.key} title={g.label} records={groups[g.key]} showWorker={showWorker} />
      ))}
    </div>
  );
}


function DaySection({
  day,
  clientNames,
}: {
  day: {
    date: string; events: DailyEvent[]; groups: DayGroups; status: string | null; reopened: boolean;
    opening: number; finalCash: number; diff: number | null; received: number; out: number; closingObs: string | null;
  };
  clientNames: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const label = format(new Date(day.date + "T12:00:00"), "EEEE, dd/MM/yyyy", { locale: ptBR });
  const statusLabel = day.status === "closed" ? (day.reopened ? "Reaberto e fechado" : "Fechado") : day.status === "open" ? "Caixa ainda aberto" : "Sem caixa";

  return (
    <Card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="w-full">
          <div className="flex items-center justify-between gap-2 p-3">
            <div className="flex items-center gap-2 min-w-0">
              <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
              <div className="min-w-0 text-left">
                <p className="text-sm font-medium capitalize truncate">{label}</p>
                <p className="text-[11px] text-muted-foreground truncate">
                  {statusLabel} · {day.events.length} registro(s)
                </p>
              </div>
            </div>
            <div className="text-right shrink-0">
              <p className="text-xs font-semibold text-success tabular-nums">{formatCurrency(day.received)}</p>
              <p className="text-[10px] text-muted-foreground tabular-nums">Caixa final {formatCurrency(day.finalCash)}</p>
            </div>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t p-3 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <StatCard label="Caixa inicial" value={formatCurrency(day.opening)} />
              <StatCard
                label={day.status === "closed" ? "Caixa final (fechado)" : "Caixa final (previsto)"}
                value={formatCurrency(day.finalCash)}
                sub={day.status !== "closed" ? "Caixa ainda aberto" : undefined}
              />
              {day.diff != null && (
                <StatCard
                  label="Diferença de caixa"
                  value={formatCurrency(day.diff)}
                  tone={day.diff === 0 ? undefined : day.diff > 0 ? "positive" : "negative"}
                />
              )}
              {day.reopened && <StatCard label="Status" value="Reaberto" />}
            </div>
            {day.closingObs && (
              <p className="text-xs text-muted-foreground whitespace-pre-wrap break-words">Obs. fechamento: {day.closingObs}</p>
            )}
            <div className="space-y-2">
              <EventSection title="Pagamentos" events={day.groups.pagamentos} clientNames={clientNames} />
              <EventSection title="Não pagamentos" events={day.groups.naoPagamentos} clientNames={clientNames} />
              <EventSection title="Novos empréstimos" events={day.groups.novosEmprestimos} clientNames={clientNames} />
              <EventSection title="Renovações e renegociações" events={day.groups.renovacoes} clientNames={clientNames} />
              <EventSection title="Entradas e saídas" events={day.groups.movimentacoes} clientNames={clientNames} />
              <EventSection title="Despesas" events={day.groups.despesas} clientNames={clientNames} />
              <EventSection title="Estornos" events={day.groups.estornos} clientNames={clientNames} />
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}


function StatCard({ label, value, tone, sub }: { label: string; value: string; tone?: "positive" | "negative"; sub?: string }) {
  return (
    <Card>
      <CardContent className="p-3">
        <p className="text-[11px] text-muted-foreground leading-tight">{label}</p>
        <p className={`font-bold text-sm mt-1 break-words ${tone === "positive" ? "text-success" : tone === "negative" ? "text-destructive" : ""}`}>{value}</p>
        {sub && <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function EventSection({ title, events, clientNames }: { title: string; events: DailyEvent[]; clientNames: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  const total = events.reduce((s, e) => s + Number(e.amount_in || 0) + Number(e.amount_out || 0), 0);

  return (
    <Card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="w-full" disabled={events.length === 0}>
          <div className="flex items-center justify-between gap-2 p-3">
            <div className="flex items-center gap-2 min-w-0">
              <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""} ${events.length === 0 ? "opacity-30" : ""}`} />
              <span className="text-sm font-medium truncate">{title}</span>
              <Badge variant="outline" className="h-5 text-[10px] shrink-0">{events.length}</Badge>
            </div>
            {total > 0 && <span className="text-xs font-semibold tabular-nums shrink-0">{formatCurrency(total)}</span>}
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="divide-y border-t">
            {events.map((e) => (
              <div key={e.id} className="flex items-start justify-between gap-2 p-3 text-sm">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground tabular-nums">{format(new Date(e.created_at), "HH:mm")}</span>
                    <span className="font-medium truncate">
                      {e.client_id ? (clientNames[e.client_id] || "—") : getEventTypeLabel(e.event_type)}
                    </span>
                    {e.reversed_at && <Badge variant="outline" className="text-[10px] h-4 shrink-0">Estornado</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground break-words">
                    {getEventTypeLabel(e.event_type)}
                    {e.observation ? ` · ${e.observation}` : ""}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  {Number(e.amount_in || 0) > 0 && <p className="text-success text-xs font-semibold">+ {formatCurrency(Number(e.amount_in))}</p>}
                  {Number(e.amount_out || 0) > 0 && <p className="text-destructive text-xs font-semibold">- {formatCurrency(Number(e.amount_out))}</p>}
                </div>
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

