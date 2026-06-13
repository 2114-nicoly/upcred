import { supabase } from "@/integrations/supabase/client";
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
  const today = format(new Date(), "yyyy-MM-dd");

  const [insRes, evRes, loansRes, clientsRes, workersRes] = await Promise.all([
    supabase
      .from("installments")
      .select("amount, paid_amount, due_date, status, is_penalty, loans!inner(worker_id)")
      .gte("due_date", range.startDate)
      .lte("due_date", range.endDate)
      .eq("is_penalty", false),
    supabase
      .from("daily_events" as any)
      .select("event_type, amount_in, amount_out, worker_id")
      .gte("cash_date", range.startDate)
      .lte("cash_date", range.endDate),
    supabase
      .from("loans")
      .select("id, worker_id, status, remaining_balance, client_id"),
    supabase
      .from("clients")
      .select("id, worker_id"),
    supabase.rpc("admin_list_workers" as any),
  ]);

  const workers = (workersRes.data as { id: string; nome: string }[]) || [];
  const map = new Map<string | null, WorkerStats>();
  // Always include each worker, plus a "sem trabalhador" bucket for legacy null
  workers.forEach((w) => map.set(w.id, empty(w.id, w.nome)));

  const get = (id: string | null) => {
    if (!map.has(id)) {
      map.set(id, empty(id, id ? "Trabalhador" : "Sem trabalhador"));
    }
    return map.get(id)!;
  };

  // Previsto from installments (due in range, regular only)
  ((insRes.data as any[]) || []).forEach((i) => {
    const wid = i.loans?.worker_id ?? null;
    get(wid).previsto += Number(i.amount || 0);
  });

  // Cash flow from daily_events
  ((evRes.data as any[]) || []).forEach((e) => {
    const wid = e.worker_id ?? null;
    const s = get(wid);
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

  // Snapshot counters from loans (today, not period-bound)
  ((loansRes.data as any[]) || []).forEach((l) => {
    const wid = l.worker_id ?? null;
    const s = get(wid);
    if (l.status !== "paid" && l.status !== "cancelled" && l.status !== "renegotiated" && Number(l.remaining_balance || 0) > 0.01) {
      s.emprestimosAtivos += 1;
      if (l.status === "overdue") s.atrasados += 1;
    }
  });

  ((clientsRes.data as any[]) || []).forEach((c) => {
    const wid = c.worker_id ?? null;
    get(wid).clientesAtivos += 1;
  });

  // Derived
  for (const s of map.values()) {
    s.totalSaidas = s.emprestado + s.retirada;
    s.faltaReceber = Math.max(0, s.previsto - s.recebido);
    s.percentual = s.previsto > 0 ? (s.recebido / s.previsto) * 100 : 0;
    s.saldoLiquido = s.recebido + s.aporte - s.emprestado - s.retirada;
  }

  return Array.from(map.values()).filter((s) => s.worker_id !== null || s.previsto > 0 || s.recebido > 0 || s.emprestado > 0 || s.retirada > 0 || s.aporte > 0 || s.clientesAtivos > 0);
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
