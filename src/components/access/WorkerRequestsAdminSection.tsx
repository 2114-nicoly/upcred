import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { Loader2, UserPlus, RefreshCw } from "lucide-react";
import { WorkerCreationRequest, requestStatusLabel, requestStatusVariant, formatDateTime } from "@/lib/worker-requests";

/** Seção "Solicitações de trabalhadores" na aba Equipe do Administrador. */
export default function WorkerRequestsAdminSection({ onChanged }: { onChanged?: () => void }) {

  const { user, adminId } = useAuth();
  const [rows, setRows] = useState<WorkerCreationRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [nome, setNome] = useState("");
  const [notes, setNotes] = useState("");
  const [sending, setSending] = useState(false);

  async function load() {
    setLoading(true);
    const { data } = await supabase
      .from("worker_creation_requests" as any)
      .select("*")
      .order("requested_at", { ascending: false });
    setRows(((data as any[]) ?? []) as WorkerCreationRequest[]);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!nome.trim()) { toast({ title: "Nome obrigatório", variant: "destructive" }); return; }
    if (!adminId || !user) { toast({ title: "Empresa não identificada", variant: "destructive" }); return; }
    setSending(true);
    try {
      const { error } = await supabase.from("worker_creation_requests" as any).insert({
        admin_id: adminId,
        requested_by: user.id,
        worker_name: nome.trim(),
        notes: notes.trim() || null,
        status: "pending",
      } as any);
      if (error) throw error;
      setNome(""); setNotes(""); setOpen(false);
      toast({ title: "Solicitação enviada para análise do SuperAdministrador." });
      load();
    } catch (err: any) {
      toast({ title: "Erro ao enviar solicitação", description: err.message, variant: "destructive" });
    } finally {
      setSending(false);
    }
  }

  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-sm font-semibold">Solicitações de trabalhadores</p>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" className="h-8 px-2"
              onClick={() => { load(); onChanged?.(); }} aria-label="Atualizar solicitações">
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              <UserPlus className="h-4 w-4 mr-1" /> Solicitar novo trabalhador
            </Button>
          </div>
        </div>


        {loading ? (
          <div className="flex h-16 items-center justify-center"><Loader2 className="h-4 w-4 animate-spin" /></div>
        ) : rows.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">Nenhuma solicitação enviada.</p>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => (
              <div key={r.id} className="rounded-md border p-2 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-medium">{r.worker_name}</span>
                  <Badge variant={requestStatusVariant(r.status)} className="text-[9px]">
                    {requestStatusLabel(r.status)}
                  </Badge>
                </div>
                {r.notes && <p className="text-[11px] text-muted-foreground whitespace-pre-line">{r.notes}</p>}
                <p className="text-[10px] text-muted-foreground">Solicitado em {formatDateTime(r.requested_at)}</p>
                {r.reviewed_at && (
                  <p className="text-[10px] text-muted-foreground">Respondido em {formatDateTime(r.reviewed_at)}</p>
                )}
                {r.status === "rejected" && r.rejection_reason && (
                  <p className="text-[11px] text-destructive">Motivo: {r.rejection_reason}</p>
                )}
                {r.created_worker_id && (
                  <p className="text-[10px] text-muted-foreground">Trabalhador criado.</p>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Solicitar novo trabalhador</DialogTitle></DialogHeader>
          <form onSubmit={submit} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="wcr-nome">Nome</Label>
              <Input id="wcr-nome" value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Nome do trabalhador" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="wcr-notes">Observação</Label>
              <Textarea id="wcr-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
            </div>
            <p className="text-[10px] text-muted-foreground">
              Nenhum login ou senha é criado nesta etapa. A solicitação será analisada pelo SuperAdministrador.
            </p>
            <DialogFooter>
              <Button type="submit" disabled={sending}>
                {sending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} Enviar solicitação
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
