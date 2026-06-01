/**
 * Cálculo unificado de totais do caixa a partir de daily_events.
 * Usar em CaixaPage, DailyCashPage, DailyCashHistoryPage e DailyReportPage
 * para evitar divergência entre relatório e fechamento.
 *
 * IMPORTANTE: ignora eventos estornados (reversed_at != null).
 */
export type DailyEventLike = {
  event_type: string;
  amount_in?: number | string | null;
  amount_out?: number | string | null;
  reversed_at?: string | null;
};

export type DailyTotals = {
  entradas: number;          // sum amount_in (não estornados)
  saidas: number;            // sum amount_out (não estornados)
  pagamentos: number;        // event_type = 'pagamento'
  multas: number;            // event_type = 'recebimento_multa'
  emprestimosLiberados: number; // event_type = 'emprestimo_novo'
  renovacoes: number;        // event_type = 'renovacao'
  renegociacoes: number;     // event_type = 'renegociacao'
  entradasManuais: number;   // event_type = 'entrada_manual'
  saidasManuais: number;     // event_type = 'saida_manual'
  naoPagos: number;          // contagem event_type = 'nao_pagou'
  saldoFinalEsperado: number; // opening + entradas - saidas
};

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
};

export function computeDailyTotals(
  events: DailyEventLike[],
  openingBalance = 0
): DailyTotals {
  const t: DailyTotals = {
    entradas: 0,
    saidas: 0,
    pagamentos: 0,
    multas: 0,
    emprestimosLiberados: 0,
    renovacoes: 0,
    renegociacoes: 0,
    entradasManuais: 0,
    saidasManuais: 0,
    naoPagos: 0,
    saldoFinalEsperado: 0,
  };
  for (const e of events || []) {
    if (e.reversed_at) continue; // estornado: não soma
    const ain = num(e.amount_in);
    const aout = num(e.amount_out);
    t.entradas += ain;
    t.saidas += aout;
    switch (e.event_type) {
      case "pagamento": t.pagamentos += ain; break;
      case "recebimento_multa": t.multas += ain; break;
      case "emprestimo_novo": t.emprestimosLiberados += aout; break;
      case "renovacao": t.renovacoes += aout; break;
      case "renegociacao": t.renegociacoes += aout; break;
      case "entrada_manual": t.entradasManuais += ain; break;
      case "saida_manual": t.saidasManuais += aout; break;
      case "nao_pagou": t.naoPagos += 1; break;
    }
  }
  t.saldoFinalEsperado = (openingBalance || 0) + t.entradas - t.saidas;
  return t;
}
