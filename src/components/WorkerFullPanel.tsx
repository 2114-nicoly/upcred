import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useWorkerFilter } from "@/hooks/useWorkerFilter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Loader2, Eye, MapPin, Wallet, Users, Landmark, BarChart3,
  Shield, ClipboardList, History, LockOpen,
} from "lucide-react";
import { formatCurrency } from "@/lib/loan-utils";
import { PeriodMode, getPeriodRange, loadWorkersStats, WorkerStats } from "@/lib/consolidated-stats";
import AuditLogList from "@/components/AuditLogList";
import AccessSection from "@/components/AccessSection";
import { format } from "date-fns";
import { toast } from "sonner";

type Worker = {
  id: string; nome: string; login_codigo: string; active: boolean;
  created_at: string; notas: string | null; parent_admin_id: string | null;
};
type AdminLite = { id: string; nome: string; active: boolean };
type ClientRow = { id: string; name: string; phone: string | null; client_code: number | null };
type LoanRow = {
  id: string; status: string; amount: number; total_amount: number;
  remaining_balance: number; loan_date: string;
  clients: { name: string } | null;
};
type EventRow = {
  id: string; cash_date: string; event_type: string;
  amount_in: number; amount_out: number; observation: string | null;
  clients: { name: string } | null;
};

export default function WorkerFullPanel({ workerId }: { workerId: string }) {
  const navigate = useNavigate();
  const { isSuperAdmin } = useAuth();
  const { setSelectedWorkerId } = useWorkerFilter();

  const [worker, setWorker] = useState<Worker | null>(null);
  const [admin, setAdmin] = useState<AdminLite | null>(null);
  const [mode, setMode] = useState<PeriodMode>("day");
  const [stats, setStats] = useState<WorkerStats | null>(null);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loans, setLoans] = useState<LoanRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [tab, setTab] = useState("resumo");
  const [loading, setLoading] = useState(true);

  const range = useMemo(() => getPeriodRange(mode), [mode]);

  useEffect(() => {
    let cancel = false;
    async function load() {
      setLoading(true);
      const [{ data: w }, statsList, { data: cs }, { data: ls }, { data: evs }] = await Promise.all([
        supabase.from("workers").select("*").eq("id", workerId).maybeSingle(),
        loadWorkersStats(range),
        supabase.from("clients").select("id, name, phone, client_code").eq("worker_id", workerId).order("name"),
        supabase.from("loans").select("id, status, amount, total_amount, remaining_balance, loan_date, clients(name)").eq("worker_id", workerId).order("loan_date", { ascending: false }).limit(200),
        supabase.from("daily_events" as any).select("id, cash_date, event_type, amount_in, amount_out, observation, clients(name)").eq("worker_id", workerId).gte("cash_date", range.startDate).lte("cash_date", range.endDate).order("cash_date", { ascending: false }).limit(200),
      ]);
      if (cancel) return;
      const wRow = w as Worker | null;
      setWorker(wRow);
      setStats(statsList.find((s) => s.worker_id === workerId) ?? null);
      setClients((cs as ClientRow[]) || []);
      setLoans((ls as any) || []);
      setEvents((evs as any) || []);

      if (wRow?.parent_admin_id && isSuperAdmin) {
        const { data: ad } = await supabase.rpc("super_admin_list_admins" as any);
        setAdmin(((ad as AdminLite[]) || []).find((a) => a.id === wRow.parent_admin_id) ?? null);
      } else if (wRow?.parent_admin_id) {
        const { data: ad } = await supabase.from("admins" as any).select("id, nome, active").eq("id", wRow.parent_admin_id).maybeSingle();
        setAdmin((ad as any) ?? null);
      }
      setLoading(false);
    }
    load();
    return () => { cancel = true; };
  }, [workerId, range, isSuperAdmin]);

  function viewAsWorker(target: string = "/") {
    if (!worker) return;
    const ok = window.confirm(
      `Você passará a registrar ações em nome de ${worker.nome}.\n\nQualquer pagamento, empréstimo ou movimento será atribuído a este trabalhador. Continuar?`
    );
    if (!ok) return;
    setSelectedWorkerId(worker.id);
    navigate(target);
  }

  if (loading) return <div className="flex h-64 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (!worker) return <div className="p-4 text-sm text-muted-foreground">Trabalhador não encontrado.</div>;

  const activeLoans = loans.filter((l) => l.status !== "paid" && Number(l.remaining_balance) > 0.01);
  const closedLoans = loans.filter((l) => l.status === "paid" || Number(l.remaining_balance) <= 0.01);

  return (
    <div className="p-3 max-w-3xl mx-auto pb-24 space-y-3">
      {/* Header */}
      <Card>
        <CardContent className="p-3 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-lg font-bold truncate">{worker.nome}</h1>
                {worker.active
                  ? <Badge className="text-[10px]">Ativo</Badge>
                  : <Badge variant="secondary" className="text-[10px]">Inativo</Badge>}
              </div>
              <p className="text-xs text-muted-foreground">
                Login <span className="font-mono">{worker.login_codigo}</span> · Criado {format(new Date(worker.created_at), "dd/MM/yyyy")}
              </p>
              {admin && (
                <p className="text-xs mt-1 flex items-center gap-1 text-muted-foreground">
                  <Shield className="h-3 w-3" />
                  Administrador responsável: <strong className="text-foreground">{admin.nome}</strong>
                  {!admin.active && <span className="text-destructive">(inativo)</span>}
                </p>
              )}
            </div>
            <Button size="sm" onClick={() => viewAsWorker("/")}>
              <Eye className="h-4 w-4 mr-1" /> Atuar como
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Period */}
      <Tabs value={mode} onValueChange={(v) => setMode(v as PeriodMode)}>
        <TabsList className="grid grid-cols-3 w-full">
          <TabsTrigger value="day" className="text-xs">Dia</TabsTrigger>
          <TabsTrigger value="week" className="text-xs">Semana</TabsTrigger>
          <TabsTrigger value="month" className="text-xs">Mês</TabsTrigger>
        </TabsList>
      </Tabs>
      <p className="text-[11px] text-muted-foreground -mt-1">{range.label}</p>

      {/* Main tabs */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid grid-cols-5 w-full h-auto">
          <TabsTrigger value="resumo" className="text-[11px] py-1.5">Resumo</TabsTrigger>
          <TabsTrigger value="clientes" className="text-[11px] py-1.5">Clientes</TabsTrigger>
          <TabsTrigger value="emprestimos" className="text-[11px] py-1.5">Empr.</TabsTrigger>
          <TabsTrigger value="historico" className="text-[11px] py-1.5">Hist.</TabsTrigger>
          <TabsTrigger value="auditoria" className="text-[11px] py-1.5">Audit.</TabsTrigger>
        </TabsList>

        <TabsContent value="resumo" className="space-y-3 mt-3">
          {stats ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <Stat label="Previsto" value={formatCurrency(stats.previsto)} />
                <Stat label="Recebido" value={formatCurrency(stats.recebido)} cls="text-success" />
                <Stat label="Falta" value={formatCurrency(stats.faltaReceber)} cls="text-destructive" />
                <Stat label="%" value={`${stats.percentual.toFixed(0)}%`} />
                <Stat label="Emprestado" value={formatCurrency(stats.emprestado)} />
                <Stat label="Retirado" value={formatCurrency(stats.retirada)} cls="text-destructive" />
                <Stat label="Aporte" value={formatCurrency(stats.aporte)} cls="text-success" />
                <Stat label="Saldo" value={formatCurrency(stats.saldoLiquido)} cls={stats.saldoLiquido >= 0 ? "text-success" : "text-destructive"} />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Clientes" value={String(stats.clientesAtivos)} />
                <Stat label="Empr.Ativos" value={String(stats.emprestimosAtivos)} />
                <Stat label="Atrasados" value={String(stats.atrasados)} cls="text-destructive" />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Não pagos" value={String(stats.naoPagosCount)} />
                <Stat label="Renovações" value={String(stats.renovacoes)} />
                <Stat label="Novos" value={String(stats.emprestimosNovos)} />
              </div>
            </>
          ) : (
            <Card><CardContent className="p-4 text-center text-sm text-muted-foreground">Sem dados no período.</CardContent></Card>
          )}

          <AccessSection
            targetKind="worker"
            targetId={worker.id}
            loginCodigo={worker.login_codigo}
            nome={worker.nome}
            active={worker.active}
          />

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Atalhos (filtrados por este trabalhador)</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-2 p-3">
              <Shortcut icon={MapPin} label="Rota" onGo={() => viewAsWorker("/")} />
              <Shortcut icon={Wallet} label="Caixa/Geral" onGo={() => viewAsWorker("/caixa")} />
              <Shortcut icon={Users} label="Clientes" onGo={() => viewAsWorker("/clients")} />
              <Shortcut icon={Landmark} label="Empréstimos" onGo={() => viewAsWorker("/active-loans")} />
              <Shortcut icon={BarChart3} label="Relatórios" onGo={() => viewAsWorker("/reports")} />
              <Shortcut icon={History} label="Histórico" onGo={() => viewAsWorker("/daily-cash-history")} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="clientes" className="mt-3">
          {clients.length === 0 ? (
            <Card><CardContent className="p-4 text-center text-sm text-muted-foreground">Nenhum cliente.</CardContent></Card>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{clients.length} clientes</p>
              {clients.map((c) => (
                <Card key={c.id} className="cursor-pointer hover:bg-muted/30" onClick={() => navigate(`/clients/${c.id}`)}>
                  <CardContent className="p-3 flex items-center justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{c.name}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {c.client_code != null && <>#{c.client_code} · </>}
                        {c.phone || "sem telefone"}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="emprestimos" className="mt-3 space-y-3">
          <LoanSection title="Ativos" loans={activeLoans} onClick={(id) => navigate(`/loans/${id}`)} />
          <LoanSection title="Quitados / Renovados" loans={closedLoans.slice(0, 50)} onClick={(id) => navigate(`/loans/${id}`)} muted />
        </TabsContent>

        <TabsContent value="historico" className="mt-3">
          {events.length === 0 ? (
            <Card><CardContent className="p-4 text-center text-sm text-muted-foreground">Sem eventos no período.</CardContent></Card>
          ) : (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{events.length} eventos</p>
              {events.map((e) => {
                const inV = Number(e.amount_in || 0);
                const outV = Number(e.amount_out || 0);
                return (
                  <Card key={e.id}>
                    <CardContent className="p-2 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs font-medium">
                          <Badge variant="outline" className="text-[9px] mr-1">{e.event_type}</Badge>
                          {e.clients?.name ?? ""}
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          {format(new Date(e.cash_date + "T12:00:00"), "dd/MM/yyyy")}
                          {e.observation && <> · {e.observation}</>}
                        </p>
                      </div>
                      <div className="text-right text-xs whitespace-nowrap">
                        {inV > 0 && <p className="text-success font-semibold">+{formatCurrency(inV)}</p>}
                        {outV > 0 && <p className="text-destructive font-semibold">-{formatCurrency(outV)}</p>}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="auditoria" className="mt-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-1"><ClipboardList className="h-4 w-4" /> Histórico de ações</CardTitle>
            </CardHeader>
            <CardContent className="p-3">
              <AuditLogList workerId={worker.id} limit={100} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <Card><CardContent className="p-2">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className={`text-sm font-bold ${cls || ""}`}>{value}</p>
    </CardContent></Card>
  );
}

function Shortcut({ icon: Icon, label, onGo }: { icon: any; label: string; onGo: () => void }) {
  return (
    <button onClick={onGo} className="flex items-center gap-2 border rounded-md p-2 text-sm hover:bg-muted/40 text-left">
      <Icon className="h-4 w-4 text-primary" />
      <span>{label}</span>
    </button>
  );
}

function LoanSection({
  title, loans, onClick, muted,
}: { title: string; loans: LoanRow[]; onClick: (id: string) => void; muted?: boolean }) {
  return (
    <div>
      <p className="text-xs font-semibold mb-1">{title} ({loans.length})</p>
      {loans.length === 0 ? (
        <Card><CardContent className="p-3 text-center text-xs text-muted-foreground">Nenhum.</CardContent></Card>
      ) : (
        <div className="space-y-1">
          {loans.map((l) => {
            const paid = Math.max(0, Number(l.total_amount) - Number(l.remaining_balance));
            return (
              <Card key={l.id} className={`cursor-pointer hover:bg-muted/30 ${muted ? "opacity-80" : ""}`} onClick={() => onClick(l.id)}>
                <CardContent className="p-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{l.clients?.name ?? "—"}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {format(new Date(l.loan_date + "T12:00:00"), "dd/MM/yyyy")} · {l.status}
                    </p>
                  </div>
                  <div className="text-right text-xs whitespace-nowrap">
                    <p className="font-semibold">{formatCurrency(Number(l.remaining_balance))}</p>
                    <p className="text-[10px] text-muted-foreground">pago {formatCurrency(paid)}</p>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
