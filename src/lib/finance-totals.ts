import { supabase } from "@/integrations/supabase/client";

/**
 * Fonte ÚNICA dos três indicadores financeiros exibidos em todos os relatórios
 * e painéis (Trabalhador, Administrador e SuperAdministrador):
 *
 *  1. Caixa disponível  -> exclusivamente cash_balance.available_cash
 *  2. Valor emprestado  -> apenas dinheiro realmente liberado (amount_out do evento)
 *  3. Valor recebido    -> principal (pagamento) + multas (recebimento_multa), separados
 *
 * Nenhuma função aqui altera dados no banco.
 */

export type CoreEventLike = {
  event_type: string;
  amount_in?: number | string | null;
  amount_out?: number | string | null;
  reversed_at?: string | null;
};

export type CoreTotals = {
  /** Recebido de parcelas/quitações (event_type = 'pagamento'). */
  recebidoPrincipal: number;
  /** Multas efetivamente recebidas (event_type = 'recebimento_multa'). */
  multasRecebidas: number;
  /** Principal + multas. */
  recebidoTotal: number;
  /** Dinheiro realmente entregue ao cliente no período. */
  emprestado: number;
};

const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Tipos de evento que representam liberação de dinheiro ao cliente.
 * O valor considerado é SEMPRE `amount_out` (dinheiro que saiu do caixa),
 * nunca o total do contrato. Em renovação/renegociação, `amount_out` já é
 * apenas o adicional entregue — saldo absorvido e juros ficam em R$ 0,00.
 */
const LENDING_EVENT_TYPES = new Set(["emprestimo_novo", "renovacao", "renegociacao"]);

export function emptyCoreTotals(): CoreTotals {
  return { recebidoPrincipal: 0, multasRecebidas: 0, recebidoTotal: 0, emprestado: 0 };
}

/**
 * Calcula recebido (principal/multas) e emprestado a partir dos daily_events.
 * Ignora eventos estornados, informativos e marcações de "não pagou".
 * Cada valor é contado uma única vez — sempre pelo evento financeiro.
 */
export function computeCoreTotals(events: CoreEventLike[] | null | undefined): CoreTotals {
  const t = emptyCoreTotals();
  for (const e of events || []) {
    if (!e || e.reversed_at) continue;
    if (e.event_type === "pagamento") t.recebidoPrincipal += num(e.amount_in);
    else if (e.event_type === "recebimento_multa") t.multasRecebidas += num(e.amount_in);
    else if (LENDING_EVENT_TYPES.has(e.event_type)) t.emprestado += num(e.amount_out);
  }
  t.recebidoTotal = t.recebidoPrincipal + t.multasRecebidas;
  return t;
}

/** Soma totais já calculados (equipe = soma dos trabalhadores). */
export function sumCoreTotals(list: CoreTotals[]): CoreTotals {
  const t = emptyCoreTotals();
  for (const s of list) {
    t.recebidoPrincipal += s.recebidoPrincipal;
    t.multasRecebidas += s.multasRecebidas;
    t.emprestado += s.emprestado;
  }
  t.recebidoTotal = t.recebidoPrincipal + t.multasRecebidas;
  return t;
}

export type AvailableCashMap = Record<string, number>;

/**
 * Caixa disponível atual por trabalhador (cash_balance.available_cash).
 * Trabalhador sem registro em cash_balance retorna 0.
 * Erro de consulta é propagado — nunca convertido em R$ 0,00 "confirmado".
 */
export async function fetchAvailableCashByWorker(workerIds: string[]): Promise<AvailableCashMap> {
  const ids = Array.from(new Set(workerIds.filter(Boolean)));
  const map: AvailableCashMap = {};
  ids.forEach((id) => { map[id] = 0; });
  if (ids.length === 0) return map;

  const { data, error } = await supabase
    .from("cash_balance")
    .select("worker_id, available_cash")
    .in("worker_id", ids);
  if (error) throw error;

  (data || []).forEach((r: any) => {
    if (r.worker_id) map[r.worker_id] = num(r.available_cash);
  });
  return map;
}

/** Caixa disponível de um único trabalhador (0 quando não houver registro). */
export async function fetchWorkerAvailableCash(workerId: string): Promise<number> {
  const map = await fetchAvailableCashByWorker([workerId]);
  return map[workerId] ?? 0;
}

/** Soma o caixa disponível apenas dos trabalhadores informados (ativos). */
export function sumAvailableCash(map: AvailableCashMap, workerIds: string[]): number {
  return workerIds.reduce((s, id) => s + num(map[id]), 0);
}
