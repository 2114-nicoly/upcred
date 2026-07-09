import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BellRing, Loader2 } from "lucide-react";
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

export default function RemindersAdminList() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancel = false;
    async function load() {
      setLoading(true);
      try {
        const { data, error } = await supabase
          .from("installment_reminders" as any)
          .select("id, installment_id, loan_id, client_id, worker_id, reminded_at, reminded_by_name")
          .order("reminded_at", { ascending: false })
          .limit(200);
        if (error) { console.warn(error); setRows([]); return; }
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

        const rows: Row[] = base.map(r => ({
          ...r,
          worker_name: r.worker_id ? wm.get(r.worker_id) ?? null : null,
          client_name: r.client_id ? cm.get(r.client_id) ?? null : null,
          installment_number: im.get(r.installment_id)?.number ?? null,
          due_date: im.get(r.installment_id)?.due_date ?? null,
        }));
        if (!cancel) setRows(rows);
      } finally {
        if (!cancel) setLoading(false);
      }
    }
    load();
    return () => { cancel = true; };
  }, []);

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <BellRing className="h-4 w-4" /> Lembretes enviados
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-2">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
          </div>
        ) : rows.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">Nenhum lembrete registrado ainda.</p>
        ) : (
          <div className="divide-y">
            {rows.map((r) => (
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
