import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/hooks/use-toast";
import { Check, X, DoorOpen, Loader2, RefreshCw } from "lucide-react";
import { format } from "date-fns";

export type CashReopenRequest = {
  id: string;
  cash_date: string;
  reason: string | null;
  requested_at: string;
  worker_id: string | null;
  worker_name: string | null;
  admin_id: string | null;
  request_type: string | null;
  daily_cash_id: string | null;
};

type HookOptions = {
  /** Admin: escopo obrigatório da própria empresa. SuperAdmin: null/undefined + superAdmin=true. */
  adminId?: string | null;
  /** SuperAdmin vê todas as empresas, agrupadas por admin_id. */
  superAdmin?: boolean;
  enabled?: boolean;
};

const SELECT =
  "id, cash_date, reason, requested_at, worker_id, worker_name, admin_id, request_type, daily_cash_id";

/**
 * Fonte única das solicitações de reabertura pendentes.
 * O contador e a lista vêm sempre desta mesma consulta.
 */
export function useCashReopenRequests({ adminId, superAdmin, enabled = true }: HookOptions) {
  const [requests, setRequests] = useState<CashReopenRequest[]>([]);
  const [adminNames, setAdminNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled || (!superAdmin && !adminId)) {
      setRequests([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      let query = supabase
        .from("cash_reopen_requests" as any)
        .select(SELECT)
        .eq("status", "pending")
        .order("requested_at", { ascending: false });

      if (!superAdmin) query = query.eq("admin_id", adminId as string);

      const { data, error } = await query;
      if (error) throw error;
      let rows = ((data as any[]) || []) as CashReopenRequest[];

      if (!superAdmin && adminId) {
        // Segurança extra no cliente: só trabalhadores da própria empresa.
        const { data: ws } = await supabase
          .from("workers")
          .select("id, nome, parent_admin_id")
          .eq("parent_admin_id", adminId);
        const allowed = new Set(((ws as any[]) || []).map((w) => w.id as string));
        const nameById: Record<string, string> = {};
        for (const w of ((ws as any[]) || [])) nameById[w.id] = w.nome;
        rows = rows
          .filter((r) => r.admin_id === adminId && (!r.worker_id || allowed.has(r.worker_id)))
          .map((r) => ({ ...r, worker_name: r.worker_name ?? (r.worker_id ? nameById[r.worker_id] ?? null : null) }));
      }

      if (superAdmin) {
        const { data: admins } = await supabase.rpc("super_admin_list_admins" as any);
        const map: Record<string, string> = {};
        for (const a of ((admins as any[]) || [])) map[a.id] = a.nome;
        setAdminNames(map);
      }

      setRequests(rows);
    } catch (e: any) {
      toast({ title: "Erro ao carregar solicitações", description: e?.message || "Falha", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [adminId, superAdmin, enabled]);

  useEffect(() => { void refresh(); }, [refresh]);

  const review = useCallback(
    async (req: CashReopenRequest, action: "approve" | "reject") => {
      setBusyId(req.id);
      try {
        const rpc = action === "approve" ? "approve_cash_reopen_request" : "reject_cash_reopen_request";
        const { error } = await supabase.rpc(rpc as any, { p_request_id: req.id, p_note: null } as any);
        if (error) throw error;
        // Remove imediatamente dos pendentes (contador e agrupamento acompanham).
        setRequests((prev) => prev.filter((r) => r.id !== req.id));
        toast({ title: action === "approve" ? "Solicitação aprovada" : "Solicitação recusada" });
        void refresh();
      } catch (e: any) {
        toast({ title: "Erro", description: e?.message || "Falha ao processar solicitação", variant: "destructive" });
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  return { requests, count: requests.length, adminNames, loading, busyId, refresh, review };
}

function typeLabel(t: string | null) {
  return t === "open_missed" ? "Caixa não foi aberto" : "Reabertura de caixa fechado";
}

function fmtDate(d: string) {
  return format(new Date(d + "T12:00:00"), "dd/MM/yyyy");
}

function RequestCard({
  req, companyName, busy, onReview,
}: {
  req: CashReopenRequest;
  companyName?: string | null;
  busy: boolean;
  onReview: (r: CashReopenRequest, a: "approve" | "reject") => void;
}) {
  return (
    <div className="rounded-md border bg-background p-2.5 space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold">{req.worker_name || "Trabalhador"}</p>
        <Badge variant={req.request_type === "open_missed" ? "outline" : "secondary"} className="text-[10px] shrink-0">
          {typeLabel(req.request_type)}
        </Badge>
      </div>
      {companyName && <p className="text-[11px] text-muted-foreground">Empresa: {companyName}</p>}
      <p className="text-[11px] text-muted-foreground">
        Caixa {fmtDate(req.cash_date)} · Solicitado {format(new Date(req.requested_at), "dd/MM/yyyy HH:mm")}
      </p>
      {req.reason && <p className="text-xs">Motivo: {req.reason}</p>}
      <div className="flex gap-2 pt-0.5">
        <Button size="sm" className="flex-1 h-7 text-xs" disabled={busy} onClick={() => onReview(req, "approve")}>
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <><Check className="h-3 w-3 mr-1" /> Aprovar</>}
        </Button>
        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => onReview(req, "reject")}>
          <X className="h-3 w-3 mr-1" /> Recusar
        </Button>
      </div>
    </div>
  );
}

type PanelProps = {
  requests: CashReopenRequest[];
  loading: boolean;
  busyId: string | null;
  onRefresh: () => void;
  onReview: (r: CashReopenRequest, a: "approve" | "reject") => void;
  /** SuperAdmin: agrupa por empresa (admin_id). */
  groupByCompany?: boolean;
  adminNames?: Record<string, string>;
};

/** Central única de solicitações de reabertura (Admin e SuperAdmin). */
export default function CashReopenRequestsPanel({
  requests, loading, busyId, onRefresh, onReview, groupByCompany, adminNames = {},
}: PanelProps) {
  const groups = useMemo(() => {
    if (!groupByCompany) return [];
    const map = new Map<string, CashReopenRequest[]>();
    for (const r of requests) {
      const key = r.admin_id ?? "sem-empresa";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return Array.from(map.entries()).map(([id, list]) => ({
      id,
      name: adminNames[id] || (id === "sem-empresa" ? "Sem empresa" : "Empresa"),
      list,
    }));
  }, [requests, groupByCompany, adminNames]);

  const has = requests.length > 0;

  return (
    <Card className={has ? "border-warning bg-warning/5" : ""}>
      <CardHeader className="p-3 pb-1 flex-row items-center justify-between space-y-0">
        <CardTitle className={`text-sm flex items-center gap-2 ${has ? "text-warning" : ""}`}>
          <DoorOpen className="h-4 w-4" />
          Solicitações de reabertura{has ? ` (${requests.length})` : ""}
        </CardTitle>
        <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={onRefresh} disabled={loading}>
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
          Atualizar
        </Button>
      </CardHeader>
      <CardContent className="p-3 pt-1 space-y-2">
        {!has ? (
          <p className="text-[11px] text-muted-foreground">Nenhuma solicitação de reabertura pendente</p>
        ) : groupByCompany ? (
          groups.map((g) => (
            <div key={g.id} className="space-y-1.5">
              <p className="text-xs font-semibold">{g.name} ({g.list.length})</p>
              <div className="space-y-2 pl-2 border-l-2 border-warning/40">
                {g.list.map((r) => (
                  <RequestCard key={r.id} req={r} companyName={g.name} busy={busyId === r.id} onReview={onReview} />
                ))}
              </div>
            </div>
          ))
        ) : (
          requests.map((r) => (
            <RequestCard key={r.id} req={r} busy={busyId === r.id} onReview={onReview} />
          ))
        )}
      </CardContent>
    </Card>
  );
}
