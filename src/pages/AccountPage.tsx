import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, LogOut, User as UserIcon, Shield } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

export default function AccountPage() {
  const navigate = useNavigate();
  const { user, isAdmin, isSuperAdmin, workerId, signOut } = useAuth();
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState<{ nome?: string; login?: string; admin?: string }>({});

  useEffect(() => {
    let cancel = false;
    async function load() {
      if (!user) return;
      setLoading(true);
      try {
        if (workerId) {
          const { data: w } = await supabase
            .from("workers")
            .select("nome, login_codigo, parent_admin_id")
            .eq("id", workerId)
            .maybeSingle();
          let adminNome: string | undefined;
          if ((w as any)?.parent_admin_id) {
            const { data: a } = await supabase
              .from("admins" as any)
              .select("nome")
              .eq("id", (w as any).parent_admin_id)
              .maybeSingle();
            adminNome = (a as any)?.nome;
          }
          if (!cancel) setInfo({ nome: (w as any)?.nome, login: (w as any)?.login_codigo, admin: adminNome });
        } else {
          const { data: a } = await supabase
            .from("admins" as any)
            .select("nome, login_codigo")
            .eq("auth_user_id", user.id)
            .maybeSingle();
          if (!cancel) setInfo({ nome: (a as any)?.nome, login: (a as any)?.login_codigo });
        }
      } finally {
        if (!cancel) setLoading(false);
      }
    }
    load();
    return () => { cancel = true; };
  }, [user, workerId]);

  const role = isSuperAdmin ? "Super Administrador" : isAdmin ? "Administrador" : "Trabalhador";

  async function handleSignOut() {
    await signOut();
    toast.success("Sessão encerrada");
    navigate("/auth", { replace: true });
  }

  return (
    <div className="p-3 max-w-md mx-auto pb-24 space-y-3">
      <h1 className="text-xl font-bold">Minha Conta</h1>

      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <UserIcon className="h-4 w-4" /> Dados de acesso
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-2 space-y-2 text-sm">
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>
              <Row label="Nome" value={info.nome ?? "—"} />
              <Row label="Login" value={info.login ?? "—"} mono />
              <Row label="Função" value={role} />
              {info.admin && <Row label="Admin responsável" value={info.admin} />}
              <Row label="Email interno" value={user?.email ?? "—"} mono small />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Shield className="h-4 w-4" /> Senha
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-2 space-y-3">
          {!isAdmin && !isSuperAdmin ? (
            <>
              <p className="text-xs text-muted-foreground">
                Para trocar sua senha, solicite ao seu administrador ou use a opção "Esqueci minha senha" na tela de login.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={async () => {
                  await signOut();
                  navigate("/auth", { replace: true });
                }}
              >
                Ir para tela de login
              </Button>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              Sua senha é gerenciada pelo sistema. Para redefinir, peça ao super administrador.
            </p>
          )}
        </CardContent>
      </Card>

      <Button variant="outline" className="w-full" onClick={handleSignOut}>
        <LogOut className="h-4 w-4 mr-2" /> Sair da conta
      </Button>
    </div>
  );
}

function Row({ label, value, mono, small }: { label: string; value: string; mono?: boolean; small?: boolean }) {
  return (
    <div className="flex justify-between items-center gap-2 border-b last:border-0 pb-1.5 last:pb-0">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className={`${mono ? "font-mono" : ""} ${small ? "text-[11px]" : "text-sm"} font-medium text-right truncate`}>{value}</span>
    </div>
  );
}
