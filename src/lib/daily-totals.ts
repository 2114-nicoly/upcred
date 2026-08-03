/**
 * Cálculo unificado de totais do caixa a partir de daily_events.
 * Usar em CaixaPage, DailyCashPage, DailyCashHistoryPage e DailyReportPage
 * para evitar divergência entre relatório e fechamento.
 *
 * REGRA DE ESTORNO (sem impacto duplo):
 * - lançamento original estornado NÃO conta como recebido/despesa válida;
 * - o valor estornado aparece separadamente em `estornos`;
 * - para o impacto líquido no caixa (entradas/saídas) soma-se
 *   original + contrapartida (resultado zero) — nunca só a contrapartida;
 * - estorno antigo SEM contrapartida continua ignorado e sinalizado.
 */
export type DailyEventLike = {
  id?: string | null;
  event_type: string;
  amount_in?: number | string | null;
  amount_out?: number | string | null;
  reversed_at?: string | null;
  reversal_event_id?: string | null;
  reverses_event_id?: string | null;
  metadata?: Record<string, any> | null;
};

export type DailyTotals = {
  entradas: number;          // impacto líquido de entradas (original + contrapartida)
  saidas: number;            // impacto líquido de saídas (original + contrapartida)
  pagamentos: number;        // event_type = 'pagamento' (não estornados)
  multas: number;            // event_type = 'recebimento_multa'
  emprestimosLiberados: number; // event_type = 'emprestimo_novo'
  renovacoes: number;        // event_type = 'renovacao'
  renegociacoes: number;     // event_type = 'renegociacao'
  entradasManuais: number;   // event_type = 'entrada_manual'
  saidasManuais: number;     // event_type = 'saida_manual'
  despesas: number;          // event_type = 'despesa'
  despesasCount: number;
  despesasPorCategoria: Record<string, number>;
  naoPagos: number;          // contagem event_type = 'nao_pagou'
  emprestimosImportados: number;   // contagem event_type = 'emprestimo_importado'
  valorImportadoAReceber: number;  // soma do saldo restante adicionado ao A Receber via importações
  /** Total estornado no dia (valor absoluto das contrapartidas). */
  estornos: number;
  estornosCount: number;
  /** Estornos legados sem contrapartida (ignorados, apenas sinalizados). */
  estornosSemContrapartida: string[];
  saldoFinalEsperado: number; // opening + entradas - saidas
};

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
};

const isReversalType = (t: string) => String(t || "").startsWith("estorno");

/**
 * Estornos do período: SEMPRE o valor absoluto das contrapartidas
 * (`reverses_event_id` preenchido ou event_type `estorno_*`), contado UMA vez.
 * O lançamento original estornado nunca é somado aqui.
 */
export function computeReversalSummary(
  events: DailyEventLike[] | null | undefined
): { total: number; count: number } {
  let total = 0;
  let count = 0;
  for (const e of events || []) {
    if (!e) continue;
    const isCounter = !!e.reverses_event_id || isReversalType(e.event_type);
    if (!isCounter) continue;
    total += Math.abs(num(e.amount_in)) + Math.abs(num(e.amount_out));
    count += 1;
  }
  return { total, count };
}

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
    despesas: 0,
    despesasCount: 0,
    despesasPorCategoria: {},
    naoPagos: 0,
    emprestimosImportados: 0,
    valorImportadoAReceber: 0,
    estornos: 0,
    estornosCount: 0,
    estornosSemContrapartida: [],
    saldoFinalEsperado: 0,
  };

  const list = events || [];
  const counteredIds = new Set<string>();
  for (const e of list) {
    if (e.reverses_event_id) counteredIds.add(String(e.reverses_event_id));
  }

  for (const e of list) {
    const ain = num(e.amount_in);
    const aout = num(e.amount_out);

    // Empréstimo importado é informativo: nunca entra no caixa.
    if (e.event_type === "emprestimo_importado") {
      t.emprestimosImportados += 1;
      t.valorImportadoAReceber += ain;
      continue;
    }

    const hasCounter = !!e.reversal_event_id || (e.id ? counteredIds.has(String(e.id)) : false);

    // Contrapartida de estorno: entra apenas no efeito líquido do caixa.
    if (isReversalType(e.event_type)) {
      t.entradas += ain;
      t.saidas += aout;
      t.estornos += ain + aout;
      t.estornosCount += 1;
      continue;
    }

    if (e.reversed_at) {
      if (!hasCounter) {
        // Padrão legado: estornado sem contrapartida — ignorar e sinalizar.
        if (e.id) t.estornosSemContrapartida.push(String(e.id));
        continue;
      }
      // Original preservado: soma no caixa para anular com a contrapartida,
      // mas NÃO conta como recebido/despesa válida.
      t.entradas += ain;
      t.saidas += aout;
      continue;
    }

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
      case "despesa": {
        t.despesas += aout;
        t.despesasCount += 1;
        const cat = (e.metadata?.category as string) || "Outros";
        t.despesasPorCategoria[cat] = (t.despesasPorCategoria[cat] || 0) + aout;
        break;
      }
      case "nao_pagou": t.naoPagos += 1; break;
    }
  }
  t.saldoFinalEsperado = (openingBalance || 0) + t.entradas - t.saidas;
  return t;
}


// ============================================================================
// Resumo unificado de cobranças do dia
// Usar tanto na Rota do Dia (DailyCashPage) quanto na Caixa do Dia (CaixaPage)
// para garantir que ambas mostrem exatamente os mesmos números:
//   - expectedToReceiveToday: quanto era para receber se TODOS pagassem
//   - receivedToday: pagamentos + multas efetivamente recebidos hoje
//   - pendingToReceiveToday: max(esperado - recebido, 0)
//   - cashExpectedForClosing: saldo inicial + entradas reais - saídas reais
// ============================================================================
import { supabase } from "@/integrations/supabase/client";
import { getCurrentDailyCashScope, applyDailyCashScope } from "@/lib/cash-utils";
import { fetchCollectionMetrics } from "@/lib/collection-metrics";

export type DailyCollectionSummary = {
  /** Previsto do dia: parcelas regulares com vencimento EXATAMENTE na data. */
  expectedToReceiveToday: number;
  /** Recebido total no dia (pagamentos + multas), independente do previsto. */
  receivedToday: number;
  /** Recebido aplicado nas parcelas que venciam na data. */
  receivedFromExpected: number;
  /** Saldo pendente somente das parcelas que vencem na data. */
  pendingToReceiveToday: number;
  /** Saldo pendente de parcelas vencidas ANTES da data (nunca da própria data). */
  overdueAmount: number;
  cashExpectedForClosing: number;
  /** Total estornado no dia (não conta como recebido). */
  reversedToday: number;
  hasError: boolean;
  /**
   * Dia fechado com histórico congelado INCOMPLETO (fechamento antigo
   * reconciliado). Previsto, falta receber e atrasado NÃO existem para esse dia
   * e nunca podem ser recalculados com as parcelas atuais.
   */
  historicalIncomplete: boolean;
};

/** Texto único para valores que nunca foram congelados. */
export const HISTORICAL_UNAVAILABLE_LABEL = "Informação histórica indisponível";

export async function getDailyCollectionSummary(
  cashDate: string,
  options: { workerId?: string | null; adminId?: string | null } = {}
): Promise<DailyCollectionSummary> {
  const { workerId = null, adminId = null } = options;
  let hasError = false;

  // 0) Dia FECHADO -> valores congelados no snapshot oficial (nunca recalculados
  //    com as parcelas atuais). Dia aberto segue com os dados atuais.
  try {
    const scope0 = await getCurrentDailyCashScope({ workerId, adminId });
    const { data: dc0 } = await applyDailyCashScope(
      supabase.from("daily_cash").select("status").eq("cash_date", cashDate),
      scope0
    ).maybeSingle();
    if ((dc0 as any)?.status === "closed") {
      const { loadDailyCashSnapshot } = await import("@/lib/daily-snapshot");
      const snap = await loadDailyCashSnapshot(cashDate, { workerId, adminId });

      // Histórico incompleto: PROIBIDO consultar parcelas/empréstimos atuais.
      if (snap && (snap as any).historical_complete === false) {
        const t: any = (snap as any).totals || {};
        return {
          expectedToReceiveToday: 0,
          receivedToday: (Number(t.received) || 0) + (Number(t.penalty) || 0),
          receivedFromExpected: 0,
          pendingToReceiveToday: 0,
          overdueAmount: 0,
          reversedToday: Number(t.estornos) || 0,
          cashExpectedForClosing: Number(t.expected_worker_cash) || 0,
          hasError: false,
          historicalIncomplete: true,
        };
      }

      const ds = snap?.daily_summary;
      if (ds) {
        return {
          expectedToReceiveToday: Number(ds.expectedToReceiveToday) || 0,
          receivedToday: Number(ds.receivedToday) || 0,
          receivedFromExpected: Number(
            ds.receivedFromExpected ?? Math.max((ds.expectedToReceiveToday || 0) - (ds.pendingToReceiveToday || 0), 0)
          ) || 0,
          pendingToReceiveToday: Number(ds.pendingToReceiveToday) || 0,
          overdueAmount: Number(ds.overdueAmount ?? 0) || 0,
          reversedToday: Number((ds as any).reversedToday ?? 0) || 0,

          cashExpectedForClosing: Number(ds.cashExpectedForClosing) || 0,
          hasError: false,
          historicalIncomplete: false,
        };
      }
    }
  } catch (err) {
    console.warn("[getDailyCollectionSummary] snapshot indisponível, usando dados atuais", err);
  }



  // 1) Previsto / falta receber / atrasado — fonte única compartilhada.
  //    Sem multas, sem parcelas de outros dias, sem saldo total do empréstimo.
  let expectedToReceiveToday = 0;
  let pendingToReceiveToday = 0;
  let receivedFromExpected = 0;
  let overdueAmount = 0;
  try {
    const m = await fetchCollectionMetrics(cashDate, cashDate, { workerId, adminId });
    expectedToReceiveToday = m.previsto;
    pendingToReceiveToday = m.faltaReceber;
    receivedFromExpected = m.recebidoDoPrevisto;
    overdueAmount = m.valorAtrasado;
  } catch (err) {
    console.error("[getDailyCollectionSummary] previsto/atrasado falhou", err);
    hasError = true;
  }


  // 2) Recebido hoje + componentes para conferência do caixa.
  //    NÃO usar soma genérica amount_in/amount_out: o "Valor Esperado no Caixa" segue a fórmula
  //    opening + pagamentos + multas + entradasManuais - emprestimosLiberados(+renovação+renegociação) - saidasManuais.
  let receivedToday = 0;
  let pagamentos = 0;
  let multas = 0;
  let manualIn = 0;
  let manualOut = 0;
  let expenses = 0;
  let lent = 0;
  let reversedToday = 0;
  try {
    let q: any = supabase.from("daily_events" as any)
      .select("event_type, amount_in, amount_out, reversed_at, worker_id, admin_id")
      .eq("cash_date", cashDate)
      .is("reversed_at", null);
    if (workerId) q = q.eq("worker_id", workerId);
    if (adminId) q = q.eq("admin_id", adminId);
    const { data } = await q;
    for (const e of ((data as any[]) || [])) {
      if (e.event_type === "emprestimo_importado") continue;
      const ain = Number(e.amount_in) || 0;
      const aout = Number(e.amount_out) || 0;
      // Contrapartida de estorno: o original já foi excluído (reversed_at),
      // então a contrapartida também não entra nos buckets — apenas em "Estornos".
      if (String(e.event_type || "").startsWith("estorno")) {
        reversedToday += ain + aout;
        continue;
      }
      switch (e.event_type) {
        case "pagamento": pagamentos += ain; break;
        case "recebimento_multa": multas += ain; break;
        case "entrada_manual": manualIn += ain; break;
        case "saida_manual": manualOut += aout; break;
        case "despesa": expenses += aout; break;
        case "emprestimo_novo":
        case "renovacao":
        case "renegociacao": lent += aout; break;
        default: break;
      }
    }
    receivedToday = pagamentos + multas;

  } catch (err) {
    console.error("[getDailyCollectionSummary] recebido/lançamentos falhou", err);
    hasError = true;
  }

  // 3) Saldo inicial do dia (para conferência do caixa)
  let opening = 0;
  try {
    const scope = await getCurrentDailyCashScope({ workerId, adminId });
    const { data: dc } = await applyDailyCashScope(
      supabase.from("daily_cash").select("opening_balance, status").eq("cash_date", cashDate),
      scope
    ).maybeSingle();
    const dcAny = dc as any;
    if (dcAny?.opening_balance != null) {
      opening = Number(dcAny.opening_balance) || 0;
    } else {
      const { data: prior } = await applyDailyCashScope(
        supabase.from("daily_cash")
          .select("counted_closing_balance, expected_closing_balance, cash_date")
          .lt("cash_date", cashDate)
          .eq("status", "closed")
          .order("cash_date", { ascending: false })
          .limit(1),
        scope
      );
      const prev = (prior?.[0] as any) || null;
      if (prev) opening = Number(prev.counted_closing_balance ?? prev.expected_closing_balance ?? 0) || 0;
    }
    if (opening < 0) {
      console.warn("[daily-totals] Saldo inicial negativo, exibindo 0:", opening);
      opening = 0;
    }

  } catch (err) {
    console.error("[getDailyCollectionSummary] saldo inicial falhou", err);
    hasError = true;
  }

  // Esperado no caixa = dinheiro físico esperado (sem futuras cobranças, sem importados).
  const cashExpectedForClosing = opening + pagamentos + multas + manualIn - lent - manualOut - expenses;

  return {
    expectedToReceiveToday,
    receivedToday,
    receivedFromExpected,
    pendingToReceiveToday,
    overdueAmount,
    cashExpectedForClosing,
    reversedToday,

    hasError,
  };
}

