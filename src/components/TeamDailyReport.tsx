import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/loan-utils";
import { computeDailyTotals } from "@/lib/daily-totals";
import { useAuth } from "@/hooks/useAuth";
import { Download, Loader2, Users } from "lucide-react";
import { toast } from "sonner";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

type WorkerRow = {
  id: string;
  nome: string;
  cashStatus: "open" | "closed" | "not_opened";
  opening: number;
  expected: number;
  counted: number | null;
  diff: number | null;
  received: number;
  lent: number;
  manualIn: number;
  manualOut: number;
  penalties: number;
  reversals: number;
  cancels: number;
};

type AdminOpt = { id: string; nome: string };

export default function TeamDailyReport() {
  const { adminId: myAdminId, isSuperAdmin, isAdmin } = useAuth();
  const [date, setDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [selectedAdminId, setSelectedAdminId] = useState<string | null>(null);
  const [admins, setAdmins] = useState<AdminOpt[]>([]);
  const [rows, setRows] = useState<WorkerRow[]>([]);
  const [reopenPending, setReopenPending] = useState(0);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);

  const scopeAdminId = isSuperAdmin ? selectedAdminId : myAdminId;

  useEffect(() => {
    if (!isSuperAdmin) return;
    (async () => {
      const { data } = await supabase.rpc("super_admin_list_admins" as any);
      setAdmins(((data as any[]) || []).map((a) => ({ id: a.id, nome: a.nome })));
    })();
  }, [isSuperAdmin]);

  useEffect(() => {
    (async () => {
      if (!isAdmin && !isSuperAdmin) return;
      setLoading(true);
      try {
        const { data: ws } = await supabase.rpc("list_workers_by_admin" as any, {
          p_admin_id: isSuperAdmin ? selectedAdminId : null,
          p_include_archived: false,
        });
        const workers = ((ws as any[]) || []).filter((w) => w.active !== false);
        const workerIds = workers.map((w) => w.id);

        // events for date
        let evQ: any = supabase.from("daily_events" as any)
          .select("worker_id, event_type, amount_in, amount_out, reversed_at, admin_id")
          .eq("cash_date", date);
        if (workerIds.length) evQ = evQ.in("worker_id", workerIds);
        else if (scopeAdminId) evQ = evQ.eq("admin_id", scopeAdminId);
        const { data: evs } = await evQ;

        // daily_cash for date
        let dcQ: any = supabase.from("daily_cash")
          .select("worker_id, status, opening_balance, expected_closing_balance, counted_closing_balance, closing_difference, admin_id")
          .eq("cash_date", date);
        if (workerIds.length) dcQ = dcQ.in("worker_id", workerIds);
        else if (scopeAdminId) dcQ = dcQ.eq("admin_id", scopeAdminId);
        const { data: dcs } = await dcQ;

        const evByWorker = new Map<string, any[]>();
        for (const e of ((evs as any[]) || [])) {
          const k = e.worker_id || "";
          if (!evByWorker.has(k)) evByWorker.set(k, []);
          evByWorker.get(k)!.push(e);
        }
        const dcByWorker = new Map<string, any>();
        for (const d of ((dcs as any[]) || [])) {
          dcByWorker.set(d.worker_id || "", d);
        }

        const out: WorkerRow[] = workers.map((w) => {
          const wEvs = evByWorker.get(w.id) || [];
          const dc = dcByWorker.get(w.id);
          const opening = Number(dc?.opening_balance || 0);
          const t = computeDailyTotals(wEvs, opening);
          const reversals = wEvs.filter((e) => e.reversed_at).length;
          const cancels = wEvs.filter((e) => e.event_type === "cancelamento" && !e.reversed_at).length;
          const cashStatus: WorkerRow["cashStatus"] =
            dc?.status === "closed" ? "closed" :
            dc?.status === "open" ? "open" : "not_opened";
          const expected = dc?.expected_closing_balance != null ? Number(dc.expected_closing_balance) : t.saldoFinalEsperado;
          const counted = dc?.counted_closing_balance != null ? Number(dc.counted_closing_balance) : null;
          const diff = dc?.closing_difference != null ? Number(dc.closing_difference) : (counted != null ? counted - expected : null);
          return {
            id: w.id,
            nome: w.nome,
            cashStatus,
            opening,
            expected,
            counted,
            diff,
            received: t.pagamentos + t.multas,
            lent: t.emprestimosLiberados + t.renovacoes + t.renegociacoes,
            manualIn: t.entradasManuais,
            manualOut: t.saidasManuais,
            penalties: t.multas,
            reversals,
            cancels,
          };
        });

        // sort by received desc (ranking base)
        out.sort((a, b) => b.received - a.received);
        setRows(out);

        // reopen requests pending for the date
        let rQ: any = supabase.from("cash_reopen_requests" as any)
          .select("id", { count: "exact", head: true })
          .eq("cash_date", date).eq("status", "pending");
        if (workerIds.length) rQ = rQ.in("worker_id", workerIds);
        else if (scopeAdminId) rQ = rQ.eq("admin_id", scopeAdminId);
        const { count } = await rQ;
        setReopenPending(count || 0);
      } catch (err: any) {
        console.error("[TeamDailyReport]", err);
        toast.error("Erro ao carregar relatório da equipe");
      } finally {
        setLoading(false);
      }
    })();
  }, [date, scopeAdminId, isAdmin, isSuperAdmin, selectedAdminId]);

  const totals = useMemo(() => {
    const t = {
      received: 0, lent: 0, manualIn: 0, manualOut: 0,
      opened: 0, closed: 0, notOpened: 0,
      totalDiff: 0, reversals: 0, cancels: 0,
    };
    for (const r of rows) {
      t.received += r.received;
      t.lent += r.lent;
      t.manualIn += r.manualIn;
      t.manualOut += r.manualOut;
      if (r.cashStatus === "open") t.opened += 1;
      else if (r.cashStatus === "closed") t.closed += 1;
      else t.notOpened += 1;
      if (r.diff != null) t.totalDiff += r.diff;
      t.reversals += r.reversals;
      t.cancels += r.cancels;
    }
    return t;
  }, [rows]);

  const dateLabel = useMemo(() => format(new Date(date + "T12:00:00"), "dd 'de' MMMM 'de' yyyy", { locale: ptBR }), [date]);

  const buildPdf = () => {
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const issuedAt = format(new Date(), "dd/MM/yyyy HH:mm", { locale: ptBR });
    const HEADER_BOTTOM = 42;
    const PAGE_BOTTOM = pageHeight - 22;

    const drawHeader = () => {
      doc.setFontSize(15); doc.setFont("helvetica", "bold"); doc.setTextColor(0, 0, 0);
      doc.text("UpCred — Relatório Diário da Equipe", 14, 16);
      doc.setFont("helvetica", "normal"); doc.setFontSize(9);
      doc.text(`Emitido em ${issuedAt}`, pageWidth - 14, 16, { align: "right" });
      doc.setFontSize(10);
      doc.text(`Data: ${dateLabel}`, 14, 24);
      doc.text(`Trabalhadores: ${rows.length}`, 14, 30);
      doc.text(`Caixas: ${totals.opened} aberto(s) · ${totals.closed} fechado(s) · ${totals.notOpened} não aberto(s)`, 14, 36);
      doc.setDrawColor(200);
      doc.line(14, 38, pageWidth - 14, 38);
    };

    drawHeader();
    (doc as any).lastAutoTable = { finalY: HEADER_BOTTOM };
    const cursorY = () => (doc as any).lastAutoTable?.finalY ?? HEADER_BOTTOM;
    const ensureSpace = (n: number) => {
      if (cursorY() + n > PAGE_BOTTOM) {
        doc.addPage(); drawHeader();
        (doc as any).lastAutoTable = { finalY: HEADER_BOTTOM };
      }
    };
    const writeBlockTitle = (title: string) => {
      ensureSpace(14);
      const y = cursorY() + 8;
      doc.setFillColor(59, 130, 246);
      doc.rect(14, y - 5, pageWidth - 28, 8, "F");
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(11); doc.setFont("helvetica", "bold");
      doc.text(title, 16, y);
      doc.setTextColor(0, 0, 0); doc.setFont("helvetica", "normal");
      (doc as any).lastAutoTable = { finalY: y + 3 };
    };

    // Bloco 1: Resumo consolidado
    writeBlockTitle("1. Resumo Consolidado da Equipe");
    const resumo: [string, string][] = [
      ["Total recebido pela equipe", formatCurrency(totals.received)],
      ["Total emprestado pela equipe", formatCurrency(totals.lent)],
      ["Entradas manuais", formatCurrency(totals.manualIn)],
      ["Saídas manuais", formatCurrency(totals.manualOut)],
      ["Caixas abertos", String(totals.opened)],
      ["Caixas fechados", String(totals.closed)],
      ["Caixas não abertos", String(totals.notOpened)],
      ["Diferença total de caixa", formatCurrency(totals.totalDiff)],
      ["Solicitações de reabertura pendentes", String(reopenPending)],
      ["Estornos", String(totals.reversals)],
      ["Cancelamentos", String(totals.cancels)],
    ];
    autoTable(doc, {
      startY: cursorY() + 4,
      head: [["Indicador", "Valor"]],
      body: resumo,
      styles: { fontSize: 9 },
      headStyles: { fillColor: [59, 130, 246] },
      columnStyles: { 1: { halign: "right" } },
      margin: { top: HEADER_BOTTOM, left: 14, right: 14, bottom: 22 },
      didDrawPage: () => drawHeader(),
    });

    // Bloco 2: Ranking por valor recebido
    writeBlockTitle("2. Ranking por Valor Recebido");
    autoTable(doc, {
      startY: cursorY() + 4,
      head: [["#", "Trabalhador", "Recebido", "Emprestado", "Caixa"]],
      body: rows.map((r, i) => [
        String(i + 1),
        r.nome,
        formatCurrency(r.received),
        formatCurrency(r.lent),
        r.cashStatus === "closed" ? "Fechado" : r.cashStatus === "open" ? "Aberto" : "Não aberto",
      ]),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [59, 130, 246] },
      columnStyles: { 2: { halign: "right" }, 3: { halign: "right" } },
      margin: { top: HEADER_BOTTOM, left: 14, right: 14, bottom: 22 },
      didDrawPage: () => drawHeader(),
    });

    // Bloco 3: Detalhamento por trabalhador
    writeBlockTitle("3. Detalhamento por Trabalhador");
    autoTable(doc, {
      startY: cursorY() + 4,
      head: [["Trabalhador", "Recebido", "Emprestado", "Ent. Man.", "Saí. Man.", "Diferença", "Est.", "Canc."]],
      body: rows.map((r) => [
        r.nome,
        formatCurrency(r.received),
        formatCurrency(r.lent),
        formatCurrency(r.manualIn),
        formatCurrency(r.manualOut),
        r.diff != null ? formatCurrency(r.diff) : "—",
        String(r.reversals),
        String(r.cancels),
      ]),
      styles: { fontSize: 8 },
      headStyles: { fillColor: [59, 130, 246] },
      columnStyles: {
        1: { halign: "right" }, 2: { halign: "right" },
        3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" },
        6: { halign: "right" }, 7: { halign: "right" },
      },
      margin: { top: HEADER_BOTTOM, left: 14, right: 14, bottom: 22 },
      didDrawPage: () => drawHeader(),
    });

    const filename = `relatorio-equipe-${date}.pdf`;
    return { doc, filename };
  };

  const handleDownload = async () => {
    if (generating) return;
    setGenerating(true);
    try {
      const { doc, filename } = buildPdf();
      doc.save(filename);
      toast.success("PDF gerado");
    } catch (err: any) {
      console.error(err);
      toast.error("Não foi possível gerar o PDF: " + (err?.message || "erro"));
    } finally {
      setGenerating(false);
    }
  };

  if (!isAdmin && !isSuperAdmin) return null;

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            <h2 className="text-base font-semibold">Relatório Diário da Equipe</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {isSuperAdmin && (
              <div>
                <Label className="text-xs">Administrador</Label>
                <select
                  className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
                  value={selectedAdminId || ""}
                  onChange={(e) => setSelectedAdminId(e.target.value || null)}
                >
                  <option value="">Todos</option>
                  {admins.map((a) => <option key={a.id} value={a.id}>{a.nome}</option>)}
                </select>
              </div>
            )}
            <div>
              <Label className="text-xs">Data</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <Stat label="Total recebido" value={formatCurrency(totals.received)} positive />
          <Stat label="Total emprestado" value={formatCurrency(totals.lent)} negative />
          <Stat label="Entradas manuais" value={formatCurrency(totals.manualIn)} positive />
          <Stat label="Saídas manuais" value={formatCurrency(totals.manualOut)} negative />
          <Stat label="Caixas abertos" value={String(totals.opened)} />
          <Stat label="Caixas fechados" value={String(totals.closed)} />
          <Stat label="Caixas não abertos" value={String(totals.notOpened)} />
          <Stat label="Diferença total" value={formatCurrency(totals.totalDiff)} positive={totals.totalDiff >= 0} negative={totals.totalDiff < 0} />
          <Stat label="Reaberturas pendentes" value={String(reopenPending)} />
          <Stat label="Estornos" value={String(totals.reversals)} />
          <Stat label="Cancelamentos" value={String(totals.cancels)} />
        </CardContent>
      </Card>

      <Button onClick={handleDownload} disabled={loading || generating || rows.length === 0} className="w-full">
        {generating
          ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Gerando…</>
          : <><Download className="mr-2 h-4 w-4" /> Baixar PDF da Equipe</>}
      </Button>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-10"><Loader2 className="h-5 w-5 animate-spin" /></div>
          ) : rows.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-10">Nenhum trabalhador no escopo.</p>
          ) : (
            <div className="divide-y">
              <div className="px-3 py-2 text-[11px] font-semibold text-muted-foreground uppercase">Ranking por valor recebido</div>
              {rows.map((r, i) => (
                <div key={r.id} className="flex items-center justify-between gap-2 p-3 text-sm">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground tabular-nums w-5">#{i + 1}</span>
                      <span className="font-medium truncate">{r.nome}</span>
                      <Badge variant={r.cashStatus === "closed" ? "secondary" : r.cashStatus === "open" ? "default" : "outline"} className="text-[10px] h-4">
                        {r.cashStatus === "closed" ? "Fechado" : r.cashStatus === "open" ? "Aberto" : "Não aberto"}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      Emprestado {formatCurrency(r.lent)}
                      {r.diff != null ? ` · Dif. ${formatCurrency(r.diff)}` : ""}
                      {r.reversals > 0 ? ` · ${r.reversals} estorno(s)` : ""}
                      {r.cancels > 0 ? ` · ${r.cancels} cancel.` : ""}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-success text-xs font-semibold">+ {formatCurrency(r.received)}</p>
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
