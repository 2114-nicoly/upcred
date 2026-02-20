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
  const current = await getCashBalance();
  if (!current) return;

  const updated: Record<string, number> = {};
  if (changes.available_cash !== undefined)
    updated.available_cash = Number(current.available_cash) + changes.available_cash;
  if (changes.money_lent !== undefined)
    updated.money_lent = Number(current.money_lent) + changes.money_lent;
  if (changes.interest_receivable !== undefined)
    updated.interest_receivable = Number(current.interest_receivable) + changes.interest_receivable;
  if (changes.penalty_receivable !== undefined)
    updated.penalty_receivable = Number(current.penalty_receivable) + changes.penalty_receivable;

  await supabase.from("cash_balance").update({ ...updated, updated_at: new Date().toISOString() }).eq("id", current.id);
}

export async function createCashMovement(movement: {
  type: CashMovementType;
  amount: number;
  client_id?: string | null;
  loan_id?: string | null;
  installment_id?: string | null;
  observation?: string | null;
}) {
  const { data } = await supabase.from("cash_movements").insert({
    type: movement.type,
    amount: movement.amount,
    client_id: movement.client_id || null,
    loan_id: movement.loan_id || null,
    installment_id: movement.installment_id || null,
    observation: movement.observation || null,
  }).select().single();
  return data;
}

export async function deleteCashMovement(id: string) {
  await supabase.from("cash_movements").delete().eq("id", id);
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
