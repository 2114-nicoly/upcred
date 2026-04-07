import { supabase } from "@/integrations/supabase/client";

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
  const { data } = await supabase.from("cash_movements").insert({
    type: movement.type,
    amount: movement.amount,
    client_id: movement.client_id || null,
    loan_id: movement.loan_id || null,
    installment_id: movement.installment_id || null,
    observation: movement.observation || null,
    cash_date: movement.cash_date || new Date().toISOString().slice(0, 10),
  } as any).select().single();
  return data;
}

export async function deleteCashMovement(id: string) {
  await supabase.from("cash_movements").delete().eq("id", id);
}

/**
 * Recalculates cash_balance from all cash_movements (ledger = source of truth).
 * Call this after bulk deletes or when balance may be out of sync.
 */
export async function recalculateCashBalanceFromLedger() {
  const { data: movements } = await supabase.from("cash_movements").select("type, amount");
  if (!movements) return;

  let available_cash = 0;
  let money_lent = 0;
  let interest_receivable = 0;
  let penalty_receivable = 0;

  // We also need loan data to compute interest/principal split
  // Instead, we derive from movements directly:
  // emprestimo: cash -= |amount|, money_lent += |amount|, interest_receivable += interest
  // recebimento_normal: cash += amount (interest/principal split needs loan data)
  // recebimento_multa: cash += amount, penalty_receivable -= amount
  // entrada_manual: cash += amount
  // saida_manual: cash += amount (amount is negative)
  // ajuste_manual: cash += amount

  // For accurate split, we need loan-level data. Let's compute from loans table.
  const { data: loans } = await supabase.from("loans").select("id, amount, total_amount");
  const { data: installments } = await supabase.from("installments").select("loan_id, amount, paid_amount, is_penalty");
  const { data: penaltyRecords } = await supabase.from("penalties").select("amount");

  // money_lent = sum of loan.amount for non-fully-paid loans minus what was paid toward principal
  // interest_receivable = sum of (loan.total_amount - loan.amount) minus what was paid toward interest
  // penalty_receivable = sum of penalty amounts minus penalty payments

  if (loans && installments) {
    for (const loan of loans) {
      const loanInsts = installments.filter(i => i.loan_id === loan.id && !i.is_penalty);
      const totalPaid = loanInsts.reduce((s, i) => s + Number(i.paid_amount), 0);
      const loanInterest = Number(loan.total_amount) - Number(loan.amount);
      const interestPaid = Math.min(loanInterest, totalPaid);
      const principalPaid = totalPaid - interestPaid;

      money_lent += Number(loan.amount) - principalPaid;
      interest_receivable += loanInterest - interestPaid;
    }
  }

  // penalty_receivable from installments
  if (installments) {
    const penaltyInsts = installments.filter(i => i.is_penalty);
    penalty_receivable = penaltyInsts.reduce((s, i) => s + Number(i.amount) - Number(i.paid_amount), 0);
  }

  // available_cash = sum of all movements
  for (const m of movements) {
    available_cash += Number(m.amount);
  }

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
