import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { History, Loader2 } from "lucide-react";
import { format } from "date-fns";

type Log = {
  id: string;
  created_at: string;
  action_type: string;
  user_role: string | null;
  old_value: any;
  new_value: any;
  observation: string | null;
};

const ACTION_LABEL: Record<string, string> = {
  criar_cliente: "Criação do cliente",
  editar_cliente: "Edição do cadastro",
  excluir_cliente: "Exclusão do cliente",
  transferencia_cliente: "Transferência de trabalhador",
  anexar_arquivo: "Anexo adicionado",
  excluir_anexo: "Anexo apagado",
};

function describe(log: Log): string {
  const label = ACTION_LABEL[log.action_type] || log.action_type;
  if (log.action_type === "editar_cliente" && log.old_value && log.new_value) {
    const changes: string[] = [];
    const keys = new Set([...Object.keys(log.old_value || {}), ...Object.keys(log.new_value || {})]);
    keys.forEach((k) => {
      const a = log.old_value?.[k];
      const b = log.new_value?.[k];
      if (a !== b) changes.push(`${k}: "${a ?? "—"}" → "${b ?? "—"}"`);
    });
    return changes.length ? `${label}: ${changes.join(", ")}` : label;
  }
  if (log.action_type === "anexar_arquivo") {
    return `${label}: ${log.new_value?.file_name ?? "arquivo"}`;
  }
  if (log.action_type === "excluir_anexo") {
    return `${label}: ${log.old_value?.file_name ?? "arquivo"}`;
  }
  return label;
}

export default function ClientHistory({ clientId }: { clientId: string }) {
  const [logs, setLogs] = useState<Log[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("audit_logs")
        .select("id, created_at, action_type, user_role, old_value, new_value, observation")
        .eq("entity_type", "client")
        .eq("entity_id", clientId)
        .order("created_at", { ascending: false })
        .limit(100);
      setLogs((data as any) || []);
      setLoading(false);
    })();
  }, [clientId]);

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
        <History className="h-3.5 w-3.5" /> Histórico de Alterações
      </h2>
      {loading ? (
        <div className="flex justify-center p-2"><Loader2 className="h-4 w-4 animate-spin" /></div>
      ) : logs.length === 0 ? (
        <Card><CardContent className="p-3 text-center text-xs text-muted-foreground">Nenhum registro.</CardContent></Card>
      ) : (
        <div className="space-y-1">
          {logs.map((l) => (
            <Card key={l.id}>
              <CardContent className="p-2.5 space-y-0.5">
                <p className="text-xs font-medium">{describe(l)}</p>
                <p className="text-[10px] text-muted-foreground">
                  {format(new Date(l.created_at), "dd/MM/yyyy HH:mm")}
                  {l.user_role ? ` • ${l.user_role}` : ""}
                </p>
                {l.observation && <p className="text-[10px] text-muted-foreground italic">{l.observation}</p>}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
