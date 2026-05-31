import { supabase } from "@/integrations/supabase/client";

/**
 * Returns true if the daily_cash row for the current user's scope (worker or
 * admin) on the given date has status='closed'. Uses the SQL function
 * `is_cash_closed` so the scope is resolved on the server (auth.uid()).
 */
export async function isCashClosed(cashDate: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc("is_cash_closed" as any, {
      p_cash_date: cashDate,
    } as any);
    if (error) {
      console.warn("[cash-lock] is_cash_closed rpc failed", error);
      return false;
    }
    return data === true;
  } catch (err) {
    console.warn("[cash-lock] is_cash_closed threw", err);
    return false;
  }
}

/**
 * Throws if the cash for the given date is closed.
 * Use at the start of any handler that mutates financial data for that date.
 */
export async function assertCashOpen(cashDate: string): Promise<void> {
  const closed = await isCashClosed(cashDate);
  if (closed) {
    throw new Error(
      "Caixa do dia já está fechado. Reabra o caixa antes de registrar essa operação."
    );
  }
}
