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
  | "aporte" | "retirada" | "ajuste_caixa" | "fechar_caixa" | "reabrir_caixa"
  | "criar_trabalhador" | "reset_senha_trabalhador" | "ativar_trabalhador" | "desativar_trabalhador"
  | "arquivar_trabalhador" | "desarquivar_trabalhador" | "excluir_trabalhador"
  | "ativar_admin" | "desativar_admin";

export type AuditEntity =
  | "client" | "loan" | "installment" | "payment" | "cash" | "worker" | "transfer" | "admin"
  | "penalty" | "installment_reschedules" | "loan_renegotiations";

/**
 * Logs an action. Never throws — auditing must not block the UI flow.
 * Both `oldValue` and `newValue` are jsonb in the DB; callers should put
 * enrichment fields (client_name, worker_name, loan_id, etc) directly in
 * `newValue` so the audit list can render them without extra joins.
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
    await supabase.rpc("log_audit" as any, {
      p_action: action,
      p_entity: entity,
      p_entity_id: entityId ?? null,
      p_old: oldValue ? (oldValue as any) : null,
      p_new: newValue ? (newValue as any) : null,
      p_obs: observation ?? null,
      p_worker_id: workerId ?? null,
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
