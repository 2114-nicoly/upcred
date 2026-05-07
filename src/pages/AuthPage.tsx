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

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      let emailToUse = identifier.trim();

      if (!emailToUse.includes("@")) {
        const { data, error } = await supabase.functions.invoke("auth-resolve-login", {
          body: { login: emailToUse },
        });
        if (error) throw error;
        if (!data?.email) throw new Error("Login não encontrado.");
        emailToUse = data.email as string;
      }

      const { error } = await supabase.auth.signInWithPassword({ email: emailToUse, password });
      if (error) throw error;
      toast.success("Bem-vindo!");
      navigate("/", { replace: true });
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
                    placeholder="email, 4 ou 5 dígitos"
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
