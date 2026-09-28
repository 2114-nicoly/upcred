import { format } from "date-fns";
import { formatCurrency, getPaymentTypeLabel } from "@/lib/loan-utils";
import { getEventTypeLabel } from "@/lib/daily-events";

/**
 * NORMALIZADOR ÚNICO de registros (daily_events) para todas as telas.
 *
 * Função PURA: usa somente o evento e o metadata congelado no momento da ação
 * (mais, opcionalmente, linhas também congeladas como loan_renegotiations e
 * audit_logs). Nunca consulta o estado atual do empréstimo, nunca extrai
 * valores financeiros de `observation` e nunca inventa números.
 */

export type DetailLine = { label: string; value: string };

export type NormalizedRecord = {
  id: string;
  kind: string;
  /** Categoria exibida (igual em todas as telas). */
  category: string;
  /** Situação: Ativo / Estornado / Cancelado / Informativo. */
  status: string;
  createdAt: string | null;
  time: string;
  cashDate: string | null;
  clientName: string;
  workerName: string;
  title: string;
  summary: string;
  amountIn: number;
  amountOut: number;
  reversed: boolean;
  /** Registro antigo sem todas as informações congeladas. */
  incomplete: boolean;
  /** Detalhe interno de outra ação (ex.: renovacao_absorvida) — não listar sozinho. */
  internal: boolean;
  /** Ação informativa — não entra em totais financeiros. */
  informative: boolean;
  /** Pagamento que zerou o saldo. */
  isSettlement: boolean;
  details: DetailLine[];
};

export const INCOMPLETE_RECORD_LABEL = "Registro antigo com informações incompletas";

export type NormalizeInput = {
  id: string;
  cash_date?: string | null;
  event_type: string;
  client_id?: string | null;
  loan_id?: string | null;
  installment_id?: string | null;
  cash_movement_id?: string | null;
  amount_in?: number | string | null;
  amount_out?: number | string | null;
  observation?: string | null;
  origin?: string | null;
  created_at?: string | null;
  worker_id?: string | null;
  admin_id?: string | null;
  reversed_at?: string | null;
  metadata?: Record<string, any> | null;
};

export type NormalizeContext = {
  clientName?: (id: string | null | undefined) => string | null | undefined;
  workerName?: (id: string | null | undefined) => string | null | undefined;
  adminName?: (id: string | null | undefined) => string | null | undefined;
  /** Linha congelada de loan_renegotiations ligada ao evento (renovação/renegociação legadas). */
  renegotiation?: Record<string, any> | null;
  /** Auditoria congelada do pagamento (registros antigos sem metadata). */
  audit?: Record<string, any> | null;
};

/** Eventos que são apenas informativos (não movem dinheiro). */
export const INFORMATIVE_KINDS = new Set([
  "nao_pagou", "multa_adicionada", "emprestimo_importado", "cliente_criado", "cliente_editado",
  "parcela_editada", "transferencia_cliente", "anexo_adicionado", "anexo_removido",
  "renovacao_absorvida", "caixa_aberto", "caixa_fechado", "caixa_reaberto",
]);

/** Eventos que são detalhes internos de outra ação principal. */
export const INTERNAL_KINDS = new Set(["renovacao_absorvida"]);

// ---------- helpers ----------

/** Número financeiro seguro: aceita somente valores finitos e não negativos. */
export function safeAmount(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v !== "number" && typeof v !== "string") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}
/** Número qualquer (pode ser negativo, ex.: diferença). */
function anyNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v !== "number" && typeof v !== "string") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const money = (v: number | null) => (v == null ? null : formatCurrency(v));
const text = (v: unknown) => (v == null || v === "" ? null : String(v));
const dt = (v: unknown) => {
  if (!v) return null;
  try { return format(new Date(String(v).slice(0, 10) + "T12:00:00"), "dd/MM/yyyy"); } catch { return null; }
};
const dtHour = (v: unknown) => {
  if (!v) return null;
  try { return format(new Date(String(v)), "dd/MM/yyyy HH:mm"); } catch { return null; }
};
const shortId = (v: unknown) => (v ? String(v).slice(0, 8) : null);
const fmtUnits = (n: number | null) => (n == null ? null : String(Math.round(n * 100) / 100).replace(".", ","));

function push(lines: DetailLine[], label: string, value: string | number | null | undefined) {
  if (value == null || value === "" || value === "—") return;
  lines.push({ label, value: String(value) });
}

const LOAN_STATUS_LABEL: Record<string, string> = {
  open: "Em dia", overdue: "Atrasado", paid: "Quitado", renegotiated: "Renegociado",
  renewed: "Renovado", cancelled: "Cancelado",
};

const CATEGORY: Record<string, string> = {
  pagamento: "Pagamento",
  recebimento_multa: "Multa recebida",
  multa_adicionada: "Multa adicionada",
  nao_pagou: "Não pagou",
  emprestimo_novo: "Empréstimo novo",
  emprestimo_importado: "Empréstimo importado/em andamento",
  renovacao: "Renovação",
  renovacao_absorvida: "Renovação (saldo absorvido)",
  renegociacao: "Renegociação",
  entrada_manual: "Entrada manual",
  saida_manual: "Saída manual",
  ajuste_manual: "Ajuste manual",
  ajuste_fechamento: "Ajuste de fechamento",
  despesa: "Despesa",
  saida: "Saída",
  estorno_pagamento: "Estorno",
  estorno_manual: "Estorno",
  cancelamento: "Cancelamento",
  cliente_criado: "Cliente criado",
  cliente_editado: "Cliente editado",
  parcela_editada: "Parcela editada",
  transferencia_cliente: "Transferência de cliente",
  anexo_adicionado: "Anexo adicionado",
  anexo_removido: "Anexo removido",
  caixa_aberto: "Abertura de caixa",
  caixa_fechado: "Fechamento de caixa",
  caixa_reaberto: "Reabertura de caixa",
};

export function categoryLabel(kind: string): string {
  return CATEGORY[kind] || getEventTypeLabel(kind);
}

function changesLines(lines: DetailLine[], before: any, after: any) {
  if (!before && !after) return;
  const keys = Array.from(new Set([...Object.keys(before || {}), ...Object.keys(after || {})]));
  keys.forEach((k) => {
    const a = before?.[k];
    const b = after?.[k];
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    const f = (v: any) => (v == null || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
    push(lines, `Alterado: ${k}`, `${f(a)} → ${f(b)}`);
  });
}

// ---------- normalizador ----------

export function normalizeEvent(e: NormalizeInput, ctx: NormalizeContext = {}): NormalizedRecord {
  const m = (e.metadata || {}) as Record<string, any>;
  const kind = e.event_type;
  const details: DetailLine[] = [];
  let incomplete = false;

  const clientName = text(m.client_name) || text(ctx.clientName?.(e.client_id)) || (e.client_id ? "Cliente" : "—");
  const workerName = text(m.worker_name) || text(ctx.workerName?.(e.worker_id)) || "—";
  const adminName = text(m.admin_name) || text(ctx.adminName?.(e.admin_id));
  const amountIn = safeAmount(e.amount_in) ?? 0;
  const amountOut = safeAmount(e.amount_out) ?? 0;
  const reversed = !!e.reversed_at;
  const informative = INFORMATIVE_KINDS.has(kind);
  const internal = INTERNAL_KINDS.has(kind);
  let category = categoryLabel(kind);
  let title = category;
  let summary = "";
  let isSettlement = false;

  const specific: DetailLine[] = [];
  const P = (l: string, v: string | number | null | undefined) => push(specific, l, v);

  switch (kind) {
    case "pagamento": {
      const r = ctx.audit;
      const paid = safeAmount(m.payment_amount) ?? amountIn;
      const before = safeAmount(m.remaining_balance_before) ?? safeAmount(r?.old_value?.remaining_balance);
      const after = safeAmount(m.remaining_balance_after) ?? safeAmount(r?.new_value?.remaining_balance);
      const instAmt = safeAmount(m.installment_amount);
      const total = safeAmount(m.total_installments);
      const unitsB = anyNum(m.progress_units_before);
      const unitsA = anyNum(m.progress_units_after);
      const progB = text(m.installment_progress_before) || (unitsB != null && total ? `${fmtUnits(unitsB)}/${total}` : null);
      const progA = text(m.installment_progress_after) || (unitsA != null && total ? `${fmtUnits(unitsA)}/${total}` : null);
      const totalAmt = safeAmount(m.loan_total_amount) ?? (instAmt != null && total != null ? instAmt * total : null);
      const paidTotB = safeAmount(m.total_paid_before) ?? (totalAmt != null && before != null ? Math.max(0, totalAmt - before) : null);
      const paidTotA = safeAmount(m.total_paid_after) ?? (totalAmt != null && after != null ? Math.max(0, totalAmt - after) : null);
      const paidInstA = safeAmount(m.paid_installments_after) ?? (unitsA != null ? Math.floor(unitsA + 1e-6) : null);
      const restantes = total != null && unitsA != null ? Math.max(0, Math.round((total - unitsA) * 100) / 100) : null;
      isSettlement = after != null && after <= 0.01;
      const isPartial = !isSettlement && instAmt != null && paid + 0.01 < instAmt;
      if (m.renewal || e.origin === "renovacao") {
        category = "Pagamento";
        title = isSettlement ? "Quitação (renovação)" : "Pagamento da renovação";
      } else {
        category = isSettlement ? "Quitação" : "Pagamento";
        title = isSettlement ? "Quitação" : isPartial ? "Pagamento parcial" : "Pagamento";
      }
      if (before == null || after == null || progB == null || progA == null) incomplete = true;
      P("Valor pago", money(paid));
      P("Tipo", title);
      P("Saldo antes", money(before));
      P("Saldo depois", money(after));
      P("Progresso antes", progB);
      P("Progresso depois", progA);
      P("Total pago antes", money(paidTotB));
      P("Total pago depois", money(paidTotA));
      P("Valor da parcela", money(instAmt));
      P("Total de parcelas", total);
      P("Parcelas pagas", paidInstA);
      P("Parcelas restantes", restantes != null ? fmtUnits(restantes) : null);
      P("Parcelas avançadas", anyNum(m.installments_advanced) != null ? fmtUnits(anyNum(m.installments_advanced)) : null);
      (Array.isArray(m.affected_installments) ? m.affected_installments : []).forEach((a: any, i: number) => {
        P(`Parcela atingida ${i + 1}`,
          `Nº ${a?.number ?? "?"} · aplicado ${money(safeAmount(a?.amount_applied)) ?? "—"}${a?.paid_amount_before != null ? ` · ${money(safeAmount(a.paid_amount_before))} → ${money(safeAmount(a.paid_amount_after))}` : ""}`);
      });
      P("Próximo vencimento", isSettlement ? "Sem próximas parcelas" : dt(m.next_due_date));
      P("Multa paga separadamente", money(safeAmount(m.penalty_paid_amount)));
      P("Forma de pagamento", text(m.payment_method));
      if (m.renewal || e.origin === "renovacao") P("Renovação", `Contrato ${shortId(m.old_loan_id)} → ${shortId(m.new_loan_id)}`);
      summary = [
        money(paid),
        progB && progA ? `${progB} → ${progA}` : null,
        before != null && after != null ? `saldo ${money(before)} → ${money(after)}` : null,
      ].filter(Boolean).join(" · ");
      break;
    }
    case "recebimento_multa": {
      const received = safeAmount(m.penalty_paid_amount) ?? safeAmount(m.payment_amount) ?? amountIn;
      const before = safeAmount(m.penalty_balance_before);
      const after = safeAmount(m.penalty_balance_after);
      if (before == null || after == null) incomplete = true;
      P("Valor recebido", money(received));
      P("Multa antes", money(before));
      P("Multa restante", money(after));
      P("Situação da multa", after == null ? null : after <= 0.01 ? "Quitada" : "Em aberto");
      summary = [money(received), after != null ? `restante ${money(after)}` : null].filter(Boolean).join(" · ");
      break;
    }
    case "multa_adicionada": {
      const amt = safeAmount(m.penalty_amount);
      if (amt == null) incomplete = true;
      P("Valor da multa", money(amt));
      P("Tipo", text(m.penalty_type) === "percentage" ? "Percentual" : text(m.penalty_type) === "fixed" ? "Valor fixo" : text(m.penalty_type));
      P("Percentual", m.penalty_percent != null ? `${m.penalty_percent}%` : null);
      P("Vencimento", dt(m.due_date));
      P("Parcela", m.installment_number != null ? `Nº ${m.installment_number}` : null);
      P("Motivo", text(m.reason));
      P("Situação", text(m.status) || (amt != null ? "Em aberto" : null));
      summary = [money(amt), text(m.reason)].filter(Boolean).join(" · ");
      break;
    }
    case "nao_pagou": {
      const expected = safeAmount(m.expected_amount);
      if (expected == null || m.due_date == null) incomplete = true;
      const days = anyNum(m.overdue_days);
      P("Parcela", m.installment_number != null ? `Nº ${m.installment_number}${m.total_installments ? ` de ${m.total_installments}` : ""}` : null);
      P("Valor esperado", money(expected));
      P("Vencimento", dt(m.due_date));
      P("Atraso na data", days != null ? `${days} dia${days === 1 ? "" : "s"}` : null);
      P("Motivo", text(m.reason));
      P("Saldo na data", money(safeAmount(m.remaining_balance)));
      P("Progresso pago", text(m.installment_progress));
      P("Parcelas restantes", anyNum(m.remaining_installments) != null ? fmtUnits(anyNum(m.remaining_installments)) : null);
      summary = [
        m.installment_number != null ? `Parcela ${m.installment_number}` : null,
        money(expected),
        m.due_date ? `venc. ${dt(m.due_date)}` : null,
        text(m.reason),
      ].filter(Boolean).join(" · ");
      break;
    }
    case "emprestimo_novo":
    case "emprestimo_importado": {
      const imported = kind === "emprestimo_importado";
      const principal = safeAmount(m.principal_amount) ?? safeAmount(m.original_amount);
      const total = safeAmount(m.total_amount);
      const count = safeAmount(m.installments) ?? safeAmount(m.installment_count);
      const instAmt = safeAmount(m.installment_amount);
      const released = imported ? 0 : (safeAmount(m.released_amount) ?? amountOut);
      if (principal == null || total == null || count == null) incomplete = true;
      title = imported ? "Empréstimo importado/em andamento" : "Empréstimo novo";
      P("Principal", money(principal));
      P("Total a receber", money(total));
      P("Juros", principal != null && total != null ? money(Math.max(0, total - principal)) : null);
      P("Taxa", m.interest_type === "percentage" && m.interest_value != null ? `${m.interest_value}%` : m.interest_type === "fixed" ? money(safeAmount(m.interest_value)) : null);
      P("Parcelas", count != null ? `${count}x${instAmt != null ? ` de ${money(instAmt)}` : ""}` : null);
      P("Frequência", m.payment_type ? getPaymentTypeLabel(m.payment_type, m.first_due_date) : null);
      P("Primeiro vencimento", dt(m.first_due_date ?? m.next_due_date));
      P("Último vencimento", dt(m.last_due_date));
      P("Valor liberado", money(released));
      if (imported) {
        P("Valor já pago", money(safeAmount(m.amount_already_paid)));
        P("Saldo inicial importado", money(safeAmount(m.remaining_balance)));
        P("Data original", dt(m.original_loan_date));
        P("Liberação de dinheiro", "Não houve nova liberação de dinheiro");
      }
      P("Situação", imported ? "Em andamento (importado)" : "Ativo");
      summary = [money(principal), count != null ? `${count}x${instAmt != null ? ` de ${money(instAmt)}` : ""}` : null,
        imported ? "sem liberação de caixa" : released ? `liberado ${money(released)}` : null].filter(Boolean).join(" · ");
      break;
    }
    case "renovacao":
    case "renegociacao": {
      const isReneg = kind === "renegociacao";
      const r = ctx.renegotiation || null;
      const oldBal = safeAmount(m.old_remaining_before) ?? safeAmount(r?.original_remaining_balance);
      const paid = safeAmount(m.renew_paid_amount) ?? safeAmount(r?.client_paid_amount);
      const absorbed = safeAmount(m.renew_absorbed_amount) ?? safeAmount(r?.absorbed_from_new);
      const released = safeAmount(m.renew_additional_cash) ?? safeAmount(m.released_amount) ?? safeAmount(r?.released_to_client) ?? amountOut;
      const principal = safeAmount(m.principal_amount) ?? safeAmount(r?.new_amount);
      const total = safeAmount(m.total_amount) ?? safeAmount(r?.new_total_amount);
      const count = safeAmount(m.installments) ?? safeAmount(r?.new_installment_count);
      const instAmt = safeAmount(m.installment_amount) ?? (total != null && count ? total / count : null);
      const pType = text(m.payment_type) || text(r?.new_payment_type);
      if (oldBal == null || principal == null || total == null) incomplete = true;
      title = isReneg ? "Renegociação" : "Renovação";
      P("Empréstimo anterior", shortId(m.old_loan_id ?? r?.original_loan_id));
      P("Empréstimo novo", shortId(m.new_loan_id ?? r?.new_loan_id ?? e.loan_id));
      P("Saldo anterior", money(oldBal));
      if (isReneg) {
        P("Condições anteriores", r ? [money(safeAmount(r.original_total_amount)), r.original_installment_count ? `${r.original_installment_count}x` : null, r.original_payment_type ? getPaymentTypeLabel(r.original_payment_type) : null].filter(Boolean).join(" · ") : null);
      }
      P("Valor pago", money(paid));
      P("Valor absorvido (não é entrada de dinheiro)", money(absorbed));
      P("Valor adicional liberado", money(released));
      P("Principal do novo", money(principal));
      P("Total do novo", money(total));
      P("Juros", principal != null && total != null ? money(Math.max(0, total - principal)) : null);
      P("Parcelas", count != null ? `${count}x${instAmt != null ? ` de ${money(instAmt)}` : ""}` : null);
      P("Frequência", pType ? getPaymentTypeLabel(pType, m.first_due_date) : null);
      P("Primeiro vencimento", dt(m.first_due_date));
      P("Último vencimento", dt(m.last_due_date));
      P("Saldo novo", money(total));
      P("Motivo", text(r?.reason) || text(m.reason));
      summary = [
        oldBal != null ? `saldo anterior ${money(oldBal)}` : null,
        paid != null ? `pago ${money(paid)}` : null,
        principal != null ? `novo ${money(principal)}` : null,
        released != null ? `liberado ${money(released)}` : null,
      ].filter(Boolean).join(" · ");
      break;
    }
    case "renovacao_absorvida": {
      const abs = safeAmount(m.absorbed_amount);
      P("Saldo absorvido (não é entrada de dinheiro)", money(abs));
      P("Empréstimo anterior", shortId(m.old_loan_id));
      P("Empréstimo novo", shortId(m.new_loan_id));
      summary = abs != null ? `Absorvido ${money(abs)} — detalhe da renovação` : "Detalhe da renovação";
      break;
    }
    case "entrada_manual":
    case "saida_manual":
    case "ajuste_manual":
    case "ajuste_fechamento":
    case "despesa":
    case "saida": {
      const isIn = amountIn > 0;
      P("Direção", isIn ? "Entrada" : amountOut > 0 ? "Saída" : null);
      P("Valor", money(isIn ? amountIn : amountOut));
      P("Categoria", text(m.category) || (kind === "despesa" ? "Outros" : null));
      P("Descrição/motivo", text(m.description) || text(m.reason));
      P("Saldo antes", money(anyNum(m.available_cash_before)));
      P("Saldo depois", money(anyNum(m.available_cash_after)));
      summary = [isIn ? `+ ${money(amountIn)}` : amountOut > 0 ? `- ${money(amountOut)}` : null,
        text(m.category), text(m.description) || text(e.observation)].filter(Boolean).join(" · ");
      break;
    }
    case "estorno_pagamento":
    case "estorno_manual":
    case "cancelamento": {
      const origType = text(m.original_type) || text(m.original_event_type);
      const origAmount = safeAmount(m.original_amount);
      const reversedAmt = safeAmount(m.reversed_amount) ?? (amountIn || amountOut || null);
      if (!m.reverses_event_id && !m.reverses_movement_id) incomplete = true;
      P("Ação original", origType ? categoryLabel(origType) : null);
      P("Valor original", money(origAmount));
      P("Valor estornado", money(reversedAmt));
      P("Data da ação original", dt(m.original_cash_date));
      P("Motivo", text(m.reason));
      P("Responsável", text(m.reversed_by_name) || text(m.actor_name));
      P("Evento original", shortId(m.reverses_event_id));
      P("Movimento original", shortId(m.reverses_movement_id));
      P("Resultado", "Registro original marcado como estornado (não conta como nova entrada)");
      summary = [origType ? categoryLabel(origType) : null, money(reversedAmt), text(m.reason)].filter(Boolean).join(" · ");
      break;
    }
    case "cliente_criado":
    case "cliente_editado":
    case "parcela_editada":
    case "anexo_adicionado":
    case "anexo_removido":
    case "transferencia_cliente": {
      changesLines(specific, m.before ?? m.old_value, m.after ?? m.new_value);
      P("Origem", text(m.from_worker_name) || shortId(m.from_worker_id));
      P("Destino", text(m.to_worker_name) || shortId(m.to_worker_id));
      P("Arquivo", text(m.file_name));
      P("Parcela", m.installment_number != null ? `Nº ${m.installment_number}` : null);
      P("Responsável", text(m.actor_name));
      P("Motivo", text(m.reason));
      summary = text(m.file_name) || text(e.observation) || title;
      break;
    }
    case "caixa_aberto":
    case "caixa_fechado":
    case "caixa_reaberto": {
      appendCashSnapshotLines(specific, m);
      summary = text(e.observation) || title;
      break;
    }
    default: {
      if (amountIn > 0) P("Entrada", money(amountIn));
      if (amountOut > 0) P("Saída", money(amountOut));
      summary = [amountIn > 0 ? `+ ${money(amountIn)}` : null, amountOut > 0 ? `- ${money(amountOut)}` : null, text(e.observation)]
        .filter(Boolean).join(" · ");
    }
  }

  const status = reversed ? "Estornado" : kind === "cancelamento" ? "Cancelado" : informative ? "Informativo" : "Ativo";

  // ---- Bloco comum (mesma ordem em todas as telas)
  push(details, "Categoria", category);
  push(details, "Situação", status);
  if (e.client_id || m.client_name) push(details, "Cliente", clientName);
  push(details, "Empresa", adminName);
  push(details, "Trabalhador", workerName);
  push(details, "Data financeira", dt(e.cash_date));
  push(details, "Horário real", dtHour(e.created_at));
  if (!informative) push(details, "Valor", money(amountIn || amountOut || 0));
  details.push(...specific);
  push(details, "Observação", text(e.observation));
  push(details, "Estornado em", dtHour(e.reversed_at));
  push(details, "ID do evento", shortId(e.id));
  push(details, "ID do movimento", shortId(e.cash_movement_id ?? m.cash_movement_id));
  push(details, "ID do empréstimo", shortId(e.loan_id));
  push(details, "ID da parcela", shortId(e.installment_id));
  if (incomplete) push(details, "Aviso", INCOMPLETE_RECORD_LABEL);

  if (!summary) summary = text(e.observation) || title;

  return {
    id: e.id,
    kind,
    category,
    status,
    createdAt: e.created_at ?? null,
    time: e.created_at ? format(new Date(e.created_at), "HH:mm") : "",
    cashDate: e.cash_date ?? null,
    clientName,
    workerName,
    title,
    summary,
    amountIn,
    amountOut,
    reversed,
    incomplete,
    internal,
    informative,
    isSettlement,
    details,
  };
}

/** Linhas de abertura/fechamento/reabertura de caixa a partir de daily_cash + snapshot congelado. */
export function appendCashSnapshotLines(lines: DetailLine[], s: Record<string, any>) {
  const snap = (s.closing_snapshot || s.snapshot || s) as Record<string, any>;
  push(lines, "Abertura", money(anyNum(s.opening_balance ?? snap.opening_balance)));
  push(lines, "Entradas", money(anyNum(snap.total_in ?? s.total_in)));
  push(lines, "Saídas", money(anyNum(snap.total_out ?? s.total_out)));
  push(lines, "Esperado", money(anyNum(s.expected_closing_balance ?? snap.expected_closing_balance)));
  push(lines, "Disponível", money(anyNum(snap.available_cash ?? snap.current_available_cash)));
  push(lines, "Contado", money(anyNum(s.counted_amount ?? s.closing_balance ?? snap.counted_amount)));
  push(lines, "Diferença", money(anyNum(s.difference ?? snap.difference)));
  push(lines, "Observação do caixa", text(s.closing_observation ?? s.observation));
  push(lines, "Responsável", text(s.closed_by_name ?? snap.closed_by_name));
  push(lines, "Versão", text(s.snapshot_version ?? snap.snapshot_version ?? snap.version));
}

/** Registro normalizado de um dia de caixa (daily_cash), sem recalcular nada. */
export function normalizeDailyCash(dc: Record<string, any>): DetailLine[] {
  const lines: DetailLine[] = [];
  push(lines, "Data financeira", dt(dc.cash_date));
  push(lines, "Situação", dc.status === "closed" ? "Fechado" : dc.status === "open" ? "Aberto" : text(dc.status));
  push(lines, "Aberto em", dtHour(dc.opened_at ?? dc.created_at));
  push(lines, "Fechado em", dtHour(dc.closed_at));
  push(lines, "Reaberto em", dtHour(dc.reopened_at));
  appendCashSnapshotLines(lines, dc);
  return lines;
}

/** Loan status label (usado por telas que ainda mostram situação atual de um empréstimo). */
export function loanStatusText(status: string | null | undefined): string | null {
  return status ? LOAN_STATUS_LABEL[status] || status : null;
}
