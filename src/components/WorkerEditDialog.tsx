import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";

// Modal único de edição de trabalhador, reutilizado pelo Admin (aba Equipe) e pelo
// Super Admin (aba Trabalhadores). Salvar passa sempre pela mesma função
// "admin-edit-worker", que valida sessão, escopo do trabalhador e duplicidade de login.
export type WorkerEditTarget = {
  id: string;
  nome: string;
  login_codigo: string;
  active: boolean;
  notas?: string | null;
};

export default function WorkerEditDialog({ worker, onOpenChange, onSaved }: {
  worker: WorkerEditTarget | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [editNome, setEditNome] = useState("");
  const [editLogin, setEditLogin] = useState("");
  const [editNotas, setEditNotas] = useState("");
  const [editActive, setEditActive] = useState(true);
  // A lista de trabalhadores do Super Admin não expõe a observação. Enquanto ela não
  // for conhecida, o campo fica fora do envio para nunca sobrescrever o valor real.
  const [notasKnown, setNotasKnown] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);

  useEffect(() => {
    if (!worker) return;
    setEditNome(worker.nome);
    setEditLogin(worker.login_codigo);
    setEditActive(worker.active);
    const known = worker.notas !== undefined;
    setNotasKnown(known);
    setEditNotas(known ? (worker.notas ?? "") : "");
    if (known) return;
    let cancel = false;
    supabase.from("workers").select("notas").eq("id", worker.id).maybeSingle()
      .then(({ data, error }: { data?: { notas?: string | null } | null; error?: unknown }) => {
        if (cancel || error || !data) return;
        setNotasKnown(true);
        setEditNotas(data.notas ?? "");
      });
    return () => { cancel = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worker?.id]);

  async function handleSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!worker) return;
    const n = editNome.trim();
    const login = editLogin.trim();
    if (!n) return toast({ title: "Nome obrigatório", variant: "destructive" });
    if (!/^\d{4}$/.test(login)) return toast({ title: "Login deve ter 4 dígitos", variant: "destructive" });
    setSavingEdit(true);
    try {
      const body: Record<string, unknown> = { worker_id: worker.id, nome: n, login_codigo: login, active: editActive };
      if (notasKnown) body.notas = editNotas.trim() || null;
      const { data, error } = await supabase.functions.invoke("admin-edit-worker", { body });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error || "Falha ao salvar");
      toast({ title: "Trabalhador atualizado" });
      onOpenChange(false);
      onSaved();
    } catch (err: any) {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    } finally {
      setSavingEdit(false);
    }
  }

  return (
    <Dialog open={!!worker} onOpenChange={(o) => !o && onOpenChange(false)}>
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
          <p className="text-[11px] text-muted-foreground">
            Pausa, vencimento e mensalidade são controlados apenas pela licença, na aba “Acessos” do SuperAdministrador.
          </p>

          <DialogFooter>
            <Button type="submit" disabled={savingEdit} className="w-full">
              {savingEdit ? <Loader2 className="h-4 w-4 animate-spin" /> : "Salvar alterações"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
