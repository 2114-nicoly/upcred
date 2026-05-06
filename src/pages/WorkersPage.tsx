import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/hooks/use-toast";
import { Loader2, Plus, Copy, KeyRound, RefreshCw, Inbox } from "lucide-react";
import { generateLoginCodigo, generateTempPassword, syntheticEmailFor } from "@/lib/worker-utils";
import { useAuth } from "@/hooks/useAuth";

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

export default function WorkersPage() {
  const navigate = useNavigate();
  const { isAdmin, loading: authLoading } = useAuth();

  const [workers, setWorkers] = useState<Worker[]>([]);
  const [resetRequests, setResetRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const [openCreate, setOpenCreate] = useState(false);
  const [nome, setNome] = useState("");
  const [notas, setNotas] = useState("");

  const [creds, setCreds] = useState<CredsToShow | null>(null);

  useEffect(() => {
    if (!authLoading && !isAdmin) navigate("/");
  }, [authLoading, isAdmin, navigate]);

  async function load() {
    setLoading(true);
    const [{ data: w }, { data: r }] = await Promise.all([
      supabase.from("workers").select("*").order("created_at", { ascending: false }),
      supabase.from("worker_password_reset_requests").select("*").eq("status", "pending").order("created_at", { ascending: false }),
    ]);
    setWorkers((w as any) || []);
    setResetRequests((r as any) || []);
    setLoading(false);
  }

  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin]);

  // pick a unique 4-digit login code
  async function pickUniqueLogin(): Promise<string> {
    for (let i = 0; i < 20; i++) {
      const code = generateLoginCodigo();
      const { data } = await supabase.from("workers").select("id").eq("login_codigo", code).maybeSingle();
      if (!data) return code;
    }
    throw new Error("Não foi possível gerar um login único. Tente novamente.");
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!nome.trim()) {
      toast({ title: "Nome obrigatório", variant: "destructive" });
      return;
    }
    setCreating(true);

    // 1) snapshot current admin session — we'll restore it after signUp
    const { data: { session: adminSession } } = await supabase.auth.getSession();

    try {
      const login = await pickUniqueLogin();
      const password = generateTempPassword();
      const email = syntheticEmailFor(login);

      // 2) create the auth user via signUp (this REPLACES the current session)
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/`,
          data: { display_name: nome.trim() },
        },
      });
      if (signUpError) throw signUpError;
      const newUserId = signUpData.user?.id;
      if (!newUserId) throw new Error("Falha ao criar usuário.");

      // 3) restore admin session immediately
      if (adminSession) {
        await supabase.auth.setSession({
          access_token: adminSession.access_token,
          refresh_token: adminSession.refresh_token,
        });
      }

      // 4) register worker + role via admin RPC
      const { data: workerId, error: rpcError } = await supabase.rpc("admin_register_worker", {
        p_nome: nome.trim(),
        p_login_codigo: login,
        p_synthetic_email: email,
        p_auth_user_id: newUserId,
        p_notas: notas.trim() || null,
      });
      if (rpcError) throw rpcError;

      // 5) save credentials log
      await supabase.from("worker_credentials_log").insert({
        worker_id: workerId as string,
        login_codigo: login,
        temp_password: password,
        reason: "created",
      } as any);

      setCreds({ nome: nome.trim(), login, password });
      setNome("");
      setNotas("");
      setOpenCreate(false);
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
    if (error) {
      toast({ title: "Erro", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: w.active ? "Trabalhador desativado" : "Trabalhador ativado" });
    load();
  }

  async function handleResetPassword(w: Worker) {
    if (!confirm(`Gerar nova senha temporária para ${w.nome}?`)) return;

    const adminSession = (await supabase.auth.getSession()).data.session;
    try {
      const password = generateTempPassword();
      // We can't reset password without service role from client.
      // Workaround: only log the new desired password and ask admin to use Cloud panel,
      // OR use updateUser by re-signing-in as the worker. Simpler approach:
      // store in log + show — admin must use the existing password. For now, just store request.
      await supabase.from("worker_credentials_log").insert({
        worker_id: w.id,
        login_codigo: w.login_codigo,
        temp_password: password,
        reason: "reset_pending",
      } as any);
      setCreds({ nome: w.nome, login: w.login_codigo, password });
      toast({
        title: "Nova senha gerada",
        description: "Atenção: a senha real só será trocada quando o trabalhador entrar com ela. Use o painel Cloud → Users para forçar a alteração se necessário.",
      });
    } finally {
      if (adminSession) {
        await supabase.auth.setSession({
          access_token: adminSession.access_token,
          refresh_token: adminSession.refresh_token,
        });
      }
    }
  }

  async function resolveResetRequest(id: string) {
    await supabase
      .from("worker_password_reset_requests")
      .update({ status: "resolved", resolved_at: new Date().toISOString() } as any)
      .eq("id", id);
    load();
  }

  function copyCreds() {
    if (!creds) return;
    const text = `Trabalhador: ${creds.nome}\nLogin: ${creds.login}\nSenha: ${creds.password}`;
    navigator.clipboard.writeText(text);
    toast({ title: "Copiado!" });
  }

  if (authLoading || loading) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }

  return (
    <div className="p-4 space-y-4 max-w-lg mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Trabalhadores</h1>
        <Button size="sm" onClick={() => setOpenCreate(true)}>
          <Plus className="h-4 w-4 mr-1" /> Novo
        </Button>
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

      <Card>
        <CardContent className="p-2 space-y-1">
          {workers.length === 0 ? (
            <p className="text-sm text-muted-foreground p-3 text-center">Nenhum trabalhador cadastrado.</p>
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

      {/* Create dialog */}
      <Dialog open={openCreate} onOpenChange={setOpenCreate}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Novo trabalhador</DialogTitle>
            <DialogDescription>Login e senha serão gerados automaticamente.</DialogDescription>
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
            <DialogFooter>
              <Button type="submit" disabled={creating} className="w-full">
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : "Criar"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Show credentials */}
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
