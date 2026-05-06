import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/hooks/use-toast";
import { ArrowLeft, RefreshCw, Users, Landmark, FileText, Shield, Loader2 } from "lucide-react";

type TaskStatus = "idle" | "running" | "done" | "error";

export default function AdminPage() {
  const navigate = useNavigate();
  const [installmentsStatus, setInstallmentsStatus] = useState<TaskStatus>("idle");
  const [loansStatus, setLoansStatus] = useState<TaskStatus>("idle");
  const [clientsStatus, setClientsStatus] = useState<TaskStatus>("idle");
  const [fullStatus, setFullStatus] = useState<TaskStatus>("idle");
  const [log, setLog] = useState<string[]>([]);

  const addLog = (msg: string) => setLog((prev) => [...prev, `${new Date().toLocaleTimeString()} - ${msg}`]);

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

          <Button
            className="w-full"
            variant="secondary"
            onClick={() => navigate("/")}
          >
            Voltar para Início
          </Button>
        </CardContent>
      </Card>

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
