import { supabase } from "@/integrations/supabase/client";
import { getCurrentUserId, getCurrentWorkerId } from "@/lib/auth-utils";
import { sumLedgerMovements } from "@/lib/reversal";


/**
 * Resolve worker_id/admin_id for a financial movement or daily event.
 * Priority: loan_id -> client_id -> current user's scope.
 * Throws if admin_id cannot be determined (financial actions MUST be scoped).
 */
export async function resolveScope(input: {
  loan_id?: string | null;
  client_id?: string | null;
  required?: boolean;
}): Promise<{ worker_id: string | null; admin_id: string | null }> {
  let worker_id: string | null = null;
  let admin_id: string | null = null;

  if (input.loan_id) {
    const { data } = await supabase
      .from("loans")
      .select("worker_id, admin_id")
      .eq("id", input.loan_id)
      .maybeSingle();
    if (data) { worker_id = (data as any).worker_id ?? null; admin_id = (data as any).admin_id ?? null; }
  }
  if (!admin_id && input.client_id) {
    const { data } = await supabase
      .from("clients")
      .select("worker_id, admin_id")
      .eq("id", input.client_id)
      .maybeSingle();
    if (data) { worker_id = worker_id ?? (data as any).worker_id ?? null; admin_id = (data as any).admin_id ?? null; }
  }
  if (!admin_id) {
    // Fallback to current authenticated user
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        const uid = session.user.id;
        const { data: w } = await supabase
          .from("workers").select("id, parent_admin_id").eq("auth_user_id", uid).maybeSingle();
        if (w) {
          worker_id = worker_id ?? (w as any).id ?? null;
          admin_id = (w as any).parent_admin_id ?? null;
        }
        if (!admin_id) {
          const { data: a } = await supabase
            .from("admins" as any).select("id").eq("auth_user_id", uid).maybeSingle();
          if (a) admin_id = (a as any).id ?? null;
        }
      }
    } catch { /* ignore */ }
  }
  if (!worker_id) {
    worker_id = await getCurrentWorkerId();
  }
  if (input.required && !admin_id) {
    throw new Error("Não foi possível determinar o administrador responsável por esta operação. Faça login novamente ou contate o admin.");
  }
  return { worker_id, admin_id };
}

/**
 * Escopo explícito passado pelas telas (modo "visualizar como trabalhador").
 * Quando `workerId` é informado, ele tem PRIORIDADE sobre o usuário autenticado.
 */
export type ExplicitScope = { workerId?: string | null; adminId?: string | null } | null | undefined;

export type FinancialScope = { worker_id: string | null; admin_id: string };

export const SCOPE_ADMIN_REQUIRED_MESSAGE =
  "Não foi possível determinar a empresa (admin) desta operação financeira. Faça login novamente ou informe o escopo.";

/**
 * Resolve um escopo financeiro COMPLETO. Nunca devolve admin_id nulo.
 *
 * - escopo explícito de trabalhador: worker_id informado + admin_id informado
 *   (ou o `parent_admin_id` do próprio trabalhador quando omitido);
 * - escopo explícito de administrador: worker_id IS NULL + admin_id informado;
 * - sem escopo explícito: resolve pelo usuário autenticado (trabalhador ->
 *   worker_id + parent_admin_id; admin -> worker_id NULL + admins.id).
 *
 * Lança erro quando o admin_id não puder ser determinado.
 */
export async function resolveFinancialScope(scope?: ExplicitScope): Promise<FinancialScope> {
  if (scope?.workerId) {
    let admin_id = scope.adminId ?? null;
    if (!admin_id) {
      const { data, error } = await supabase
        .from("workers").select("parent_admin_id").eq("id", scope.workerId).maybeSingle();
      if (error) throw error;
      admin_id = (data as any)?.parent_admin_id ?? null;
    }
    if (!admin_id) throw new Error(SCOPE_ADMIN_REQUIRED_MESSAGE);
    return { worker_id: scope.workerId, admin_id };
  }
  if (scope?.adminId) return { worker_id: null, admin_id: scope.adminId };

  const { data: { session } } = await supabase.auth.getSession();
  const uid = session?.user?.id ?? null;
  if (!uid) throw new Error(SCOPE_ADMIN_REQUIRED_MESSAGE);

  const { data: w, error: wErr } = await supabase
    .from("workers").select("id, parent_admin_id").eq("auth_user_id", uid).maybeSingle();
  if (wErr) throw wErr;
  if (w?.id) {
    const admin_id = (w as any).parent_admin_id ?? null;
    if (!admin_id) throw new Error(SCOPE_ADMIN_REQUIRED_MESSAGE);
    return { worker_id: (w as any).id as string, admin_id };
  }

  const { data: a, error: aErr } = await supabase
    .from("admins" as any).select("id").eq("auth_user_id", uid).maybeSingle();
  if (aErr) throw aErr;
  const admin_id = (a as any)?.id ?? null;
  if (!admin_id) throw new Error(SCOPE_ADMIN_REQUIRED_MESSAGE);
  return { worker_id: null, admin_id };
}

/**
 * Returns the daily_cash scope (worker_id/admin_id).
 * Se um escopo explícito for informado, ele prevalece sobre o usuário autenticado.
 */
export async function getCurrentDailyCashScope(scope?: ExplicitScope): Promise<{ worker_id: string | null; admin_id: string | null }> {
  if (scope?.workerId) return { worker_id: scope.workerId, admin_id: scope.adminId ?? null };
  if (scope?.adminId) return { worker_id: null, admin_id: scope.adminId };
  return await resolveScope({ required: false });
}


/**
 * Apply the daily_cash scope filter to a supabase query builder.
 * - worker_id present: eq worker_id + eq admin_id (obrigatório)
 * - admin_id only:     worker_id IS NULL + eq admin_id
 * Nunca aceita worker_id sem admin_id.
 */
export function applyDailyCashScope(query: any, scope: { worker_id: string | null; admin_id: string | null }): any {
  if (scope.worker_id) {
    if (!scope.admin_id) throw new Error(SCOPE_ADMIN_REQUIRED_MESSAGE);
    return query.eq("worker_id", scope.worker_id).eq("admin_id", scope.admin_id);
  }
  if (scope.admin_id) return query.is("worker_id", null).eq("admin_id", scope.admin_id);
  throw new Error(SCOPE_ADMIN_REQUIRED_MESSAGE);
}


export type CashMovementType =
  | "emprestimo"
  | "recebimento_normal"
  | "recebimento_multa"
  | "entrada_manual"
  | "saida_manual"
  | "ajuste_manual"
  | "despesa"
  | "estorno_pagamento"
  | "estorno_manual";

export type CashMovement = {
  id: string;
  type: CashMovementType;
  amount: number;
  client_id: string | null;
  loan_id: string | null;
  installment_id: string | null;
  observation: string | null;
  cash_date?: string;
  daily_event_id?: string | null;
  reversed_at?: string | null;
  reversed_by?: string | null;
  created_at: string;
};

export type CashBalance = {
  id: string;
  available_cash: number;
  money_lent: number;
  interest_receivable: number;
  penalty_receivable: number;
  updated_at: string;
};

/**
 * Returns the cash_balance row.
 * - Escopo explícito (`{ workerId }`): SEMPRE a linha daquele trabalhador.
 * - Worker logado: sua própria linha (worker_id = current worker)
 * - Admin / super_admin sem escopo: linha admin/global (worker_id IS NULL)
 */
export async function getCashBalance(scope?: ExplicitScope): Promise<CashBalance | null> {
  const { data } = await getCashBalanceResult(scope);
  return data as unknown as CashBalance;
}

/**
 * Leitura ESTRITA do cash_balance: devolve `{ data, error }` para que o
 * chamador possa distinguir erro de consulta de "linha inexistente".
 *
 * Quando um escopo EXPLÍCITO é informado (`workerId` e/ou `adminId`), ele é
 * usado como está — nunca substituído pelo usuário autenticado — e os dois
 * filtros são aplicados juntos. Mais de uma linha vira erro (maybeSingle).
 */
export async function getCashBalanceResult(
  scope?: ExplicitScope,
): Promise<{ data: CashBalance | null; error: any }> {
  const hasExplicit = !!(scope?.workerId || scope?.adminId);
  let q = supabase.from("cash_balance").select("*");

  if (hasExplicit) {
    if (scope?.workerId) q = q.eq("worker_id", scope.workerId);
    else q = q.is("worker_id", null);
    if (scope?.adminId) q = q.eq("admin_id", scope.adminId);
    const { data, error } = await q.maybeSingle();
    return { data: (data as unknown as CashBalance) ?? null, error };
  }

  const workerId = await getCurrentWorkerId();
  if (workerId) q = q.eq("worker_id", workerId);
  else q = q.is("worker_id", null);
  const { data, error } = await q.limit(1).maybeSingle();
  return { data: (data as unknown as CashBalance) ?? null, error };
}




export async function updateCashBalance(changes: {
  available_cash?: number;
  money_lent?: number;
  interest_receivable?: number;
  penalty_receivable?: number;
}) {
  const { error } = await supabase.rpc("update_cash_balance_atomic", {
    p_available_cash: changes.available_cash ?? 0,
    p_money_lent: changes.money_lent ?? 0,
    p_interest_receivable: changes.interest_receivable ?? 0,
    p_penalty_receivable: changes.penalty_receivable ?? 0,
  });
  if (error) throw error;
}

export async function createCashMovement(movement: {
  type: CashMovementType;
  amount: number;
  client_id?: string | null;
  loan_id?: string | null;
  installment_id?: string | null;
  observation?: string | null;
  cash_date?: string | null;
  daily_event_id?: string | null;
  /** Preenchido apenas em movimentações de estorno (contrapartida). */
  reverses_movement_id?: string | null;
  reversal_reason?: string | null;
}) {
  const userId = await getCurrentUserId();
  const { worker_id, admin_id } = await resolveScope({
    loan_id: movement.loan_id,
    client_id: movement.client_id,
    required: true,
  });
  const { data, error } = await supabase.from("cash_movements").insert({
    type: movement.type,
    amount: movement.amount,
    client_id: movement.client_id || null,
    loan_id: movement.loan_id || null,
    installment_id: movement.installment_id || null,
    observation: movement.observation || null,
    cash_date: movement.cash_date || new Date().toISOString().slice(0, 10),
    daily_event_id: movement.daily_event_id || null,
    reverses_movement_id: movement.reverses_movement_id || null,
    reversal_reason: movement.reversal_reason || null,
    user_id: userId,
    worker_id,
    admin_id,
  } as any).select().single();
  if (error) throw error;
  return data;
}


export async function linkCashMovementToDailyEvent(movementId: string, eventId: string) {
  const { error } = await supabase.from("cash_movements").update({ daily_event_id: eventId } as any).eq("id", movementId);
  if (error) throw error;
}

/**
 * Mark a cash_movement as reversed (audit trail). NEVER deletes.
 */
export async function markCashMovementReversed(movementId: string) {
  const userId = await getCurrentUserId();
  await supabase
    .from("cash_movements")
    .update({ reversed_at: new Date().toISOString(), reversed_by: userId } as any)
    .eq("id", movementId);
}

/**
 * Reverse a cash_movement (preserves history). Optionally appends a reason
 * to the observation field for human readability. NEVER deletes the row.
 */
export async function reverseCashMovement(
  id: string,
  opts: { reason?: string } = {},
): Promise<void> {
  await markCashMovementReversed(id);
  if (opts.reason && opts.reason.trim().length > 0) {
    const { data: cur } = await supabase
      .from("cash_movements").select("observation").eq("id", id).maybeSingle();
    const prev = (cur as any)?.observation || "";
    const tag = `[ESTORNO] ${opts.reason.trim()}`;
    const next = prev ? `${prev}\n${tag}` : tag;
    await supabase.from("cash_movements").update({ observation: next } as any).eq("id", id);
  }
}

/**
 * @deprecated Use `reverseCashMovement`. Kept for legacy callers — NEVER deletes; marks as reversed.
 */
export async function deleteCashMovement(id: string) {
  await reverseCashMovement(id);
}

/**
 * Recalculates cash_balance from authoritative sources, SCOPED to the
 * current user's worker_id (if logged in as worker). Admins recalculate
 * the global / their-admin scope.
 *
 * - available_cash: sum of all (non-reversed) cash_movements.amount
 * - money_lent + interest_receivable: derived from loans.remaining_balance
 * - penalty_receivable: from penalty installments (amount - paid_amount)
 */
export async function recalculateCashBalanceFromLedger() {
  const workerId = await getCurrentWorkerId();

  let movQ = supabase
    .from("cash_movements")
    .select("id, amount, worker_id, reversed_at, reverses_movement_id, reversal_movement_id");
  let loanQ = supabase.from("loans").select("amount, total_amount, remaining_balance, status, worker_id");
  let instQ = supabase
    .from("installments")
    .select("amount, paid_amount, is_penalty, loan_id, loans!inner(worker_id)");

  if (workerId) {
    movQ = movQ.eq("worker_id", workerId);
    loanQ = loanQ.eq("worker_id", workerId);
    instQ = instQ.eq("loans.worker_id", workerId) as any;
  }

  const [{ data: movements }, { data: loans }, { data: installments }] = await Promise.all([
    movQ, loanQ, instQ,
  ]);

  let money_lent = 0;
  let interest_receivable = 0;
  let penalty_receivable = 0;

  // REGRA ÚNICA: soma original + contrapartida (efeito líquido zero).
  // Estornos legados (marcados sem contrapartida) são ignorados e sinalizados.
  const { total: available_cash, legacyReversedWithoutCounter } = sumLedgerMovements(
    (movements || []) as any[],
  );
  if (legacyReversedWithoutCounter.length > 0) {
    console.warn(
      "[cash-utils] movimentações estornadas sem contrapartida (padrão antigo):",
      legacyReversedWithoutCounter,
    );
  }


  for (const loan of (loans || []) as any[]) {
    // Skip inactive loans (cancelled/renegotiated) — they no longer represent receivables.
    if (loan.status === "cancelled" || loan.status === "renegotiated") continue;
    const principal = Number(loan.amount);
    const total = Number(loan.total_amount);
    const remaining = Math.max(0, Number(loan.remaining_balance));
    const interestPortion = Math.max(0, total - principal);
    const totalPaid = Math.max(0, total - remaining);

    const interestPaid = Math.min(interestPortion, totalPaid);
    const principalPaid = totalPaid - interestPaid;

    money_lent += Math.max(0, principal - principalPaid);
    interest_receivable += Math.max(0, interestPortion - interestPaid);
  }

  const penaltyInsts = ((installments || []) as any[]).filter((i) => i.is_penalty);
  penalty_receivable = penaltyInsts.reduce(
    (s: number, i: any) => s + Math.max(0, Number(i.amount) - Number(i.paid_amount)),
    0
  );

  const current = await getCashBalance();
  if (!current) return;

  await supabase.from("cash_balance").update({
    available_cash,
    money_lent,
    interest_receivable,
    penalty_receivable,
    updated_at: new Date().toISOString(),
  }).eq("id", current.id);
}

export function getMovementTypeLabel(type: string): string {
  switch (type) {
    case "emprestimo": return "Empréstimo";
    case "recebimento_normal": return "Recebimento Normal";
    case "recebimento_multa": return "Recebimento Multa";
    case "entrada_manual": return "Entrada Manual";
    case "saida_manual": return "Saída Manual";
    case "ajuste_manual": return "Ajuste Manual";
    case "despesa": return "Despesa";
    case "estorno_pagamento": return "Estorno Pagamento";
    case "estorno_manual": return "Estorno Manual";
    default: return type;
  }
}

export function getMovementTypeColor(type: string): string {
  switch (type) {
    case "emprestimo": return "text-destructive";
    case "recebimento_normal": return "text-success";
    case "recebimento_multa": return "text-warning";
    case "entrada_manual": return "text-success";
    case "saida_manual": return "text-destructive";
    case "ajuste_manual": return "text-primary";
    case "despesa": return "text-destructive";
    case "estorno_pagamento": return "text-muted-foreground";
    case "estorno_manual": return "text-muted-foreground";
    default: return "text-muted-foreground";
  }
}
