import { supabase } from "@/integrations/supabase/client";
import { getCurrentUserId } from "@/lib/auth-utils";

export type CashMovementType =
  | "emprestimo"
  | "recebimento_normal"
  | "recebimento_multa"
  | "entrada_manual"
  | "saida_manual"
  | "ajuste_manual";

export type CashMovement = {
  id: string;
  type: CashMovementType;
  amount: number;
  client_id: string | null;
  loan_id: string | null;
  installment_id: string | null;
  observation: string | null;
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

export async function getCashBalance(): Promise<CashBalance | null> {
  const { data } = await supabase.from("cash_balance").select("*").limit(1).single();
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
}) {
  const userId = await getCurrentUserId();
  const { data } = await supabase.from("cash_movements").insert({
    type: movement.type,
    amount: movement.amount,
    client_id: movement.client_id || null,
    loan_id: movement.loan_id || null,
    installment_id: movement.installment_id || null,
    observation: movement.observation || null,
    cash_date: movement.cash_date || new Date().toISOString().slice(0, 10),
    user_id: userId,
  } as any).select().single();
  return data;
}

export async function deleteCashMovement(id: string) {
  await supabase.from("cash_movements").delete().eq("id", id);
}

/**
 * Recalculates cash_balance from authoritative sources:
 * - available_cash: sum of ALL cash_movements (ledger of cash flow)
 * - money_lent + interest_receivable: derived from loans.remaining_balance (single source of truth)
 * - penalty_receivable: derived from penalty installments (amount - paid_amount)
 *
 * IMPORTANT: This uses loan.remaining_balance (set by apply_loan_payment RPC) instead of
 * installments.paid_amount, ensuring consistency even when installments are edited manually.
 */
export async function recalculateCashBalanceFromLedger() {
  const [{ data: movements }, { data: loans }, { data: installments }] = await Promise.all([
    supabase.from("cash_movements").select("amount"),
    supabase.from("loans").select("amount, total_amount, remaining_balance, status"),
    supabase.from("installments").select("amount, paid_amount, is_penalty"),
  ]);

  let available_cash = 0;
  let money_lent = 0;
  let interest_receivable = 0;
  let penalty_receivable = 0;

  // available_cash = ledger sum
  for (const m of (movements || [])) {
    available_cash += Number(m.amount);
  }

  // money_lent + interest_receivable: derived from remaining_balance
  // Allocation rule: paid amount goes to interest first, then principal
  for (const loan of (loans || [])) {
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

  // penalty_receivable: from penalty installments
  const penaltyInsts = (installments || []).filter((i: any) => i.is_penalty);
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
    default: return "text-muted-foreground";
  }
}
