/**
 * ÍNDICE ÚNICO DE BUSCA DA ROTA DO DIA.
 *
 * Função PURA: recebe exatamente o que a tela já carregou (pendentes, pagos,
 * não pagos, novos empréstimos, renovações, eventos do dia e estornos) e
 * devolve uma lista única de ações daquela data.
 *
 * Nunca consulta banco, nunca usa estado atual do empréstimo e nunca faz busca
 * global em `clients`. Em dia fechado, a tela alimenta esta função apenas com
 * os dados do snapshot.
 */

export type RouteSearchStatus = "pending" | "done" | "reversed";

export type RouteSearchAction =
  | "pendente"
  | "pagamento"
  | "nao_pagou"
  | "renovacao"
  | "emprestimo_novo"
  | "evento";

export type RouteSearchResult = {
  /** Chave estável para render. */
  key: string;
  /** Identificador original do registro (evento, movimento, marca, parcela...). */
  sourceId: string;
  clientId: string | null;
  clientName: string;
  loanId: string | null;
  installmentId: string | null;
  action: RouteSearchAction;
  /** Tipo bruto (event_type quando existir). */
  actionType: string;
  label: string;
  description: string;
  amount: number | null;
  /** Horário/data do registro (ISO) ou data do dia quando não houver. */
  at: string | null;
  status: RouteSearchStatus;
};

export type RouteSearchScope = { workerId?: string | null; adminId?: string | null };

export type RouteSearchInput = {
  cashDate: string;
  scope?: RouteSearchScope;
  pendingInstallments?: any[];
  paidGroups?: any[];
  notPaidMarks?: any[];
  newLoans?: any[];
  renewalEvents?: any[];
  events?: any[];
  reversedEvents?: any[];
  clientNames?: Record<string, string>;
  /** Dia fechado: nada é enriquecido com dados vivos. */
  readOnly?: boolean;
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const brl = (v: number): string =>
  `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Minúsculas + sem acentos, para busca tolerante. */
export function normalizeSearchText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function inScope(row: any, scope: RouteSearchScope): boolean {
  if (!row) return false;
  if (scope.workerId && row.worker_id != null && row.worker_id !== scope.workerId) return false;
  if (scope.adminId && row.admin_id != null && row.admin_id !== scope.adminId) return false;
  return true;
}

const EVENT_LABELS: Record<string, string> = {
  pagamento: "Pago",
  nao_pagou: "Não pagou",
  renovacao: "Renovação",
  renegociacao: "Renegociação",
  emprestimo_novo: "Novo empréstimo",
  emprestimo_importado: "Empréstimo importado",
  recebimento_multa: "Multa recebida",
  multa_adicionada: "Multa adicionada",
  entrada_manual: "Entrada manual",
  saida_manual: "Saída manual",
  ajuste_manual: "Ajuste manual",
  despesa: "Despesa",
  estorno_pagamento: "Pagamento estornado",
  estorno_manual: "Estorno manual",
  cancelamento: "Cancelamento",
};

function eventLabel(type: string): string {
  return EVENT_LABELS[type] || type;
}

/** Eventos já representados por outra fonte (evita duplicação). */
const COVERED_EVENT_TYPES = new Set([
  "pagamento",
  "nao_pagou",
  "renovacao",
  "emprestimo_novo",
]);

export function buildDailyRouteSearchIndex(input: RouteSearchInput): RouteSearchResult[] {
  const scope = input.scope ?? {};
  const names = input.clientNames ?? {};
  const out: RouteSearchResult[] = [];

  const nameOf = (clientId: string | null | undefined, fallback?: string | null): string =>
    (fallback && String(fallback).trim()) || (clientId ? names[clientId] : "") || "Cliente";

  // 1) Pendentes
  for (const inst of input.pendingInstallments || []) {
    if (!inst) continue;
    const loan = inst.loans || null;
    const clientId = loan?.client_id ?? loan?.clients?.id ?? null;
    out.push({
      key: `pending-${inst.id}`,
      sourceId: String(inst.id),
      clientId,
      clientName: nameOf(clientId, loan?.clients?.name),
      loanId: inst.loan_id ?? loan?.id ?? null,
      installmentId: inst.id ?? null,
      action: "pendente",
      actionType: "pendente",
      label: "Pendente",
      description: `Parcela ${num(inst.number)}${loan?.installment_count ? `/${num(loan.installment_count)}` : ""} — ${brl(num(inst.amount))}`,
      amount: num(inst.amount),
      at: null,
      status: "pending",
    });
  }

  // 2) Pagamentos (fonte única: paidGroups)
  const seenPaymentEventIds = new Set<string>();
  const seenPaymentMovementIds = new Set<string>();
  for (const g of input.paidGroups || []) {
    if (!g) continue;
    if (g.eventId) seenPaymentEventIds.add(String(g.eventId));
    if (g.movementId) seenPaymentMovementIds.add(String(g.movementId));
    const progress =
      g.progressBeforeFormatted && g.progressAfterFormatted
        ? ` — parcelas ${g.progressBeforeFormatted} → ${g.progressAfterFormatted}`
        : "";
    out.push({
      key: `paid-${g.movementId || g.eventId || g.loanId}`,
      sourceId: String(g.movementId || g.eventId || ""),
      clientId: g.clientId || null,
      clientName: nameOf(g.clientId, g.clientName),
      loanId: g.loanId || null,
      installmentId: null,
      action: "pagamento",
      actionType: "pagamento",
      label: "Pago",
      description: `${brl(num(g.totalPaid))}${progress}`,
      amount: num(g.totalPaid),
      at: g.createdAt || null,
      status: "done",
    });
  }

  // 3) Não pagou
  const seenNotPaidInstallments = new Set<string>();
  for (const m of input.notPaidMarks || []) {
    if (!m) continue;
    if (!inScope(m, scope)) continue;
    if (m.installment_id) seenNotPaidInstallments.add(String(m.installment_id));
    const clientId = m.client_id ?? null;
    out.push({
      key: `notpaid-${m.id}`,
      sourceId: String(m.id),
      clientId,
      clientName: nameOf(clientId, m.installment?.loans?.clients?.name),
      loanId: m.loan_id ?? null,
      installmentId: m.installment_id ?? null,
      action: "nao_pagou",
      actionType: "nao_pagou",
      label: "Não pagou",
      description: m.observation ? String(m.observation) : "Sem observação",
      amount: m.installment?.amount != null ? num(m.installment.amount) : null,
      at: m.created_at || null,
      status: "done",
    });
  }

  // 4) Novos empréstimos e renovações
  const renewalByLoan = new Map<string, any>();
  for (const ev of input.renewalEvents || []) {
    if (ev?.loan_id) renewalByLoan.set(String(ev.loan_id), ev);
  }
  const seenLoanIds = new Set<string>();
  for (const loan of input.newLoans || []) {
    if (!loan) continue;
    if (!inScope(loan, scope)) continue;
    seenLoanIds.add(String(loan.id));
    const clientId = loan.clients?.id ?? loan.client_id ?? null;
    const isRenewal = !!loan.renewed_from_loan_id;
    const renewEvt = renewalByLoan.get(String(loan.id));
    const liberado = renewEvt ? num(renewEvt.amount_out) : num(loan.amount);
    out.push({
      key: `loan-${loan.id}`,
      sourceId: String(loan.id),
      clientId,
      clientName: nameOf(clientId, loan.clients?.name),
      loanId: loan.id ?? null,
      installmentId: null,
      action: isRenewal ? "renovacao" : "emprestimo_novo",
      actionType: isRenewal ? "renovacao" : "emprestimo_novo",
      label: isRenewal ? "Renovação" : "Novo empréstimo",
      description: isRenewal
        ? `Liberado ${brl(liberado)} — novo contrato ${brl(num(loan.amount))} em ${num(loan.installment_count)}x`
        : `${brl(num(loan.amount))} em ${num(loan.installment_count)}x`,
      amount: isRenewal ? liberado : num(loan.amount),
      at: renewEvt?.created_at || loan.created_at || null,
      status: "done",
    });
  }

  // 5) Demais eventos válidos do dia (multas, manuais, despesas, importados...)
  for (const ev of input.events || []) {
    if (!ev) continue;
    if (!inScope(ev, scope)) continue;
    if (input.cashDate && ev.cash_date && ev.cash_date !== input.cashDate) continue;
    if (ev.reversed_at) continue;
    const type = String(ev.event_type || "");
    if (COVERED_EVENT_TYPES.has(type)) {
      // já representado por paidGroups / notPaidMarks / newLoans
      if (type === "pagamento" && (seenPaymentEventIds.has(String(ev.id)) || (ev.cash_movement_id && seenPaymentMovementIds.has(String(ev.cash_movement_id))))) continue;
      if (type === "nao_pagou" && ev.installment_id && seenNotPaidInstallments.has(String(ev.installment_id))) continue;
      if ((type === "renovacao" || type === "emprestimo_novo") && ev.loan_id && seenLoanIds.has(String(ev.loan_id))) continue;
    }
    const value = num(ev.amount_in) || num(ev.amount_out) || null;
    out.push({
      key: `event-${ev.id}`,
      sourceId: String(ev.id),
      clientId: ev.client_id ?? null,
      clientName: nameOf(ev.client_id, (ev.metadata as any)?.client_name),
      loanId: ev.loan_id ?? null,
      installmentId: ev.installment_id ?? null,
      action: COVERED_EVENT_TYPES.has(type) ? (type as RouteSearchAction) : "evento",
      actionType: type,
      label: eventLabel(type),
      description: ev.observation ? String(ev.observation) : eventLabel(type),
      amount: value,
      at: ev.created_at || null,
      status: "done",
    });
  }

  // 6) Estornados
  for (const ev of input.reversedEvents || []) {
    if (!ev) continue;
    if (!inScope(ev, scope)) continue;
    if (input.cashDate && ev.cash_date && ev.cash_date !== input.cashDate) continue;
    const type = String(ev.event_type || "");
    const value = num(ev.amount_in) || num(ev.amount_out) || null;
    out.push({
      key: `reversed-${ev.id}`,
      sourceId: String(ev.id),
      clientId: ev.client_id ?? null,
      clientName: nameOf(ev.client_id, (ev.metadata as any)?.client_name),
      loanId: ev.loan_id ?? null,
      installmentId: ev.installment_id ?? null,
      action: "evento",
      actionType: type,
      label: type === "pagamento" ? "Pagamento estornado" : `${eventLabel(type)} (estornado)`,
      description: ev.observation ? String(ev.observation) : "Registro estornado",
      amount: value,
      at: ev.created_at || null,
      status: "reversed",
    });
  }

  // Ordem de registro. Pendentes (sem horário) ficam no início.
  return out.sort((a, b) => {
    const ta = a.at ? new Date(a.at).getTime() : 0;
    const tb = b.at ? new Date(b.at).getTime() : 0;
    return ta - tb;
  });
}

/** Filtra o índice pelo nome do cliente, ignorando maiúsculas e acentos. */
export function filterRouteSearchIndex(
  index: RouteSearchResult[],
  query: string,
): RouteSearchResult[] {
  const q = normalizeSearchText(query);
  if (!q) return [];
  return index.filter((r) => normalizeSearchText(r.clientName).includes(q));
}

export type RouteSearchGroup = {
  clientId: string | null;
  clientName: string;
  results: RouteSearchResult[];
};

/** Agrupa por cliente mantendo a ordem de registro dentro de cada grupo. */
export function groupRouteSearchResults(results: RouteSearchResult[]): RouteSearchGroup[] {
  const groups = new Map<string, RouteSearchGroup>();
  for (const r of results) {
    const key = r.clientId || `name:${normalizeSearchText(r.clientName)}`;
    let g = groups.get(key);
    if (!g) {
      g = { clientId: r.clientId, clientName: r.clientName, results: [] };
      groups.set(key, g);
    }
    g.results.push(r);
  }
  return [...groups.values()].sort((a, b) => a.clientName.localeCompare(b.clientName, "pt-BR"));
}
