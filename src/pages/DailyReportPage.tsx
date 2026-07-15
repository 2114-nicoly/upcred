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
import { Download, FileText, Loader2, Share2 } from "lucide-react";
import { toast } from "sonner";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

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

export default function DailyReportPage() {
  const { workerId: myWorkerId, adminId: myAdminId, isAdmin, isSuperAdmin } = useAuth();
  const [searchParams] = useSearchParams();

  const today = format(new Date(), "yyyy-MM-dd");
  const [date, setDate] = useState<string>(searchParams.get("date") || today);
  const [selectedAdminId, setSelectedAdminId] = useState<string | null>(null);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(
    isSuperAdmin || isAdmin ? searchParams.get("worker") : myWorkerId
  );

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
        // daily_events
        let eq: any = supabase.from("daily_events" as any).select("*").eq("cash_date", date);
        if (selectedWorkerId) eq = eq.eq("worker_id", selectedWorkerId);
        else if (isSuperAdmin && selectedAdminId) eq = eq.eq("admin_id", selectedAdminId).is("worker_id", null);
        else if (isAdmin && !isSuperAdmin && myAdminId) eq = eq.eq("admin_id", myAdminId).is("worker_id", null);
        const { data: evs } = await eq.order("created_at", { ascending: true });
        const eventList = (evs as unknown as DailyEvent[]) || [];
        setEvents(eventList);

        // audit_logs for the day
        const dayStart = `${date}T00:00:00`;
        const dayEnd = `${date}T23:59:59`;
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

        // daily_cash status (worker scope) + closing details
        let dcRow: any = null;
        if (selectedWorkerId) {
          const { data: dc } = await supabase.from("daily_cash").select("*").eq("cash_date", date).eq("worker_id", selectedWorkerId).maybeSingle();
          dcRow = dc;
        } else if (isSuperAdmin && selectedAdminId) {
          const { data: dc } = await supabase.from("daily_cash").select("*").eq("cash_date", date).eq("admin_id", selectedAdminId).is("worker_id", null).maybeSingle();
          dcRow = dc;
        }
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
      } catch (err: any) {
        console.error(err);
        toast.error("Erro ao carregar relatório");
      } finally {
        setLoading(false);
      }
    })();
  }, [date, selectedWorkerId, selectedAdminId, isAdmin, isSuperAdmin, myAdminId]);

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

  const dateLabel = useMemo(() => format(new Date(date + "T12:00:00"), "dd 'de' MMMM 'de' yyyy", { locale: ptBR }), [date]);

  const buildPdf = (): { doc: jsPDF; filename: string } => {
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const issuedAt = format(new Date(), "dd/MM/yyyy HH:mm", { locale: ptBR });
    const cashLabel =
      cashStatus === "closed" ? "Fechado" :
      cashStatus === "open" ? "Aberto" :
      cashStatus ? cashStatus : "—";

    // Layout constants — never use fixed absolute Y positions after this point;
    // always route through cursorY() / ensureSpace() / addSection().
    const HEADER_BOTTOM = 42;
    const PAGE_BOTTOM = pageHeight - 22;

    const drawHeader = () => {
      doc.setFontSize(15);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(0, 0, 0);
      doc.text("UpCred — Relatório Diário", 14, 16);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.text(`Emitido em ${issuedAt}`, pageWidth - 14, 16, { align: "right" });
      doc.setFontSize(10);
      doc.text(`Trabalhador: ${workerName || "—"}`, 14, 24);
      doc.text(`Data: ${dateLabel}`, 14, 30);
      doc.text(`Caixa: ${cashLabel}`, 14, 36);
      doc.setDrawColor(200);
      doc.line(14, 38, pageWidth - 14, 38);
    };

    drawHeader();
    // Seed lastAutoTable so the first cursorY() call sits below the header.
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
      ensureSpace(14);
      const y = cursorY() + 8;
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

    const addSection = (title: string, body: (string | number)[][], head: string[]) => {
      if (body.length === 0) return;
      ensureSpace(20);
      const startY = cursorY() + 6;
      doc.setFontSize(10);
      doc.setFont("helvetica", "bold");
      doc.text(title, 14, startY);
      doc.setFont("helvetica", "normal");
      autoTable(doc, {
        startY: startY + 2,
        head: [head],
        body,
        styles: { fontSize: 8 },
        headStyles: { fillColor: [59, 130, 246] },
        margin: { top: HEADER_BOTTOM, left: 14, right: 14, bottom: 22 },
        // Repeat main report header on every new page the table spans.
        didDrawPage: () => drawHeader(),
      });
    };

    // Counts: visitados / não visitados
    const paidEvents = events.filter((e) => e.event_type === "pagamento" && !e.reversed_at);
    const notPaidEvents = events.filter((e) => e.event_type === "nao_pagou" && !e.reversed_at);
    const visitedClients = new Set<string>();
    paidEvents.forEach((e) => e.client_id && visitedClients.add(e.client_id));
    notPaidEvents.forEach((e) => e.client_id && visitedClients.add(e.client_id));
    const notVisitedCount = notPaidEvents.length;

    // ============ BLOCO 1: RESUMO DO DIA ============
    writeBlockTitle("1. Resumo do Dia");

    const opening = cashSummary?.opening ?? 0;
    const finalCash = cashSummary?.expected ?? (opening + totals.payments + totals.penalties + totals.manualIn - (totals.loans + totals.renewals) - totals.manualOut);
    const cashRows: [string, string][] = [
      ["Caixa Disponível no Início do Dia", formatCurrency(opening)],
      ["Recebido Hoje", formatCurrency(totals.payments)],
      ["Multas Recebidas", formatCurrency(totals.penalties)],
      ["Emprestado Hoje", formatCurrency(totals.loans + totals.renewals)],
      ["Entradas Manuais", formatCurrency(totals.manualIn)],
      ["Saídas Manuais", formatCurrency(totals.manualOut)],
      ["Caixa Disponível Final", formatCurrency(finalCash)],
      ...(cashSummary?.counted != null ? [["Dinheiro Contado", formatCurrency(cashSummary.counted)] as [string,string]] : []),
      ...(cashSummary?.diff != null ? [["Diferença", formatCurrency(cashSummary.diff)] as [string,string]] : []),
      ...(cashSummary?.closingObs ? [["Observação do fechamento", cashSummary.closingObs] as [string,string]] : []),
      ["Clientes visitados", String(visitedClients.size)],
      ["Clientes não visitados (não pagou)", String(notVisitedCount)],
    ];
    ensureSpace(20);
    autoTable(doc, {
      startY: cursorY() + 4,
      head: [["Indicador", "Valor"]],
      body: cashRows,
      styles: { fontSize: 9 },
      headStyles: { fillColor: [59, 130, 246] },
      columnStyles: { 1: { halign: "right" } },
      margin: { top: HEADER_BOTTOM, left: 14, right: 14, bottom: 22 },
      didDrawPage: () => drawHeader(),
    });

    // Categorize (financial events)
    const paid = paidEvents;
    const notPaid = notPaidEvents;
    const partials = paid.filter((e) => (e.observation || "").toLowerCase().includes("parcial"));
    const newLoans = events.filter((e) => e.event_type === "emprestimo_novo" && !e.reversed_at);
    const renewals = events.filter((e) => (e.event_type === "renovacao" || e.event_type === "renegociacao") && !e.reversed_at);
    const cancels = events.filter((e) => e.event_type === "cancelamento");
    const penaltiesAdded = events.filter((e) => e.event_type === "multa_adicionada" && !e.reversed_at);
    const penaltiesPaid = events.filter((e) => e.event_type === "recebimento_multa" && !e.reversed_at);
    const importedOngoing = auditRows.filter((a) =>
      a.action_type === "criar_emprestimo_importado" ||
      (a.action_type === "criar_emprestimo" &&
        (a as any).new_value && typeof (a as any).new_value === "object" && (a as any).new_value.imported_ongoing === true)
    );
    const quitacoes = auditRows.filter((a) => a.action_type === "quitar_emprestimo");

    // Audit-only rows (belong to "Auditoria")
    const penaltiesCancelled = auditRows.filter((a) => a.action_type === "multa_cancelada");
    const partialPayments = auditRows.filter((a) => a.action_type === "pagamento_parcial");
    const auditResumo = auditRows.filter((a) =>
      a.action_type === "editar_cliente" ||
      a.action_type === "editar_parcela" ||
      a.action_type === "alterar_data_parcela" ||
      a.action_type === "desfazer_pagamento" ||
      a.action_type === "estorno_pagamento" ||
      a.action_type === "estorno_manual" ||
      a.action_type === "transferencia_cliente" ||
      a.action_type === "fechar_caixa" ||
      a.action_type === "reabrir_caixa"
    );

    const nameOf = (cid: string | null) => cid ? (clientNames[cid] || "—") : "—";

    // ============ BLOCO 2: MOVIMENTAÇÕES FINANCEIRAS ============
    writeBlockTitle("2. Movimentações Financeiras");

    addSection("Clientes que pagaram", paid.map((e) => [
      format(new Date(e.created_at), "HH:mm"),
      nameOf(e.client_id),
      formatCurrency(Number(e.amount_in || 0)),
      e.observation || "",
    ]), ["Hora", "Cliente", "Valor", "Obs."]);

    addSection("Pagamentos parciais", partials.map((e) => [
      format(new Date(e.created_at), "HH:mm"),
      nameOf(e.client_id),
      formatCurrency(Number(e.amount_in || 0)),
      e.observation || "",
    ]), ["Hora", "Cliente", "Valor", "Obs."]);

    addSection("Clientes que não pagaram", notPaid.map((e) => [
      format(new Date(e.created_at), "HH:mm"),
      nameOf(e.client_id),
      e.observation || "",
    ]), ["Hora", "Cliente", "Obs."]);

    addSection("Multas aplicadas", penaltiesAdded.map((e) => [
      format(new Date(e.created_at), "HH:mm"),
      nameOf(e.client_id),
      formatCurrency(Number(e.amount_in || e.amount_out || (e.metadata as any)?.amount || 0)),
      e.observation || "",
    ]), ["Hora", "Cliente", "Valor", "Obs."]);

    addSection("Multas pagas", penaltiesPaid.map((e) => [
      format(new Date(e.created_at), "HH:mm"),
      nameOf(e.client_id),
      formatCurrency(Number(e.amount_in || 0)),
      e.observation || "",
    ]), ["Hora", "Cliente", "Valor", "Obs."]);

    addSection("Empréstimos novos", newLoans.map((e) => [
      format(new Date(e.created_at), "HH:mm"),
      nameOf(e.client_id),
      formatCurrency(Number(e.amount_out || 0)),
      e.observation || "",
    ]), ["Hora", "Cliente", "Liberado", "Obs."]);

    addSection("Empréstimos em andamento cadastrados", importedOngoing.map((a) => {
      const nv: any = (a as any).new_value || {};
      return [
        format(new Date(a.created_at), "HH:mm"),
        nv.client_name || nameOf(nv.client_id || null),
        formatCurrency(Number(nv.total_amount || 0)),
        formatCurrency(Number(nv.amount_already_paid || 0)),
        formatCurrency(Number(nv.initial_remaining_balance || nv.principal_receivable || 0)),
      ];
    }), ["Hora", "Cliente / Empréstimo", "Total", "Já pago", "Saldo restante"]);

    addSection("Renovações", renewals.map((e) => [
      format(new Date(e.created_at), "HH:mm"),
      nameOf(e.client_id),
      formatCurrency(Number(e.amount_out || 0)),
      e.observation || "",
    ]), ["Hora", "Cliente", "Liberado", "Obs."]);

    addSection("Cancelamentos", cancels.map((e) => [
      format(new Date(e.created_at), "HH:mm"),
      nameOf(e.client_id),
      e.observation || "",
    ]), ["Hora", "Cliente", "Motivo / Obs."]);

    addSection("Quitações", quitacoes.map((a) => {
      const nv: any = (a as any).new_value || {};
      return [
        format(new Date(a.created_at), "HH:mm"),
        nv.client_name || nameOf(nv.client_id || null),
        formatCurrency(Number(nv.amount_paid || nv.remaining_balance || 0)),
        a.observation || "",
      ];
    }), ["Hora", "Cliente", "Valor", "Obs."]);

    // ============ BLOCO 3: AUDITORIA ============
    writeBlockTitle("3. Auditoria");

    addSection("Pagamentos parciais (registrados)", partialPayments.map((a) => {
      const nv: any = (a as any).new_value || {};
      return [
        format(new Date(a.created_at), "HH:mm"),
        nv.client_name || nameOf(nv.client_id || null),
        `#${nv.installment_number ?? "—"}`,
        formatCurrency(Number(nv.amount_paid || 0)),
        formatCurrency(Number(nv.installment_amount || 0)),
        formatCurrency(Number(nv.installment_remaining || 0)),
      ];
    }), ["Hora", "Cliente", "Parcela", "Pago", "Valor parcela", "Restante"]);

    addSection("Multas canceladas", penaltiesCancelled.map((a) => [
      format(new Date(a.created_at), "HH:mm"),
      nameOf((a as any).new_value?.client_id || null),
      a.observation || "",
    ]), ["Hora", "Cliente", "Motivo / Obs."]);

    addSection("Ações administrativas / correções", auditResumo.map((a) => {
      const nv: any = (a as any).new_value || {};
      const label =
        a.action_type === "editar_cliente" ? "Cliente editado" :
        a.action_type === "editar_parcela" ? "Parcela editada" :
        a.action_type === "alterar_data_parcela" ? "Data de parcela alterada" :
        a.action_type === "desfazer_pagamento" ? "Pagamento desfeito" :
        a.action_type === "estorno_pagamento" ? "Pagamento estornado" :
        a.action_type === "estorno_manual" ? "Movimentação estornada" :
        a.action_type === "transferencia_cliente" ? "Cliente transferido" :
        a.action_type === "fechar_caixa" ? "Caixa fechado" :
        a.action_type === "reabrir_caixa" ? "Caixa reaberto" :
        a.action_type;
      return [
        format(new Date(a.created_at), "HH:mm"),
        label,
        nv.client_name || nameOf((a.entity_type === "client" ? a.entity_id : nv.client_id) || null),
        a.observation || "",
      ];
    }), ["Hora", "Ação", "Cliente", "Obs."]);

    // Observações livres (page-break safe)
    const obsList = events.filter((e) => (e.observation || "").trim().length > 0)
      .map((e) => `• ${format(new Date(e.created_at), "HH:mm")} ${nameOf(e.client_id)} — ${e.observation}`);
    if (obsList.length > 0) {
      ensureSpace(14);
      const startY = cursorY() + 6;
      doc.setFontSize(10);
      doc.setFont("helvetica", "bold");
      doc.text("Observações", 14, startY);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      const wrapped: string[] = doc.splitTextToSize(obsList.join("\n"), pageWidth - 28);
      let y = startY + 5;
      const lineHeight = 4;
      for (const line of wrapped) {
        if (y + lineHeight > PAGE_BOTTOM) {
          doc.addPage();
          drawHeader();
          y = HEADER_BOTTOM + 6;
          doc.setFontSize(8);
        }
        doc.text(line, 14, y);
        y += lineHeight;
      }
      (doc as any).lastAutoTable = { finalY: y };
    }

    // Signatures — always reserve room; add a page if it would overlap content.
    ensureSpace(35);
    const sigY = cursorY() + 25;
    doc.setDrawColor(120);
    doc.line(20, sigY, 90, sigY);
    doc.line(pageWidth - 90, sigY, pageWidth - 20, sigY);
    doc.setFontSize(9);
    doc.text("Assinatura do trabalhador", 55, sigY + 5, { align: "center" });
    doc.text("Assinatura do administrador", pageWidth - 55, sigY + 5, { align: "center" });

    const filename = `relatorio-${(workerName || "trabalhador").replace(/\s+/g, "_")}-${date}.pdf`;
    return { doc, filename };
  };

  const handleDownloadPDF = async () => {
    if (generatingPdf) return;
    setGeneratingPdf(true);
    try {
      const { doc, filename } = buildPdf();
      doc.save(filename);
      toast.success("PDF gerado");
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
      const blob = doc.output("blob");
      const file = new File([blob], filename, { type: "application/pdf" });
      const nav: any = navigator;
      if (nav.canShare && nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: filename, text: `Relatório diário ${dateLabel}` });
      } else {
        const url = URL.createObjectURL(blob);
        window.open(url, "_blank");
        toast.message("Compartilhamento direto indisponível — abri o PDF para você salvar/enviar.");
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        console.error("[DailyReport share] erro:", err);
        toast.error("Não foi possível compartilhar: " + (err?.message || "erro desconhecido"));
      }
    } finally {
      setGeneratingPdf(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl p-4 space-y-4">
      {(isAdmin || isSuperAdmin) && (
        <div className="sticky top-0 z-20 -mx-4 -mt-4 px-4 pt-4 pb-2 bg-background/95 backdrop-blur border-b">
          <Card>
            <CardContent className="p-3 space-y-2">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase">1. Trabalhador/equipe</p>
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
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold">Relatório Diário</h2>
          </div>
          <div>
            <Label className="text-xs">2. Data</Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </CardContent>
      </Card>


      <Card>
        <CardContent className="p-4 space-y-1">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">UpCred</p>
              <h3 className="text-base font-bold">{workerName || (selectedWorkerId ? "—" : "Selecione um trabalhador")}</h3>
              <p className="text-sm text-muted-foreground capitalize">{dateLabel}</p>
            </div>
            {cashStatus && (
              <Badge variant={cashStatus === "closed" ? "secondary" : "default"}>
                Caixa {cashStatus === "closed" ? "Fechado" : "Aberto"}
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <Stat label="Caixa Disponível no Início do Dia" value={formatCurrency(cashSummary?.opening ?? 0)} />
          <Stat label="Recebido Hoje" value={formatCurrency(totals.payments)} positive />
          <Stat label="Multas Recebidas" value={formatCurrency(totals.penalties)} positive />
          <Stat label="Emprestado Hoje" value={formatCurrency(totals.loans + totals.renewals)} negative />
          <Stat label="Entradas Manuais" value={formatCurrency(totals.manualIn)} positive />
          <Stat label="Saídas Manuais" value={formatCurrency(totals.manualOut)} negative />
          <Stat
            label="Caixa Disponível Final"
            value={formatCurrency(cashSummary?.expected ?? ((cashSummary?.opening ?? 0) + totals.payments + totals.penalties + totals.manualIn - (totals.loans + totals.renewals) - totals.manualOut))}
          />
          {cashSummary?.counted != null && <Stat label="Dinheiro Contado" value={formatCurrency(cashSummary.counted)} />}
          {cashSummary?.diff != null && (
            <Stat label="Diferença" value={formatCurrency(cashSummary.diff)} positive={cashSummary.diff >= 0} negative={cashSummary.diff < 0} />
          )}
          <Stat label="Não pagou" value={String(totals.notPaidCount)} />
        </CardContent>
      </Card>

      {cashSummary?.closingObs && (
        <Card>
          <CardContent className="p-3 text-xs">
            <p className="text-muted-foreground mb-1">Observação do fechamento</p>
            <p className="whitespace-pre-wrap">{cashSummary.closingObs}</p>
          </CardContent>
        </Card>
      )}


      <div className="grid grid-cols-2 gap-2">
        <Button onClick={handleDownloadPDF} disabled={loading || generatingPdf || (rows.length === 0 && !cashSummary)} variant="default">
          {generatingPdf
            ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Gerando…</>
            : <><Download className="mr-2 h-4 w-4" /> Baixar PDF</>}
        </Button>
        <Button onClick={handleSharePDF} disabled={loading || generatingPdf || (rows.length === 0 && !cashSummary)} variant="outline">
          <Share2 className="mr-2 h-4 w-4" /> Compartilhar
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-10"><Loader2 className="h-5 w-5 animate-spin" /></div>
          ) : rows.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-10">Nenhuma movimentação registrada nesta data.</p>
          ) : (
            <div className="divide-y">
              {rows.map((r, i) => (
                <div key={i} className="flex items-center justify-between gap-2 p-3 text-sm">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground tabular-nums">{r.time}</span>
                      <span className="font-medium truncate">{r.typeLabel}</span>
                      {r.reversed && <Badge variant="outline" className="text-[10px] h-4">Estornado</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {r.clientName !== "—" ? r.clientName : ""}
                      {r.observation ? ` · ${r.observation}` : ""}
                    </p>
                  </div>
                  <div className="text-right">
                    {r.amountIn > 0 && <p className="text-success text-xs font-semibold">+ {formatCurrency(r.amountIn)}</p>}
                    {r.amountOut > 0 && <p className="text-destructive text-xs font-semibold">- {formatCurrency(r.amountOut)}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, positive, negative }: { label: string; value: string; positive?: boolean; negative?: boolean }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className={`font-bold text-sm ${positive ? "text-success" : negative ? "text-destructive" : ""}`}>{value}</p>
    </div>
  );
}
