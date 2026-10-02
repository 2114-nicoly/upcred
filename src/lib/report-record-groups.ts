import type { DailyEvent } from "@/lib/daily-events";
import type { ReportRecord } from "@/lib/report-details";
import { mergePenaltyOperations } from "@/lib/event-record";

export type RecordGroups = ReturnType<typeof buildRecordGroups>;

/**
 * Agrupa os registros detalhados por tipo de movimentação (apresentação apenas).
 * Regra única de classificação — usada pelo relatório do trabalhador e da equipe.
 * Não altera valores, saldos nem regras financeiras.
 */
export function buildRecordGroups(list: DailyEvent[], recordFor: (e: DailyEvent) => ReportRecord) {
  // renovacao_absorvida é detalhe interno da renovação: nunca listado sozinho.
  const recs = mergePenaltyOperations(list.map(recordFor)).filter((r) => !r.internal && r.kind !== "renovacao_absorvida");
  const of = (kinds: string[], filter?: (r: ReportRecord) => boolean) =>
    recs.filter((r) => kinds.includes(r.kind) && !r.reversed && (!filter || filter(r)));

  const pagamentosAll = of(["pagamento", "recebimento_multa"]);
  const parciais = pagamentosAll.filter((r) => r.title === "Pagamento parcial");
  const pagamentos = pagamentosAll.filter((r) => r.title !== "Pagamento parcial");
  const known = new Set([
    "pagamento", "recebimento_multa", "nao_pagou", "emprestimo_novo", "emprestimo_importado",
    "renovacao", "renovacao_absorvida", "renegociacao", "despesa",
  ]);
  return {
    pagamentos,
    pagamentosParciais: parciais,
    novosEmprestimos: of(["emprestimo_novo", "emprestimo_importado"]),
    renovacoes: of(["renovacao"]),
    renegociacoes: of(["renegociacao"]),
    naoPagos: of(["nao_pagou"]),
    despesas: of(["despesa"]),
    outras: recs.filter((r) => !r.reversed && !known.has(r.kind)),
    estornos: recs.filter((r) => r.reversed),
  };
}

export const RECORD_GROUP_ORDER: { key: keyof RecordGroups; label: string }[] = [
  { key: "pagamentos", label: "Pagamentos" },
  { key: "pagamentosParciais", label: "Pagamentos parciais" },
  { key: "novosEmprestimos", label: "Novos empréstimos" },
  { key: "renovacoes", label: "Renovações" },
  { key: "renegociacoes", label: "Renegociações" },
  { key: "naoPagos", label: "Clientes não pagos" },
  { key: "despesas", label: "Despesas" },
  { key: "outras", label: "Outras movimentações" },
  { key: "estornos", label: "Estornos" },
];
