import { supabase } from "@/integrations/supabase/client";
import { getTodayCashDate } from "@/lib/cash-lock";

export type ActiveCashScope = {
  workerId?: string | null;
  adminId?: string | null;
};

export type ActiveCash = {
  id: string;
  cashDate: string;
  status: string;
  workerId: string | null;
  adminId: string | null;
  openingBalance: number;
};

export const NO_ACTIVE_CASH_MESSAGE =
  "Nenhum caixa aberto. Abra o caixa do dia antes de registrar essa operação.";

export function wrongCashDateMessage(activeDate: string): string {
  return `Operação bloqueada: o caixa aberto é de ${formatCashDate(activeDate)}. Todas as novas movimentações devem ser registradas nessa data.`;
}

export function formatCashDate(date: string): string {
  const [y, m, d] = date.split("-");
  return `${d}/${m}/${y}`;
}

export function openCashNoticeMessage(activeDate: string): string {
  return `Caixa de ${formatCashDate(activeDate)} ainda aberto. Todas as novas movimentações serão registradas nesse caixa.`;
}

/**
 * Consulta o caixa aberto do escopo EXATO (worker_id + admin_id).
 * A validação de permissão acontece no servidor
 * (`get_active_daily_cash_for_scope`): trabalhador só o próprio caixa,
 * administrador só a própria empresa/equipe, super admin só a empresa ou
 * trabalhador selecionado. Nunca mistura administradores ou trabalhadores.
 */
export async function fetchActiveCash(scope: ActiveCashScope = {}): Promise<ActiveCash | null> {
  const { data, error } = await supabase.rpc("get_active_daily_cash_for_scope" as any, {
    p_worker_id: scope.workerId ?? null,
    p_admin_id: scope.adminId ?? null,
  } as any);
  if (error) throw error;
  const row = Array.isArray(data) ? (data[0] as any) : (data as any);
  if (!row) return null;
  return {
    id: row.id,
    cashDate: row.cash_date,
    status: row.status,
    workerId: row.worker_id ?? null,
    adminId: row.admin_id ?? null,
    openingBalance: Number(row.opening_balance ?? 0),
  };
}

/**
 * Data operacional: a data do caixa aberto (mesmo antiga). Sem caixa aberto,
 * a data atual de America/Sao_Paulo (apenas para leitura/abertura).
 */
export async function resolveOperationalDate(scope: ActiveCashScope = {}): Promise<{
  date: string;
  activeCash: ActiveCash | null;
}> {
  const activeCash = await fetchActiveCash(scope);
  return { date: activeCash?.cashDate ?? getTodayCashDate(), activeCash };
}

/** Exige um caixa aberto e devolve a sua data. Lança mensagem clara caso não exista. */
export async function requireActiveCashDate(scope: ActiveCashScope = {}): Promise<string> {
  const active = await fetchActiveCash(scope);
  if (!active) throw new Error(NO_ACTIVE_CASH_MESSAGE);
  return active.cashDate;
}

/**
 * Exige que a operação aconteça exatamente na data do caixa aberto.
 * Nunca considera uma data válida apenas porque não está fechada.
 */
export async function assertOperationDate(
  cashDate: string,
  scope: ActiveCashScope = {}
): Promise<ActiveCash> {
  const active = await fetchActiveCash(scope);
  if (!active) throw new Error(NO_ACTIVE_CASH_MESSAGE);
  if (active.cashDate !== cashDate) throw new Error(wrongCashDateMessage(active.cashDate));
  return active;
}
