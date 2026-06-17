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
  | "anexo_removido";

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
  opts: { includeReversed?: boolean } = {}
): Promise<DailyEvent[]> {
  const workerId = await getCurrentWorkerId();
  let q: any = supabase.from("daily_events" as any)
    .select("*")
    .eq("cash_date", cashDate);
  if (workerId) q = q.eq("worker_id", workerId);
  if (!opts.includeReversed) q = q.is("reversed_at", null);
  const { data } = await q.order("created_at", { ascending: false });
  return (data as unknown as DailyEvent[]) || [];
}

/**
 * @deprecated Kept for legacy callers — does NOT delete; marks as reversed.
 */
export async function deleteDailyEvent(id: string) {
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
 * Undo a daily event:
 * - pagamento/recebimento_multa: reversePayment (mark as reversed + counter-entry)
 * - nao_pagou: removes not_paid_mark (operational, not financial)
 * - entrada_manual/saida_manual/ajuste_manual: mark original movement+event as
 *   reversed and create counter-entries (estorno_manual)
 * - emprestimo_novo/renovacao: BLOCKED — must be undone manually
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

  const { recalculateCashBalanceFromLedger, createCashMovement, markCashMovementReversed, linkCashMovementToDailyEvent } = await import("@/lib/cash-utils");
  const { reversePayment } = await import("@/lib/payment-utils");

  if (event.event_type === "pagamento" || event.event_type === "recebimento_multa") {
    if (!event.cash_movement_id) {
      throw new Error("Este lançamento antigo não tem ID financeiro vinculado e não pode ser desfeito automaticamente com segurança.");
    }
    await reversePayment({ movementId: event.cash_movement_id, reason });
    return;
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

  if (
    event.event_type === "entrada_manual" ||
    event.event_type === "saida_manual" ||
    event.event_type === "ajuste_manual"
  ) {
    // Locate the original cash_movement (prefer linked id; else match by type+date)
    let movementId = event.cash_movement_id || null;
    let originalAmount = Number(event.amount_in) - Number(event.amount_out);
    if (!movementId) {
      const { data: candidates } = await supabase
        .from("cash_movements")
        .select("id, amount, reversed_at")
        .eq("type", event.event_type)
        .eq("cash_date", event.cash_date)
        .is("reversed_at", null)
        .order("created_at", { ascending: false })
        .limit(1);
      const original = (candidates || [])[0] as any;
      if (original) {
        movementId = original.id;
        originalAmount = Number(original.amount);
      }
    } else {
      const { data: orig } = await supabase
        .from("cash_movements").select("amount").eq("id", movementId).maybeSingle();
      if (orig) originalAmount = Number((orig as any).amount);
    }

    if (movementId) await markCashMovementReversed(movementId);
    await markDailyEventReversed(event.id);

    // Counter movement and event (negative amount, opposite in/out)
    const reasonSuffix = reason ? ` — Motivo: ${reason}` : "";
    const reversalMovement = await createCashMovement({
      type: "estorno_manual" as any,
      amount: -originalAmount,
      observation: `Estorno: ${getEventTypeLabel(event.event_type)}${reasonSuffix}`,
      cash_date: event.cash_date,
    }) as any;
    const reversalEvent = await createDailyEvent({
      cash_date: event.cash_date,
      event_type: "estorno_manual",
      amount_in: Number(event.amount_out) || 0,
      amount_out: Number(event.amount_in) || 0,
      observation: `Estorno: ${getEventTypeLabel(event.event_type)}${reasonSuffix}`,
      origin: "estorno",
      cash_movement_id: reversalMovement?.id || null,
    } as any) as any;
    if (reversalMovement?.id && reversalEvent?.id) {
      await linkCashMovementToDailyEvent(reversalMovement.id, reversalEvent.id);
    }

    await recalculateCashBalanceFromLedger();
    return;
  }

  // Fallback: just mark event as reversed
  await markDailyEventReversed(event.id);
}

export async function getDailyEventsByType(cashDate: string, eventType: string): Promise<DailyEvent[]> {
  const workerId = await getCurrentWorkerId();
  let q: any = supabase.from("daily_events" as any)
    .select("*")
    .eq("cash_date", cashDate)
    .eq("event_type", eventType)
    .is("reversed_at", null);
  if (workerId) q = q.eq("worker_id", workerId);
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
