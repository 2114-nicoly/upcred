import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import { format } from "date-fns";
import { formatCurrency } from "@/lib/loan-utils";
import type { WorkerStats } from "@/lib/consolidated-stats";
import { normalizeCloseOrigin } from "@/lib/close-origin";


/* ---------- Cards base (padrão visual atual) ---------- */

export function PanelKpi({
  icon, label, value, cls,
}: { icon?: React.ReactNode; label: string; value: string; cls?: string }) {
  return (
    <Card><CardContent className="p-2.5">
      <div className="flex items-center gap-1.5 mb-0.5">
        {icon}
        <p className="text-[11px] text-muted-foreground leading-tight">{label}</p>
      </div>
      <p className={`text-sm font-bold ${cls || ""}`}>{value}</p>
    </CardContent></Card>
  );
}

export function PanelMini({
  label, value, cls,
}: { label: string; value: string | number; cls?: string }) {
  return (
    <Card><CardContent className="p-2 text-center">
      <p className="text-[10px] text-muted-foreground leading-tight">{label}</p>
      <p className={`text-base font-bold ${cls || ""}`}>{value}</p>
    </CardContent></Card>
  );
}

/* ---------- Detalhes financeiros (fechado por padrão) ---------- */

function DetailRow({ label, value, cls }: { label: string; value: string | number; cls?: string }) {
  return (
    <div className="flex items-center justify-between py-1 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-semibold ${cls || ""}`}>{value}</span>
    </div>
  );
}

/**
 * Indicadores secundários. Nenhum valor daqui aparece nas seções
 * "Situação atual" ou "No período selecionado".
 */
export function FinancialDetails({ stats }: { stats: WorkerStats }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-3">
      <Card>
        <CollapsibleTrigger className="w-full flex items-center justify-between p-3">
          <span className="text-sm font-medium">Ver detalhes financeiros</span>
          <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="p-3 pt-0 divide-y">
            <DetailRow label="Recebido principal" value={formatCurrency(stats.recebidoPrincipal)} />
            <DetailRow label="Multas recebidas" value={formatCurrency(stats.multasRecebidas)} />
            <DetailRow label="Despesas" value={formatCurrency(stats.despesas)} cls="text-destructive" />
            <DetailRow label="Entradas manuais" value={formatCurrency(stats.aporte)} cls="text-success" />
            <DetailRow label="Retiradas" value={formatCurrency(stats.retirada)} cls="text-destructive" />
            <DetailRow label="Outras saídas" value={formatCurrency(stats.totalSaidas)} />
            <DetailRow label="Estornos" value={`${formatCurrency(stats.estornos)} (${stats.estornosCount})`} />
            <DetailRow label="Saldo líquido do período" value={formatCurrency(stats.saldoLiquido)} cls={stats.saldoLiquido < 0 ? "text-destructive" : "text-success"} />
            <DetailRow label="Empréstimos ativos" value={stats.emprestimosAtivos} />
            <DetailRow label="Novos empréstimos" value={stats.emprestimosNovos} />
            <DetailRow label="Renovações" value={stats.renovacoes} />
            <DetailRow label="Clientes não pagos" value={stats.naoPagosCount} cls="text-destructive" />
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

/* ---------- Resumo dos trabalhadores (Admin e SuperAdmin) ---------- */

type CashStatus = "open" | "closed" | "not_opened" | "closed_auto" | "closed_auto_not_opened";

function statusLabel(s: CashStatus) {
  if (s === "open") return { text: "Caixa aberto", variant: "default" as const };
  if (s === "closed") return { text: "Fechado manualmente", variant: "secondary" as const };
  if (s === "closed_auto") return { text: "Fechado automaticamente", variant: "secondary" as const };
  if (s === "closed_auto_not_opened") {
    return { text: "Caixa não foi aberto e foi fechado automaticamente", variant: "secondary" as const };
  }
  return { text: "Não aberto", variant: "outline" as const };
}


/**
 * Card compacto por trabalhador ativo, reutilizado pelo Administrador e
 * pelo SuperAdministrador. Não recalcula nada — usa a mesma WorkerStats.
 */
export function WorkerSummaryList({
  stats, onSelect, title = "Resumo dos trabalhadores",
}: { stats: WorkerStats[]; onSelect: (workerId: string) => void; title?: string }) {
  const [cash, setCash] = useState<Record<string, CashStatus>>({});
  const ids = stats.map((s) => s.worker_id).filter(Boolean) as string[];
  const key = ids.join(",");

  useEffect(() => {
    let cancel = false;
    if (ids.length === 0) { setCash({}); return; }
    const today = format(new Date(), "yyyy-MM-dd");
    supabase
      .from("daily_cash")
      .select("worker_id, status, close_origin")
      .eq("cash_date", today)
      .in("worker_id", ids)
      .then(({ data, error }) => {
        if (cancel) return;
        if (error) { console.error("[PanelSummary] falha ao carregar status do caixa", error); return; }
        const map: Record<string, CashStatus> = {};
        ((data as any[]) || []).forEach((d) => {
          if (!d.worker_id) return;
          if (d.status === "closed") {
            const origin = normalizeCloseOrigin(d.close_origin);
            map[d.worker_id] =
              origin === "automatic_opened" ? "closed_auto"
                : origin === "automatic_not_opened" ? "closed_auto_not_opened"
                  : "closed";
          } else {
            map[d.worker_id] = d.status === "open" ? "open" : "not_opened";
          }
        });

        setCash(map);
      });
    return () => { cancel = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (stats.length === 0) return null;

  return (
    <div className="mt-4">
      <h2 className="text-sm font-semibold mb-2">{title}</h2>
      <div className="space-y-2">
        {stats.map((s) => {
          const st = statusLabel(cash[s.worker_id ?? ""] ?? "not_opened");
          return (
            <button
              key={s.worker_id}
              type="button"
              onClick={() => s.worker_id && onSelect(s.worker_id)}
              className="w-full text-left"
            >
              <Card className="hover:bg-muted/40 transition-colors">
                <CardContent className="p-3 space-y-2">
                  <p className="text-sm font-semibold truncate">{s.worker_name}</p>

                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">Atual</p>
                    <div className="grid grid-cols-2 gap-x-3 text-[11px]">
                      <span className="text-muted-foreground">Caixa disponível <b className="text-foreground">{formatCurrency(s.availableCash)}</b></span>
                      <span className="text-muted-foreground">Na rua <b className="text-foreground">{formatCurrency(s.saldoNaRua)}</b></span>
                    </div>
                  </div>

                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">Período</p>
                    <div className="grid grid-cols-3 gap-x-2 text-[11px]">
                      <span className="text-muted-foreground">Previsto <b className="text-foreground block">{formatCurrency(s.previsto)}</b></span>
                      <span className="text-muted-foreground">Recebido <b className="text-success block">{formatCurrency(s.recebido)}</b></span>
                      <span className="text-muted-foreground">Atrasado <b className="text-destructive block">{formatCurrency(s.valorAtrasado)}</b></span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 border-t pt-2">
                    <span className="text-[11px] text-muted-foreground">
                      Clientes atrasados <b className="text-destructive">{s.atrasados}</b>
                    </span>
                    <Badge variant={st.variant} className="text-[9px] h-4">{st.text}</Badge>
                  </div>
                </CardContent>
              </Card>
            </button>
          );
        })}
      </div>
    </div>
  );
}
