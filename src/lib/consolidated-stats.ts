import { supabase } from "@/integrations/supabase/client";
import { isLoanActive } from "@/lib/status-constants";
import {
  format, startOfWeek, endOfWeek, startOfMonth, endOfMonth,
} from "date-fns";

export type PeriodMode = "day" | "week" | "month" | "custom";

export type PeriodRange = { startDate: string; endDate: string; label: string };

export function getPeriodRange(
  mode: PeriodMode,
  customStart?: string,
  customEnd?: string,
): PeriodRange {
  const today = new Date();
  let s: Date, e: Date;
  if (mode === "day") { s = today; e = today; }
  else if (mode === "week") { s = startOfWeek(today, { weekStartsOn: 1 }); e = endOfWeek(today, { weekStartsOn: 1 }); }
  else if (mode === "month") { s = startOfMonth(today); e = endOfMonth(today); }
  else {
    s = customStart ? new Date(customStart + "T12:00:00") : today;
    e = customEnd ? new Date(customEnd + "T12:00:00") : today;
  }
  const startDate = format(s, "yyyy-MM-dd");
  const endDate = format(e, "yyyy-MM-dd");
  const label = startDate === endDate
    ? `${format(s, "dd/MM/yyyy")}`
    : `${format(s, "dd/MM/yyyy")} a ${format(e, "dd/MM/yyyy")}`;
  return { startDate, endDate, label };
}

export type WorkerStats = {
  worker_id: string | null;
  worker_name: string;
  previsto: number;
  recebido: number;
  faltaReceber: number;
  percentual: number;
  emprestado: number;
  retirada: number;
  aporte: number;
  totalSaidas: number;
  saldoLiquido: number;
  naoPagosCount: number;
  renovacoes: number;
  emprestimosNovos: number;
  clientesAtivos: number;
  emprestimosAtivos: number;
  atrasados: number;
};

const empty = (id: string | null, name: string): WorkerStats => ({
  worker_id: id, worker_name: name,
  previsto: 0, recebido: 0, faltaReceber: 0, percentual: 0,
  emprestado: 0, retirada: 0, aporte: 0, totalSaidas: 0, saldoLiquido: 0,
  naoPagosCount: 0, renovacoes: 0, emprestimosNovos: 0,
  clientesAtivos: 0, emprestimosAtivos: 0, atrasados: 0,
});

/**
 * Builds aggregated stats grouped by worker for a period.
 * - Reads installments (due_date in range) for "previsto"
 * - Reads daily_events (cash_date in range) for actual cash flow
 * - Reads loans/clients counts for snapshot indicators
 */
export async function loadWorkersStats(range: PeriodRange): Promise<WorkerStats[]> {
  // 1) Operational workers only (active + not archived)
  const workersRes = await supabase.rpc("admin_list_workers" as any, { p_include_archived: true });
  const allWorkers = (workersRes.data as { id: string; nome: string; active: boolean; archived_at: string | null }[]) || [];
  const operational = allWorkers.filter((w) => w.active && !w.archived_at);
  const operationalIds = new Set(operational.map((w) => w.id));

  const [insRes, evRes, loansRes, clientsRes] = await Promise.all([
    supabase
      .from("installments")
      .select("amount, paid_amount, due_date, status, is_penalty, loans!inner(worker_id, client_id, clients!inner(archived_at))")
      .gte("due_date", range.startDate)
      .lte("due_date", range.endDate)
      .eq("is_penalty", false)
      .in("status", ["pending", "partial", "overdue"])
      .is("loans.clients.archived_at", null),
    supabase
      .from("daily_events" as any)
      .select("event_type, amount_in, amount_out, worker_id, reversed_at")
      .gte("cash_date", range.startDate)
      .lte("cash_date", range.endDate)
      .is("reversed_at", null),
    supabase
      .from("loans")
      .select("id, worker_id, status, remaining_balance, client_id, clients!inner(archived_at)")
      .is("clients.archived_at", null),
    supabase
      .from("clients")
      .select("id, worker_id")
      .is("archived_at", null),
  ]);

  const map = new Map<string, WorkerStats>();
  operational.forEach((w) => map.set(w.id, empty(w.id, w.nome)));

  const get = (id: string | null): WorkerStats | null => {
    if (!id || !operationalIds.has(id)) return null;
    return map.get(id) || null;
  };

  // Previsto from installments (regular, pending/partial/overdue, active worker+client)
  ((insRes.data as any[]) || []).forEach((i) => {
    const s = get(i.loans?.worker_id ?? null);
    if (!s) return;
    const remaining = Math.max(Number(i.amount || 0) - Number(i.paid_amount || 0), 0);
    s.previsto += remaining;
  });

  // Cash flow from daily_events (non-reversed, active workers only)
  ((evRes.data as any[]) || []).forEach((e) => {
    const s = get(e.worker_id ?? null);
    if (!s) return;
    const inV = Number(e.amount_in || 0);
    const outV = Number(e.amount_out || 0);
    switch (e.event_type) {
      case "pagamento": s.recebido += inV; break;
      case "recebimento_multa": s.recebido += inV; break;
      case "emprestimo_novo": s.emprestado += outV; s.emprestimosNovos += 1; break;
      case "renovacao": s.emprestado += outV; s.renovacoes += 1; break;
      case "saida":
      case "saida_manual": s.retirada += outV; break;
      case "entrada_manual": s.aporte += inV; break;
      case "nao_pagou": s.naoPagosCount += 1; break;
    }
  });

  // Active loans snapshot: active worker+client, open/overdue, remaining_balance > 0.01
  ((loansRes.data as any[]) || []).forEach((l) => {
    const s = get(l.worker_id ?? null);
    if (!s) return;
    const isActive =
      (l.status === "open" || l.status === "overdue") &&
      Number(l.remaining_balance || 0) > 0.01;
    if (isActive) {
      s.emprestimosAtivos += 1;
      if (l.status === "overdue") s.atrasados += 1;
    }
  });

  ((clientsRes.data as any[]) || []).forEach((c) => {
    const s = get(c.worker_id ?? null);
    if (!s) return;
    s.clientesAtivos += 1;
  });

  // Derived
  for (const s of map.values()) {
    s.totalSaidas = s.emprestado + s.retirada;
    s.faltaReceber = Math.max(0, s.previsto - s.recebido);
    s.percentual = s.previsto > 0 ? (s.recebido / s.previsto) * 100 : 0;
    s.saldoLiquido = s.recebido + s.aporte - s.emprestado - s.retirada;
  }

  return Array.from(map.values());
}

export function consolidate(stats: WorkerStats[]): WorkerStats {
  const total = empty(null, "Consolidado");
  for (const s of stats) {
    total.previsto += s.previsto;
    total.recebido += s.recebido;
    total.emprestado += s.emprestado;
    total.retirada += s.retirada;
    total.aporte += s.aporte;
    total.naoPagosCount += s.naoPagosCount;
    total.renovacoes += s.renovacoes;
    total.emprestimosNovos += s.emprestimosNovos;
    total.clientesAtivos += s.clientesAtivos;
    total.emprestimosAtivos += s.emprestimosAtivos;
    total.atrasados += s.atrasados;
  }
  total.totalSaidas = total.emprestado + total.retirada;
  total.faltaReceber = Math.max(0, total.previsto - total.recebido);
  total.percentual = total.previsto > 0 ? (total.recebido / total.previsto) * 100 : 0;
  total.saldoLiquido = total.recebido + total.aporte - total.emprestado - total.retirada;
  return total;
}
