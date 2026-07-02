import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { KeyRound, Loader2, Lock } from "lucide-react";
import { CredentialsDialog, GeneratedCreds } from "@/components/CredentialsDialog";
import { toast } from "sonner";
import { format } from "date-fns";
import { requireAudit, getCurrentActorIdentity, AuditRequiredError } from "@/lib/audit-utils";


type Props = {
  targetKind: "admin" | "worker";
  targetId: string;
  loginCodigo: string | null | undefined;
  nome: string;
  active: boolean;
  archivedAt?: string | null;
};

type Latest = {
  login_codigo: string;
  temp_password: string;
  created_at: string;
  reason: string;
  status: string;
};

export default function AccessSection({ targetKind, targetId, loginCodigo, nome, active, archivedAt }: Props) {
  const [latest, setLatest] = useState<Latest | null>(null);
  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState(false);
  const [creds, setCreds] = useState<GeneratedCreds | null>(null);

  async function loadLatest() {
    setLoading(true);
    const { data, error } = await supabase.rpc("get_latest_credential" as any, {
      p_kind: targetKind,
      p_target_id: targetId,
    });
    if (!error && Array.isArray(data) && data.length > 0) {
      setLatest(data[0] as Latest);
    } else {
      setLatest(null);
    }
    setLoading(false);
  }

  useEffect(() => {
    loadLatest();
  }, [targetKind, targetId]);

  async function reset() {
    if (!confirm(`Gerar nova senha para ${nome}? A senha atual deixará de funcionar.`)) return;
    setResetting(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-reset-password", {
        body: { target_kind: targetKind, target_id: targetId },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      const r = data as any;
      setCreds({
        nome: r.nome,
        role: r.role,
        login: r.login,
        password: r.password,
        created_at: r.created_at,
      });
      toast.success("Nova senha gerada");
      loadLatest();
    } catch (e: any) {
      toast.error(e?.message || "Falha ao redefinir senha");
    } finally {
      setResetting(false);
    }
  }

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-1">
            <Lock className="h-4 w-4" /> Acesso
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3 space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-xs">Login</span>
            <span className="font-mono font-bold">{loginCodigo || "—"}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-xs">Status</span>
            <div className="flex gap-1">
              {active ? (
                <Badge className="text-[10px]">Ativo</Badge>
              ) : (
                <Badge variant="secondary" className="text-[10px]">Inativo</Badge>
              )}
              {archivedAt && <Badge variant="outline" className="text-[10px]">Arquivado</Badge>}
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-xs">Última redefinição</span>
            <span className="text-xs">
              {loading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : latest ? (
                <>
                  {format(new Date(latest.created_at), "dd/MM/yyyy HH:mm")}
                  <Badge variant="outline" className="ml-1 text-[9px]">{latest.reason}</Badge>
                </>
              ) : (
                "—"
              )}
            </span>
          </div>
          <Button onClick={reset} disabled={resetting} className="w-full mt-2" size="sm">
            {resetting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <KeyRound className="h-4 w-4 mr-1" />}
            Gerar nova senha
          </Button>
          <p className="text-[10px] text-muted-foreground">
            A senha gerada aparece uma única vez para você copiar e enviar ao usuário.
          </p>
        </CardContent>
      </Card>
      <CredentialsDialog creds={creds} onClose={() => setCreds(null)} />
    </>
  );
}
