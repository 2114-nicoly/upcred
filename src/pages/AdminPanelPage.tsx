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
import { Loader2, Plus, Copy, KeyRound, RefreshCw, Inbox, ChevronRight, ArrowUpDown,
  TrendingUp, AlertTriangle, ArrowDownCircle, ArrowUpCircle, Wallet, Target, TrendingDown } from "lucide-react";
import { generateLoginCodigo, generateTempPassword, syntheticEmailFor } from "@/lib/worker-utils";
import { useAuth } from "@/hooks/useAuth";
import { formatCurrency } from "@/lib/loan-utils";
import {
  PeriodMode, getPeriodRange, loadWorkersStats, consolidate, WorkerStats,
} from "@/lib/consolidated-stats";
import AuditLogList from "@/components/AuditLogList";
import { logAction } from "@/lib/audit-utils";

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
      <Tabs defaultValue="overview">
        <TabsList className="grid grid-cols-4 w-full">
          <TabsTrigger value="overview" className="text-xs">Visão Geral</TabsTrigger>
          <TabsTrigger value="workers" className="text-xs">Trabalhadores</TabsTrigger>
          <TabsTrigger value="compare" className="text-xs">Comparativo</TabsTrigger>
          <TabsTrigger value="audit" className="text-xs">Auditoria</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-3">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="workers" className="mt-3">
          <WorkersTab />
        </TabsContent>
        <TabsContent value="compare" className="mt-3">
          <CompareTab />
        </TabsContent>
        <TabsContent value="audit" className="mt-3">
          <AuditLogList />
        </TabsContent>
      </Tabs>
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
            <Kpi icon={<ArrowUpCircle className="h-4 w-4 text-warning" />} label="Emprestado" value={formatCurrency(stats.emprestado)} />
            <Kpi icon={<ArrowDownCircle className="h-4 w-4 text-destructive" />} label="Retirado" value={formatCurrency(stats.retirada)} />
            <Kpi icon={<ArrowUpCircle className="h-4 w-4 text-success" />} label="Aporte" value={formatCurrency(stats.aporte)} />
            <Kpi icon={<TrendingDown className="h-4 w-4 text-destructive" />} label="Total saídas" value={formatCurrency(stats.totalSaidas)} />
          </div>

          <Card className="mb-3"><CardContent className="p-3 flex justify-between items-center">
            <div className="flex items-center gap-2">
              <Wallet className="h-5 w-5 text-primary" />
              <div>
                <p className="text-xs text-muted-foreground">Saldo líquido do período</p>
                <p className={`text-lg font-bold ${stats.saldoLiquido >= 0 ? "text-success" : "text-destructive"}`}>
                  {formatCurrency(stats.saldoLiquido)}
                </p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground">Não pagos</p>
              <p className="text-sm font-bold text-destructive">{stats.naoPagosCount}</p>
            </div>
          </CardContent></Card>

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

/* ============= COMPARE TAB ============= */
function CompareTab() {
  const [mode, setMode] = useState<PeriodMode>("day");
  const [customStart, setCustomStart] = useState(new Date().toISOString().slice(0, 10));
  const [customEnd, setCustomEnd] = useState(new Date().toISOString().slice(0, 10));
  const [rows, setRows] = useState<WorkerStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<keyof WorkerStats>("recebido");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const range = useMemo(() => getPeriodRange(mode, customStart, customEnd), [mode, customStart, customEnd]);

  useEffect(() => {
    let cancel = false;
    async function load() {
      setLoading(true);
      const list = await loadWorkersStats(range);
      if (cancel) return;
      setRows(list);
      setLoading(false);
    }
    load();
    return () => { cancel = true; };
  }, [range]);

  const sorted = useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      const av = a[sortKey] as number;
      const bv = b[sortKey] as number;
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return arr;
  }, [rows, sortKey, sortDir]);

  function toggleSort(k: keyof WorkerStats) {
    if (sortKey === k) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(k); setSortDir("desc"); }
  }

  const Th = ({ k, label }: { k: keyof WorkerStats; label: string }) => (
    <th className="text-right cursor-pointer select-none px-1.5 py-1 text-[10px] font-semibold whitespace-nowrap" onClick={() => toggleSort(k)}>
      <span className="inline-flex items-center gap-0.5">{label} <ArrowUpDown className="h-2.5 w-2.5" /></span>
    </th>
  );

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

      <p className="text-xs text-muted-foreground mb-2">{range.label}</p>

      {loading ? (
        <div className="flex justify-center p-6"><Loader2 className="h-5 w-5 animate-spin" /></div>
      ) : (
        <Card><CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/40">
              <tr>
                <th className="text-left px-2 py-1 text-[10px] font-semibold">Trabalhador</th>
                <Th k="previsto" label="Previsto" />
                <Th k="recebido" label="Recebido" />
                <Th k="percentual" label="%" />
                <Th k="naoPagosCount" label="N.Pg" />
                <Th k="atrasados" label="Atr" />
                <Th k="emprestado" label="Emp" />
                <Th k="retirada" label="Ret" />
                <Th k="aporte" label="Apt" />
                <Th k="saldoLiquido" label="Saldo" />
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr><td colSpan={10} className="p-3 text-center text-muted-foreground">Sem dados no período</td></tr>
              ) : sorted.map((s) => (
                <tr key={s.worker_id ?? "null"} className="border-t">
                  <td className="px-2 py-1.5 font-medium">{s.worker_name}</td>
                  <td className="text-right px-1.5">{formatCurrency(s.previsto)}</td>
                  <td className="text-right px-1.5 text-success">{formatCurrency(s.recebido)}</td>
                  <td className="text-right px-1.5">{s.percentual.toFixed(0)}%</td>
                  <td className="text-right px-1.5 text-destructive">{s.naoPagosCount}</td>
                  <td className="text-right px-1.5 text-destructive">{s.atrasados}</td>
                  <td className="text-right px-1.5">{formatCurrency(s.emprestado)}</td>
                  <td className="text-right px-1.5 text-destructive">{formatCurrency(s.retirada)}</td>
                  <td className="text-right px-1.5 text-success">{formatCurrency(s.aporte)}</td>
                  <td className={`text-right px-1.5 font-bold ${s.saldoLiquido >= 0 ? "text-success" : "text-destructive"}`}>{formatCurrency(s.saldoLiquido)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent></Card>
      )}
    </div>
  );
}

/* ============= WORKERS TAB ============= */
function WorkersTab() {
  const navigate = useNavigate();
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [resetRequests, setResetRequests] = useState<any[]>([]);
  const [stats, setStats] = useState<Record<string, WorkerStats>>({});
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [openCreate, setOpenCreate] = useState(false);
  const [nome, setNome] = useState("");
  const [notas, setNotas] = useState("");
  const [creds, setCreds] = useState<CredsToShow | null>(null);

  async function load() {
    setLoading(true);
    const today = new Date().toISOString().slice(0, 10);
    const range = getPeriodRange("day", today, today);
    const [{ data: w }, { data: r }, statsList] = await Promise.all([
      supabase.from("workers").select("*").order("created_at", { ascending: false }),
      supabase.from("worker_password_reset_requests").select("*").eq("status", "pending").order("created_at", { ascending: false }),
      loadWorkersStats(range),
    ]);
    setWorkers((w as any) || []);
    setResetRequests((r as any) || []);
    const map: Record<string, WorkerStats> = {};
    statsList.forEach((s) => { if (s.worker_id) map[s.worker_id] = s; });
    setStats(map);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

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
    const { data: { session: adminSession } } = await supabase.auth.getSession();

    try {
      const login = await pickUniqueLogin();
      const password = generateTempPassword();
      const email = syntheticEmailFor(login);

      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email, password,
        options: {
          emailRedirectTo: `${window.location.origin}/`,
          data: { display_name: nome.trim() },
        },
      });
      if (signUpError) throw signUpError;
      const newUserId = signUpData.user?.id;
      if (!newUserId) throw new Error("Falha ao criar usuário.");

      if (adminSession) {
        await supabase.auth.setSession({ access_token: adminSession.access_token, refresh_token: adminSession.refresh_token });
      }

      const { data: workerId, error: rpcError } = await supabase.rpc("admin_register_worker", {
        p_nome: nome.trim(), p_login_codigo: login, p_synthetic_email: email,
        p_auth_user_id: newUserId, p_notas: notas.trim() || null,
      });
      if (rpcError) throw rpcError;

      await supabase.from("worker_credentials_log").insert({
        worker_id: workerId as string, login_codigo: login, temp_password: password, reason: "created",
      } as any);

      await logAction("criar_trabalhador", "worker", workerId as string, null, { nome: nome.trim(), login });

      setCreds({ nome: nome.trim(), login, password });
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
    const { error } = await supabase.from("workers").update({ active: !w.active } as any).eq("id", w.id);
    if (error) { toast({ title: "Erro", description: error.message, variant: "destructive" }); return; }
    await logAction(w.active ? "desativar_trabalhador" : "ativar_trabalhador", "worker", w.id, { active: w.active }, { active: !w.active });
    toast({ title: w.active ? "Desativado" : "Ativado" });
    load();
  }

  async function handleResetPassword(w: Worker) {
    if (!confirm(`Gerar nova senha temporária para ${w.nome}?`)) return;
    const password = generateTempPassword();
    await supabase.from("worker_credentials_log").insert({
      worker_id: w.id, login_codigo: w.login_codigo, temp_password: password, reason: "reset_pending",
    } as any);
    await logAction("reset_senha_trabalhador", "worker", w.id, null, { login: w.login_codigo });
    setCreds({ nome: w.nome, login: w.login_codigo, password });
  }

  async function resolveResetRequest(id: string) {
    await supabase.from("worker_password_reset_requests").update({ status: "resolved", resolved_at: new Date().toISOString() } as any).eq("id", id);
    load();
  }

  function copyCreds() {
    if (!creds) return;
    navigator.clipboard.writeText(`Trabalhador: ${creds.nome}\nLogin: ${creds.login}\nSenha: ${creds.password}`);
    toast({ title: "Copiado!" });
  }

  if (loading) return <div className="flex h-64 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{workers.length} trabalhador(es)</p>
        <Button size="sm" onClick={() => setOpenCreate(true)}><Plus className="h-4 w-4 mr-1" /> Novo</Button>
      </div>

      {resetRequests.length > 0 && (
        <Card className="border-warning">
          <CardHeader className="p-3 pb-1">
            <CardTitle className="text-sm flex items-center gap-2"><Inbox className="h-4 w-4" /> Pedidos de senha</CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-1 space-y-2">
            {resetRequests.map((r) => (
              <div key={r.id} className="flex items-center justify-between text-sm border rounded p-2">
                <div>
                  <div className="font-medium">{r.identifier}</div>
                  <div className="text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</div>
                </div>
                <Button size="sm" variant="outline" onClick={() => resolveResetRequest(r.id)}>Resolver</Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        {workers.length === 0 ? (
          <p className="text-sm text-muted-foreground p-3 text-center">Nenhum trabalhador cadastrado.</p>
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
                        {!w.active && <Badge variant="secondary" className="text-[10px]">Inativo</Badge>}
                      </div>
                      <div className="text-[11px] text-muted-foreground">Login <span className="font-mono">{w.login_codigo}</span></div>
                    </button>
                    <Switch checked={w.active} onCheckedChange={() => handleToggleActive(w)} />
                    <Button size="icon" variant="ghost" onClick={() => handleResetPassword(w)} title="Gerar nova senha"><KeyRound className="h-4 w-4" /></Button>
                    <ChevronRight className="h-4 w-4 text-muted-foreground cursor-pointer" onClick={() => navigate(`/admin/worker/${w.id}`)} />
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
    </div>
  );
}
