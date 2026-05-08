import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import { Loader2, Plus, Copy, RefreshCw, ArrowUpDown, Eye, Users, BarChart3, KeyRound } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { generateLoginCodigo, generateTempPassword } from "@/lib/worker-utils";
import { formatCurrency } from "@/lib/loan-utils";
import { logAction } from "@/lib/audit-utils";
import { PeriodMode, getPeriodRange, loadWorkersStats, consolidate, WorkerStats } from "@/lib/consolidated-stats";
import { TrendingUp, AlertTriangle, ArrowDownCircle, ArrowUpCircle, Wallet, Target } from "lucide-react";
import { CredentialsDialog, GeneratedCreds } from "@/components/CredentialsDialog";
import { useConfirm } from "@/hooks/useConfirm";

type AdminRow = {
  id: string;
  nome: string;
  email_real: string;
  login_codigo: string | null;
  active: boolean;
  created_at: string;
};

type AdminStat = {
  admin_id: string;
  admin_nome: string;
  active: boolean;
  workers_count: number;
  active_loans: number;
  total_received: number;
  total_lent: number;
};

type Creds = { nome: string; email: string; password: string };

export default function SuperAdminPage() {
  const navigate = useNavigate();
  const { isSuperAdmin, loading } = useAuth();

  useEffect(() => {
    if (!loading && !isSuperAdmin) navigate("/");
  }, [loading, isSuperAdmin, navigate]);

  if (loading) return <div className="flex h-64 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (!isSuperAdmin) return null;

  return (
    <div className="p-3 max-w-3xl mx-auto pb-24">
      <h1 className="text-xl font-bold mb-3">Super Admin</h1>
      <Tabs defaultValue="dashboard">
        <TabsList className="grid grid-cols-3 w-full">
          <TabsTrigger value="dashboard" className="text-xs">Dashboard</TabsTrigger>
          <TabsTrigger value="admins" className="text-xs">Administradores</TabsTrigger>
          <TabsTrigger value="ranking" className="text-xs">Ranking</TabsTrigger>
        </TabsList>
        <TabsContent value="dashboard" className="mt-3"><DashboardTab /></TabsContent>
        <TabsContent value="admins" className="mt-3"><AdminsTab /></TabsContent>
        <TabsContent value="ranking" className="mt-3"><RankingTab /></TabsContent>
      </Tabs>
    </div>
  );
}

/* ============ DASHBOARD TAB ============ */
function DashboardTab() {
  const [mode, setMode] = useState<PeriodMode>("day");
  const [customStart, setCustomStart] = useState(new Date().toISOString().slice(0, 10));
  const [customEnd, setCustomEnd] = useState(new Date().toISOString().slice(0, 10));
  const [stats, setStats] = useState<WorkerStats | null>(null);
  const [loading, setLoading] = useState(true);

  const range = useMemo(() => getPeriodRange(mode, customStart, customEnd), [mode, customStart, customEnd]);

  useEffect(() => {
    let cancel = false;
    (async () => {
      setLoading(true);
      const list = await loadWorkersStats(range);
      if (cancel) return;
      setStats(consolidate(list));
      setLoading(false);
    })();
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
      <p className="text-xs text-muted-foreground mb-2">{range.label} · Sistema inteiro</p>
      {loading || !stats ? (
        <div className="flex justify-center p-6"><Loader2 className="h-5 w-5 animate-spin" /></div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 mb-3">
            <DKpi icon={<Target className="h-4 w-4 text-primary" />} label="Previsto" value={formatCurrency(stats.previsto)} />
            <DKpi icon={<TrendingUp className="h-4 w-4 text-success" />} label="Recebido" value={formatCurrency(stats.recebido)} cls="text-success" />
            <DKpi icon={<AlertTriangle className="h-4 w-4 text-destructive" />} label="Falta receber" value={formatCurrency(stats.faltaReceber)} cls="text-destructive" />
            <DKpi icon={<TrendingUp className="h-4 w-4 text-primary" />} label="% Recebido" value={`${stats.percentual.toFixed(1)}%`} />
            <DKpi icon={<ArrowUpCircle className="h-4 w-4 text-warning" />} label="Emprestado" value={formatCurrency(stats.emprestado)} />
            <DKpi icon={<ArrowDownCircle className="h-4 w-4 text-destructive" />} label="Retirado" value={formatCurrency(stats.retirada)} cls="text-destructive" />
            <DKpi icon={<ArrowUpCircle className="h-4 w-4 text-success" />} label="Aporte" value={formatCurrency(stats.aporte)} cls="text-success" />
            <DKpi icon={<Wallet className="h-4 w-4 text-primary" />} label="Saldo líquido" value={formatCurrency(stats.saldoLiquido)} cls={stats.saldoLiquido >= 0 ? "text-success" : "text-destructive"} />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <DMini label="Clientes" value={stats.clientesAtivos} />
            <DMini label="Empr.Ativos" value={stats.emprestimosAtivos} />
            <DMini label="Atrasados" value={stats.atrasados} cls="text-destructive" />
          </div>
        </>
      )}
    </div>
  );
}
function DKpi({ icon, label, value, cls }: { icon: React.ReactNode; label: string; value: string; cls?: string }) {
  return (<Card><CardContent className="p-2.5">
    <div className="flex items-center gap-1.5 mb-0.5">{icon}<p className="text-[11px] text-muted-foreground">{label}</p></div>
    <p className={`text-sm font-bold ${cls || ""}`}>{value}</p>
  </CardContent></Card>);
}
function DMini({ label, value, cls }: { label: string; value: number; cls?: string }) {
  return (<Card><CardContent className="p-2 text-center">
    <p className="text-[10px] text-muted-foreground">{label}</p>
    <p className={`text-base font-bold ${cls || ""}`}>{value}</p>
  </CardContent></Card>);
}

/* ============ ADMINS TAB ============ */
function AdminsTab() {
  const navigate = useNavigate();
  const [list, setList] = useState<AdminRow[]>([]);
  const [statsByAdmin, setStatsByAdmin] = useState<Record<string, AdminStat>>({});
  const [loading, setLoading] = useState(true);
  const [openCreate, setOpenCreate] = useState(false);
  const [creds, setCreds] = useState<Creds | null>(null);

  async function load() {
    setLoading(true);
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = new Date(); monthStart.setDate(1);
    const ms = monthStart.toISOString().slice(0, 10);
    const [{ data: admins, error }, { data: stats }] = await Promise.all([
      supabase.rpc("super_admin_list_admins" as any),
      supabase.rpc("super_admin_stats_by_admin" as any, { p_start: ms, p_end: today }),
    ]);
    if (error) toast({ title: "Erro", description: error.message, variant: "destructive" });
    setList((admins as AdminRow[]) || []);
    const map: Record<string, AdminStat> = {};
    ((stats as AdminStat[]) || []).forEach((s) => { map[s.admin_id] = s; });
    setStatsByAdmin(map);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function toggleActive(a: AdminRow) {
    const { error } = await supabase.rpc("super_admin_set_admin_active" as any, {
      p_admin_id: a.id, p_active: !a.active,
    });
    if (error) return toast({ title: "Erro", description: error.message, variant: "destructive" });
    toast({ title: a.active ? "Desativado" : "Ativado" });
    await logAction(a.active ? "desativar_admin" : "ativar_admin", "admin", a.id, { active: a.active }, { active: !a.active });
    load();
  }

  return (
    <div className="space-y-2">
      <Button onClick={() => setOpenCreate(true)} className="w-full" size="sm">
        <Plus className="h-4 w-4 mr-1" /> Criar administrador
      </Button>

      {loading ? (
        <div className="flex justify-center p-6"><Loader2 className="h-5 w-5 animate-spin" /></div>
      ) : list.length === 0 ? (
        <Card><CardContent className="p-4 text-center text-sm text-muted-foreground">Nenhum administrador.</CardContent></Card>
      ) : (
        list.map((a) => {
          const s = statsByAdmin[a.id];
          return (
            <Card key={a.id}>
              <CardContent className="p-3 space-y-2">
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-sm truncate">{a.nome}</p>
                      {a.active
                        ? <Badge className="text-[9px] h-4">Ativo</Badge>
                        : <Badge variant="secondary" className="text-[9px] h-4">Inativo</Badge>}
                    </div>
                    <p className="text-[11px] text-muted-foreground truncate">{a.email_real}</p>
                    {a.login_codigo && <p className="text-[10px] text-muted-foreground">Login <span className="font-mono">{a.login_codigo}</span></p>}
                  </div>
                  <Switch checked={a.active} onCheckedChange={() => toggleActive(a)} />
                </div>

                <div className="grid grid-cols-4 gap-1 text-center">
                  <MiniStat label="Trab" value={s?.workers_count ?? 0} />
                  <MiniStat label="Empr" value={s?.active_loans ?? 0} />
                  <MiniStat label="Receb." value={formatCurrency(s?.total_received ?? 0)} small />
                  <MiniStat label="Empr.$" value={formatCurrency(s?.total_lent ?? 0)} small />
                </div>

                <div className="grid grid-cols-2 gap-1.5">
                  <Button size="sm" variant="default" className="h-8 text-xs" onClick={() => navigate(`/super-admin/${a.id}`)}>
                    <Users className="h-3.5 w-3.5 mr-1" /> Ver equipe
                  </Button>
                  <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => navigate(`/super-admin/${a.id}`)}>
                    <BarChart3 className="h-3.5 w-3.5 mr-1" /> Relatórios
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })
      )}

      <CreateAdminDialog
        open={openCreate}
        onOpenChange={setOpenCreate}
        onCreated={(c) => { setCreds(c); load(); }}
      />

      <Dialog open={!!creds} onOpenChange={() => setCreds(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Credenciais do administrador</DialogTitle>
            <DialogDescription>Anote agora — não será exibido novamente.</DialogDescription>
          </DialogHeader>
          {creds && (
            <div className="space-y-2 text-sm">
              <CredRow label="Nome" value={creds.nome} />
              <CredRow label="Email" value={creds.email} />
              <CredRow label="Senha" value={creds.password} />
            </div>
          )}
          <DialogFooter><Button onClick={() => setCreds(null)}>Fechar</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MiniStat({ label, value, small }: { label: string; value: string | number; small?: boolean }) {
  return (
    <div className="rounded border p-1">
      <p className="text-[9px] text-muted-foreground leading-none">{label}</p>
      <p className={`${small ? "text-[10px]" : "text-sm"} font-bold leading-tight mt-0.5`}>{value}</p>
    </div>
  );
}

function CredRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded border p-2">
      <div><p className="text-[10px] text-muted-foreground">{label}</p><p className="font-mono text-sm">{value}</p></div>
      <Button variant="ghost" size="icon" onClick={() => { navigator.clipboard.writeText(value); toast({ title: "Copiado" }); }}>
        <Copy className="h-4 w-4" />
      </Button>
    </div>
  );
}

function CreateAdminDialog({
  open, onOpenChange, onCreated,
}: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: (c: Creds) => void }) {
  const [nome, setNome] = useState("");
  const [email, setEmail] = useState("");
  const [notas, setNotas] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    if (!nome.trim() || !email.trim()) return toast({ title: "Preencha nome e email", variant: "destructive" });
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-create-user", {
        body: { kind: "admin", nome: nome.trim(), email_real: email.trim(), notas: notas.trim() || null },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error || "Falha ao criar admin");
      onCreated({ nome: data.nome, email: data.login, password: data.password });
      setNome(""); setEmail(""); setNotas("");
      onOpenChange(false);
    } catch (err: any) {
      toast({ title: "Erro", description: err.message ?? String(err), variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Novo administrador</DialogTitle>
          <DialogDescription>Login feito por email e senha. Senha gerada automaticamente.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <div><Label className="text-xs">Nome *</Label><Input value={nome} onChange={(e) => setNome(e.target.value)} /></div>
          <div><Label className="text-xs">Email *</Label><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div><Label className="text-xs">Notas</Label><Textarea value={notas} onChange={(e) => setNotas(e.target.value)} rows={2} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancelar</Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin mr-1" />}Criar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ============ RANKING TAB ============ */
function RankingTab() {
  const [mode, setMode] = useState<"day" | "week" | "month" | "custom">("month");
  const [customStart, setCustomStart] = useState(new Date().toISOString().slice(0, 10));
  const [customEnd, setCustomEnd] = useState(new Date().toISOString().slice(0, 10));
  const [rows, setRows] = useState<AdminStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<keyof AdminStat>("total_received");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const navigate = useNavigate();

  const range = useMemo(() => computeRange(mode, customStart, customEnd), [mode, customStart, customEnd]);

  useEffect(() => {
    let cancel = false;
    async function load() {
      setLoading(true);
      const { data, error } = await supabase.rpc("super_admin_stats_by_admin" as any, {
        p_start: range.start, p_end: range.end,
      });
      if (cancel) return;
      if (error) toast({ title: "Erro", description: error.message, variant: "destructive" });
      setRows((data as AdminStat[]) || []);
      setLoading(false);
    }
    load();
    return () => { cancel = true; };
  }, [range]);

  const sorted = useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      const av = a[sortKey] as any;
      const bv = b[sortKey] as any;
      if (typeof av === "number") return sortDir === "asc" ? av - bv : bv - av;
      return sortDir === "asc" ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
    });
    return arr;
  }, [rows, sortKey, sortDir]);

  function toggle(k: keyof AdminStat) {
    if (sortKey === k) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(k); setSortDir("desc"); }
  }
  const Th = ({ k, label }: { k: keyof AdminStat; label: string }) => (
    <th className="text-right cursor-pointer select-none px-1.5 py-1 text-[10px] font-semibold whitespace-nowrap" onClick={() => toggle(k)}>
      <span className="inline-flex items-center gap-0.5">{label}<ArrowUpDown className="h-2.5 w-2.5" /></span>
    </th>
  );

  return (
    <div>
      <Tabs value={mode} onValueChange={(v) => setMode(v as any)} className="mb-3">
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
      {loading ? (
        <div className="flex justify-center p-6"><Loader2 className="h-5 w-5 animate-spin" /></div>
      ) : (
        <Card><CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/40">
              <tr>
                <th className="text-left px-2 py-1 text-[10px] font-semibold">Admin</th>
                <Th k="workers_count" label="Trab" />
                <Th k="active_loans" label="Empr" />
                <Th k="total_received" label="Recebido" />
                <Th k="total_lent" label="Emprestado" />
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr><td colSpan={6} className="p-3 text-center text-muted-foreground">Sem administradores</td></tr>
              ) : sorted.map((r) => (
                <tr key={r.admin_id} className="border-t">
                  <td className="px-2 py-1.5">
                    <div className="font-medium">{r.admin_nome}</div>
                    {!r.active && <span className="text-[10px] text-muted-foreground">inativo</span>}
                  </td>
                  <td className="text-right px-1.5">{r.workers_count}</td>
                  <td className="text-right px-1.5">{r.active_loans}</td>
                  <td className="text-right px-1.5 text-success">{formatCurrency(r.total_received)}</td>
                  <td className="text-right px-1.5">{formatCurrency(r.total_lent)}</td>
                  <td className="px-1">
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => navigate(`/super-admin/${r.admin_id}`)}>
                      <Eye className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent></Card>
      )}
    </div>
  );
}

function computeRange(mode: "day" | "week" | "month" | "custom", customStart: string, customEnd: string) {
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  if (mode === "day") return { start: iso(today), end: iso(today) };
  if (mode === "week") {
    const s = new Date(today); s.setDate(s.getDate() - 6);
    return { start: iso(s), end: iso(today) };
  }
  if (mode === "month") {
    const s = new Date(today.getFullYear(), today.getMonth(), 1);
    return { start: iso(s), end: iso(today) };
  }
  return { start: customStart, end: customEnd };
}
