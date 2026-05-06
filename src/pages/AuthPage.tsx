import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { isLoginCodigo } from "@/lib/worker-utils";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

export default function AuthPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  // Login state
  const [identifier, setIdentifier] = useState(""); // email OU 4 dígitos
  const [password, setPassword] = useState("");

  // Forgot state
  const [forgotIdentifier, setForgotIdentifier] = useState("");
  const [forgotLoading, setForgotLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      let emailToUse = identifier.trim();

      if (isLoginCodigo(emailToUse)) {
        const { data, error } = await supabase.rpc("get_synthetic_email_by_login", { p_login: emailToUse });
        if (error) throw error;
        if (!data) throw new Error("Login não encontrado ou trabalhador inativo.");
        emailToUse = data as unknown as string;
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
      const value = forgotIdentifier.trim();
      if (!value) throw new Error("Informe nome ou login.");
      const { error } = await supabase
        .from("worker_password_reset_requests")
        .insert({ identifier: value, status: "pending" } as any);
      if (error) throw error;
      toast.success("Solicitação enviada à administradora.");
      setForgotIdentifier("");
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
          <CardDescription>Entrar com login ou email</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="login">
            <TabsList className="grid w-full grid-cols-2 mb-4">
              <TabsTrigger value="login">Entrar</TabsTrigger>
              <TabsTrigger value="forgot">Esqueci senha</TabsTrigger>
            </TabsList>

            <TabsContent value="login">
              <form onSubmit={handleLogin} className="space-y-3">
                <div>
                  <Label htmlFor="identifier">Login (4 dígitos) ou email</Label>
                  <Input
                    id="identifier"
                    inputMode="text"
                    autoComplete="username"
                    required
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    placeholder="Ex.: 1234 ou seu@email.com"
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
                  Sua solicitação será enviada à administradora, que poderá redefinir sua senha.
                </p>
                <div>
                  <Label htmlFor="forgot-id">Seu nome ou login</Label>
                  <Input
                    id="forgot-id"
                    required
                    value={forgotIdentifier}
                    onChange={(e) => setForgotIdentifier(e.target.value)}
                    placeholder="Nome ou login de 4 dígitos"
                  />
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
