import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { format, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";

type Log = {
  id: string;
  user_id: string | null;
  user_role: string | null;
  worker_id: string | null;
  action_type: string;
  entity_type: string;
  entity_id: string | null;
  old_value: any;
  new_value: any;
  observation: string | null;
  created_at: string;
};

const ACTION_LABELS: Record<string, string> = {
  transferencia_cliente: "Transferência de cliente",
  criar_cliente: "Criar cliente",
  editar_cliente: "Editar cliente",
  excluir_cliente: "Excluir cliente",
  criar_emprestimo: "Criar empréstimo",
  editar_emprestimo: "Editar empréstimo",
  excluir_emprestimo: "Excluir empréstimo",
  renovar_emprestimo: "Renovar empréstimo",
  quitar_emprestimo: "Quitar empréstimo",
  pagamento: "Pagamento",
  editar_pagamento: "Editar pagamento",
  desfazer_pagamento: "Desfazer pagamento",
  nao_pagou: "Não pagou",
  editar_parcela: "Editar parcela",
  alterar_data_parcela: "Alterar data parcela",
  aporte: "Aporte na rota",
  retirada: "Retirada da rota",
  ajuste_caixa: "Ajuste de caixa",
  fechar_caixa: "Fechar caixa",
  criar_trabalhador: "Criar trabalhador",
  reset_senha_trabalhador: "Reset senha",
  ativar_trabalhador: "Ativar trabalhador",
  desativar_trabalhador: "Desativar trabalhador",
};

type Props = {
  workerId?: string | null;
  limit?: number;
};

export default function AuditLogList({ workerId, limit = 100 }: Props) {
  const [logs, setLogs] = useState<Log[]>([]);
  const [workers, setWorkers] = useState<{ id: string; nome: string }[]>([]);
  const [filterAction, setFilterAction] = useState<string>("__all__");
  const [filterWorker, setFilterWorker] = useState<string>(workerId ?? "__all__");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.rpc("admin_list_workers" as any).then(({ data }) => {
      setWorkers((data as any[]) || []);
    });
  }, []);

  useEffect(() => {
    let cancel = false;
    async function load() {
      setLoading(true);
      let q = supabase
        .from("audit_logs" as any)
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (filterAction !== "__all__") q = q.eq("action_type", filterAction);
      const wid = workerId ?? (filterWorker !== "__all__" ? filterWorker : null);
      if (wid) q = q.eq("worker_id", wid);
      if (from) q = q.gte("created_at", from + "T00:00:00");
      if (to) q = q.lte("created_at", to + "T23:59:59");
      const { data } = await q;
      if (!cancel) {
        setLogs((data as unknown as Log[]) || []);
        setLoading(false);
      }
    }
    load();
    return () => { cancel = true; };
  }, [filterAction, filterWorker, from, to, workerId, limit]);

  const workerName = (id: string | null) => id ? (workers.find((w) => w.id === id)?.nome ?? "—") : "Admin";

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div>
          <Label className="text-[10px]">Ação</Label>
          <Select value={filterAction} onValueChange={setFilterAction}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Todas</SelectItem>
              {Object.entries(ACTION_LABELS).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {!workerId && (
          <div>
            <Label className="text-[10px]">Trabalhador</Label>
            <Select value={filterWorker} onValueChange={setFilterWorker}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Todos</SelectItem>
                {workers.map((w) => (
                  <SelectItem key={w.id} value={w.id}>{w.nome}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div>
          <Label className="text-[10px]">De</Label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 text-xs" />
        </div>
        <div>
          <Label className="text-[10px]">Até</Label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 text-xs" />
        </div>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">Carregando…</p>
      ) : logs.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nenhum registro encontrado.</p>
      ) : (
        <div className="space-y-2">
          {logs.map((l) => (
            <Card key={l.id}>
              <CardContent className="p-2.5">
                <div className="flex justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold">
                      {ACTION_LABELS[l.action_type] ?? l.action_type}
                      <span className="ml-1 text-muted-foreground font-normal">· {l.entity_type}</span>
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {l.user_role === "admin" ? "Admin" : workerName(l.worker_id)}
                      {" · "}
                      {format(parseISO(l.created_at), "dd/MM/yy HH:mm", { locale: ptBR })}
                    </p>
                    {l.observation && <p className="text-[11px] mt-1 italic">{l.observation}</p>}
                    {(l.old_value || l.new_value) && (
                      <div className="text-[10px] mt-1 grid grid-cols-2 gap-2">
                        {l.old_value && (
                          <div className="text-muted-foreground">
                            <span className="font-semibold">Antes:</span>{" "}
                            <code className="break-all">{JSON.stringify(l.old_value)}</code>
                          </div>
                        )}
                        {l.new_value && (
                          <div className="text-success">
                            <span className="font-semibold">Depois:</span>{" "}
                            <code className="break-all">{JSON.stringify(l.new_value)}</code>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
