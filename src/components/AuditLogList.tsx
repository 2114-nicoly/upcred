import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { format, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import { useAuth } from "@/hooks/useAuth";
import { EmptyState } from "@/components/LoadingSkeleton";
import { FileSearch, Eye } from "lucide-react";
import { formatCurrency } from "@/lib/loan-utils";

type Log = {
  id: string;
  user_id: string | null;
  user_role: string | null;
  worker_id: string | null;
  admin_id: string | null;
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
  criar_cliente: "Criar cliente", editar_cliente: "Editar cliente", excluir_cliente: "Arquivar cliente",
  criar_emprestimo: "Criar empréstimo",
  criar_emprestimo_importado: "Empréstimo importado",
  editar_emprestimo: "Editar empréstimo", excluir_emprestimo: "Cancelar empréstimo",
  editar_observacao_emprestimo: "Editar obs. empréstimo",
  renovar_emprestimo: "Renovar empréstimo", quitar_emprestimo: "Quitar empréstimo",
  pagamento: "Pagamento", editar_pagamento: "Editar pagamento", desfazer_pagamento: "Desfazer pagamento", nao_pagou: "Não pagou",
  editar_parcela: "Editar parcela", alterar_data_parcela: "Reorganizar parcelas",
  multa_aplicada: "Multa aplicada", multa_paga: "Multa paga", multa_cancelada: "Multa cancelada", editar_multa: "Editar multa",
  anexar_arquivo: "Anexar arquivo", excluir_anexo: "Excluir anexo",
  aporte: "Aporte na rota", retirada: "Retirada da rota", ajuste_caixa: "Ajuste de caixa",
  fechar_caixa: "Fechar caixa", reabrir_caixa: "Reabrir caixa",
  criar_trabalhador: "Criar trabalhador", reset_senha_trabalhador: "Reset senha",
  ativar_trabalhador: "Ativar trabalhador", desativar_trabalhador: "Desativar trabalhador",
  arquivar_trabalhador: "Arquivar trabalhador", excluir_trabalhador: "Excluir trabalhador",
  ativar_admin: "Ativar admin", desativar_admin: "Desativar admin",
};

type Props = { workerId?: string | null; limit?: number };

function extractAmount(v: any): number | null {
  if (!v || typeof v !== "object") return null;
  const keys = [
    "amount", "total_amount", "value",
    "remaining_balance", "released",
    "initial_remaining_balance", "principal_receivable",
  ];
  for (const k of keys) {
    if (v[k] != null && !isNaN(Number(v[k]))) return Number(v[k]);
  }
  return null;
}

function getLogAmount(l: Log): number | null {
  return extractAmount(l.new_value) ?? extractAmount(l.old_value);
}

function getRelatedClientId(l: Log): string | null {
  if (l.entity_type === "client" && l.entity_id) return l.entity_id;
  const fromNew = l.new_value && typeof l.new_value === "object" ? l.new_value.client_id : null;
  const fromOld = l.old_value && typeof l.old_value === "object" ? l.old_value.client_id : null;
  return fromNew || fromOld || null;
}

function diffEntries(oldV: any, newV: any): Array<{ key: string; before: any; after: any }> {
  const out: Array<{ key: string; before: any; after: any }> = [];
  const keys = new Set<string>();
  if (oldV && typeof oldV === "object") Object.keys(oldV).forEach((k) => keys.add(k));
  if (newV && typeof newV === "object") Object.keys(newV).forEach((k) => keys.add(k));
  for (const k of Array.from(keys).sort()) {
    const a = oldV?.[k];
    const b = newV?.[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    out.push({ key: k, before: a, after: b });
  }
  return out;
}

function renderValue(v: any): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "sim" : "não";
  try { return JSON.stringify(v); } catch { return String(v); }
}

export default function AuditLogList({ workerId, limit = 200 }: Props) {
  const { isSuperAdmin } = useAuth();
  const [logs, setLogs] = useState<Log[]>([]);
  const [workers, setWorkers] = useState<{ id: string; nome: string; parent_admin_id?: string | null }[]>([]);
  const [admins, setAdmins] = useState<{ id: string; nome: string }[]>([]);
  const [clientsMap, setClientsMap] = useState<Record<string, string>>({});
  const [filterAction, setFilterAction] = useState<string>("__all__");
  const [filterAdmin, setFilterAdmin] = useState<string>("__all__");
  const [filterWorker, setFilterWorker] = useState<string>(workerId ?? "__all__");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [search, setSearch] = useState("");
  const [clientSearch, setClientSearch] = useState("");
  const [minValue, setMinValue] = useState("");
  const [maxValue, setMaxValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [openLog, setOpenLog] = useState<Log | null>(null);

  useEffect(() => {
    if (isSuperAdmin) {
      supabase.rpc("super_admin_list_admins" as any).then(({ data }) => setAdmins((data as any[]) || []));
    }
  }, [isSuperAdmin]);

  useEffect(() => {
    const adminParam = isSuperAdmin && filterAdmin !== "__all__" ? filterAdmin : null;
    supabase.rpc("list_workers_by_admin" as any, { p_admin_id: adminParam }).then(({ data }) => {
      setWorkers((data as any[]) || []);
    });
  }, [isSuperAdmin, filterAdmin]);

  useEffect(() => { if (!workerId) setFilterWorker("__all__"); }, [filterAdmin, workerId]);

  useEffect(() => {
    let cancel = false;
    async function load() {
      setLoading(true);
      let q = supabase.from("audit_logs" as any)
        .select("*").order("created_at", { ascending: false }).limit(limit);
      if (filterAction !== "__all__") q = q.eq("action_type", filterAction);
      if (isSuperAdmin && filterAdmin !== "__all__") q = q.eq("admin_id", filterAdmin);
      const wid = workerId ?? (filterWorker !== "__all__" ? filterWorker : null);
      if (wid) q = q.eq("worker_id", wid);
      if (from) q = q.gte("created_at", from + "T00:00:00");
      if (to) q = q.lte("created_at", to + "T23:59:59");
      const { data } = await q;
      const loaded = (data as unknown as Log[]) || [];

      // Resolve client names
      const cids = new Set<string>();
      loaded.forEach((l) => { const cid = getRelatedClientId(l); if (cid) cids.add(cid); });
      if (cids.size > 0) {
        const { data: cs } = await supabase.from("clients").select("id, name").in("id", Array.from(cids));
        const map: Record<string, string> = {};
        (cs || []).forEach((c: any) => { map[c.id] = c.name; });
        if (!cancel) setClientsMap(map);
      } else if (!cancel) {
        setClientsMap({});
      }

      if (!cancel) {
        setLogs(loaded);
        setLoading(false);
      }
    }
    load();
    return () => { cancel = true; };
  }, [filterAction, filterAdmin, filterWorker, from, to, workerId, limit, isSuperAdmin]);

  const workerName = (id: string | null) => id ? (workers.find((w) => w.id === id)?.nome ?? "—") : "Admin";
  const adminName = (id: string | null) => id ? (admins.find((a) => a.id === id)?.nome ?? "—") : null;
  const clientName = (l: Log) => {
    const cid = getRelatedClientId(l);
    return cid ? (clientsMap[cid] ?? null) : null;
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const qc = clientSearch.trim().toLowerCase();
    const min = minValue ? Number(minValue) : null;
    const max = maxValue ? Number(maxValue) : null;
    return logs.filter((l) => {
      if (q) {
        const label = (ACTION_LABELS[l.action_type] || l.action_type).toLowerCase();
        const hay = `${label} ${l.entity_type} ${l.entity_id ?? ""} ${l.observation ?? ""} ${JSON.stringify(l.new_value ?? "")} ${JSON.stringify(l.old_value ?? "")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (qc) {
        const name = clientName(l)?.toLowerCase() ?? "";
        if (!name.includes(qc)) return false;
      }
      if (min != null || max != null) {
        const amt = getLogAmount(l);
        if (amt == null) return false;
        if (min != null && amt < min) return false;
        if (max != null && amt > max) return false;
      }
      return true;
    });
  }, [logs, search, clientSearch, minValue, maxValue, clientsMap]);

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
        {isSuperAdmin && !workerId && (
          <div>
            <Label className="text-[10px]">Admin</Label>
            <Select value={filterAdmin} onValueChange={setFilterAdmin}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Todos</SelectItem>
                {admins.map((a) => (<SelectItem key={a.id} value={a.id}>{a.nome}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
        )}
        {!workerId && (
          <div>
            <Label className="text-[10px]">Trabalhador</Label>
            <Select value={filterWorker} onValueChange={setFilterWorker}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Todos</SelectItem>
                {workers.map((w) => (<SelectItem key={w.id} value={w.id}>{w.nome}</SelectItem>))}
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
        <div>
          <Label className="text-[10px]">Cliente</Label>
          <Input placeholder="Nome..." value={clientSearch} onChange={(e) => setClientSearch(e.target.value)} className="h-8 text-xs" />
        </div>
        <div>
          <Label className="text-[10px]">Valor mín.</Label>
          <Input type="number" inputMode="decimal" value={minValue} onChange={(e) => setMinValue(e.target.value)} className="h-8 text-xs" />
        </div>
        <div>
          <Label className="text-[10px]">Valor máx.</Label>
          <Input type="number" inputMode="decimal" value={maxValue} onChange={(e) => setMaxValue(e.target.value)} className="h-8 text-xs" />
        </div>
        <div className="col-span-2 md:col-span-4">
          <Label className="text-[10px]">Buscar texto</Label>
          <Input placeholder="Observação, ação, id..." value={search} onChange={(e) => setSearch(e.target.value)} className="h-8 text-xs" />
        </div>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">Carregando…</p>
      ) : filtered.length === 0 ? (
        <EmptyState icon={FileSearch} message="Nenhum registro encontrado" description="Ajuste os filtros para tentar novamente." compact />
      ) : (
        <>
          <p className="text-[10px] text-muted-foreground">{filtered.length} de {logs.length} registros</p>
          <div className="space-y-2">
            {filtered.map((l) => {
              const amt = getLogAmount(l);
              const cname = clientName(l);
              return (
                <Card key={l.id}>
                  <CardContent className="p-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold">
                          {ACTION_LABELS[l.action_type] ?? l.action_type}
                          {amt != null && (
                            <Badge variant="outline" className="ml-1.5 text-[9px] h-4">{formatCurrency(amt)}</Badge>
                          )}
                        </p>
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          {l.user_role === "super_admin" ? "Super Admin"
                            : l.user_role === "admin" ? `Admin${adminName(l.admin_id) ? ` · ${adminName(l.admin_id)}` : ""}`
                            : workerName(l.worker_id)}
                          {isSuperAdmin && l.user_role === "trabalhador" && adminName(l.admin_id) && (
                            <span className="ml-1">· {adminName(l.admin_id)}</span>
                          )}
                          {cname && <span className="ml-1">· {cname}</span>}
                          {" · "}
                          {format(parseISO(l.created_at), "dd/MM/yy HH:mm", { locale: ptBR })}
                        </p>
                        {l.observation && <p className="text-[11px] mt-1 italic line-clamp-2">{l.observation}</p>}
                      </div>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-[10px]" onClick={() => setOpenLog(l)}>
                        <Eye className="h-3 w-3 mr-1" /> Detalhes
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </>
      )}

      <Dialog open={!!openLog} onOpenChange={(o) => !o && setOpenLog(null)}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          {openLog && (
            <>
              <DialogHeader>
                <DialogTitle className="text-base">
                  {ACTION_LABELS[openLog.action_type] ?? openLog.action_type}
                </DialogTitle>
                <DialogDescription className="text-[11px]">
                  {format(parseISO(openLog.created_at), "dd/MM/yyyy HH:mm:ss", { locale: ptBR })}
                  {" · "}
                  {openLog.user_role === "super_admin" ? "Super Admin"
                    : openLog.user_role === "admin" ? `Admin${adminName(openLog.admin_id) ? ` · ${adminName(openLog.admin_id)}` : ""}`
                    : workerName(openLog.worker_id)}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-2 text-xs">
                {clientName(openLog) && (
                  <div><span className="font-semibold">Cliente:</span> {clientName(openLog)}</div>
                )}
                <div><span className="font-semibold">Entidade:</span> {openLog.entity_type}{openLog.entity_id ? ` · ${openLog.entity_id.slice(0, 8)}…` : ""}</div>
                {openLog.observation && (
                  <div className="rounded bg-muted/50 p-2 italic">{openLog.observation}</div>
                )}

                {(() => {
                  const diff = diffEntries(openLog.old_value, openLog.new_value);
                  if (diff.length === 0) {
                    return (
                      <div className="space-y-2">
                        {openLog.old_value && (
                          <div>
                            <p className="font-semibold text-muted-foreground mb-1">Antes</p>
                            <pre className="text-[10px] bg-muted/40 p-2 rounded overflow-x-auto">{JSON.stringify(openLog.old_value, null, 2)}</pre>
                          </div>
                        )}
                        {openLog.new_value && (
                          <div>
                            <p className="font-semibold text-success mb-1">Depois</p>
                            <pre className="text-[10px] bg-success/5 p-2 rounded overflow-x-auto">{JSON.stringify(openLog.new_value, null, 2)}</pre>
                          </div>
                        )}
                      </div>
                    );
                  }
                  return (
                    <div>
                      <p className="font-semibold mb-1">Alterações</p>
                      <div className="border rounded overflow-hidden">
                        <table className="w-full text-[10px]">
                          <thead className="bg-muted/50">
                            <tr>
                              <th className="text-left p-1.5">Campo</th>
                              <th className="text-left p-1.5">Antes</th>
                              <th className="text-left p-1.5">Depois</th>
                            </tr>
                          </thead>
                          <tbody>
                            {diff.map((d) => (
                              <tr key={d.key} className="border-t">
                                <td className="p-1.5 font-mono">{d.key}</td>
                                <td className="p-1.5 text-muted-foreground break-all">{renderValue(d.before)}</td>
                                <td className="p-1.5 text-success break-all">{renderValue(d.after)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })()}

                <p className="text-[9px] text-muted-foreground pt-1">ID: {openLog.id}</p>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
