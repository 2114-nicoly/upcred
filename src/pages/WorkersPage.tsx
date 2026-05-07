import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/hooks/use-toast";
import { Loader2, Plus, KeyRound, RefreshCw, Inbox, Archive, ArchiveRestore, Trash2, Eye } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { CredentialsDialog, GeneratedCreds } from "@/components/CredentialsDialog";
import { useConfirm } from "@/hooks/useConfirm";
import { EmptyState } from "@/components/LoadingSkeleton";

type Worker = {
  id: string;
  nome: string;
  login_codigo: string;
  synthetic_email: string;
  active: boolean;
  notas: string | null;
  parent_admin_id: string | null;
  created_at: string;
  auth_user_id: string | null;
};

type AdminOption = { id: string; nome: string };

export default function WorkersPage() {
  const navigate = useNavigate();
  const { isAdmin, isSuperAdmin, loading: authLoading } = useAuth();
  const confirm = useConfirm();

  const [workers, setWorkers] = useState<Worker[]>([]);
  const [admins, setAdmins] = useState<AdminOption[]>([]);
  const [recoveryRequests, setRecoveryRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const [openCreate, setOpenCreate] = useState(false);
  const [nome, setNome] = useState("");
  const [notas, setNotas] = useState("");
  const [parentAdminId, setParentAdminId] = useState<string>("");

  const [creds, setCreds] = useState<GeneratedCreds | null>(null);

  useEffect(() => {
    if (!authLoading && !isAdmin) navigate("/");
  }, [authLoading, isAdmin, navigate]);

  async function load() {
    setLoading(true);
    const wRes = await supabase.from("workers").select("*").order("created_at", { ascending: false });
    const rRes = await supabase.from("password_recovery_requests" as any).select("*").eq("status", "open").order("requested_at", { ascending: false });
    setWorkers((wRes.data as any) || []);
    setRecoveryRequests((rRes.data as any) || []);
    if (isSuperAdmin) {
      const aRes = await supabase.rpc("super_admin_list_admins" as any);
      setAdmins(((aRes.data as any) || []).map((a: any) => ({ id: a.id, nome: a.nome })));
    }
    setLoading(false);
  }

  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin, isSuperAdmin]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!nome.trim()) {
      toast({ title: "Nome obrigatório", variant: "destructive" });
      return;
    }
    if (isSuperAdmin && !parentAdminId) {
      toast({ title: "Selecione a equipe (admin)", variant: "destructive" });
      return;
    }
    setCreating(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-create-user", {
        body: {
          kind: "worker",
          nome: nome.trim(),
          notas: notas.trim() || null,
          parent_admin_id: isSuperAdmin ? parentAdminId : undefined,
        },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error || "Falha ao criar trabalhador");

      setCreds({
        nome: data.nome, role: data.role, login: data.login,
        password: data.password, created_at: data.created_at,
      });
      setNome(""); setNotas(""); setParentAdminId("");
      setOpenCreate(false);
      load();
    } catch (err: any) {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    } finally {
      setCreating(false);
    }
  }

  async function handleToggleActive(w: Worker) {
    const desativando = w.active;
    const ok = await confirm({
      title: desativando ? "Desativar trabalhador?" : "Ativar trabalhador?",
      description: desativando
        ? "O trabalhador perderá acesso ao sistema. Os dados (clientes, empréstimos, caixa) permanecem preservados."
        : "O trabalhador voltará a poder acessar o sistema.",
      affected: [{ label: "Trabalhador", value: w.nome }, { label: "Login", value: w.login_codigo }],
      confirmText: desativando ? "Desativar" : "Ativar",
      destructive: desativando,
    });
    if (!ok) return;
    const { error } = await supabase.rpc("set_worker_active" as any, {
      p_worker_id: w.id, p_active: !w.active,
    });
    if (error) {
      toast({ title: "Erro", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: w.active ? "Trabalhador desativado" : "Trabalhador ativado" });
    load();
  }

  async function handleResetPassword(w: Worker) {
    const ok = await confirm({
      title: "Resetar senha?",
      description: "Uma nova senha temporária de 8 dígitos será gerada. A senha anterior deixará de funcionar.",
      affected: [{ label: "Trabalhador", value: w.nome }, { label: "Login", value: w.login_codigo }],
      confirmText: "Gerar nova senha", destructive: true,
    });
    if (!ok) return;
    const { data, error } = await supabase.functions.invoke("admin-reset-password", {
      body: { target_kind: "worker", target_id: w.id },
    });
    if (error || !data?.ok) {
      toast({ title: "Erro", description: error?.message || data?.error, variant: "destructive" });
      return;
    }
    setCreds({ nome: data.nome, role: data.role, login: data.login, password: data.password, created_at: data.created_at });
  }

  async function resolveRecovery(id: string) {
    await supabase.from("password_recovery_requests" as any)
      .update({ status: "resolved", resolved_at: new Date().toISOString() })
      .eq("id", id);
    load();
  }

  if (authLoading || loading) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }

  return (
    <div className="p-4 space-y-4 max-w-lg mx-auto pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Trabalhadores</h1>
        <Button size="sm" onClick={() => setOpenCreate(true)}>
          <Plus className="h-4 w-4 mr-1" /> Novo
        </Button>
      </div>

      {recoveryRequests.length > 0 && (
        <Card className="border-warning">
          <CardHeader className="p-3 pb-1">
            <CardTitle className="text-sm flex items-center gap-2"><Inbox className="h-4 w-4" /> Solicitações de acesso</CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-1 space-y-2">
            {recoveryRequests.map((r) => (
              <div key={r.id} className="flex items-center justify-between text-sm border rounded p-2">
                <div className="min-w-0">
                  <div className="font-medium truncate">{r.nome_informado || r.login_informado || r.email_informado}</div>
                  <div className="text-xs text-muted-foreground">
                    {r.login_informado && <span>Login: {r.login_informado} · </span>}
                    {new Date(r.requested_at).toLocaleString()}
                  </div>
                </div>
                <Button size="sm" variant="outline" onClick={() => resolveRecovery(r.id)}>Resolver</Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-2 space-y-1">
          {workers.length === 0 ? (
            <EmptyState
              icon={Inbox}
              message="Nenhum trabalhador cadastrado"
              description="Crie um trabalhador para começar a operar a rota."
              actionLabel="Cadastrar trabalhador"
              onAction={() => setOpenCreate(true)}
              compact
            />
          ) : (
            workers.map((w) => (
              <div key={w.id} className="flex items-center gap-2 border rounded p-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm truncate">{w.nome}</span>
                    {!w.active && <Badge variant="secondary" className="text-xs">Inativo</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground">Login: <span className="font-mono">{w.login_codigo}</span></div>
                </div>
                <Switch checked={w.active} onCheckedChange={() => handleToggleActive(w)} />
                <Button size="icon" variant="ghost" onClick={() => handleResetPassword(w)} title="Gerar nova senha">
                  <KeyRound className="h-4 w-4" />
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Button variant="outline" size="sm" className="w-full" onClick={load}>
        <RefreshCw className="h-4 w-4 mr-1" /> Atualizar
      </Button>

      <Dialog open={openCreate} onOpenChange={setOpenCreate}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Novo trabalhador</DialogTitle>
            <DialogDescription>Login de 4 dígitos e senha de 8 números gerados automaticamente.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-3">
            <div>
              <Label htmlFor="nome">Nome</Label>
              <Input id="nome" required value={nome} onChange={(e) => setNome(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="notas">Observação (opcional)</Label>
              <Textarea id="notas" value={notas} onChange={(e) => setNotas(e.target.value)} rows={2} />
            </div>
            {isSuperAdmin && (
              <div>
                <Label>Equipe (admin)</Label>
                <Select value={parentAdminId} onValueChange={setParentAdminId}>
                  <SelectTrigger><SelectValue placeholder="Selecione a equipe" /></SelectTrigger>
                  <SelectContent>
                    {admins.map((a) => (<SelectItem key={a.id} value={a.id}>{a.nome}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <DialogFooter>
              <Button type="submit" disabled={creating} className="w-full">
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : "Criar"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <CredentialsDialog creds={creds} onClose={() => setCreds(null)} />
    </div>
  );
}
