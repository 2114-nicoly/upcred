import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useWorkerFilter } from "@/hooks/useWorkerFilter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Loader2, ArrowLeft, Eye, MapPin, Wallet, Users, Landmark, BarChart3 } from "lucide-react";
import { formatCurrency } from "@/lib/loan-utils";
import { PeriodMode, getPeriodRange, loadWorkersStats, WorkerStats } from "@/lib/consolidated-stats";
import AuditLogList from "@/components/AuditLogList";

type Worker = { id: string; nome: string; login_codigo: string; active: boolean; created_at: string; notas: string | null };

export default function AdminWorkerDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAdmin, loading: authLoading } = useAuth();
  const { setSelectedWorkerId } = useWorkerFilter();

  const [worker, setWorker] = useState<Worker | null>(null);
  const [mode, setMode] = useState<PeriodMode>("day");
  const [stats, setStats] = useState<WorkerStats | null>(null);
  const [loading, setLoading] = useState(true);

  const range = useMemo(() => getPeriodRange(mode), [mode]);

  useEffect(() => {
    if (!authLoading && !isAdmin) navigate("/");
  }, [authLoading, isAdmin, navigate]);

  useEffect(() => {
    if (!id) return;
    let cancel = false;
    async function load() {
      setLoading(true);
      const [{ data: w }, list] = await Promise.all([
        supabase.from("workers").select("*").eq("id", id!).maybeSingle(),
        loadWorkersStats(range),
      ]);
      if (cancel) return;
      setWorker(w as Worker);
      setStats(list.find((s) => s.worker_id === id) ?? null);
      setLoading(false);
    }
    load();
    return () => { cancel = true; };
  }, [id, range]);

  function viewAsWorker() {
    if (!id) return;
    setSelectedWorkerId(id);
    navigate("/");
  }

  if (authLoading || loading) return <div className="flex h-64 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (!worker) return <div className="p-4">Trabalhador não encontrado.</div>;

  return (
    <div className="p-3 max-w-2xl mx-auto pb-24">
      <Button variant="ghost" size="sm" onClick={() => navigate("/admin")} className="mb-2"><ArrowLeft className="h-4 w-4 mr-1" /> Voltar</Button>

      <Card className="mb-3"><CardContent className="p-3 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold">{worker.nome}</h1>
          <p className="text-xs text-muted-foreground">Login <span className="font-mono">{worker.login_codigo}</span></p>
          {!worker.active && <Badge variant="secondary" className="text-[10px] mt-1">Inativo</Badge>}
        </div>
        <Button size="sm" onClick={viewAsWorker}><Eye className="h-4 w-4 mr-1" /> Ver como este</Button>
      </CardContent></Card>

      <Tabs value={mode} onValueChange={(v) => setMode(v as PeriodMode)} className="mb-3">
        <TabsList className="grid grid-cols-3 w-full">
          <TabsTrigger value="day" className="text-xs">Dia</TabsTrigger>
          <TabsTrigger value="week" className="text-xs">Semana</TabsTrigger>
          <TabsTrigger value="month" className="text-xs">Mês</TabsTrigger>
        </TabsList>
      </Tabs>

      <p className="text-xs text-muted-foreground mb-2">{range.label}</p>

      {stats && (
        <>
          <div className="grid grid-cols-2 gap-2 mb-3">
            <Stat label="Previsto" value={formatCurrency(stats.previsto)} />
            <Stat label="Recebido" value={formatCurrency(stats.recebido)} cls="text-success" />
            <Stat label="Falta" value={formatCurrency(stats.faltaReceber)} cls="text-destructive" />
            <Stat label="%" value={`${stats.percentual.toFixed(0)}%`} />
            <Stat label="Emprestado" value={formatCurrency(stats.emprestado)} />
            <Stat label="Retirado" value={formatCurrency(stats.retirada)} cls="text-destructive" />
            <Stat label="Aporte" value={formatCurrency(stats.aporte)} cls="text-success" />
            <Stat label="Saldo" value={formatCurrency(stats.saldoLiquido)} cls={stats.saldoLiquido >= 0 ? "text-success" : "text-destructive"} />
          </div>
          <div className="grid grid-cols-3 gap-2 mb-3">
            <Stat label="Clientes" value={String(stats.clientesAtivos)} />
            <Stat label="Empr.Ativos" value={String(stats.emprestimosAtivos)} />
            <Stat label="Atrasados" value={String(stats.atrasados)} cls="text-destructive" />
          </div>
        </>
      )}

      <Card className="mb-3"><CardHeader className="pb-2"><CardTitle className="text-sm">Atalhos (filtrados por este trabalhador)</CardTitle></CardHeader>
      <CardContent className="grid grid-cols-2 gap-2 p-3">
        <Shortcut to="/" icon={MapPin} label="Rota" onGo={viewAsWorker} />
        <Shortcut to="/caixa" icon={Wallet} label="Caixa/Geral" onGo={viewAsWorker} />
        <Shortcut to="/clients" icon={Users} label="Clientes" onGo={viewAsWorker} />
        <Shortcut to="/active-loans" icon={Landmark} label="Empréstimos Ativos" onGo={viewAsWorker} />
        <Shortcut to="/reports" icon={BarChart3} label="Relatórios" onGo={viewAsWorker} />
      </CardContent></Card>

      <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Histórico de ações</CardTitle></CardHeader>
      <CardContent className="p-3"><AuditLogList workerId={worker.id} limit={50} /></CardContent></Card>
    </div>
  );
}

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (<Card><CardContent className="p-2">
    <p className="text-[10px] text-muted-foreground">{label}</p>
    <p className={`text-sm font-bold ${cls || ""}`}>{value}</p>
  </CardContent></Card>);
}

function Shortcut({ to, icon: Icon, label, onGo }: { to: string; icon: any; label: string; onGo: () => void }) {
  return (
    <button onClick={onGo} className="flex items-center gap-2 border rounded-md p-2 text-sm hover:bg-muted/40 text-left">
      <Icon className="h-4 w-4 text-primary" />
      <span>{label}</span>
    </button>
  );
}
