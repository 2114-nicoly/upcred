import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

export default function AuthPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");

  const [forgotLogin, setForgotLogin] = useState("");
  const [forgotNome, setForgotNome] = useState("");
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotLoading, setForgotLoading] = useState(false);


  const trySignIn = async (email: string, pwd: string) => {
    return await supabase.auth.signInWithPassword({ email, password: pwd });
  };

  const resolveEmailViaFn = async (login: string): Promise<string | null> => {
    try {
      const { data, error } = await supabase.functions.invoke("auth-resolve-login", { body: { login } });
      if (error || !data?.email) return null;
      return data.email as string;
    } catch {
      return null;
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const raw = identifier.trim().toLowerCase();
      const pwd = password.trim();
      if (!raw || !pwd) throw new Error("Informe login e senha.");

      const candidates: string[] = [];
      if (raw.includes("@")) {
        candidates.push(raw);
      } else {
        const digits = raw.replace(/\D/g, "");
        if (/^\d{4}$/.test(digits)) {
          // Trabalhador — tenta padrões deterministas, sem precisar consultar o DB antes
          candidates.push(`w${digits}@upcred.local`);
          candidates.push(`worker_${digits}@upcred.local`);
        } else if (/^\d{5}$/.test(digits)) {
          // Admin — padrão novo determinístico + fallback para email_real via edge function
          candidates.push(`admin_${digits}@upcred.local`);
        } else {
          throw new Error("Formato de login inválido. Use 4 dígitos (trabalhador), 5 dígitos (admin) ou email.");
        }
      }

      let lastError: any = null;
      for (const email of candidates) {
        const { error } = await trySignIn(email, pwd);
        if (!error) {
          toast.success("Bem-vindo!");
          navigate("/", { replace: true });
          return;
        }
        lastError = error;
        // Se for "email not confirmed" tenta próximo candidato
      }

      // Fallback: chamar a edge function (que também confirma o email se necessário)
      // e tentar de novo, mesmo que o email seja igual a um já tentado — pois a confirmação
      // pendente pode ter sido o motivo da falha.
      if (!raw.includes("@")) {
        const resolved = await resolveEmailViaFn(raw);
        if (resolved) {
          const { error } = await trySignIn(resolved, pwd);
          if (!error) {
            toast.success("Bem-vindo!");
            navigate("/", { replace: true });
            return;
          }
          lastError = error;
        }
      }

      const msg = (lastError?.message || "").toLowerCase();
      if (msg.includes("email not confirmed")) {
        throw new Error("Conta ainda não confirmada. Peça ao administrador para gerar uma nova senha.");
      }
      if (msg.includes("invalid login credentials")) {
        throw new Error("Login ou senha incorretos. Confira o código numérico e a senha de 8 dígitos.");
      }
      throw new Error(lastError?.message || "Login não encontrado.");
    } catch (err: any) {
      toast.error(err?.message || "Erro ao entrar");
    } finally {
      setLoading(false);
    }
  };

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    setForgotLoading(true);
    try {
      if (!forgotLogin && !forgotNome && !forgotEmail) {
        throw new Error("Informe pelo menos um campo.");
      }
      const { error } = await supabase.rpc("register_recovery_request" as any, {
        p_login: forgotLogin || null,
        p_nome: forgotNome || null,
        p_email: forgotEmail || null,
      });
      if (error) throw error;
      toast.success("Solicitação enviada. Aguarde contato do administrador.");
      setForgotLogin(""); setForgotNome(""); setForgotEmail("");
    } catch (err: any) {
      toast.error(err?.message || "Erro ao enviar solicitação");
    } finally {
      setForgotLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">UpCred</CardTitle>
          <CardDescription>Acesso seguro</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="login">
            <TabsList className="grid w-full grid-cols-2 mb-4">
              <TabsTrigger value="login">Entrar</TabsTrigger>
              <TabsTrigger value="forgot">Esqueci</TabsTrigger>
            </TabsList>

            <TabsContent value="login">
              <form onSubmit={handleLogin} className="space-y-3">
                <div>
                  <Label htmlFor="identifier">Login</Label>
                  <Input
                    id="identifier"
                    inputMode="text"
                    autoComplete="username"
                    required
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    placeholder="4 dígitos, 5 dígitos ou email"
                  />
                </div>
                <div>
                  <Label htmlFor="password">Senha</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Entrar"}
                </Button>
              </form>
            </TabsContent>

            <TabsContent value="forgot">
              <form onSubmit={handleForgot} className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Sua solicitação será enviada ao administrador responsável, que poderá redefinir sua senha.
                </p>
                <div>
                  <Label className="text-xs">Login (se souber)</Label>
                  <Input value={forgotLogin} onChange={(e) => setForgotLogin(e.target.value)} placeholder="4 ou 5 dígitos" />
                </div>
                <div>
                  <Label className="text-xs">Nome</Label>
                  <Input value={forgotNome} onChange={(e) => setForgotNome(e.target.value)} />
                </div>
                <div>
                  <Label className="text-xs">Email (se aplicável)</Label>
                  <Input type="email" value={forgotEmail} onChange={(e) => setForgotEmail(e.target.value)} />
                </div>
                <Button type="submit" className="w-full" disabled={forgotLoading}>
                  {forgotLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Solicitar"}
                </Button>
              </form>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
