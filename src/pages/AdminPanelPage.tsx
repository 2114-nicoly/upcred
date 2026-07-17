import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/hooks/use-toast";
import { useConfirm } from "@/hooks/useConfirm";
import { EmptyState } from "@/components/LoadingSkeleton";
import { Loader2, Plus, Copy, KeyRound, RefreshCw, Inbox, ChevronRight,
  TrendingUp, AlertTriangle, Target, ExternalLink, Wallet, CalendarDays, History } from "lucide-react";

import { generateLoginCodigo, generateTempPassword, syntheticEmailFor } from "@/lib/worker-utils";
import { useAuth } from "@/hooks/useAuth";
import { formatCurrency } from "@/lib/loan-utils";
import {
  PeriodMode, getPeriodRange, loadWorkersStats, consolidate, WorkerStats,
} from "@/lib/consolidated-stats";

import { logAction, requireAudit, getCurrentActorIdentity, AuditRequiredError } from "@/lib/audit-utils";
import AuditLogList from "@/components/AuditLogList";
import ReportsPage from "@/pages/ReportsPage";
import RemindersAdminList from "@/components/RemindersAdminList";


type Worker = {
  id: string;
  nome: string;
  login_codigo: string;
  synthetic_email: string;
  active: boolean;
  notas: string | null;
  created_at: string;
  auth_user_id: string | null;
};

type CredsToShow = { nome: string; login: string; password: string };

export default function AdminPanelPage() {
  const navigate = useNavigate();
  const { isAdmin, loading: authLoading } = useAuth();

  useEffect(() => {
    if (!authLoading && !isAdmin) navigate("/");
  }, [authLoading, isAdmin, navigate]);

  if (authLoading) return <div className="flex h-64 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (!isAdmin) return null;

  return (
    <div className="p-3 max-w-3xl mx-auto pb-24">
      <h1 className="text-xl font-bold mb-3">Painel Administrador</h1>
      <Tabs defaultValue="painel">
        <TabsList className="grid grid-cols-5 w-full">
          <TabsTrigger value="painel" className="text-[10px]">Painel</TabsTrigger>
          <TabsTrigger value="equipe" className="text-[10px]">Equipe</TabsTrigger>
          <TabsTrigger value="reports" className="text-[10px]">Relatórios</TabsTrigger>
          <TabsTrigger value="caixa" className="text-[10px]">Caixa</TabsTrigger>
          <TabsTrigger value="audit" className="text-[10px]">Auditoria</TabsTrigger>
        </TabsList>

        <TabsContent value="painel" className="mt-3">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="equipe" className="mt-3">
          <WorkersTab />
        </TabsContent>
        <TabsContent value="reports" className="mt-3">
          <ReportsPage />
        </TabsContent>
        <TabsContent value="caixa" className="mt-3">
          <CaixaTab />
        </TabsContent>
        <TabsContent value="audit" className="mt-3 space-y-3">
          <RemindersAdminList />
          <AuditLogList />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ============= CAIXA TAB ============= */
function CaixaTab() {
  const navigate = useNavigate();
  const items: { label: string; path: string; icon: any }[] = [
    { label: "Caixa do dia", path: "/caixa", icon: Wallet },
    { label: "Histórico do Caixa (aberturas, fechamentos, diferenças)", path: "/daily-cash-history", icon: CalendarDays },
    { label: "Histórico de movimentações", path: "/cash-history", icon: History },
  ];
  return (
    <div className="space-y-2">
      {items.map((it) => (
        <Button key={it.path} variant="outline" size="sm" className="w-full justify-between" onClick={() => navigate(it.path)}>
          <span className="flex items-center gap-2"><it.icon className="h-4 w-4" /> {it.label}</span>
          <ExternalLink className="h-3.5 w-3.5" />
        </Button>
      ))}
    </div>
  );
}



/* ============= OVERVIEW TAB ============= */
function OverviewTab() {
  const [mode, setMode] = useState<PeriodMode>("day");
  const [customStart, setCustomStart] = useState(new Date().toISOString().slice(0, 10));
  const [customEnd, setCustomEnd] = useState(new Date().toISOString().slice(0, 10));
  const [stats, setStats] = useState<WorkerStats | null>(null);
  const [activeWorkers, setActiveWorkers] = useState(0);
  const [loading, setLoading] = useState(true);

  const range = useMemo(() => getPeriodRange(mode, customStart, customEnd), [mode, customStart, customEnd]);

  useEffect(() => {
    let cancel = false;
    async function load() {
      setLoading(true);
      const [list, { count }] = await Promise.all([
        loadWorkersStats(range),
        supabase.from("workers").select("id", { count: "exact", head: true }).eq("active", true),
      ]);
      if (cancel) return;
      setStats(consolidate(list));
      setActiveWorkers(count || 0);
      setLoading(false);
    }
    load();
    return () => { cancel = true; };
  }, [range]);

  return (
    <div>
      <Tabs value={mode} onValueChange={(v) => setMode(v as PeriodMode)} className="mb-3">
        <TabsList className="grid grid-cols-4 w-full">
          <TabsTrigger value="day" className="text-xs">Dia</TabsTrigger>
          <TabsTrigger value="week" className="text-xs">Semana</TabsTrigger>
          <TabsTrigger value="month" className="text-xs">Mês</TabsTrigger>
          <TabsTrigger value="custom" className="text-xs">Período</TabsTrigger>
        </TabsList>
      </Tabs>

      {mode === "custom" && (
        <Card className="mb-3"><CardContent className="p-2 grid grid-cols-2 gap-2">
          <div><Label className="text-[10px]">Início</Label><Input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} className="h-8 text-xs" /></div>
          <div><Label className="text-[10px]">Fim</Label><Input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} className="h-8 text-xs" /></div>
        </CardContent></Card>
      )}

      <p className="text-xs text-muted-foreground mb-2">{range.label} · Visão consolidada</p>

      {loading || !stats ? (
        <div className="flex justify-center p-6"><Loader2 className="h-5 w-5 animate-spin" /></div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 mb-3">
            <Kpi icon={<Target className="h-4 w-4 text-primary" />} label="Previsto" value={formatCurrency(stats.previsto)} />
            <Kpi icon={<TrendingUp className="h-4 w-4 text-success" />} label="Recebido" value={formatCurrency(stats.recebido)} valueClass="text-success" />
            <Kpi icon={<AlertTriangle className="h-4 w-4 text-destructive" />} label="Falta receber" value={formatCurrency(stats.faltaReceber)} valueClass="text-destructive" />
            <Kpi icon={<TrendingUp className="h-4 w-4 text-primary" />} label="% Recebido" value={`${stats.percentual.toFixed(1)}%`} />
          </div>

          <div className="grid grid-cols-4 gap-2">
            <MiniStat label="Clientes" value={stats.clientesAtivos} />
            <MiniStat label="Empr. ativos" value={stats.emprestimosAtivos} />
            <MiniStat label="Atrasados" value={stats.atrasados} valueClass="text-destructive" />
            <MiniStat label="Trab. ativos" value={activeWorkers} />
          </div>
        </>
      )}
    </div>
  );
}

function Kpi({ icon, label, value, valueClass }: { icon: React.ReactNode; label: string; value: string; valueClass?: string }) {
  return (
    <Card><CardContent className="p-2.5">
      <div className="flex items-center gap-1.5 mb-0.5">{icon}<p className="text-[11px] text-muted-foreground">{label}</p></div>
      <p className={`text-sm font-bold ${valueClass || ""}`}>{value}</p>
    </CardContent></Card>
  );
}
function MiniStat({ label, value, valueClass }: { label: string; value: number; valueClass?: string }) {
  return (
    <Card><CardContent className="p-2 text-center">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className={`text-base font-bold ${valueClass || ""}`}>{value}</p>
    </CardContent></Card>
  );
}



/* ============= WORKERS TAB ============= */
type WorkerRow = Worker & { archived_at?: string | null };

function WorkersTab() {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { isSuperAdmin } = useAuth();
  const [workers, setWorkers] = useState<WorkerRow[]>([]);
  // resetRequests removed: handled by PasswordRecoveryBell in header
  const [stats, setStats] = useState<Record<string, WorkerStats>>({});
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [openCreate, setOpenCreate] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [nome, setNome] = useState("");
  const [notas, setNotas] = useState("");
  const [creds, setCreds] = useState<CredsToShow | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<WorkerRow | null>(null);
  const [archiveCascade, setArchiveCascade] = useState(false);
  const [archiveWorking, setArchiveWorking] = useState(false);
  const [archiveAckTarget, setArchiveAckTarget] = useState<WorkerRow | null>(null);


  // Edição de trabalhador
  const [editing, setEditing] = useState<WorkerRow | null>(null);
  const [editNome, setEditNome] = useState("");
  const [editLogin, setEditLogin] = useState("");
  const [editNotas, setEditNotas] = useState("");
  const [editActive, setEditActive] = useState(true);
  const [savingEdit, setSavingEdit] = useState(false);

  function openEdit(w: WorkerRow) {
    setEditing(w);
    setEditNome(w.nome);
    setEditLogin(w.login_codigo);
    setEditNotas(w.notas ?? "");
    setEditActive(w.active);
  }

  async function handleSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const n = editNome.trim();
    const login = editLogin.trim();
    if (!n) return toast({ title: "Nome obrigatório", variant: "destructive" });
    if (!/^\d{4}$/.test(login)) return toast({ title: "Login deve ter 4 dígitos", variant: "destructive" });
    setSavingEdit(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-edit-worker", {
        body: { worker_id: editing.id, nome: n, login_codigo: login, notas: editNotas.trim() || null, active: editActive },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error || "Falha ao salvar");
      toast({ title: "Trabalhador atualizado" });
      setEditing(null);
      load();
    } catch (err: any) {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    } finally {
      setSavingEdit(false);
    }
  }

  async function load() {
    setLoading(true);
    const today = new Date().toISOString().slice(0, 10);
    const range = getPeriodRange("day", today, today);
    const [{ data: w }, statsList] = await Promise.all([
      supabase.rpc("admin_list_workers" as any, { p_include_archived: showArchived }),
      loadWorkersStats(range),
    ]);
    setWorkers((w as any) || []);
    const map: Record<string, WorkerStats> = {};
    statsList.forEach((s) => { if (s.worker_id) map[s.worker_id] = s; });
    setStats(map);
    setLoading(false);
  }

  useEffect(() => { load(); }, [showArchived]);

  async function handleUnarchive(w: WorkerRow) {
    if (!isSuperAdmin) { toast({ title: "Apenas o Super Administrador pode desarquivar", variant: "destructive" }); return; }
    const cascade = window.confirm(
      `Desarquivar "${w.nome}"?\n\nOK = Desarquivar trabalhador e restaurar todos os seus clientes.\nCancelar = apenas o trabalhador.`,
    );
    // If user cancels the browser confirm we still ask a final confirmation via useConfirm
    const proceed = await confirm({
      title: "Desarquivar trabalhador?",
      description: cascade
        ? "Trabalhador e todos os seus clientes voltarão a aparecer nas listas ativas."
        : "Somente o trabalhador voltará a aparecer nas listas ativas.",
      affected: [{ label: "Trabalhador", value: w.nome }],
      confirmText: "Desarquivar",
    });
    if (!proceed) return;
    const { error } = await supabase.rpc("unarchive_worker" as any, { p_worker_id: w.id, p_cascade: cascade });
    if (error) { toast({ title: "Erro", description: error.message, variant: "destructive" }); return; }
    toast({ title: "Desarquivado" });
    load();
  }

  function openArchiveDialog(w: WorkerRow) {
    if (isSuperAdmin) {
      setArchiveTarget(w);
      setArchiveCascade(false);
    } else {
      // Administrador comum: exigir aviso de responsabilidade antes
      setArchiveAckTarget(w);
    }
  }

  function acknowledgeArchiveWarning() {
    if (!archiveAckTarget) return;
    const w = archiveAckTarget;
    setArchiveAckTarget(null);
    setArchiveTarget(w);
    setArchiveCascade(false);
  }


  async function confirmArchive() {
    if (!archiveTarget) return;
    setArchiveWorking(true);
    try {
      const { data, error } = await supabase.rpc("archive_worker" as any, {
        p_worker_id: archiveTarget.id, p_cascade: archiveCascade,
      });
      if (error) throw error;
      const clientsArchived = (data as any)?.clients_archived ?? 0;
      toast({
        title: "Trabalhador arquivado",
        description: archiveCascade
          ? `${clientsArchived} cliente(s) também foram arquivados.`
          : "Clientes vinculados permanecem ativos.",
      });
      setArchiveTarget(null);
      load();
    } catch (err: any) {
      toast({ title: "Erro ao arquivar", description: err.message, variant: "destructive" });
    } finally {
      setArchiveWorking(false);
    }
  }


  async function pickUniqueLogin(): Promise<string> {
    for (let i = 0; i < 20; i++) {
      const code = generateLoginCodigo();
      const { data } = await supabase.from("workers").select("id").eq("login_codigo", code).maybeSingle();
      if (!data) return code;
    }
    throw new Error("Não foi possível gerar um login único.");
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!nome.trim()) { toast({ title: "Nome obrigatório", variant: "destructive" }); return; }
    setCreating(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-create-user", {
        body: { kind: "worker", nome: nome.trim(), notas: notas.trim() || null },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error || "Falha ao criar trabalhador");

      setCreds({ nome: data.nome, login: data.login_codigo, password: data.password });
      setNome(""); setNotas(""); setOpenCreate(false);
      load();
      toast({ title: "Trabalhador criado", description: "Anote o login e a senha temporária." });
    } catch (err: any) {
      toast({ title: "Erro ao criar trabalhador", description: err.message, variant: "destructive" });
    } finally {
      setCreating(false);
    }
  }

  async function handleToggleActive(w: Worker) {
    const desativando = w.active;
    const ok = await confirm({
      title: desativando ? "Desativar trabalhador?" : "Ativar trabalhador?",
      description: desativando ? "O trabalhador perderá acesso ao sistema." : "O trabalhador voltará a poder acessar o sistema.",
      affected: [{ label: "Trabalhador", value: w.nome }, { label: "Login", value: w.login_codigo }],
      confirmText: desativando ? "Desativar" : "Ativar", destructive: desativando,
    });
    if (!ok) return;
    const { error } = await supabase.from("workers").update({ active: !w.active } as any).eq("id", w.id);
    if (error) { toast({ title: "Erro", description: error.message, variant: "destructive" }); return; }
    const actor = await getCurrentActorIdentity();
    await logAction(
      w.active ? "desativar_trabalhador" : "ativar_trabalhador",
      "worker", w.id,
      { name: w.nome, username: w.login_codigo, status: w.active ? "ativo" : "inativo" },
      {
        before: { name: w.nome, username: w.login_codigo, status: w.active ? "ativo" : "inativo" },
        after:  { name: w.nome, username: w.login_codigo, status: w.active ? "inativo" : "ativo" },
        performed_by: actor.id,
        performed_by_name: actor.name,
        performed_by_role: actor.role,
        timestamp: new Date().toISOString(),
      },
    );
    toast({ title: w.active ? "Desativado" : "Ativado" });
    load();
  }


  async function handleResetPassword(w: Worker) {
    const ok = await confirm({
      title: "Resetar senha?",
      description: "Uma nova senha de 8 dígitos será gerada e atualizada no Auth. A senha anterior deixa de funcionar imediatamente.",
      affected: [{ label: "Trabalhador", value: w.nome }, { label: "Login", value: w.login_codigo }],
      confirmText: "Gerar nova senha", destructive: true,
    });
    if (!ok) return;
    try {
      // Auditoria OBRIGATÓRIA — bloqueia o reset se o log falhar.
      const actor = await getCurrentActorIdentity();
      const now = new Date().toISOString();
      try {
        await requireAudit(
          "reset_senha_trabalhador", "worker", w.id,
          { name: w.nome, login: w.login_codigo, status: w.active ? "ativo" : "inativo" },
          {
            name: w.nome, login: w.login_codigo,
            status: w.active ? "ativo" : "inativo",
            target_kind: "worker", target_id: w.id,
            performed_by: actor.id, performed_by_name: actor.name, performed_by_role: actor.role,
            timestamp: now,
          },
          `Reset de senha do trabalhador ${w.nome}`,
        );
      } catch (err) {
        if (err instanceof AuditRequiredError) return;
        throw err;
      }
      const { data, error } = await supabase.functions.invoke("admin-reset-password", {
        body: { target_kind: "worker", target_id: w.id },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error || "Falha ao redefinir senha");
      setCreds({ nome: data.nome, login: data.login, password: data.password });
    } catch (err: any) {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    }
  }


  // resolveResetRequest removed: handled by PasswordRecoveryBell

  function copyCreds() {
    if (!creds) return;
    navigator.clipboard.writeText(`Trabalhador: ${creds.nome}\nLogin: ${creds.login}\nSenha: ${creds.password}`);
    toast({ title: "Copiado!" });
  }

  if (loading) return <div className="flex h-64 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm text-muted-foreground">{workers.length} trabalhador(es)</p>
        <div className="flex items-center gap-2">
          {isSuperAdmin && (
            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none">
              <Switch checked={showArchived} onCheckedChange={setShowArchived} />
              Mostrar arquivados
            </label>
          )}
          <Button size="sm" onClick={() => setOpenCreate(true)}><Plus className="h-4 w-4 mr-1" /> Novo</Button>
        </div>
      </div>

      {/* Reset password requests moved to PasswordRecoveryBell in header */}

      <div className="space-y-2">
        {workers.length === 0 ? (
          <EmptyState
            icon={Inbox}
            message="Nenhum trabalhador cadastrado"
            description="Cadastre um trabalhador para começar."
            actionLabel="Cadastrar trabalhador"
            onAction={() => setOpenCreate(true)}
            compact
          />
        ) : (
          workers.map((w) => {
            const s = stats[w.id];
            return (
              <Card key={w.id}>
                <CardContent className="p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <button onClick={() => navigate(`/admin/worker/${w.id}`)} className="flex-1 text-left min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm truncate">{w.nome}</span>
                        {w.archived_at ? (
                          <Badge variant="outline" className="text-[10px]">Arquivado</Badge>
                        ) : !w.active ? (
                          <Badge variant="secondary" className="text-[10px]">Inativo</Badge>
                        ) : null}
                      </div>
                      <div className="text-[11px] text-muted-foreground">Login <span className="font-mono">{w.login_codigo}</span></div>
                    </button>
                    {!w.archived_at && (
                      <Switch checked={w.active} onCheckedChange={() => handleToggleActive(w)} />
                    )}
                    <ChevronRight className="h-4 w-4 text-muted-foreground cursor-pointer" onClick={() => navigate(`/admin/worker/${w.id}`)} />
                  </div>
                  <div className="flex flex-wrap gap-1 mb-2">
                    {!w.archived_at && (
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => openEdit(w)}>
                        Editar Trabalhador
                      </Button>
                    )}
                    {!w.archived_at && (
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleResetPassword(w)}>
                        <KeyRound className="h-3.5 w-3.5 mr-1" /> Gerar Nova Senha
                      </Button>
                    )}
                    {!w.archived_at && (
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => openArchiveDialog(w)}>
                        Arquivar Trabalhador
                      </Button>
                    )}

                    {isSuperAdmin && w.archived_at && (
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleUnarchive(w)}>
                        Desarquivar Trabalhador
                      </Button>
                    )}
                  </div>
                  {s && (
                    <div className="grid grid-cols-4 gap-1 text-[10px] border-t pt-2">
                      <div><div className="text-muted-foreground">Clientes</div><div className="font-bold">{s.clientesAtivos}</div></div>
                      <div><div className="text-muted-foreground">Empr.At</div><div className="font-bold">{s.emprestimosAtivos}</div></div>
                      <div><div className="text-muted-foreground">Atrasados</div><div className="font-bold text-destructive">{s.atrasados}</div></div>
                      <div><div className="text-muted-foreground">N.Pagos hoje</div><div className="font-bold text-destructive">{s.naoPagosCount}</div></div>
                      <div className="col-span-2"><div className="text-muted-foreground">Previsto hoje</div><div className="font-bold">{formatCurrency(s.previsto)}</div></div>
                      <div className="col-span-2"><div className="text-muted-foreground">Recebido hoje</div><div className="font-bold text-success">{formatCurrency(s.recebido)}</div></div>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })
        )}
      </div>

      <Button variant="outline" size="sm" className="w-full" onClick={load}><RefreshCw className="h-4 w-4 mr-1" /> Atualizar</Button>

      <Dialog open={openCreate} onOpenChange={setOpenCreate}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Novo trabalhador</DialogTitle>
            <DialogDescription>Login e senha serão gerados automaticamente.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-3">
            <div><Label htmlFor="nome">Nome</Label><Input id="nome" required value={nome} onChange={(e) => setNome(e.target.value)} /></div>
            <div><Label htmlFor="notas">Observação</Label><Textarea id="notas" value={notas} onChange={(e) => setNotas(e.target.value)} rows={2} /></div>
            <DialogFooter>
              <Button type="submit" disabled={creating} className="w-full">{creating ? <Loader2 className="h-4 w-4 animate-spin" /> : "Criar"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!creds} onOpenChange={(o) => !o && setCreds(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Credenciais geradas</DialogTitle>
            <DialogDescription>Anote ou copie agora — você pode consultar depois no log.</DialogDescription>
          </DialogHeader>
          {creds && (
            <div className="space-y-2 font-mono text-sm bg-muted p-3 rounded">
              <div>Nome: <span className="font-bold">{creds.nome}</span></div>
              <div>Login: <span className="font-bold text-primary">{creds.login}</span></div>
              <div>Senha: <span className="font-bold text-primary">{creds.password}</span></div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={copyCreds}><Copy className="h-4 w-4 mr-1" /> Copiar</Button>
            <Button onClick={() => setCreds(null)}>Fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Editar trabalhador</DialogTitle>
            <DialogDescription>Alterar o login atualiza imediatamente a credencial de entrada. Histórico e dados são preservados.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSaveEdit} className="space-y-3">
            <div>
              <Label htmlFor="edit-nome">Nome</Label>
              <Input id="edit-nome" required value={editNome} onChange={(e) => setEditNome(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="edit-login">Login (4 dígitos)</Label>
              <Input id="edit-login" required inputMode="numeric" pattern="\d{4}" maxLength={4} value={editLogin} onChange={(e) => setEditLogin(e.target.value.replace(/\D/g, "").slice(0, 4))} />
            </div>
            <div>
              <Label htmlFor="edit-notas">Observação</Label>
              <Textarea id="edit-notas" value={editNotas} onChange={(e) => setEditNotas(e.target.value)} rows={2} />
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Switch checked={editActive} onCheckedChange={setEditActive} />
              <span>Ativo</span>
            </label>
            <DialogFooter>
              <Button type="submit" disabled={savingEdit} className="w-full">
                {savingEdit ? <Loader2 className="h-4 w-4 animate-spin" /> : "Salvar alterações"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!archiveTarget} onOpenChange={(o) => !o && setArchiveTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Arquivar trabalhador</DialogTitle>
            <DialogDescription>
              O trabalhador {archiveTarget?.nome ? <b>{archiveTarget.nome}</b> : null} sairá das listas ativas.
              Todo o histórico (empréstimos, pagamentos, caixa, auditoria) é preservado.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <label className={`flex items-start gap-2 rounded-md border p-2 cursor-pointer ${!archiveCascade ? "border-primary bg-primary/5" : ""}`}>
              <input type="radio" checked={!archiveCascade} onChange={() => setArchiveCascade(false)} />
              <div>
                <div className="font-medium">Arquivar somente o trabalhador</div>
                <div className="text-[11px] text-muted-foreground">Clientes vinculados continuam ativos e podem ser reatribuídos.</div>
              </div>
            </label>
            <label className={`flex items-start gap-2 rounded-md border p-2 cursor-pointer ${archiveCascade ? "border-primary bg-primary/5" : ""}`}>
              <input type="radio" checked={archiveCascade} onChange={() => setArchiveCascade(true)} />
              <div>
                <div className="font-medium">Arquivar trabalhador e todos os clientes vinculados</div>
                <div className="text-[11px] text-muted-foreground">Executado em uma única transação. Nada é excluído.</div>
              </div>
            </label>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setArchiveTarget(null)} disabled={archiveWorking}>Cancelar</Button>
            <Button onClick={confirmArchive} disabled={archiveWorking}>
              {archiveWorking ? <Loader2 className="h-4 w-4 animate-spin" /> : "Confirmar arquivamento"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!archiveAckTarget} onOpenChange={(o) => !o && setArchiveAckTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-4 w-4" /> Aviso de responsabilidade
            </DialogTitle>
            <DialogDescription>
              Você está arquivando um trabalhador e poderá retirar clientes e dados da operação atual. Essa ação é de sua responsabilidade.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setArchiveAckTarget(null)}>Cancelar</Button>
            <Button onClick={acknowledgeArchiveWarning}>Confirmo e desejo continuar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>

  );
}
