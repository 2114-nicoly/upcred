import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  History, Loader2, DollarSign, AlertTriangle, CalendarClock,
  FileText, RefreshCw, Filter,
} from "lucide-react";
import { format } from "date-fns";
import { formatCurrency } from "@/lib/loan-utils";

type TimelineItem = {
  id: string;
  date: string; // ISO
  kind: "payment" | "penalty" | "reschedule" | "audit" | "renegotiation";
  title: string;
  detail?: string;
  amount?: number | null;
  badge?: string;
  meta?: string;
};

const ACTION_LABEL: Record<string, string> = {
  criar_cliente: "Cliente criado",
  editar_cliente: "Cadastro editado",
  excluir_cliente: "Cliente excluído",
  transferencia_cliente: "Transferência de trabalhador",
  anexar_arquivo: "Anexo adicionado",
  excluir_anexo: "Anexo apagado",
  criar_emprestimo: "Empréstimo criado",
  editar_emprestimo: "Empréstimo editado",
  excluir_emprestimo: "Empréstimo excluído",
  editar_observacao_emprestimo: "Observação editada",
  renovar_emprestimo: "Empréstimo renovado",
  quitar_emprestimo: "Empréstimo quitado",
  renegociacao_emprestimo: "Renegociação",
  renovacao_emprestimo: "Renovação",
  pagamento: "Pagamento registrado",
  editar_pagamento: "Pagamento editado",
  desfazer_pagamento: "Pagamento desfeito",
  nao_pagou: "Marcado como não pagou",
  editar_parcela: "Parcela editada",
  alterar_data_parcela: "Data da parcela alterada",
  multa_aplicada: "Multa aplicada",
  multa_paga: "Multa paga",
  reagendamento_solicitado: "Reagendamento solicitado",
  reagendamento_aprovado: "Reagendamento aprovado",
  reagendamento_recusado: "Reagendamento recusado",
};

const KIND_COLORS: Record<string, string> = {
  payment: "bg-success/15 text-success border-success/30",
  penalty: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  reschedule: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30",
  audit: "bg-muted text-muted-foreground border-border",
  renegotiation: "bg-purple-500/15 text-purple-700 dark:text-purple-400 border-purple-500/30",
};

const KIND_ICON = {
  payment: DollarSign,
  penalty: AlertTriangle,
  reschedule: CalendarClock,
  audit: FileText,
  renegotiation: RefreshCw,
};

type Filter = "all" | "payment" | "penalty" | "reschedule" | "renegotiation" | "audit";

export default function ClientHistory({ clientId }: { clientId: string }) {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        // fetch all loans for this client to join related tables
        const { data: loans } = await supabase
          .from("loans")
          .select("id")
          .eq("client_id", clientId);
        const loanIds = (loans || []).map((l: any) => l.id);

        const [auditRes, movRes, penRes, reschRes] = await Promise.all([
          supabase
            .from("audit_logs")
            .select("id, created_at, action_type, user_role, old_value, new_value, observation, entity_type, entity_id")
            .or(
              `and(entity_type.eq.client,entity_id.eq.${clientId})` +
              (loanIds.length ? `,and(entity_type.eq.loan,entity_id.in.(${loanIds.join(",")}))` : "")
            )
            .order("created_at", { ascending: false })
            .limit(200),
          loanIds.length
            ? supabase
                .from("cash_movements")
                .select("id, created_at, type, amount, observation, loan_id, reversed_at")
                .in("loan_id", loanIds)
                .is("reversed_at", null)
                .order("created_at", { ascending: false })
                .limit(200)
            : Promise.resolve({ data: [] as any[] }),
          loanIds.length
            ? supabase
                .from("penalties")
                .select("id, created_at, amount, paid, paid_at, paid_amount, observation, loan_id, penalty_type")
                .in("loan_id", loanIds)
                .order("created_at", { ascending: false })
                .limit(200)
            : Promise.resolve({ data: [] as any[] }),
          loanIds.length
            ? supabase
                .from("installment_reschedules")
                .select("id, created_at, status, original_due_date, requested_due_date, approved_due_date, reason, loan_id, resolved_at")
                .in("loan_id", loanIds)
                .order("created_at", { ascending: false })
                .limit(200)
            : Promise.resolve({ data: [] as any[] }),
        ]);

        const out: TimelineItem[] = [];

        (auditRes.data || []).forEach((l: any) => {
          const isReneg = l.action_type === "renegociacao_emprestimo" || l.action_type === "renovacao_emprestimo";
          out.push({
            id: `a-${l.id}`,
            date: l.created_at,
            kind: isReneg ? "renegotiation" : "audit",
            title: ACTION_LABEL[l.action_type] || l.action_type,
            detail: l.observation || undefined,
            meta: l.user_role || undefined,
          });
        });

        (movRes.data || []).forEach((m: any) => {
          if (m.type === "payment" || m.type === "penalty_payment") {
            out.push({
              id: `m-${m.id}`,
              date: m.created_at,
              kind: m.type === "penalty_payment" ? "penalty" : "payment",
              title: m.type === "penalty_payment" ? "Multa paga" : "Pagamento",
              amount: Number(m.amount),
              detail: m.observation || undefined,
            });
          }
        });

        (penRes.data || []).forEach((p: any) => {
          out.push({
            id: `p-${p.id}`,
            date: p.created_at,
            kind: "penalty",
            title: "Multa aplicada",
            amount: Number(p.amount),
            badge: p.paid ? "Paga" : "Pendente",
            detail: p.observation || undefined,
          });
          if (p.paid && p.paid_at) {
            out.push({
              id: `pp-${p.id}`,
              date: p.paid_at,
              kind: "penalty",
              title: "Multa quitada",
              amount: Number(p.paid_amount || p.amount),
            });
          }
        });

        (reschRes.data || []).forEach((r: any) => {
          const statusLabel =
            r.status === "approved" ? "Aprovado" :
            r.status === "rejected" ? "Recusado" : "Pendente";
          out.push({
            id: `r-${r.id}`,
            date: r.created_at,
            kind: "reschedule",
            title: "Reagendamento solicitado",
            detail: `${format(new Date(r.original_due_date + "T12:00:00"), "dd/MM/yyyy")} → ${format(new Date(r.requested_due_date + "T12:00:00"), "dd/MM/yyyy")}${r.reason ? ` • ${r.reason}` : ""}`,
            badge: statusLabel,
          });
          if (r.resolved_at && r.status !== "pending") {
            out.push({
              id: `rr-${r.id}`,
              date: r.resolved_at,
              kind: "reschedule",
              title: r.status === "approved" ? "Reagendamento aprovado" : "Reagendamento recusado",
              detail: r.approved_due_date
                ? `Nova data: ${format(new Date(r.approved_due_date + "T12:00:00"), "dd/MM/yyyy")}`
                : undefined,
            });
          }
        });

        out.sort((a, b) => b.date.localeCompare(a.date));
        setItems(out);
      } finally {
        setLoading(false);
      }
    })();
  }, [clientId]);

  const filtered = useMemo(
    () => (filter === "all" ? items : items.filter((i) => i.kind === filter)),
    [items, filter]
  );

  const totals = useMemo(() => {
    let payments = 0, penaltiesPaid = 0, penaltiesApplied = 0;
    items.forEach((i) => {
      if (i.kind === "payment" && i.title === "Pagamento") payments += i.amount || 0;
      if (i.kind === "penalty" && i.title === "Multa quitada") penaltiesPaid += i.amount || 0;
      if (i.kind === "penalty" && i.title === "Multa aplicada") penaltiesApplied += i.amount || 0;
    });
    return { payments, penaltiesPaid, penaltiesApplied };
  }, [items]);

  const FILTERS: { key: Filter; label: string }[] = [
    { key: "all", label: "Tudo" },
    { key: "payment", label: "Pagamentos" },
    { key: "penalty", label: "Multas" },
    { key: "reschedule", label: "Reagendamentos" },
    { key: "renegotiation", label: "Renegociações" },
    { key: "audit", label: "Cadastro" },
  ];

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
        <History className="h-3.5 w-3.5" /> Histórico Completo
      </h2>

      {!loading && items.length > 0 && (
        <Card>
          <CardContent className="p-2.5 grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="text-[10px] text-muted-foreground">Recebido</p>
              <p className="text-xs font-bold text-success tabular-nums">{formatCurrency(totals.payments)}</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">Multas pagas</p>
              <p className="text-xs font-bold text-amber-600 tabular-nums">{formatCurrency(totals.penaltiesPaid)}</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">Multas aplicadas</p>
              <p className="text-xs font-bold tabular-nums">{formatCurrency(totals.penaltiesApplied)}</p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap gap-1">
        <Filter className="h-3 w-3 mt-1.5 text-muted-foreground" />
        {FILTERS.map((f) => (
          <Button
            key={f.key}
            size="sm"
            variant={filter === f.key ? "default" : "outline"}
            className="h-6 px-2 text-[10px]"
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center p-3"><Loader2 className="h-4 w-4 animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <Card><CardContent className="p-3 text-center text-xs text-muted-foreground">Nenhum registro.</CardContent></Card>
      ) : (
        <div className="space-y-1">
          {filtered.map((i) => {
            const Icon = KIND_ICON[i.kind];
            return (
              <Card key={i.id} className={`border-l-2 ${KIND_COLORS[i.kind].split(" ").find(c => c.startsWith("border-"))}`}>
                <CardContent className="p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-1.5 min-w-0 flex-1">
                      <Icon className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium leading-tight">{i.title}</p>
                        {i.detail && <p className="text-[10px] text-muted-foreground mt-0.5">{i.detail}</p>}
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          {format(new Date(i.date), "dd/MM/yyyy HH:mm")}
                          {i.meta ? ` • ${i.meta}` : ""}
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-0.5 shrink-0">
                      {i.amount != null && (
                        <span className="text-xs font-bold tabular-nums">{formatCurrency(i.amount)}</span>
                      )}
                      {i.badge && (
                        <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4">{i.badge}</Badge>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
