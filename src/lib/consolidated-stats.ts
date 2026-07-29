import { supabase } from "@/integrations/supabase/client";
import { fetchAvailableCashByWorker } from "@/lib/finance-totals";
import { INSTALLMENT_COLLECTIBLE_STATUSES, LOAN_ACTIVE_STATUSES } from "@/lib/status-constants";

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
  recebidoPrincipal: number;
  multasRecebidas: number;
  availableCash: number;
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
  /** Chaves worker_id+client_id de clientes atrasados (para não duplicar ao consolidar). */
  atrasadosClientIds: string[];
};

const empty = (id: string | null, name: string): WorkerStats => ({
  worker_id: id, worker_name: name,
  previsto: 0, recebido: 0, recebidoPrincipal: 0, multasRecebidas: 0, availableCash: 0, faltaReceber: 0, percentual: 0,
  emprestado: 0, retirada: 0, aporte: 0, totalSaidas: 0, saldoLiquido: 0,
  naoPagosCount: 0, renovacoes: 0, emprestimosNovos: 0,
  clientesAtivos: 0, emprestimosAtivos: 0, atrasados: 0, atrasadosClientIds: [],
});

/**
 * Busca TODAS as linhas de uma query (sem o teto padrão de 1000 do PostgREST).
 * Usado em todos os totais para nunca truncar contagens/valores.
 */
async function fetchAll<T = any>(build: (from: number, to: number) => any, page = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await build(from, from + page - 1);
    if (error) throw error;
    const rows = (data as T[]) || [];
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

/**
 * Builds aggregated stats grouped by worker for a period.
 * - Reads installments (due_date in range) for "previsto"
 * - Reads daily_events (cash_date in range) for actual cash flow
 * - Reads loans/clients counts for snapshot indicators
 */
export async function loadWorkersStats(range: PeriodRange): Promise<WorkerStats[]> {
  const collectibleStatuses = [...INSTALLMENT_COLLECTIBLE_STATUSES];
  const activeLoanStatuses = [...LOAN_ACTIVE_STATUSES];
  const today = format(new Date(), "yyyy-MM-dd");
  const overdueReferenceDate = range.endDate > today ? today : range.endDate;
  // Parcelas/empréstimos encerrados por cancelamento ou renegociação nunca entram no previsto.
  const deadInstallmentStatuses = ["cancelled", "renegotiated"];
  const deadLoanStatuses = ["cancelled", "renegotiated"];

  // 1) Operational workers only (active + not archived)
  const workersRes = await supabase.rpc("admin_list_workers" as any, { p_include_archived: true });
  const allWorkers = (workersRes.data as { id: string; nome: string; active: boolean; archived_at: string | null }[]) || [];
  const operational = allWorkers.filter((w) => w.active && !w.archived_at);
  const operationalIds = new Set(operational.map((w) => w.id));

  const [insRows, evRows, loansRows, clientsRows, overdueInstRows] = await Promise.all([
    // Previsto do período: parcelas regulares com vencimento no período,
    // de empréstimos não cancelados/renegociados (inclui parcelas já pagas).
    fetchAll((f, t) => supabase
      .from("installments")
      .select("amount, paid_amount, due_date, status, is_penalty, loans!inner(worker_id, client_id, status, clients!inner(archived_at))")
      .gte("due_date", range.startDate)
      .lte("due_date", range.endDate)
      .eq("is_penalty", false)
      .not("status", "in", `(${deadInstallmentStatuses.join(",")})`)
      .not("loans.status", "in", `(${deadLoanStatuses.join(",")})`)
      .is("loans.clients.archived_at", null)
      .range(f, t)),
    fetchAll((f, t) => supabase
      .from("daily_events" as any)
      .select("event_type, amount_in, amount_out, worker_id, reversed_at")
      .gte("cash_date", range.startDate)
      .lte("cash_date", range.endDate)
      .is("reversed_at", null)
      .range(f, t)),
    fetchAll((f, t) => supabase
      .from("loans")
      .select("id, worker_id, status, remaining_balance, client_id, clients!inner(archived_at)")
      .is("clients.archived_at", null)
      .range(f, t)),
    fetchAll((f, t) => supabase
      .from("clients")
      .select("id, worker_id")
      .is("archived_at", null)
      .range(f, t)),
    fetchAll((f, t) => supabase
      .from("installments")
      .select("id, amount, paid_amount, due_date, status, is_penalty, loans!inner(id, worker_id, client_id, status, remaining_balance, clients!inner(archived_at))")
      .lt("due_date", overdueReferenceDate)
      .eq("is_penalty", false)
      .in("status", collectibleStatuses)
      .in("loans.status", activeLoanStatuses)
      .gt("loans.remaining_balance", 0.01)
      .is("loans.clients.archived_at", null)
      .range(f, t)),
  ]);

  const insRes = { data: insRows };
  const evRes = { data: evRows };
  const loansRes = { data: loansRows };
  const clientsRes = { data: clientsRows };
  const overdueInstRes = { data: overdueInstRows };


  const map = new Map<string, WorkerStats>();
  operational.forEach((w) => map.set(w.id, empty(w.id, w.nome)));

  const get = (id: string | null): WorkerStats | null => {
    if (!id || !operationalIds.has(id)) return null;
    return map.get(id) || null;
  };

  // Previsto do período = valor original das parcelas com vencimento no período.
  // Falta receber = saldo pendente dessas mesmas parcelas (nunca negativo).
  ((insRes.data as any[]) || []).forEach((i) => {
    const s = get(i.loans?.worker_id ?? null);
    if (!s) return;
    const amount = Number(i.amount || 0);
    const paid = Number(i.paid_amount || 0);
    s.previsto += amount;
    s.faltaReceber += Math.max(amount - paid, 0);
  });


  // Cash flow from daily_events (non-reversed, active workers only)
  ((evRes.data as any[]) || []).forEach((e) => {
    const s = get(e.worker_id ?? null);
    if (!s) return;
    const inV = Number(e.amount_in || 0);
    const outV = Number(e.amount_out || 0);
    switch (e.event_type) {
      // Recebido/emprestado seguem a fonte única (ver src/lib/finance-totals.ts):
      // pagamento = principal, recebimento_multa = multas, saída real = emprestado.
      case "pagamento": s.recebidoPrincipal += inV; s.recebido += inV; break;
      case "recebimento_multa": s.multasRecebidas += inV; s.recebido += inV; break;
      case "emprestimo_novo": s.emprestado += outV; s.emprestimosNovos += 1; break;
      case "renovacao": s.emprestado += outV; s.renovacoes += 1; break;
      case "renegociacao": s.emprestado += outV; break;
      case "saida":
      case "saida_manual": s.retirada += outV; break;
      case "entrada_manual": s.aporte += inV; break;
      case "nao_pagou": s.naoPagosCount += 1; break;
    }
  });

  // Empréstimos ativos: cada loan_id apenas uma vez, status aberto/atrasado e saldo pendente.
  const activeLoanIdsByWorker = new Map<string, Set<string>>();
  ((loansRes.data as any[]) || []).forEach((l) => {
    const workerId = l.worker_id ?? null;
    const s = get(workerId);
    if (!s || !workerId || !l.id) return;
    const isActive =
      (activeLoanStatuses as readonly string[]).includes(String(l.status)) &&
      Number(l.remaining_balance || 0) > 0.01;
    if (!isActive) return;
    const set = activeLoanIdsByWorker.get(workerId) || new Set<string>();
    set.add(String(l.id));
    activeLoanIdsByWorker.set(workerId, set);
  });
  activeLoanIdsByWorker.forEach((set, workerId) => {
    const s = map.get(workerId);
    if (s) s.emprestimosAtivos = set.size;
  });


  // "Clientes atrasados" conta worker_id+client_id único com pelo menos uma parcela vencida,
  // regular, pendente/parcial/overdue e com saldo pendente. Nunca usa loans.status sozinho.
  const overdueClientsByWorker = new Map<string, Set<string>>();
  ((overdueInstRes.data as any[]) || []).forEach((i) => {
    const loan = i.loans;
    const workerId = loan?.worker_id ?? null;
    const clientId = loan?.client_id ?? null;
    const s = get(workerId);
    if (!s || !workerId || !clientId) return;
    const pending = Math.max(Number(i.amount || 0) - Number(i.paid_amount || 0), 0);
    if (pending <= 0.01) return;
    const key = `${workerId}|${clientId}`;
    const set = overdueClientsByWorker.get(workerId) || new Set<string>();
    set.add(key);
    overdueClientsByWorker.set(workerId, set);
  });
  overdueClientsByWorker.forEach((set, workerId) => {
    const s = map.get(workerId);
    if (s) { s.atrasados = set.size; s.atrasadosClientIds = Array.from(set); }
  });
  // Clientes ativos: cada client_id apenas uma vez, por trabalhador responsável.
  const clientIdsByWorker = new Map<string, Set<string>>();
  ((clientsRes.data as any[]) || []).forEach((c) => {
    const workerId = c.worker_id ?? null;
    const s = get(workerId);
    if (!s || !workerId || !c.id) return;
    const set = clientIdsByWorker.get(workerId) || new Set<string>();
    set.add(String(c.id));
    clientIdsByWorker.set(workerId, set);
  });
  clientIdsByWorker.forEach((set, workerId) => {
    const s = map.get(workerId);
    if (s) s.clientesAtivos = set.size;
  });

  // Caixa disponível atual — exclusivamente cash_balance.available_cash.
  try {
    const cashMap = await fetchAvailableCashByWorker(Array.from(operationalIds));
    map.forEach((s, id) => { s.availableCash = cashMap[id] ?? 0; });
  } catch (err) {
    console.error("[consolidated-stats] falha ao carregar caixa disponível", err);
    throw err;
  }

  // Derived — falta receber já vem das parcelas do período (não é previsto - recebido).
  for (const s of map.values()) {
    s.totalSaidas = s.emprestado + s.retirada;
    s.faltaReceber = Math.max(0, s.faltaReceber);
    s.percentual = s.previsto > 0 ? ((s.previsto - s.faltaReceber) / s.previsto) * 100 : 0;
    s.saldoLiquido = s.recebido + s.aporte - s.emprestado - s.retirada;
  }


  return Array.from(map.values());
}

export function consolidate(stats: WorkerStats[]): WorkerStats {
  const total = empty(null, "Consolidado");
  const overdueClientKeys = new Set<string>();
  for (const s of stats) {
    s.atrasadosClientIds.forEach((id) => overdueClientKeys.add(id));
    total.previsto += s.previsto;
    total.recebido += s.recebido;
    total.recebidoPrincipal += s.recebidoPrincipal;
    total.multasRecebidas += s.multasRecebidas;
    total.availableCash += s.availableCash;
    total.emprestado += s.emprestado;
    total.retirada += s.retirada;
    total.aporte += s.aporte;
    total.naoPagosCount += s.naoPagosCount;
    total.renovacoes += s.renovacoes;
    total.emprestimosNovos += s.emprestimosNovos;
    total.clientesAtivos += s.clientesAtivos;
    total.emprestimosAtivos += s.emprestimosAtivos;
    total.faltaReceber += s.faltaReceber;
  }
  total.atrasadosClientIds = Array.from(overdueClientKeys);
  total.atrasados = overdueClientKeys.size;
  total.totalSaidas = total.emprestado + total.retirada;
  total.faltaReceber = Math.max(0, total.faltaReceber);
  total.percentual = total.previsto > 0 ? ((total.previsto - total.faltaReceber) / total.previsto) * 100 : 0;

  total.saldoLiquido = total.recebido + total.aporte - total.emprestado - total.retirada;
  return total;
}
