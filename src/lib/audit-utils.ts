import { supabase } from "@/integrations/supabase/client";

export type AuditAction =
  | "transferencia_cliente"
  | "criar_cliente" | "editar_cliente" | "excluir_cliente"
  | "criar_emprestimo" | "editar_emprestimo" | "excluir_emprestimo" | "editar_observacao_emprestimo"
  | "renovar_emprestimo" | "quitar_emprestimo"
  | "anexar_arquivo" | "excluir_anexo"
  | "pagamento" | "editar_pagamento" | "desfazer_pagamento" | "nao_pagou"
  | "editar_parcela" | "alterar_data_parcela"
  | "aporte" | "retirada" | "ajuste_caixa" | "fechar_caixa"
  | "criar_trabalhador" | "reset_senha_trabalhador" | "ativar_trabalhador" | "desativar_trabalhador"
  | "arquivar_trabalhador" | "desarquivar_trabalhador" | "excluir_trabalhador"
  | "ativar_admin" | "desativar_admin";

export type AuditEntity =
  | "client" | "loan" | "installment" | "payment" | "cash" | "worker" | "transfer" | "admin";

/**
 * Logs an action. Never throws — auditing must not block the UI flow.
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
