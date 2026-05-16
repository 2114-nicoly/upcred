import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Bell, Loader2, KeyRound } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CredentialsDialog, GeneratedCreds } from "@/components/CredentialsDialog";
import { toast } from "sonner";
import { format } from "date-fns";

type Alert = {
  id: string;
  login_informado: string | null;
  nome_informado: string | null;
  email_informado: string | null;
  target_role: string | null;
  target_admin_id: string | null;
  requested_at: string;
};

export default function PasswordRecoveryBell() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creds, setCreds] = useState<GeneratedCreds | null>(null);
  const [open, setOpen] = useState(false);

  async function load() {
    setLoading(true);
    const { data } = await supabase.rpc("list_password_recovery_alerts" as any);
    setAlerts((data as Alert[]) || []);
    setLoading(false);
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  async function resolve(a: Alert) {
    if (!a.login_informado) {
      toast.error("Sem login informado — peça ao usuário para informar o número");
      return;
    }
    setBusyId(a.id);
    try {
      // resolve target by login: try worker first, then admin
      const { data: w } = await supabase
        .from("workers")
        .select("id, parent_admin_id")
        .eq("login_codigo", a.login_informado)
        .maybeSingle();
      let kind: "admin" | "worker" = "worker";
      let targetId: string | null = w?.id ?? null;
      if (!targetId) {
        const { data: ad } = await supabase
          .from("admins")
          .select("id")
          .eq("login_codigo", a.login_informado)
          .maybeSingle();
        if (ad) {
          kind = "admin";
          targetId = ad.id;
        }
      }
      if (!targetId) {
        toast.error("Login não encontrado");
        return;
      }
      const { data, error } = await supabase.functions.invoke("admin-reset-password", {
        body: { target_kind: kind, target_id: targetId },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      const r = data as any;
      await supabase
        .from("password_recovery_requests")
        .update({ status: "resolved", resolved_at: new Date().toISOString() })
        .eq("id", a.id);
      setCreds({ nome: r.nome, role: r.role, login: r.login, password: r.password, created_at: r.created_at });
      if (a.login_informado) {
        await supabase
          .from("worker_password_reset_requests")
          .update({ status: "resolved", resolved_at: new Date().toISOString() } as any)
          .eq("identifier", a.login_informado)
          .eq("status", "pending");
      }
      toast.success("Senha redefinida");
      load();
    } catch (e: any) {
      toast.error(e?.message || "Falha");
    } finally {
      setBusyId(null);
    }
  }

  async function dismiss(a: Alert) {
    await supabase
      .from("password_recovery_requests")
      .update({ status: "dismissed", resolved_at: new Date().toISOString() })
      .eq("id", a.id);
    load();
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            className="relative rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            aria-label="Solicitações de senha"
          >
            <Bell className="h-5 w-5" />
            {alerts.length > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-bold text-destructive-foreground">
                {alerts.length}
              </span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 p-0">
          <div className="border-b px-3 py-2">
            <p className="text-sm font-semibold">Solicitações de senha</p>
            <p className="text-[11px] text-muted-foreground">
              Usuários que clicaram em "Esqueci minha senha"
            </p>
          </div>
          <div className="max-h-80 overflow-y-auto p-2 space-y-2">
            {loading ? (
              <div className="flex justify-center py-4">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : alerts.length === 0 ? (
              <p className="text-center text-xs text-muted-foreground py-4">Nenhuma solicitação aberta.</p>
            ) : (
              alerts.map((a) => (
                <div key={a.id} className="rounded border p-2 space-y-1">
                  <div className="flex items-center justify-between gap-1">
                    <p className="text-xs font-medium truncate">
                      {a.nome_informado || "—"}
                      <Badge variant="outline" className="ml-1 text-[9px]">
                        {a.target_role || "?"}
                      </Badge>
                    </p>
                    <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                      {format(new Date(a.requested_at), "dd/MM HH:mm")}
                    </span>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    {a.login_informado && <>Login: <span className="font-mono">{a.login_informado}</span></>}
                    {a.email_informado && <> · {a.email_informado}</>}
                  </p>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      className="flex-1 h-7 text-xs"
                      disabled={busyId === a.id}
                      onClick={() => resolve(a)}
                    >
                      {busyId === a.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <>
                          <KeyRound className="h-3 w-3 mr-1" /> Gerar senha
                        </>
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => dismiss(a)}
                    >
                      Dispensar
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>
      <CredentialsDialog creds={creds} onClose={() => setCreds(null)} />
    </>
  );
}
