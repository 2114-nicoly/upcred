import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/loan-utils";
import { useWorkerFilter } from "@/hooks/useWorkerFilter";
import { useAuth } from "@/hooks/useAuth";
import { AlertCircle } from "lucide-react";

type Props = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  clientId: string;
  clientName: string;
  currentWorkerId: string | null;
  onTransferred?: () => void;
};

type ActiveLoan = {
  id: string;
  amount: number;
  remaining_balance: number;
  status: string;
};

export default function TransferClientDialog({
  open, onOpenChange, clientId, clientName, currentWorkerId, onTransferred,
}: Props) {
  const { isSuperAdmin } = useAuth();
  const { workers, admins, selectedAdminId, setSelectedAdminId, refresh } = useWorkerFilter();
  const [destAdmin, setDestAdmin] = useState<string>("");
  const [toWorker, setToWorker] = useState<string>("");
  const [obs, setObs] = useState("");
  const [activeLoan, setActiveLoan] = useState<ActiveLoan | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancel = false;
    async function load() {
      setLoading(true);
      const { data: loans } = await supabase
        .from("loans")
        .select("id, amount, remaining_balance, status")
        .eq("client_id", clientId)
        .not("status", "in", "(paid,cancelled,renegotiated)")
        .gt("remaining_balance", 0.01)
        .order("created_at", { ascending: false })
        .limit(1);
      const ln = (loans as ActiveLoan[])?.[0] ?? null;
      if (cancel) return;
      setActiveLoan(ln);
      if (ln) {
        const { count } = await supabase
          .from("installments")
          .select("id", { count: "exact", head: true })
          .eq("loan_id", ln.id)
          .not("status", "in", "(paid,cancelled,renegotiated)");
        if (!cancel) setPendingCount(count || 0);
      } else {
        setPendingCount(0);
      }
      setLoading(false);
    }
    refresh();
    load();
    setDestAdmin("");
    setToWorker("");
    setObs("");
    return () => { cancel = true; };
  }, [open, clientId, refresh]);

  // Quando super_admin escolhe admin destino, refresca a lista de workers
  useEffect(() => {
    if (isSuperAdmin && destAdmin) setSelectedAdminId(destAdmin);
  }, [destAdmin, isSuperAdmin, setSelectedAdminId]);

  const eligible = workers.filter((w) => w.active && w.id !== currentWorkerId);

  const handleTransfer = async () => {
    if (!toWorker) {
      toast.error("Escolha o trabalhador destino");
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.rpc("admin_transfer_client" as any, {
      p_client_id: clientId,
      p_to_worker_id: toWorker,
      p_observation: obs || null,
    });
    setSubmitting(false);
    if (error) {
      toast.error(error.message || "Erro ao transferir");
      return;
    }
    toast.success("Cliente transferido com sucesso");
    onOpenChange(false);
    onTransferred?.();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Transferir cliente</DialogTitle>
          <DialogDescription>
            <strong>{clientName}</strong> passará a pertencer ao trabalhador escolhido. Apenas o
            empréstimo ativo e parcelas pendentes serão movidos.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-1">
            {loading ? (
              <p className="text-muted-foreground">Carregando…</p>
            ) : activeLoan ? (
              <>
                <p><strong>Empréstimo ativo:</strong> {formatCurrency(activeLoan.amount)}</p>
                <p><strong>Saldo devedor:</strong> {formatCurrency(activeLoan.remaining_balance)}</p>
                <p><strong>Parcelas pendentes:</strong> {pendingCount}</p>
              </>
            ) : (
              <p className="text-muted-foreground">Cliente sem empréstimo ativo. Apenas o cadastro será transferido.</p>
            )}
          </div>

          <div className="rounded-md border border-warning/40 bg-warning/10 p-3 flex gap-2 text-xs">
            <AlertCircle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
            <span>Histórico antigo (pagamentos, empréstimos quitados, eventos de caixa) permanece com o trabalhador atual.</span>
          </div>

          {isSuperAdmin && (
            <div>
              <Label className="text-xs">Equipe (admin) destino</Label>
              <Select value={destAdmin} onValueChange={setDestAdmin}>
                <SelectTrigger>
                  <SelectValue placeholder="Escolher equipe…" />
                </SelectTrigger>
                <SelectContent>
                  {admins.filter(a => a.active).map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.nome}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div>
            <Label className="text-xs">Trabalhador destino</Label>
            <Select value={toWorker} onValueChange={setToWorker} disabled={isSuperAdmin && !destAdmin}>
              <SelectTrigger>
                <SelectValue placeholder={isSuperAdmin && !destAdmin ? "Escolha a equipe primeiro" : "Escolher trabalhador…"} />
              </SelectTrigger>
              <SelectContent>
                {eligible.map((w) => (
                  <SelectItem key={w.id} value={w.id}>{w.nome} · {w.login_codigo}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="text-xs">Observação (opcional)</Label>
            <Textarea value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Motivo da transferência…" rows={2} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancelar</Button>
          <Button onClick={handleTransfer} disabled={submitting || !toWorker}>
            {submitting ? "Transferindo…" : "Confirmar transferência"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
