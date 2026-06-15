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
import { Download, FileText, Loader2 } from "lucide-react";
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
const OUT_TYPES = new Set(["emprestimo_novo", "renovacao", "renegociacao", "saida", "saida_manual"]);

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
          .in("entity_type", ["client", "loan", "installment"]);
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

        // daily_cash status (worker scope)
        if (selectedWorkerId) {
          const { data: dc } = await supabase.from("daily_cash").select("status").eq("cash_date", date).eq("worker_id", selectedWorkerId).maybeSingle();
          setCashStatus((dc as any)?.status || null);
        } else if (isSuperAdmin && selectedAdminId) {
          const { data: dc } = await supabase.from("daily_cash").select("status").eq("cash_date", date).eq("admin_id", selectedAdminId).is("worker_id", null).maybeSingle();
          setCashStatus((dc as any)?.status || null);
        } else {
          setCashStatus(null);
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
      notPaidCount: t.naoPagos,
      balance: t.entradas - t.saidas,
    };
  }, [events]);

  const dateLabel = useMemo(() => format(new Date(date + "T12:00:00"), "dd 'de' MMMM 'de' yyyy", { locale: ptBR }), [date]);

  const handleDownloadPDF = () => {
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text("UpCred — Relatório Diário", 14, 16);
    doc.setFontSize(11);
    doc.text(`Trabalhador: ${workerName || "—"}`, 14, 24);
    doc.text(`Data: ${dateLabel}`, 14, 30);
    if (cashStatus) doc.text(`Status do caixa: ${cashStatus === "closed" ? "Fechado" : "Aberto"}`, 14, 36);

    autoTable(doc, {
      startY: cashStatus ? 42 : 36,
      head: [["Hora", "Tipo", "Cliente", "Entrada", "Saída", "Obs.", "Status"]],
      body: rows.map((r) => [
        r.time,
        r.typeLabel,
        r.clientName,
        r.amountIn ? formatCurrency(r.amountIn) : "—",
        r.amountOut ? formatCurrency(r.amountOut) : "—",
        r.observation,
        r.reversed ? "Estornado" : "Normal",
      ]),
      styles: { fontSize: 8 },
      headStyles: { fillColor: [59, 130, 246] },
    });

    const finalY = (doc as any).lastAutoTable.finalY || 60;
    doc.setFontSize(12);
    doc.text("Resumo do dia", 14, finalY + 10);
    doc.setFontSize(10);
    const summary: [string, string][] = [
      ["Total de entradas", formatCurrency(totals.totalIn)],
      ["Total de saídas", formatCurrency(totals.totalOut)],
      ["Pagamentos recebidos", formatCurrency(totals.payments)],
      ["Empréstimos liberados", formatCurrency(totals.loans)],
      ["Renovações", formatCurrency(totals.renewals)],
      ["Multas recebidas", formatCurrency(totals.penalties)],
      ["Não pagou", String(totals.notPaidCount)],
      ["Saldo do dia", formatCurrency(totals.balance)],
    ];
    autoTable(doc, {
      startY: finalY + 14,
      body: summary,
      styles: { fontSize: 9 },
      theme: "plain",
    });

    doc.save(`relatorio-${workerName || "trabalhador"}-${date}.pdf`);
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
          <Stat label="Entradas" value={formatCurrency(totals.totalIn)} positive />
          <Stat label="Saídas" value={formatCurrency(totals.totalOut)} negative />
          <Stat label="Pagamentos" value={formatCurrency(totals.payments)} />
          <Stat label="Empréstimos" value={formatCurrency(totals.loans)} />
          <Stat label="Renovações" value={formatCurrency(totals.renewals)} />
          <Stat label="Multas recebidas" value={formatCurrency(totals.penalties)} />
          <Stat label="Não pagou" value={String(totals.notPaidCount)} />
          <Stat label="Saldo do dia" value={formatCurrency(totals.balance)} positive={totals.balance >= 0} negative={totals.balance < 0} />
        </CardContent>
      </Card>

      <Button onClick={handleDownloadPDF} disabled={loading || rows.length === 0} className="w-full">
        <Download className="mr-2 h-4 w-4" /> Baixar PDF
      </Button>

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
