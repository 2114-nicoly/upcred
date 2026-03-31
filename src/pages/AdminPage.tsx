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

  // 1) Update installments statuses based on current rules
  async function updateInstallments() {
    setInstallmentsStatus("running");
    addLog("Atualizando parcelas...");
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayStr = today.toISOString().split("T")[0];

      // Fetch all non-paid installments
      const { data: installments, error } = await supabase
        .from("installments")
        .select("id, status, due_date, amount, paid_amount")
        .neq("status", "paid");

      if (error) throw error;

      let updated = 0;
      for (const inst of installments || []) {
        const paidAmount = Number(inst.paid_amount);
        const amount = Number(inst.amount);
        let newStatus = inst.status;

        if (paidAmount >= amount) {
          newStatus = "paid";
        } else if (inst.due_date < todayStr) {
          newStatus = "overdue";
        } else if (inst.due_date === todayStr) {
          newStatus = "pending"; // due_today is computed at display time
        } else {
          newStatus = "pending";
        }

        if (newStatus !== inst.status) {
          const updateData: Record<string, unknown> = { status: newStatus };
          if (newStatus === "paid" && !inst.paid_amount) {
            // don't set paid_at if already set
          }
          await supabase.from("installments").update(updateData).eq("id", inst.id);
          updated++;
        }
      }

      addLog(`Parcelas atualizadas: ${updated} de ${installments?.length || 0}`);
      setInstallmentsStatus("done");
      toast({ title: "Parcelas atualizadas", description: `${updated} parcelas corrigidas.` });
    } catch (e: any) {
      addLog(`Erro nas parcelas: ${e.message}`);
      setInstallmentsStatus("error");
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    }
  }

  // 2) Update loans statuses based on installment totals
  async function updateLoans() {
    setLoansStatus("running");
    addLog("Atualizando empréstimos...");
    try {
      const { data: loans, error } = await supabase
        .from("loans")
        .select("id, total_amount, status");
      if (error) throw error;

      let updated = 0;
      for (const loan of loans || []) {
        // Sum paid amounts from installments
        const { data: installments } = await supabase
          .from("installments")
          .select("paid_amount, status")
          .eq("loan_id", loan.id);

        const totalPaid = (installments || []).reduce((sum, i) => sum + Number(i.paid_amount), 0);
        const totalAmount = Number(loan.total_amount);
        const remaining = totalAmount - totalPaid;

        let newStatus = loan.status;
        if (remaining <= 0) {
          newStatus = "paid";
        } else {
          // Check if any installment is overdue
          const hasOverdue = (installments || []).some((i) => i.status === "overdue");
          newStatus = hasOverdue ? "overdue" : "open";
        }

        if (newStatus !== loan.status) {
          await supabase.from("loans").update({ status: newStatus }).eq("id", loan.id);
          updated++;
        }
      }

      addLog(`Empréstimos atualizados: ${updated} de ${loans?.length || 0}`);
      setLoansStatus("done");
      toast({ title: "Empréstimos atualizados", description: `${updated} empréstimos corrigidos.` });
    } catch (e: any) {
      addLog(`Erro nos empréstimos: ${e.message}`);
      setLoansStatus("error");
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    }
  }

  // 3) Update clients (recalculate derived info - currently no derived columns stored)
  async function updateClients() {
    setClientsStatus("running");
    addLog("Atualizando clientes...");
    try {
      // Clients table has no derived columns to recalculate.
      // This ensures client_code is set for all clients missing one.
      const { data: clients, error } = await supabase
        .from("clients")
        .select("id, client_code")
        .order("created_at", { ascending: true });
      if (error) throw error;

      let updated = 0;
      const usedCodes = new Set((clients || []).filter((c) => c.client_code).map((c) => c.client_code));
      let nextCode = 1;

      for (const client of clients || []) {
        if (!client.client_code) {
          while (usedCodes.has(nextCode)) nextCode++;
          await supabase.from("clients").update({ client_code: nextCode }).eq("id", client.id);
          usedCodes.add(nextCode);
          updated++;
        }
      }

      addLog(`Clientes atualizados: ${updated} de ${clients?.length || 0}`);
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
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={() => navigate("/")}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-bold">Administrador</h1>
        </div>
      </div>

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
