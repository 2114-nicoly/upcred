import { supabase } from "@/integrations/supabase/client";
import { getCurrentUserId, getCurrentWorkerId } from "@/lib/auth-utils";

export type CashMovementType =
  | "emprestimo"
  | "recebimento_normal"
  | "recebimento_multa"
  | "entrada_manual"
  | "saida_manual"
  | "ajuste_manual"
  | "estorno_pagamento"
  | "estorno_manual";

export type CashMovement = {
  id: string;
  type: CashMovementType;
  amount: number;
  client_id: string | null;
  loan_id: string | null;
  installment_id: string | null;
  observation: string | null;
  cash_date?: string;
  daily_event_id?: string | null;
  reversed_at?: string | null;
  reversed_by?: string | null;
  created_at: string;
};

export type CashBalance = {
  id: string;
  available_cash: number;
  money_lent: number;
  interest_receivable: number;
  penalty_receivable: number;
  updated_at: string;
};

/**
 * Returns the cash_balance row for the current user.
 * - Worker: their own row (worker_id = current worker)
 * - Admin / super_admin: the admin/global row (worker_id IS NULL)
 */
export async function getCashBalance(): Promise<CashBalance | null> {
  const workerId = await getCurrentWorkerId();
  let q = supabase.from("cash_balance").select("*");
  if (workerId) q = q.eq("worker_id", workerId);
  else q = q.is("worker_id", null);
  const { data } = await q.limit(1).maybeSingle();
  return data as unknown as CashBalance;
}

export async function updateCashBalance(changes: {
  available_cash?: number;
  money_lent?: number;
  interest_receivable?: number;
  penalty_receivable?: number;
}) {
  await supabase.rpc("update_cash_balance_atomic", {
    p_available_cash: changes.available_cash ?? 0,
    p_money_lent: changes.money_lent ?? 0,
    p_interest_receivable: changes.interest_receivable ?? 0,
    p_penalty_receivable: changes.penalty_receivable ?? 0,
  });
}

export async function createCashMovement(movement: {
  type: CashMovementType;
  amount: number;
  client_id?: string | null;
  loan_id?: string | null;
  installment_id?: string | null;
  observation?: string | null;
  cash_date?: string | null;
  daily_event_id?: string | null;
}) {
  const userId = await getCurrentUserId();
  const { data, error } = await supabase.from("cash_movements").insert({
    type: movement.type,
    amount: movement.amount,
    client_id: movement.client_id || null,
    loan_id: movement.loan_id || null,
    installment_id: movement.installment_id || null,
    observation: movement.observation || null,
    cash_date: movement.cash_date || new Date().toISOString().slice(0, 10),
    daily_event_id: movement.daily_event_id || null,
    user_id: userId,
  } as any).select().single();
  if (error) throw error;
  return data;
}

export async function linkCashMovementToDailyEvent(movementId: string, eventId: string) {
  await supabase.from("cash_movements").update({ daily_event_id: eventId } as any).eq("id", movementId);
}

/**
 * Mark a cash_movement as reversed (audit trail). NEVER deletes.
 */
export async function markCashMovementReversed(movementId: string) {
  const userId = await getCurrentUserId();
  await supabase
    .from("cash_movements")
    .update({ reversed_at: new Date().toISOString(), reversed_by: userId } as any)
    .eq("id", movementId);
}

/**
 * @deprecated kept for legacy callers — does NOT delete; marks as reversed.
 */
export async function deleteCashMovement(id: string) {
  await markCashMovementReversed(id);
}

/**
 * Recalculates cash_balance from authoritative sources, SCOPED to the
 * current user's worker_id (if logged in as worker). Admins recalculate
 * the global / their-admin scope.
 *
 * - available_cash: sum of all (non-reversed) cash_movements.amount
 * - money_lent + interest_receivable: derived from loans.remaining_balance
 * - penalty_receivable: from penalty installments (amount - paid_amount)
 */
export async function recalculateCashBalanceFromLedger() {
  const workerId = await getCurrentWorkerId();

  let movQ = supabase.from("cash_movements").select("amount, worker_id, reversed_at");
  let loanQ = supabase.from("loans").select("amount, total_amount, remaining_balance, status, worker_id");
  let instQ = supabase
    .from("installments")
    .select("amount, paid_amount, is_penalty, loan_id, loans!inner(worker_id)");

  if (workerId) {
    movQ = movQ.eq("worker_id", workerId);
    loanQ = loanQ.eq("worker_id", workerId);
    instQ = instQ.eq("loans.worker_id", workerId) as any;
  }

  const [{ data: movements }, { data: loans }, { data: installments }] = await Promise.all([
    movQ, loanQ, instQ,
  ]);

  let available_cash = 0;
  let money_lent = 0;
  let interest_receivable = 0;
  let penalty_receivable = 0;

  for (const m of (movements || []) as any[]) {
    if (m.reversed_at) continue;
    available_cash += Number(m.amount);
  }

  for (const loan of (loans || []) as any[]) {
    const principal = Number(loan.amount);
    const total = Number(loan.total_amount);
    const remaining = Math.max(0, Number(loan.remaining_balance));
    const interestPortion = Math.max(0, total - principal);
    const totalPaid = Math.max(0, total - remaining);

    const interestPaid = Math.min(interestPortion, totalPaid);
    const principalPaid = totalPaid - interestPaid;

    money_lent += Math.max(0, principal - principalPaid);
    interest_receivable += Math.max(0, interestPortion - interestPaid);
  }

  const penaltyInsts = ((installments || []) as any[]).filter((i) => i.is_penalty);
  penalty_receivable = penaltyInsts.reduce(
    (s: number, i: any) => s + Math.max(0, Number(i.amount) - Number(i.paid_amount)),
    0
  );

  const current = await getCashBalance();
  if (!current) return;

  await supabase.from("cash_balance").update({
    available_cash,
    money_lent,
    interest_receivable,
    penalty_receivable,
    updated_at: new Date().toISOString(),
  }).eq("id", current.id);
}

export function getMovementTypeLabel(type: string): string {
  switch (type) {
    case "emprestimo": return "Empréstimo";
    case "recebimento_normal": return "Recebimento Normal";
    case "recebimento_multa": return "Recebimento Multa";
    case "entrada_manual": return "Entrada Manual";
    case "saida_manual": return "Saída Manual";
    case "ajuste_manual": return "Ajuste Manual";
    case "estorno_pagamento": return "Estorno Pagamento";
    case "estorno_manual": return "Estorno Manual";
    default: return type;
  }
}

export function getMovementTypeColor(type: string): string {
  switch (type) {
    case "emprestimo": return "text-destructive";
    case "recebimento_normal": return "text-success";
    case "recebimento_multa": return "text-warning";
    case "entrada_manual": return "text-success";
    case "saida_manual": return "text-destructive";
    case "ajuste_manual": return "text-primary";
    case "estorno_pagamento": return "text-muted-foreground";
    case "estorno_manual": return "text-muted-foreground";
    default: return "text-muted-foreground";
  }
}
