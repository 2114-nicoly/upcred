import { supabase } from "@/integrations/supabase/client";
import { INSTALLMENT_COLLECTIBLE_STATUSES, LOAN_ACTIVE_STATUSES } from "@/lib/status-constants";

/**
 * FONTE ÚNICA de "Previsto", "Falta receber" e "Valor atrasado".
 *
 * Regras (idênticas em Rota, Caixa, painéis, relatórios e PDF):
 *  - Previsto        -> parcelas regulares (is_penalty = false) com due_date DENTRO do
 *                       período selecionado, de empréstimos não cancelados/renegociados.
 *                       Usa o valor ORIGINAL programado (amount).
 *  - Falta receber   -> saldo pendente APENAS dessas mesmas parcelas:
 *                       Math.max(amount - paid_amount, 0). Nunca "previsto - recebido do dia".
 *  - Valor atrasado  -> parcelas com due_date ANTERIOR à data de referência (nunca igual),
 *                       cobráveis, de empréstimo ativo, com saldo pendente.
 *
 * Uma parcela nunca aparece ao mesmo tempo no previsto e no atrasado, porque as
 * janelas de data são disjuntas (atrasado usa `< startDate`).
 *
 * Nenhuma função aqui grava, altera parcelas, pagamentos ou saldos.
 */

const DEAD_INSTALLMENT_STATUSES = ["cancelled", "renegotiated"];
const DEAD_LOAN_STATUSES = ["cancelled", "renegotiated"];

const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export type InstallmentRow = {
  id?: string;
  amount?: number | string | null;
  paid_amount?: number | string | null;
  due_date?: string | null;
  status?: string | null;
  is_penalty?: boolean | null;
  loans?: { worker_id?: string | null; admin_id?: string | null; status?: string | null } | null;
};

export type CollectionMetrics = {
  /** Valor original das parcelas que vencem no período. */
  previsto: number;
  /** Saldo pendente dessas mesmas parcelas (nunca negativo). */
  faltaReceber: number;
  /** Quanto já foi aplicado nas parcelas do período (previsto - falta receber). */
  recebidoDoPrevisto: number;
  /** Saldo pendente de parcelas vencidas ANTES da data de referência. */
  valorAtrasado: number;
};

export function emptyCollectionMetrics(): CollectionMetrics {
  return { previsto: 0, faltaReceber: 0, recebidoDoPrevisto: 0, valorAtrasado: 0 };
}

/** Saldo ainda pendente de uma parcela (nunca negativo). */
export function installmentPending(i: InstallmentRow): number {
  return Math.max(num(i.amount) - num(i.paid_amount), 0);
}

/**
 * Data de referência do atraso: nunca no futuro e sempre ANTERIOR ao início
 * do período — garante que o previsto do período não vire "atrasado".
 */
export function overdueReferenceFor(startDate: string, today: string): string {
  return startDate > today ? today : startDate;
}

/** Acumula uma parcela prevista (due_date dentro do período) nas métricas. */
export function accumulateScheduled(m: CollectionMetrics, i: InstallmentRow): void {
  const amount = num(i.amount);
  const pending = installmentPending(i);
  m.previsto += amount;
  m.faltaReceber += pending;
  m.recebidoDoPrevisto += Math.max(amount - pending, 0);
}

/** Acumula uma parcela realmente vencida (due_date < referência) no valor atrasado. */
export function accumulateOverdue(m: CollectionMetrics, i: InstallmentRow): void {
  const pending = installmentPending(i);
  if (pending > 0.01) m.valorAtrasado += pending;
}

export function sumCollectionMetrics(list: CollectionMetrics[]): CollectionMetrics {
  const t = emptyCollectionMetrics();
  for (const s of list) {
    t.previsto += s.previsto;
    t.faltaReceber += s.faltaReceber;
    t.recebidoDoPrevisto += s.recebidoDoPrevisto;
    t.valorAtrasado += s.valorAtrasado;
  }
  return t;
}

const SELECT_SCHEDULED =
  "id, amount, paid_amount, due_date, status, is_penalty, loans!inner(worker_id, admin_id, status, clients!inner(archived_at))";
const SELECT_OVERDUE =
  "id, amount, paid_amount, due_date, status, is_penalty, loans!inner(id, worker_id, admin_id, client_id, status, remaining_balance, clients!inner(archived_at))";

type Scope = { workerId?: string | null; adminId?: string | null; workerIds?: string[] | null };

function applyScope(q: any, scope: Scope) {
  if (scope.workerIds && scope.workerIds.length > 0) q = q.in("loans.worker_id", scope.workerIds);
  else if (scope.workerId) q = q.eq("loans.worker_id", scope.workerId);
  if (scope.adminId) q = q.eq("loans.admin_id", scope.adminId);
  return q;
}

/** Query das parcelas PREVISTAS no período (inclui as já pagas). */
export function scheduledInstallmentsQuery(startDate: string, endDate: string, scope: Scope = {}) {
  let q: any = supabase
    .from("installments")
    .select(SELECT_SCHEDULED)
    .gte("due_date", startDate)
    .lte("due_date", endDate)
    .eq("is_penalty", false)
    .not("status", "in", `(${DEAD_INSTALLMENT_STATUSES.join(",")})`)
    .not("loans.status", "in", `(${DEAD_LOAN_STATUSES.join(",")})`)
    .is("loans.clients.archived_at", null);
  return applyScope(q, scope);
}

/** Query das parcelas realmente ATRASADAS (due_date < referência). */
export function overdueInstallmentsQuery(beforeDate: string, scope: Scope = {}) {
  let q: any = supabase
    .from("installments")
    .select(SELECT_OVERDUE)
    .lt("due_date", beforeDate)
    .eq("is_penalty", false)
    .in("status", [...INSTALLMENT_COLLECTIBLE_STATUSES])
    .in("loans.status", [...LOAN_ACTIVE_STATUSES])
    .gt("loans.remaining_balance", 0.01)
    .is("loans.clients.archived_at", null);
  return applyScope(q, scope);
}

/**
 * Métricas de cobrança de um período para um escopo.
 * Usada pela Rota do Dia, Caixa do Dia e por qualquer tela que exiba
 * Previsto / Falta receber / Valor atrasado de um único escopo.
 */
export async function fetchCollectionMetrics(
  startDate: string,
  endDate: string,
  scope: Scope = {},
  todayStr?: string,
): Promise<CollectionMetrics> {
  const m = emptyCollectionMetrics();
  const today = todayStr || new Date().toLocaleDateString("en-CA");
  const before = overdueReferenceFor(startDate, today);

  const [sched, over] = await Promise.all([
    scheduledInstallmentsQuery(startDate, endDate, scope),
    overdueInstallmentsQuery(before, scope),
  ]);
  if (sched.error) throw sched.error;
  if (over.error) throw over.error;

  ((sched.data as InstallmentRow[]) || []).forEach((i) => accumulateScheduled(m, i));
  ((over.data as InstallmentRow[]) || []).forEach((i) => accumulateOverdue(m, i));

  m.faltaReceber = Math.max(0, m.faltaReceber);
  m.valorAtrasado = Math.max(0, m.valorAtrasado);
  return m;
}
