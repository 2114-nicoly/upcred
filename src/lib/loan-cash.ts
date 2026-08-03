import { supabase } from "@/integrations/supabase/client";
import { ActiveCash, fetchActiveCash, formatCashDate } from "@/lib/active-cash";

/**
 * Escopo financeiro EXATO de um empréstimo/cliente (dono da operação).
 *
 * Telas que listam empréstimos de vários trabalhadores NUNCA podem usar o
 * escopo global do usuário logado para gravar: cada ação precisa usar o caixa
 * aberto do trabalhador dono do empréstimo.
 */
export type CashScope = {
  workerId: string | null;
  adminId: string | null;
};

export const NO_SCOPE_CASH_MESSAGE =
  "O trabalhador responsável não possui caixa aberto. Abra o caixa dele antes de registrar essa operação.";

export function scopeWrongDateMessage(activeDate: string): string {
  return `Operação bloqueada: o caixa aberto do trabalhador responsável é de ${formatCashDate(
    activeDate
  )}. Registre a movimentação nessa data.`;
}

/** Chave estável do escopo — usada para detectar troca de trabalhador/empresa. */
export function scopeKey(scope: CashScope | null | undefined): string | null {
  if (!scope) return null;
  if (!scope.workerId && !scope.adminId) return null;
  return `${scope.workerId ?? "-"}|${scope.adminId ?? "-"}`;
}

export function sameScope(a: CashScope | null, b: CashScope | null): boolean {
  return scopeKey(a) === scopeKey(b);
}

/** Escopo do empréstimo (worker_id + admin_id gravados na linha). */
export async function getLoanCashScope(loanId: string): Promise<CashScope> {
  const { data, error } = await supabase
    .from("loans")
    .select("worker_id, admin_id")
    .eq("id", loanId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Empréstimo não encontrado.");
  return { workerId: (data as any).worker_id ?? null, adminId: (data as any).admin_id ?? null };
}

/** Escopo do cliente (usado no cadastro de um novo empréstimo). */
export async function getClientCashScope(
  clientId: string
): Promise<CashScope & { name: string }> {
  const { data, error } = await supabase
    .from("clients")
    .select("name, worker_id, admin_id")
    .eq("id", clientId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Cliente não encontrado.");
  return {
    name: (data as any).name ?? "",
    workerId: (data as any).worker_id ?? null,
    adminId: (data as any).admin_id ?? null,
  };
}

/** Caixa aberto do escopo exato informado. */
export async function fetchScopedActiveCash(scope: CashScope): Promise<ActiveCash | null> {
  return fetchActiveCash({ workerId: scope.workerId, adminId: scope.adminId });
}

/** Data do caixa aberto do escopo. Lança se o trabalhador não tiver caixa aberto. */
export async function requireScopedCashDate(scope: CashScope): Promise<string> {
  const active = await fetchScopedActiveCash(scope);
  if (!active) throw new Error(NO_SCOPE_CASH_MESSAGE);
  return active.cashDate;
}

/**
 * Exige caixa aberto NO ESCOPO DO EMPRÉSTIMO e que a data da operação seja
 * exatamente a data desse caixa.
 */
export async function assertScopedCashOpen(
  cashDate: string,
  scope: CashScope
): Promise<ActiveCash> {
  const active = await fetchScopedActiveCash(scope);
  if (!active) throw new Error(NO_SCOPE_CASH_MESSAGE);
  if (active.cashDate !== cashDate) throw new Error(scopeWrongDateMessage(active.cashDate));
  return active;
}

/** Atalho: resolve o escopo pelo empréstimo e valida a data. */
export async function assertLoanCashOpen(
  cashDate: string,
  loanId: string
): Promise<ActiveCash> {
  const scope = await getLoanCashScope(loanId);
  return assertScopedCashOpen(cashDate, scope);
}
