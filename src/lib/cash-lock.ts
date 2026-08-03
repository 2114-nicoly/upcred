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
 * Exige que exista um caixa ABERTO no escopo e que a operação esteja
 * exatamente na data desse caixa. Não basta a data "não estar fechada".
 */
export async function assertCashOpen(
  cashDate: string,
  scope: { workerId?: string | null; adminId?: string | null } = {}
): Promise<void> {
  const { assertOperationDate } = await import("@/lib/active-cash");
  await assertOperationDate(cashDate, scope);
}


/** Today's date (America/Sao_Paulo) as yyyy-MM-dd — same rule as the server. */
export function getTodayCashDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export type CashDateKind = "today" | "past" | "future";

/** Classifies a cash date against today's date in America/Sao_Paulo. */
export function classifyCashDate(cashDate: string, now: Date = new Date()): CashDateKind {
  const today = getTodayCashDate(now);
  if (cashDate === today) return "today";
  return cashDate > today ? "future" : "past";
}

/** True only when the given date may be opened (must be exactly today). */
export function canOpenCashDate(cashDate: string, now: Date = new Date()): boolean {
  return classifyCashDate(cashDate, now) === "today";
}

export const CASH_OPEN_FUTURE_MESSAGE =
  "Não é permitido abrir caixa em data futura. Abra o caixa na própria data.";
export const CASH_OPEN_PAST_MESSAGE =
  "Não é permitido abrir um caixa antigo. Utilize o processo de solicitação de reabertura.";

/**
 * Opens (or returns existing open id) the daily_cash row for the current
 * user's scope on the given date. Server-side RPC enforces scope, the
 * today-only rule and inherits the opening balance.
 */
export async function openDailyCash(cashDate: string, workerId?: string | null): Promise<string> {
  const kind = classifyCashDate(cashDate);
  if (kind === "future") throw new Error(CASH_OPEN_FUTURE_MESSAGE);
  if (kind === "past") throw new Error(CASH_OPEN_PAST_MESSAGE);
  const params: any = { p_cash_date: cashDate };
  if (workerId) params.p_worker_id = workerId;
  const { data, error } = await supabase.rpc("open_daily_cash" as any, params);
  if (error) throw error;
  return (data as unknown as string) || "";
}

