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
  emprestimosImportados: number;   // contagem event_type = 'emprestimo_importado'
  valorImportadoAReceber: number;  // soma do saldo restante adicionado ao A Receber via importações
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
    emprestimosImportados: 0,
    valorImportadoAReceber: 0,
    saldoFinalEsperado: 0,
  };
  for (const e of events || []) {
    if (e.reversed_at) continue; // estornado: não soma
    const ain = num(e.amount_in);
    const aout = num(e.amount_out);
    // Empréstimo importado é informativo: não entra em entradas/saídas/pagamentos/liberados.
    if (e.event_type === "emprestimo_importado") {
      t.emprestimosImportados += 1;
      // Caso futuramente venha valor metadado em amount_in, agregamos aqui sem afetar caixa.
      t.valorImportadoAReceber += ain;
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

export type DailyCollectionSummary = {
  expectedToReceiveToday: number;
  receivedToday: number;
  pendingToReceiveToday: number;
  cashExpectedForClosing: number;
  hasError: boolean;
};

export async function getDailyCollectionSummary(
  cashDate: string,
  options: { workerId?: string | null; adminId?: string | null } = {}
): Promise<DailyCollectionSummary> {
  const { workerId = null, adminId = null } = options;
  const collectible = new Set(["pending", "partial", "overdue"]);
  let hasError = false;

  // 1) Esperado: rota do dia + multas pendentes (não inclui saldo inicial nem caixa).
  let expectedToReceiveToday = 0;
  try {
    const { data, error } = await (supabase as any).rpc("get_route_installments", { p_cash_date: cashDate });
    if (!error) {
      let rows = ((data || []) as any[]);
      const d = new Date(cashDate + "T12:00:00");
      if (d.getDay() === 0) rows = rows.filter(r => r.loan_payment_type !== "daily");

      // Escopo por trabalhador/admin
      if ((workerId || adminId) && rows.length > 0) {
        const loanIds = [...new Set(rows.map(r => r.loan_id))];
        const { data: loans } = await supabase
          .from("loans")
          .select("id, worker_id, admin_id")
          .in("id", loanIds);
        const allowed = new Set(((loans as any[]) || []).filter((l: any) => {
          if (adminId && l.admin_id !== adminId) return false;
          if (workerId && l.worker_id !== workerId) return false;
          return true;
        }).map((l: any) => l.id));
        rows = rows.filter(r => allowed.has(r.loan_id));
      }

      for (const r of rows) {
        if (!collectible.has(r.status)) continue;
        const remaining = Number(r.amount || 0) - Number(r.paid_amount || 0);
        if (remaining > 0.001) expectedToReceiveToday += remaining;
      }
    }

    // Multas pendentes cobráveis até a data
    const { data: pen } = await supabase
      .from("penalties")
      .select("amount, loan_id, loans:loan_id(worker_id, admin_id, remaining_balance, status)")
      .eq("paid", false)
      .lte("created_at", cashDate + "T23:59:59");
    for (const p of ((pen as any[]) || [])) {
      const l = p.loans;
      if (!l) continue;
      if (Number(l.remaining_balance || 0) <= 0.001) continue;
      if (adminId && l.admin_id !== adminId) continue;
      if (workerId && l.worker_id !== workerId) continue;
      expectedToReceiveToday += Number(p.amount || 0);
    }
  } catch {
    // ignora — mantém 0
  }

  // 2) Recebido hoje + componentes para conferência do caixa.
  //    NÃO usar soma genérica amount_in/amount_out: o "Valor Esperado no Caixa" segue a fórmula
  //    opening + pagamentos + multas + entradasManuais - emprestimosLiberados(+renovação+renegociação) - saidasManuais.
  let receivedToday = 0;
  let pagamentos = 0;
  let multas = 0;
  let manualIn = 0;
  let manualOut = 0;
  let lent = 0;
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
      switch (e.event_type) {
        case "pagamento": pagamentos += ain; break;
        case "recebimento_multa": multas += ain; break;
        case "entrada_manual": manualIn += ain; break;
        case "saida_manual": manualOut += aout; break;
        case "emprestimo_novo":
        case "renovacao":
        case "renegociacao": lent += aout; break;
        default: break;
      }
    }
    receivedToday = pagamentos + multas;
  } catch {
    // ignora
  }

  // 3) Saldo inicial do dia (para conferência do caixa)
  let opening = 0;
  try {
    const scope = await getCurrentDailyCashScope();
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

  } catch {
    // ignora
  }

  // Esperado no caixa = dinheiro físico esperado (sem futuras cobranças, sem importados).
  const cashExpectedForClosing = opening + pagamentos + multas + manualIn - lent - manualOut;
  const pendingToReceiveToday = Math.max(0, expectedToReceiveToday - receivedToday);

  return {
    expectedToReceiveToday,
    receivedToday,
    pendingToReceiveToday,
    cashExpectedForClosing,
  };
}

