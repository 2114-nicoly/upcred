import { supabase } from "@/integrations/supabase/client";
import { getCurrentUserId, getCurrentWorkerId } from "@/lib/auth-utils";

export type DailyEventType =
  | "pagamento"
  | "nao_pagou"
  | "renovacao"
  | "renegociacao"
  | "emprestimo_novo"
  | "emprestimo_importado"
  | "saida"
  | "entrada_manual"
  | "saida_manual"
  | "ajuste_manual"
  | "despesa"
  | "recebimento_multa"
  | "multa_adicionada"
  | "estorno_pagamento"
  | "estorno_manual"
  | "cancelamento"
  | "cliente_criado"
  | "cliente_editado"
  | "parcela_editada"
  | "transferencia_cliente"
  | "anexo_adicionado"
  | "anexo_removido"
  | "renovacao_absorvida"
  | "ajuste_fechamento";

/** Categorias de despesa operacional. */
export const EXPENSE_CATEGORIES = [
  "Gasolina/Transporte",
  "Alimentação",
  "Taxas",
  "Manutenção",
  "Material",
  "Serviços",
  "Outros",
] as const;
export type ExpenseCategory = typeof EXPENSE_CATEGORIES[number];

/** Event types that move money (have cash_movement + change available_cash). */
export const FINANCIAL_EVENT_TYPES: DailyEventType[] = [
  "pagamento",
  "recebimento_multa",
  "emprestimo_novo",
  "renovacao",
  "saida",
  "entrada_manual",
  "saida_manual",
  "ajuste_manual",
  "despesa",
];

/** Reversal / correction events. */
export const REVERSAL_EVENT_TYPES: DailyEventType[] = [
  "estorno_pagamento",
  "estorno_manual",
  "cancelamento",
];

export function isFinancialEvent(type: string): boolean {
  return (FINANCIAL_EVENT_TYPES as string[]).includes(type);
}

export function isReversalEvent(type: string): boolean {
  return (REVERSAL_EVENT_TYPES as string[]).includes(type);
}

export type DailyEvent = {
  id: string;
  cash_date: string;
  event_type: string;
  client_id: string | null;
  loan_id: string | null;
  installment_id: string | null;
  cash_movement_id?: string | null;
  amount_in: number;
  amount_out: number;
  observation: string | null;
  origin: string | null;
  created_at: string;
  worker_id?: string | null;
  admin_id?: string | null;
  reversed_at?: string | null;
  metadata?: Record<string, any> | null;
};

export async function createDailyEvent(event: {
  cash_date: string;
  event_type: DailyEventType;
  client_id?: string | null;
  loan_id?: string | null;
  installment_id?: string | null;
  amount_in?: number;
  amount_out?: number;
  observation?: string | null;
  origin?: string;
  cash_movement_id?: string | null;
  metadata?: Record<string, any> | null;
}) {
  const userId = await getCurrentUserId();
  const { resolveScope } = await import("@/lib/cash-utils");
  // Financial events require scope; operational/informational events still try to scope.
  const operationalOnly =
    event.event_type === "nao_pagou" ||
    event.event_type === "multa_adicionada" ||
    event.event_type === "emprestimo_importado";
  const isFinancial = !operationalOnly;
  const { worker_id, admin_id } = await resolveScope({
    loan_id: event.loan_id,
    client_id: event.client_id,
    required: isFinancial,
  });
  const { data, error } = await supabase.from("daily_events" as any).insert({
    cash_date: event.cash_date,
    event_type: event.event_type,
    client_id: event.client_id || null,
    loan_id: event.loan_id || null,
    installment_id: event.installment_id || null,
    amount_in: event.amount_in ?? 0,
    amount_out: event.amount_out ?? 0,
    observation: event.observation || null,
    origin: event.origin || "rota",
    cash_movement_id: event.cash_movement_id || null,
    metadata: event.metadata ?? null,
    user_id: userId,
    worker_id,
    admin_id,
  }).select().single();
  if (error) {
    console.error("Error creating daily event:", error);
    throw error;
  }
  return data as unknown as DailyEvent | null;
}


/**
 * Returns daily events for a date, scoped to the current user's worker_id
 * (when worker). Excludes events that have been reversed (reversed_at IS NOT NULL).
 *
 * Pass `includeReversed: true` to get the full audit list (used by an
 * "Estornos do dia" expander).
 */
export async function getDailyEvents(
  cashDate: string,
  opts: { includeReversed?: boolean; workerId?: string | null; adminId?: string | null } = {}
): Promise<DailyEvent[]> {
  const workerId = opts.workerId ?? (await getCurrentWorkerId());
  let q: any = supabase.from("daily_events" as any)
    .select("*")
    .eq("cash_date", cashDate);
  // Escopo: quando os dois existem, aplicar AMBOS (nunca worker OU admin).
  if (workerId) q = q.eq("worker_id", workerId);
  if (opts.adminId) q = q.eq("admin_id", opts.adminId);
  if (!opts.includeReversed) q = q.is("reversed_at", null);

  const { data } = await q.order("created_at", { ascending: false });
  return (data as unknown as DailyEvent[]) || [];
}


/**
 * @deprecated Use `reverseDailyEvent`. Kept for legacy callers — does NOT delete; marks as reversed.
 */
export async function deleteDailyEvent(id: string) {
  await markDailyEventReversed(id);
}

/**
 * Reverse a daily_event by marking it as reversed (preserves history).
 * NEVER deletes the row. Use `undoDailyEvent` for the full reversal flow
 * (creates the counter-entry too); this just flips the flag.
 */
export async function reverseDailyEvent(id: string) {
  await markDailyEventReversed(id);
}

/**
 * Mark a daily_event as reversed (audit trail). NEVER deletes.
 */
export async function markDailyEventReversed(id: string) {
  await supabase
    .from("daily_events" as any)
    .update({ reversed_at: new Date().toISOString() } as any)
    .eq("id", id);
}

/**
 * Undo a daily event.
 *
 * Eventos financeiros (pagamento, multa, entrada/saída/ajuste manual e despesa)
 * são estornados EXCLUSIVAMENTE pela RPC transacional
 * `reverse_cash_movement_tx` — nenhuma gravação de saldo, `reversed_at` ou
 * auditoria acontece no frontend.
 *
 * - nao_pagou: operação não financeira (remove a marcação).
 * - emprestimo_novo/renovacao/renegociacao: BLOQUEADO nesta etapa.
 */
export async function undoDailyEvent(event: DailyEvent, reason?: string) {
  if (event.event_type === "emprestimo_novo") {
    throw new Error(
      "Não é possível desfazer um novo empréstimo automaticamente. Exclua o empréstimo na tela de detalhes do cliente."
    );
  }
  if (event.event_type === "renovacao" || event.event_type === "renegociacao") {
    throw new Error(
      "Não é possível desfazer uma renovação/renegociação automaticamente. Exclua o novo empréstimo manualmente — o anterior ficará encerrado."
    );
  }

  if (event.event_type === "nao_pagou") {
    if (event.installment_id) {
      await supabase.from("not_paid_marks").delete()
        .eq("installment_id", event.installment_id)
        .eq("mark_date", event.cash_date);
    }
    await markDailyEventReversed(event.id);
    return;
  }

  const FINANCIAL_EVENTS = [
    "pagamento",
    "recebimento_multa",
    "entrada_manual",
    "saida_manual",
    "ajuste_manual",
    "despesa",
  ];

  if (FINANCIAL_EVENTS.includes(event.event_type)) {
    if ((event as any).reversed_at) {
      throw new Error("Este lançamento já foi estornado.");
    }
    if (!event.cash_movement_id) {
      throw new Error(
        "Este lançamento não tem movimentação financeira vinculada e não pode ser estornado automaticamente com segurança."
      );
    }
    const { error } = await supabase.rpc("reverse_cash_movement_tx" as any, {
      p_movement_id: event.cash_movement_id,
      p_reason: (reason || "").trim() || "Estorno solicitado pelo operador",
    } as any);
    if (error) throw error;
    return;
  }

  // Fallback: just mark event as reversed
  await markDailyEventReversed(event.id);
}


export async function getDailyEventsByType(
  cashDate: string,
  eventType: string,
  scope: { workerId?: string | null; adminId?: string | null } = {}
): Promise<DailyEvent[]> {
  const workerId = scope.workerId ?? (await getCurrentWorkerId());
  let q: any = supabase.from("daily_events" as any)
    .select("*")
    .eq("cash_date", cashDate)
    .eq("event_type", eventType)
    .is("reversed_at", null);
  if (workerId) q = q.eq("worker_id", workerId);
  else if (scope.adminId) q = q.eq("admin_id", scope.adminId);
  const { data } = await q.order("created_at", { ascending: false });
  return (data as unknown as DailyEvent[]) || [];
}


export function getEventTypeLabel(type: string): string {
  switch (type) {
    case "pagamento": return "Pagamento";
    case "nao_pagou": return "Não Pagou";
    case "renovacao": return "Renovação";
    case "renegociacao": return "Renegociação";
    case "emprestimo_novo": return "Novo Empréstimo";
    case "emprestimo_importado": return "Empréstimo importado";
    case "saida": return "Saída";
    case "entrada_manual": return "Entrada Manual";
    case "saida_manual": return "Saída Manual";
    case "ajuste_manual": return "Ajuste Manual";
    case "despesa": return "Despesa";
    case "recebimento_multa": return "Multa Recebida";
    case "multa_adicionada": return "Multa Adicionada";
    case "estorno_pagamento": return "Estorno de Pagamento";
    case "estorno_manual": return "Estorno Manual";
    case "cancelamento": return "Cancelamento";
    case "cliente_criado": return "Cliente Criado";
    case "cliente_editado": return "Cliente Editado";
    case "parcela_editada": return "Parcela Editada";
    case "transferencia_cliente": return "Transferência de Cliente";
    case "anexo_adicionado": return "Anexo Adicionado";
    case "anexo_removido": return "Anexo Removido";
    case "caixa_aberto": return "Caixa Aberto";
    case "caixa_fechado": return "Caixa Fechado";
    case "renovacao_absorvida": return "Renovação - Saldo Absorvido";
    case "ajuste_fechamento": return "Ajuste de Fechamento";
    default: return type;
  }
}

export function getEventTypeColor(type: string): string {
  switch (type) {
    case "pagamento": return "text-success";
    case "nao_pagou": return "text-destructive";
    case "renovacao": return "text-primary";
    case "renegociacao": return "text-primary";
    case "emprestimo_novo": return "text-primary";
    case "emprestimo_importado": return "text-muted-foreground";
    case "saida": return "text-destructive";
    case "entrada_manual": return "text-success";
    case "saida_manual": return "text-destructive";
    case "ajuste_manual": return "text-primary";
    case "despesa": return "text-destructive";
    case "recebimento_multa": return "text-warning";
    case "multa_adicionada": return "text-warning";
    case "estorno_pagamento": return "text-muted-foreground";
    case "estorno_manual": return "text-muted-foreground";
    case "cancelamento": return "text-destructive";
    case "cliente_criado":
    case "cliente_editado":
    case "parcela_editada":
    case "transferencia_cliente":
    case "anexo_adicionado":
    case "anexo_removido":
      return "text-muted-foreground";
    default: return "text-muted-foreground";
  }
}
