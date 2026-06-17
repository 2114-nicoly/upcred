import { supabase } from "@/integrations/supabase/client";

export type AuditAction =
  | "transferencia_cliente"
  | "criar_cliente" | "editar_cliente" | "excluir_cliente"
  | "criar_emprestimo" | "criar_emprestimo_importado"
  | "editar_emprestimo" | "excluir_emprestimo" | "editar_observacao_emprestimo"
  | "renovar_emprestimo" | "quitar_emprestimo"
  | "renegociacao_emprestimo" | "renovacao_emprestimo"
  | "anexar_arquivo" | "excluir_anexo"
  | "pagamento" | "editar_pagamento" | "desfazer_pagamento" | "nao_pagou"
  | "editar_parcela" | "alterar_data_parcela"
  | "multa_aplicada" | "multa_paga" | "multa_cancelada" | "editar_multa"
  | "reagendamento_solicitado" | "reagendamento_aprovado" | "reagendamento_recusado"
  | "aporte" | "retirada" | "ajuste_caixa" | "fechar_caixa" | "reabrir_caixa" | "solicitar_reabertura_caixa"
  | "estorno_manual" | "estorno_pagamento"
  | "criar_trabalhador" | "reset_senha_trabalhador" | "ativar_trabalhador" | "desativar_trabalhador"
  | "arquivar_trabalhador" | "desarquivar_trabalhador" | "excluir_trabalhador"
  | "ativar_admin" | "desativar_admin";

export type AuditEntity =
  | "client" | "loan" | "installment" | "payment" | "cash" | "worker" | "transfer" | "admin"
  | "penalty" | "installment_reschedules" | "loan_renegotiations";

/**
 * Auto-enriches an audit payload so financial logs always carry human context.
 * - if it has `loan_id` without client/worker → fills from `loans` row
 * - if it has `client_id` without `client_name` → fills from `clients`
 * - if it has `worker_id` without `worker_name` → fills from `workers`
 * Always stamps `timestamp` when missing. Never throws.
 */
async function enrichAuditPayload(payload: any): Promise<any> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const out: any = { ...payload };
  try {
    if (out.loan_id && (!out.client_id || !out.worker_id)) {
      const { data: loan } = await supabase
        .from("loans")
        .select("client_id, worker_id, amount, total_amount, remaining_balance, installment_count, status")
        .eq("id", out.loan_id).maybeSingle();
      if (loan) {
        out.client_id = out.client_id ?? (loan as any).client_id ?? null;
        out.worker_id = out.worker_id ?? (loan as any).worker_id ?? null;
        if (!out.loan_snapshot) {
          out.loan_snapshot = {
            amount: (loan as any).amount,
            total_amount: (loan as any).total_amount,
            remaining_balance: (loan as any).remaining_balance,
            installment_count: (loan as any).installment_count,
            status: (loan as any).status,
          };
        }
      }
    }
    if (out.client_id && !out.client_name) {
      const { data: c } = await supabase.from("clients").select("name, worker_id").eq("id", out.client_id).maybeSingle();
      if (c) {
        out.client_name = (c as any).name ?? null;
        out.worker_id = out.worker_id ?? (c as any).worker_id ?? null;
      }
    }
    if (out.worker_id && !out.worker_name) {
      const { data: w } = await supabase.from("workers").select("nome").eq("id", out.worker_id).maybeSingle();
      if (w) out.worker_name = (w as any).nome ?? null;
    }
  } catch (err) {
    console.warn("[audit] enrichAuditPayload failed", err);
  }
  if (!out.timestamp) out.timestamp = new Date().toISOString();
  return out;
}

/**
 * Logs an action. Never throws — auditing must not block the UI flow.
 * Auto-enriches `oldValue` / `newValue` with client_name / worker_name /
 * loan snapshot when those ids are present but the names are missing.
 */
export async function logAction(
  action: AuditAction,
  entity: AuditEntity,
  entityId?: string | null,
  oldValue?: unknown,
  newValue?: unknown,
  observation?: string,
  workerId?: string | null,
): Promise<void> {
  try {
    const enrichedNew: any = newValue ? await enrichAuditPayload(newValue) : null;
    const enrichedOld: any = oldValue ? await enrichAuditPayload(oldValue) : null;
    await supabase.rpc("log_audit" as any, {
      p_action: action,
      p_entity: entity,
      p_entity_id: entityId ?? null,
      p_old: enrichedOld,
      p_new: enrichedNew,
      p_obs: observation ?? null,
      p_worker_id:
        workerId ?? enrichedNew?.worker_id ?? enrichedOld?.worker_id ?? null,
    });
  } catch (err) {
    console.warn("[audit] log failed", err);
  }
}

/**
 * Resolves the client / worker / admin names attached to a loan so audit
 * payloads always carry human-readable context. Never throws — falls back to
 * what was passed in if any lookup fails.
 */
async function enrichLoanContext(opts: {
  loanId?: string | null;
  clientId?: string | null;
  clientName?: string | null;
  workerId?: string | null;
}): Promise<{
  loan_id: string | null;
  client_id: string | null;
  client_name: string | null;
  worker_id: string | null;
  worker_name: string | null;
  admin_id: string | null;
  admin_name: string | null;
}> {
  let loanId = opts.loanId ?? null;
  let clientId = opts.clientId ?? null;
  let clientName = opts.clientName ?? null;
  let workerId = opts.workerId ?? null;
  let adminId: string | null = null;

  try {
    if (loanId && (!clientId || !workerId)) {
      const { data: loan } = await supabase
        .from("loans")
        .select("client_id, worker_id, admin_id")
        .eq("id", loanId)
        .maybeSingle();
      if (loan) {
        clientId = clientId ?? (loan as any).client_id ?? null;
        workerId = workerId ?? (loan as any).worker_id ?? null;
        adminId = adminId ?? (loan as any).admin_id ?? null;
      }
    }
    if (clientId && (!clientName || !workerId)) {
      const { data: client } = await supabase
        .from("clients")
        .select("name, worker_id, admin_id")
        .eq("id", clientId)
        .maybeSingle();
      if (client) {
        clientName = clientName ?? (client as any).name ?? null;
        workerId = workerId ?? (client as any).worker_id ?? null;
        adminId = adminId ?? (client as any).admin_id ?? null;
      }
    }
  } catch (err) {
    console.warn("[audit] enrichLoanContext failed", err);
  }

  let workerName: string | null = null;
  let adminName: string | null = null;
  try {
    if (workerId) {
      const { data: w } = await supabase
        .from("workers")
        .select("nome, parent_admin_id")
        .eq("id", workerId)
        .maybeSingle();
      if (w) {
        workerName = (w as any).nome ?? null;
        adminId = adminId ?? (w as any).parent_admin_id ?? null;
      }
    }
    if (adminId) {
      const { data: a } = await supabase
        .from("admins")
        .select("nome")
        .eq("id", adminId)
        .maybeSingle();
      if (a) adminName = (a as any).nome ?? null;
    }
  } catch (err) {
    console.warn("[audit] enrichLoanContext name lookup failed", err);
  }

  return {
    loan_id: loanId,
    client_id: clientId,
    client_name: clientName,
    worker_id: workerId,
    worker_name: workerName,
    admin_id: adminId,
    admin_name: adminName,
  };
}

/**
 * Specialized logger for loan-related actions. Auto-fills client / worker /
 * loan identifiers and names so no financial audit line ever shows up
 * "anônimo". Use this for: criar/renovar/quitar/cancelar emprestimo,
 * pagamento, desfazer pagamento, multa, reorganização de parcelas, etc.
 */
export async function logLoanAction(params: {
  action: AuditAction;
  entity?: AuditEntity;
  entityId?: string | null;
  loanId?: string | null;
  clientId?: string | null;
  clientName?: string | null;
  workerId?: string | null;
  before?: Record<string, any> | null;
  after?: Record<string, any> | null;
  observation?: string | null;
}): Promise<void> {
  const ctx = await enrichLoanContext({
    loanId: params.loanId ?? (params.entity === "loan" ? params.entityId ?? null : null),
    clientId: params.clientId,
    clientName: params.clientName,
    workerId: params.workerId,
  });

  const newPayload = {
    ...(params.after || {}),
    client_id: ctx.client_id,
    client_name: ctx.client_name,
    worker_id: ctx.worker_id,
    worker_name: ctx.worker_name,
    admin_id: ctx.admin_id,
    admin_name: ctx.admin_name,
    loan_id: ctx.loan_id,
  };

  const oldPayload = params.before ?? null;

  await logAction(
    params.action,
    params.entity ?? "loan",
    params.entityId ?? ctx.loan_id ?? null,
    oldPayload,
    newPayload,
    params.observation ?? undefined,
    ctx.worker_id,
  );
}

/**
 * Resolves the current actor identity (logged-in user) as
 * { id, name, role } for audit metadata. Never throws.
 */
export async function getCurrentActorIdentity(): Promise<{
  id: string | null;
  name: string | null;
  role: "super_admin" | "admin" | "trabalhador" | null;
}> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const uid = session?.user?.id ?? null;
    if (!uid) return { id: null, name: null, role: null };

    const { data: w } = await supabase
      .from("workers").select("id, nome").eq("auth_user_id", uid).maybeSingle();
    if (w) return { id: uid, name: (w as any).nome ?? null, role: "trabalhador" };

    const { data: a } = await supabase
      .from("admins" as any).select("id, nome, is_super_admin").eq("auth_user_id", uid).maybeSingle();
    if (a) return {
      id: uid,
      name: (a as any).nome ?? null,
      role: (a as any).is_super_admin ? "super_admin" : "admin",
    };
  } catch (err) {
    console.warn("[audit] getCurrentActorIdentity failed", err);
  }
  return { id: null, name: null, role: null };
}

/**
 * Standardized reversal audit logger. Writes an audit_log entry with the
 * full structured payload required for professional auditability:
 *
 *   original_event_id, original_movement_id,
 *   reversal_movement_id, reversal_event_id,
 *   reversal_reason, reversed_by, reversed_by_name, reversed_by_role,
 *   reversed_at, original_amount, reversal_amount,
 *   client_id, loan_id, original_type
 *
 * `action` should be "estorno_manual" or "desfazer_pagamento" depending on
 * the flow. `entity` defaults to "cash".
 */
export async function logReversal(params: {
  action: "estorno_manual" | "desfazer_pagamento" | "estorno_pagamento";
  entity?: AuditEntity;
  original_movement_id?: string | null;
  original_event_id?: string | null;
  reversal_movement_id?: string | null;
  reversal_event_id?: string | null;
  original_type?: string | null;
  original_amount: number;
  reversal_amount?: number;
  reversal_reason?: string | null;
  client_id?: string | null;
  loan_id?: string | null;
  cash_date?: string | null;
  observation?: string | null;
  beforeSnapshot?: Record<string, any> | null;
}): Promise<void> {
  const actor = await getCurrentActorIdentity();
  const now = new Date().toISOString();
  const reversalAmount = params.reversal_amount ?? -Number(params.original_amount);

  const ctx = await (async () => {
    try {
      return await (await import("@/lib/audit-utils")).logLoanAction ? null : null;
    } catch { return null; }
  })();
  void ctx;

  const newPayload: Record<string, any> = {
    original_event_id: params.original_event_id ?? null,
    original_movement_id: params.original_movement_id ?? null,
    reversal_movement_id: params.reversal_movement_id ?? null,
    reversal_event_id: params.reversal_event_id ?? null,
    original_type: params.original_type ?? null,
    original_amount: Number(params.original_amount),
    reversal_amount: Number(reversalAmount),
    reversal_reason: params.reversal_reason ?? null,
    reversed_by: actor.id,
    reversed_by_name: actor.name,
    reversed_by_role: actor.role,
    reversed_at: now,
    client_id: params.client_id ?? null,
    loan_id: params.loan_id ?? null,
    cash_date: params.cash_date ?? null,
  };

  await logAction(
    params.action,
    params.entity ?? "cash",
    params.original_movement_id ?? null,
    params.beforeSnapshot ?? null,
    newPayload,
    params.observation ?? (params.reversal_reason ?? undefined),
  );
}
