import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/hooks/use-toast";
import { ArrowLeft, RefreshCw, Users, Landmark, FileText, Shield, Loader2, AlertTriangle } from "lucide-react";
import EmptyCashCleanup from "@/components/EmptyCashCleanup";

type TaskStatus = "idle" | "running" | "done" | "error";
type Orphan = { entity_type: string; entity_id: string; label: string; missing: string; created_at: string };

export default function AdminPage() {
  const navigate = useNavigate();
  const [installmentsStatus, setInstallmentsStatus] = useState<TaskStatus>("idle");
  const [loansStatus, setLoansStatus] = useState<TaskStatus>("idle");
  const [clientsStatus, setClientsStatus] = useState<TaskStatus>("idle");
  const [fullStatus, setFullStatus] = useState<TaskStatus>("idle");
  const [orphansStatus, setOrphansStatus] = useState<TaskStatus>("idle");
  const [orphans, setOrphans] = useState<Orphan[]>([]);
  const [log, setLog] = useState<string[]>([]);

  const addLog = (msg: string) => setLog((prev) => [...prev, `${new Date().toLocaleTimeString()} - ${msg}`]);

  async function checkOrphans() {
    setOrphansStatus("running");
    addLog("Verificando registros sem vínculo...");
    try {
      const { data, error } = await supabase.rpc("admin_find_orphans" as any);
      if (error) throw error;
      const list = (data as Orphan[]) || [];
      setOrphans(list);
      addLog(`${list.length} registro(s) sem vínculo.`);
      setOrphansStatus("done");
      toast({ title: "Verificação concluída", description: `${list.length} registro(s) sem vínculo.` });
    } catch (e: any) {
      addLog(`Erro: ${e.message}`);
      setOrphansStatus("error");
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    }
  }

  // 1) Update installments statuses (server-enforced admin RPC)
  async function updateInstallments() {
    setInstallmentsStatus("running");
    addLog("Atualizando parcelas...");
    try {
      const { data, error } = await supabase.rpc("admin_recalculate_installments");
      if (error) throw error;
      const updated = Number(data ?? 0);
      addLog(`Parcelas atualizadas: ${updated}`);
      setInstallmentsStatus("done");
      toast({ title: "Parcelas atualizadas", description: `${updated} parcelas corrigidas.` });
    } catch (e: any) {
      addLog(`Erro nas parcelas: ${e.message}`);
      setInstallmentsStatus("error");
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    }
  }

  // 2) Update loans statuses (server-enforced admin RPC)
  async function updateLoans() {
    setLoansStatus("running");
    addLog("Atualizando empréstimos...");
    try {
      const { data, error } = await supabase.rpc("admin_recalculate_loans");
      if (error) throw error;
      const updated = Number(data ?? 0);
      addLog(`Empréstimos atualizados: ${updated}`);
      setLoansStatus("done");
      toast({ title: "Empréstimos atualizados", description: `${updated} empréstimos corrigidos.` });
    } catch (e: any) {
      addLog(`Erro nos empréstimos: ${e.message}`);
      setLoansStatus("error");
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    }
  }

  // 3) Assign missing client codes (server-enforced admin RPC)
  async function updateClients() {
    setClientsStatus("running");
    addLog("Atualizando clientes...");
    try {
      const { data, error } = await supabase.rpc("admin_assign_client_codes");
      if (error) throw error;
      const updated = Number(data ?? 0);
      addLog(`Clientes atualizados: ${updated}`);
      setClientsStatus("done");
      toast({ title: "Clientes atualizados", description: `${updated} clientes corrigidos.` });
    } catch (e: any) {
      addLog(`Erro nos clientes: ${e.message}`);
      setClientsStatus("error");
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    }
  }

  // 4) Full system update
  async function updateAll() {
    setFullStatus("running");
    addLog("=== Padronização completa iniciada ===");
    try {
      await updateInstallments();
      await updateLoans();
      await updateClients();
      addLog("=== Padronização completa finalizada ===");
      setFullStatus("done");
      toast({ title: "Sistema padronizado", description: "Todos os dados foram atualizados." });
    } catch (e: any) {
      addLog(`Erro geral: ${e.message}`);
      setFullStatus("error");
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    }
  }

  const statusIcon = (status: TaskStatus) => {
    if (status === "running") return <Loader2 className="h-4 w-4 animate-spin" />;
    if (status === "done") return <span className="text-xs text-primary">✓</span>;
    if (status === "error") return <span className="text-xs text-destructive">✗</span>;
    return null;
  };

  return (
    <div className="p-4 space-y-4 max-w-lg mx-auto">

      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm">Manutenção do Sistema</CardTitle>
          <CardDescription className="text-xs">
            Use os botões abaixo para reaplicar as regras atuais do app aos dados existentes.
            Nenhum dado será apagado — apenas status e campos derivados serão recalculados.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 pt-2 space-y-2">
          <Button
            className="w-full justify-start gap-2"
            variant="outline"
            disabled={installmentsStatus === "running" || fullStatus === "running"}
            onClick={updateInstallments}
          >
            <FileText className="h-4 w-4" />
            Atualizar Parcelas
            {statusIcon(installmentsStatus)}
          </Button>

          <Button
            className="w-full justify-start gap-2"
            variant="outline"
            disabled={loansStatus === "running" || fullStatus === "running"}
            onClick={updateLoans}
          >
            <Landmark className="h-4 w-4" />
            Atualizar Empréstimos
            {statusIcon(loansStatus)}
          </Button>

          <Button
            className="w-full justify-start gap-2"
            variant="outline"
            disabled={clientsStatus === "running" || fullStatus === "running"}
            onClick={updateClients}
          >
            <Users className="h-4 w-4" />
            Atualizar Clientes
            {statusIcon(clientsStatus)}
          </Button>

          <div className="pt-2 border-t">
            <Button
              className="w-full justify-start gap-2"
              disabled={fullStatus === "running"}
              onClick={updateAll}
            >
              <RefreshCw className="h-4 w-4" />
              Padronizar Sistema Completo
              {statusIcon(fullStatus)}
            </Button>
          </div>

          <div className="pt-2 border-t">
            <Button
              className="w-full justify-start gap-2"
              variant="outline"
              disabled={orphansStatus === "running"}
              onClick={checkOrphans}
            >
              <AlertTriangle className="h-4 w-4" />
              Verificar registros sem vínculo
              {statusIcon(orphansStatus)}
            </Button>
          </div>

          <Button
            className="w-full"
            variant="secondary"
            onClick={() => navigate("/")}
          >
            Voltar para Início
          </Button>
        </CardContent>
      </Card>

      {orphans.length > 0 && (
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm">Registros sem vínculo ({orphans.length})</CardTitle>
            <CardDescription className="text-xs">Clientes/empréstimos sem trabalhador ou administrador. Edite ou transfira para corrigir.</CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-1.5">
            {orphans.map((o) => (
              <div key={`${o.entity_type}-${o.entity_id}`} className="flex items-center justify-between text-xs border rounded p-2">
                <div className="min-w-0">
                  <p className="font-medium truncate">{o.entity_type === "client" ? "Cliente" : "Empréstimo"}: {o.label}</p>
                  <p className="text-[10px] text-muted-foreground">Faltando: {o.missing}</p>
                </div>
                <Button
                  size="sm" variant="outline" className="h-7 text-xs ml-2"
                  onClick={() => navigate(o.entity_type === "client" ? `/clients/${o.entity_id}` : `/loans/${o.entity_id}`)}
                >Abrir</Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {log.length > 0 && (
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm">Log de execução</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="max-h-48 overflow-auto text-xs font-mono space-y-0.5 bg-muted p-2 rounded">
              {log.map((entry, i) => (
                <div key={i}>{entry}</div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
