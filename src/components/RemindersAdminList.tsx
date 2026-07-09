import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { BellRing, Loader2, X } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

type Row = {
  id: string;
  installment_id: string;
  loan_id: string;
  client_id: string | null;
  worker_id: string | null;
  reminded_at: string;
  reminded_by_name: string | null;
  worker_name?: string | null;
  client_name?: string | null;
  installment_number?: number | null;
  due_date?: string | null;
};

type WorkerOpt = { id: string; nome: string };

export default function RemindersAdminList() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [workers, setWorkers] = useState<WorkerOpt[]>([]);

  // filters
  const [workerId, setWorkerId] = useState<string>("all");
  const [clientQuery, setClientQuery] = useState<string>("");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");

  useEffect(() => {
    let cancel = false;
    async function load() {
      setLoading(true);
      try {
        let q = supabase
          .from("installment_reminders" as any)
          .select("id, installment_id, loan_id, client_id, worker_id, reminded_at, reminded_by_name")
          .order("reminded_at", { ascending: false })
          .limit(500);

        if (workerId !== "all") q = q.eq("worker_id", workerId);
        if (fromDate) q = q.gte("reminded_at", `${fromDate}T00:00:00`);
        if (toDate) q = q.lte("reminded_at", `${toDate}T23:59:59`);

        const { data, error } = await q;
        if (error) { console.warn(error); if (!cancel) setRows([]); return; }
        const base = (data as any[]) || [];
        const workerIds = Array.from(new Set(base.map(r => r.worker_id).filter(Boolean)));
        const clientIds = Array.from(new Set(base.map(r => r.client_id).filter(Boolean)));
        const instIds = Array.from(new Set(base.map(r => r.installment_id).filter(Boolean)));

        const [workersRes, clientsRes, instRes] = await Promise.all([
          workerIds.length
            ? supabase.from("workers").select("id, nome").in("id", workerIds)
            : Promise.resolve({ data: [] as any[] }),
          clientIds.length
            ? supabase.from("clients").select("id, name").in("id", clientIds)
            : Promise.resolve({ data: [] as any[] }),
          instIds.length
            ? supabase.from("installments").select("id, number, due_date").in("id", instIds)
            : Promise.resolve({ data: [] as any[] }),
        ]);

        const wm = new Map<string, string>();
        for (const w of (workersRes.data as any[]) || []) wm.set(w.id, w.nome);
        const cm = new Map<string, string>();
        for (const c of (clientsRes.data as any[]) || []) cm.set(c.id, c.name);
        const im = new Map<string, { number: number; due_date: string }>();
        for (const i of (instRes.data as any[]) || []) im.set(i.id, { number: i.number, due_date: i.due_date });

        const mapped: Row[] = base.map(r => ({
          ...r,
          worker_name: r.worker_id ? wm.get(r.worker_id) ?? null : null,
          client_name: r.client_id ? cm.get(r.client_id) ?? null : null,
          installment_number: im.get(r.installment_id)?.number ?? null,
          due_date: im.get(r.installment_id)?.due_date ?? null,
        }));
        if (!cancel) setRows(mapped);
      } finally {
        if (!cancel) setLoading(false);
      }
    }
    load();
    return () => { cancel = true; };
  }, [workerId, fromDate, toDate]);

  // Load available workers for the filter (scoped by RLS — admin only sees own team).
  useEffect(() => {
    let cancel = false;
    (async () => {
      const { data } = await supabase.rpc("admin_list_workers", { p_include_archived: true } as any);
      if (!cancel && Array.isArray(data)) {
        setWorkers((data as any[]).map(w => ({ id: w.id, nome: w.nome })));
      }
    })();
    return () => { cancel = true; };
  }, []);

  const filtered = useMemo(() => {
    const q = clientQuery.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r => (r.client_name || "").toLowerCase().includes(q));
  }, [rows, clientQuery]);

  const clearFilters = () => {
    setWorkerId("all");
    setClientQuery("");
    setFromDate("");
    setToDate("");
  };

  const hasFilters = workerId !== "all" || clientQuery || fromDate || toDate;

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <BellRing className="h-4 w-4" /> Lembretes enviados ({filtered.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-2 space-y-3">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <div>
            <Label className="text-[10px] text-muted-foreground">Trabalhador</Label>
            <Select value={workerId} onValueChange={setWorkerId}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                {workers.map(w => (
                  <SelectItem key={w.id} value={w.id}>{w.nome}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-[10px] text-muted-foreground">Cliente</Label>
            <Input
              value={clientQuery}
              onChange={(e) => setClientQuery(e.target.value)}
              placeholder="Buscar por nome"
              className="h-8 text-xs"
            />
          </div>
          <div>
            <Label className="text-[10px] text-muted-foreground">De</Label>
            <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-8 text-xs" />
          </div>
          <div>
            <Label className="text-[10px] text-muted-foreground">Até</Label>
            <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-8 text-xs" />
          </div>
        </div>
        {hasFilters && (
          <div>
            <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={clearFilters}>
              <X className="h-3 w-3 mr-1" /> Limpar filtros
            </Button>
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">Nenhum lembrete encontrado.</p>
        ) : (
          <div className="divide-y">
            {filtered.map((r) => (
              <div key={r.id} className="py-2 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{r.client_name || "Cliente"}</p>
                  <p className="text-[11px] text-muted-foreground">
                    Trabalhador: {r.worker_name || r.reminded_by_name || "—"}
                    {r.installment_number != null && ` • Parcela ${r.installment_number}`}
                    {r.due_date && ` • Vence ${format(new Date(r.due_date + "T12:00:00"), "dd/MM/yyyy")}`}
                  </p>
                </div>
                <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums">
                  {format(new Date(r.reminded_at), "dd/MM/yyyy HH:mm", { locale: ptBR })}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
