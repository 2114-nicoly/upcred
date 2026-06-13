import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useWorkerFilter } from "@/hooks/useWorkerFilter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Loader2, Eye, MapPin, Wallet, Users, Landmark, BarChart3,
  ClipboardList, History, UserCog, ChevronRight, Archive, ArchiveRestore, Trash2, Power,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { useConfirm } from "@/hooks/useConfirm";
import { formatCurrency } from "@/lib/loan-utils";
import {
  PeriodMode, getPeriodRange, loadWorkersStats, WorkerStats, consolidate,
} from "@/lib/consolidated-stats";
import AuditLogList from "@/components/AuditLogList";
import AccessSection from "@/components/AccessSection";
import { CredentialsDialog, GeneratedCreds } from "@/components/CredentialsDialog";
import { KeyRound } from "lucide-react";
import { format } from "date-fns";

type Admin = {
  id: string; nome: string; email_real: string; login_codigo: string | null;
  active: boolean; created_at: string; notas: string | null;
};
type Worker = { id: string; nome: string; login_codigo: string; active: boolean; parent_admin_id?: string | null; archived_at?: string | null };
type ClientRow = { id: string; name: string; phone: string | null; client_code: number | null; worker_id: string | null };
type LoanRow = {
  id: string; status: string; amount: number; total_amount: number;
  remaining_balance: number; loan_date: string; worker_id: string | null;
  clients: { name: string } | null;
};
type EventRow = {
  id: string; cash_date: string; event_type: string; worker_id: string | null;
  amount_in: number; amount_out: number; observation: string | null;
  clients: { name: string } | null;
};

export default function AdminFullPanel({ adminId }: { adminId: string }) {
  const navigate = useNavigate();
  const { isSuperAdmin } = useAuth();
  const { setSelectedAdminId, setSelectedWorkerId } = useWorkerFilter();
  const confirm = useConfirm();

  const [admin, setAdmin] = useState<Admin | null>(null);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [stats, setStats] = useState<WorkerStats[]>([]);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loans, setLoans] = useState<LoanRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [mode, setMode] = useState<PeriodMode>("day");
  const [tab, setTab] = useState("resumo");
  const [loading, setLoading] = useState(true);

  const range = useMemo(() => getPeriodRange(mode), [mode]);

  async function load(signal?: { cancel: boolean }) {
    setLoading(true);
    const [{ data: admins }, { data: ws }] = await Promise.all([
      supabase.rpc("super_admin_list_admins" as any),
      supabase.rpc("list_workers_by_admin" as any, { p_admin_id: adminId, p_include_archived: true }),
    ]);
    if (signal?.cancel) return;
    const ad = ((admins as Admin[]) || []).find((a) => a.id === adminId) ?? null;
    const wList = (ws as Worker[]) || [];
    setAdmin(ad);
    setWorkers(wList);

    const wIds = wList.map((w) => w.id);
    const [allStats, cs, ls, evs] = await Promise.all([
      loadWorkersStats(range),
      supabase.from("clients").select("id, name, phone, client_code, worker_id").eq("admin_id", adminId).order("name"),
      supabase.from("loans").select("id, status, amount, total_amount, remaining_balance, loan_date, worker_id, clients(name)").eq("admin_id", adminId).order("loan_date", { ascending: false }).limit(300),
      supabase.from("daily_events" as any).select("id, cash_date, event_type, worker_id, amount_in, amount_out, observation, clients(name)").eq("admin_id", adminId).gte("cash_date", range.startDate).lte("cash_date", range.endDate).order("cash_date", { ascending: false }).limit(300),
    ]);
    if (signal?.cancel) return;

    const wSet = new Set(wIds);
    setStats(allStats.filter((s) => s.worker_id && wSet.has(s.worker_id)));
    setClients((cs.data as ClientRow[]) || []);
    setLoans((ls.data as any) || []);
    setEvents((evs.data as any) || []);
    setLoading(false);
  }

  useEffect(() => {
    const signal = { cancel: false };
    load(signal);
    return () => { signal.cancel = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminId, range]);

  async function handleToggleActive(w: Worker, e: React.MouseEvent) {
    e.stopPropagation();
    const desativando = w.active;
    const ok = await confirm({
      title: desativando ? "Desativar trabalhador?" : "Ativar trabalhador?",
      description: desativando ? "O trabalhador perderá acesso. Histórico preservado." : "O trabalhador voltará a acessar o sistema.",
      affected: [{ label: "Trabalhador", value: w.nome }],
      confirmText: desativando ? "Desativar" : "Ativar", destructive: desativando,
    });
    if (!ok) return;
    const { error } = await supabase.rpc("set_worker_active" as any, { p_worker_id: w.id, p_active: !w.active });
    if (error) return toast({ title: "Erro", description: error.message, variant: "destructive" });
    toast({ title: w.active ? "Desativado" : "Ativado" });
    load();
  }

  async function handleArchive(w: Worker, e: React.MouseEvent) {
    e.stopPropagation();
    if (w.active) return toast({ title: "Desative o trabalhador antes de arquivar", variant: "destructive" });
    const ok = await confirm({
      title: "Arquivar trabalhador?",
      description: "Sai da operação ativa. Histórico preservado. Pode desarquivar depois.",
      affected: [{ label: "Trabalhador", value: w.nome }],
      confirmText: "Arquivar", destructive: true,
    });
    if (!ok) return;
    const { error } = await supabase.rpc("archive_worker" as any, { p_worker_id: w.id });
    if (error) return toast({ title: "Erro", description: error.message, variant: "destructive" });
    toast({ title: "Trabalhador arquivado" }); load();
  }

  async function handleUnarchive(w: Worker, e: React.MouseEvent) {
    e.stopPropagation();
    const { error } = await supabase.rpc("unarchive_worker" as any, { p_worker_id: w.id });
    if (error) return toast({ title: "Erro", description: error.message, variant: "destructive" });
    toast({ title: "Trabalhador desarquivado" }); load();
  }

  async function handleDeleteForever(w: Worker, e: React.MouseEvent) {
    e.stopPropagation();
    const ok = await confirm({
      title: "Excluir definitivamente?",
      description: "Ação irreversível. Só funciona se o trabalhador não tiver clientes, empréstimos ou movimentações.",
      affected: [{ label: "Trabalhador", value: w.nome }],
      confirmText: "Excluir definitivamente", destructive: true,
    });
    if (!ok) return;
    const { error } = await supabase.rpc("delete_worker_if_empty" as any, { p_worker_id: w.id });
    if (error) return toast({ title: "Não foi possível excluir", description: error.message, variant: "destructive" });
    toast({ title: "Trabalhador excluído" }); load();
  }

  function viewAsAdmin(target = "/admin") {
    if (!admin) return;
    const ok = window.confirm(
      `Você passará a operar dentro do escopo do administrador ${admin.nome}.\n\nTodos os dados e ações serão filtrados por esta equipe. Continuar?`
    );
    if (!ok) return;
    setSelectedAdminId(adminId);
    setSelectedWorkerId(null);
    navigate(target);
  }

  function openWorker(workerId: string) {
    if (isSuperAdmin) navigate(`/super-admin/worker/${workerId}`);
    else navigate(`/admin/worker/${workerId}`);
  }

  if (loading) return <div className="flex h-64 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (!admin) return <div className="p-4 text-sm text-muted-foreground">Administrador não encontrado.</div>;

  const total = consolidate(stats);
  const activeLoans = loans.filter((l) => l.status !== "paid" && l.status !== "cancelled" && l.status !== "renegotiated" && Number(l.remaining_balance) > 0.01);
  const closedLoans = loans.filter((l) => l.status === "paid" || Number(l.remaining_balance) <= 0.01);
  const workerName = (id: string | null) => workers.find((w) => w.id === id)?.nome ?? "—";

  return (
    <div className="p-3 max-w-3xl mx-auto pb-24 space-y-3">
      {/* Header */}
      <Card>
        <CardContent className="p-3 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-lg font-bold truncate">{admin.nome}</h1>
                {admin.active
                  ? <Badge className="text-[10px]">Ativo</Badge>
                  : <Badge variant="secondary" className="text-[10px]">Inativo</Badge>}
              </div>
              <p className="text-xs text-muted-foreground">
                {admin.email_real}
                {admin.login_codigo && <> · Login <span className="font-mono">{admin.login_codigo}</span></>}
                {admin.created_at && <> · Criado {format(new Date(admin.created_at), "dd/MM/yyyy")}</>}
              </p>
              <p className="text-xs mt-1 flex items-center gap-1 text-muted-foreground">
                <Users className="h-3 w-3" />
                {workers.length} trabalhadores · {workers.filter((w) => w.active).length} ativos
              </p>
            </div>
            <Button size="sm" onClick={() => viewAsAdmin("/admin")}>
              <Eye className="h-4 w-4 mr-1" /> Ver como
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
        <TabsList className="grid grid-cols-6 w-full h-auto">
          <TabsTrigger value="resumo" className="text-[11px] py-1.5">Resumo</TabsTrigger>
          <TabsTrigger value="trabalhadores" className="text-[11px] py-1.5">Equipe</TabsTrigger>
          <TabsTrigger value="clientes" className="text-[11px] py-1.5">Client.</TabsTrigger>
          <TabsTrigger value="emprestimos" className="text-[11px] py-1.5">Empr.</TabsTrigger>
          <TabsTrigger value="historico" className="text-[11px] py-1.5">Hist.</TabsTrigger>
          <TabsTrigger value="auditoria" className="text-[11px] py-1.5">Audit.</TabsTrigger>
        </TabsList>

        <TabsContent value="resumo" className="space-y-3 mt-3">
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Previsto" value={formatCurrency(total.previsto)} />
            <Stat label="Recebido" value={formatCurrency(total.recebido)} cls="text-success" />
            <Stat label="Falta" value={formatCurrency(total.faltaReceber)} cls="text-destructive" />
            <Stat label="%" value={`${total.percentual.toFixed(0)}%`} />
            <Stat label="Emprestado" value={formatCurrency(total.emprestado)} />
            <Stat label="Retirado" value={formatCurrency(total.retirada)} cls="text-destructive" />
            <Stat label="Aporte" value={formatCurrency(total.aporte)} cls="text-success" />
            <Stat label="Saldo" value={formatCurrency(total.saldoLiquido)} cls={total.saldoLiquido >= 0 ? "text-success" : "text-destructive"} />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Clientes" value={String(total.clientesAtivos)} />
            <Stat label="Empr.Ativos" value={String(total.emprestimosAtivos)} />
            <Stat label="Atrasados" value={String(total.atrasados)} cls="text-destructive" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Não pagos" value={String(total.naoPagosCount)} />
            <Stat label="Renovações" value={String(total.renovacoes)} />
            <Stat label="Novos" value={String(total.emprestimosNovos)} />
          </div>

          {isSuperAdmin && (
            <>
              <AccessSection
                targetKind="admin"
                targetId={admin.id}
                loginCodigo={admin.login_codigo}
                nome={admin.nome}
                active={admin.active}
              />
              <AdminPendingPasswordRequests adminId={admin.id} />
            </>
          )}

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Atalhos (escopo deste admin)</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-2 p-3">
              <Shortcut icon={MapPin} label="Rota" onGo={() => viewAsAdmin("/")} />
              <Shortcut icon={Wallet} label="Caixa/Geral" onGo={() => viewAsAdmin("/caixa")} />
              <Shortcut icon={Users} label="Clientes" onGo={() => viewAsAdmin("/clients")} />
              <Shortcut icon={Landmark} label="Empréstimos" onGo={() => viewAsAdmin("/active-loans")} />
              <Shortcut icon={BarChart3} label="Relatórios" onGo={() => viewAsAdmin("/reports")} />
              <Shortcut icon={History} label="Histórico" onGo={() => viewAsAdmin("/daily-cash-history")} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="trabalhadores" className="mt-3 space-y-2">
          <p className="text-[11px] text-muted-foreground">
            {workers.length} trabalhador(es) ·{" "}
            {workers.filter((w) => w.active).length} ativos ·{" "}
            {workers.filter((w) => !w.active && !w.archived_at).length} inativos ·{" "}
            {workers.filter((w) => w.archived_at).length} arquivados
          </p>
          {workers.length === 0 ? (
            <Card><CardContent className="p-4 text-center text-sm text-muted-foreground">Nenhum trabalhador desta equipe.</CardContent></Card>
          ) : (
            workers.map((w) => {
              const s = stats.find((x) => x.worker_id === w.id);
              const isArchived = !!w.archived_at;
              return (
                <Card key={w.id} className={isArchived ? "opacity-70" : ""}>
                  <CardContent className="p-3 space-y-2">
                    <div className="flex items-center gap-2 cursor-pointer" onClick={() => openWorker(w.id)}>
                      <UserCog className="h-4 w-4 text-primary shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate flex items-center gap-1 flex-wrap">
                          {w.nome}
                          {isArchived
                            ? <Badge variant="outline" className="text-[9px]">Arquivado</Badge>
                            : w.active
                              ? <Badge className="text-[9px]">Ativo</Badge>
                              : <Badge variant="secondary" className="text-[9px]">Inativo</Badge>}
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          Login {w.login_codigo} · Recebido {formatCurrency(s?.recebido ?? 0)} · Falta {formatCurrency(s?.faltaReceber ?? 0)}
                        </p>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {!isArchived && (
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={(e) => handleToggleActive(w, e)}>
                          <Power className="h-3.5 w-3.5 mr-1" /> {w.active ? "Desativar" : "Ativar"}
                        </Button>
                      )}
                      {!isArchived && !w.active && (
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={(e) => handleArchive(w, e)}>
                          <Archive className="h-3.5 w-3.5 mr-1" /> Arquivar
                        </Button>
                      )}
                      {isArchived && (
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={(e) => handleUnarchive(w, e)}>
                          <ArchiveRestore className="h-3.5 w-3.5 mr-1" /> Desarquivar
                        </Button>
                      )}
                      {isArchived && (
                        <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={(e) => handleDeleteForever(w, e)}>
                          <Trash2 className="h-3.5 w-3.5 mr-1" /> Excluir
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
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
                        {workerName(c.worker_id)} · {c.phone || "sem telefone"}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="emprestimos" className="mt-3 space-y-3">
          <LoanSection title="Ativos" loans={activeLoans} onClick={(id) => navigate(`/loans/${id}`)} workerName={workerName} />
          <LoanSection title="Quitados / Renovados" loans={closedLoans.slice(0, 50)} onClick={(id) => navigate(`/loans/${id}`)} workerName={workerName} muted />
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
                          {" · "}{workerName(e.worker_id)}
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
              <AuditLogList limit={150} />
              <p className="text-[10px] text-muted-foreground mt-2">
                Use o filtro &quot;Admin&quot; acima para restringir a esta equipe.
              </p>
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
  title, loans, onClick, workerName, muted,
}: {
  title: string; loans: LoanRow[]; onClick: (id: string) => void;
  workerName: (id: string | null) => string; muted?: boolean;
}) {
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
                      {format(new Date(l.loan_date + "T12:00:00"), "dd/MM/yyyy")} · {workerName(l.worker_id)} · {l.status}
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

function AdminPendingPasswordRequests({ adminId }: { adminId: string }) {
  const [requests, setRequests] = useState<any[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creds, setCreds] = useState<GeneratedCreds | null>(null);

  async function load() {
    const { data } = await supabase
      .from("password_recovery_requests")
      .select("*")
      .eq("target_admin_id", adminId)
      .eq("status", "pending")
      .order("requested_at", { ascending: false });
    setRequests((data as any[]) || []);
  }

  useEffect(() => { load(); }, [adminId]);

  async function resolve(r: any) {
    setBusyId(r.id);
    try {
      const { data, error } = await supabase.functions.invoke("admin-reset-password", {
        body: { target_kind: "admin", target_id: adminId },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      const x = data as any;
      await supabase
        .from("password_recovery_requests")
        .update({ status: "resolved", resolved_at: new Date().toISOString() } as any)
        .eq("id", r.id);
      setCreds({ nome: x.nome, role: x.role, login: x.login, password: x.password, created_at: x.created_at });
      toast({ title: "Senha redefinida" });
      load();
    } catch (e: any) {
      toast({ title: "Erro", description: e?.message || "Falha", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  async function dismiss(r: any) {
    await supabase
      .from("password_recovery_requests")
      .update({ status: "dismissed", resolved_at: new Date().toISOString() } as any)
      .eq("id", r.id);
    load();
  }

  if (requests.length === 0) return null;

  return (
    <>
      <Card className="border-warning">
        <CardHeader className="p-3 pb-1">
          <CardTitle className="text-sm flex items-center gap-2">
            <KeyRound className="h-4 w-4" /> Solicitações de senha pendentes ({requests.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-1 space-y-2">
          {requests.map((r) => (
            <div key={r.id} className="rounded border p-2 space-y-1">
              <p className="text-sm font-medium">{r.nome_informado || "—"}</p>
              <p className="text-[11px] text-muted-foreground">
                {r.login_informado && <>Login: <span className="font-mono">{r.login_informado}</span> · </>}
                {format(new Date(r.requested_at), "dd/MM/yyyy HH:mm")}
              </p>
              <div className="flex gap-1">
                <Button size="sm" className="flex-1 h-7 text-xs" disabled={busyId === r.id} onClick={() => resolve(r)}>
                  {busyId === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Resolver: gerar nova senha"}
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => dismiss(r)}>
                  Dispensar
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
      <CredentialsDialog creds={creds} onClose={() => setCreds(null)} />
    </>
  );
}
