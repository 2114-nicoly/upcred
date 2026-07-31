import { supabase } from "@/integrations/supabase/client";
import { getCurrentUserId } from "@/lib/auth-utils";

/**
 * REGRA ÚNICA DE ESTORNO (UpCredit)
 * ---------------------------------
 * - A movimentação original NUNCA é excluída nem alterada em valor.
 * - Todo estorno cria UMA movimentação oposta vinculada à original.
 * - Os totais somam original + estorno (efeito líquido zero).
 * - Movimentação antiga marcada como estornada SEM contrapartida (padrão
 *   legado) é apenas ignorada — nunca ajustada automaticamente.
 * - Nunca existe mais de um estorno para a mesma movimentação
 *   (índice único em cash_movements.reverses_movement_id).
 */

export type LedgerMovementLike = {
  id: string;
  amount: number | string | null;
  reversed_at?: string | null;
  reverses_movement_id?: string | null;
  reversal_movement_id?: string | null;
};

const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Soma líquida do ledger seguindo a regra única.
 * Também devolve as inconsistências encontradas (padrão legado), para
 * sinalização — nunca para correção automática.
 */
export function sumLedgerMovements(rows: LedgerMovementLike[] | null | undefined): {
  total: number;
  legacyReversedWithoutCounter: string[];
} {
  const list = rows || [];
  const counteredIds = new Set<string>();
  for (const r of list) {
    if (r.reverses_movement_id) counteredIds.add(r.reverses_movement_id);
  }

  let total = 0;
  const legacy: string[] = [];
  for (const r of list) {
    const hasCounter = counteredIds.has(r.id) || !!r.reversal_movement_id;
    if (r.reversed_at && !hasCounter) {
      // Padrão antigo: estorno sem contrapartida. Ignorar (não somar) e sinalizar.
      legacy.push(r.id);
      continue;
    }
    total += num(r.amount);
  }
  return { total, legacyReversedWithoutCounter: legacy };
}

export type ReversalGuardResult = {
  movement: any;
  existingReversalId: string | null;
};

/**
 * Valida idempotência antes de estornar:
 * - a movimentação precisa existir;
 * - não pode já possuir contrapartida;
 * - não pode estar marcada como estornada.
 * Lança erro amigável em português quando o estorno não é permitido.
 */
export async function assertReversible(movementId: string): Promise<ReversalGuardResult> {
  if (!movementId) throw new Error("Movimentação não informada para estorno.");

  const { data: movement, error } = await supabase
    .from("cash_movements")
    .select("*")
    .eq("id", movementId)
    .maybeSingle();
  if (error) throw error;
  if (!movement) throw new Error("Movimentação não encontrada.");

  if ((movement as any).reverses_movement_id) {
    throw new Error("Esta movimentação já é um estorno e não pode ser estornada novamente.");
  }

  const { data: existing } = await supabase
    .from("cash_movements")
    .select("id")
    .eq("reverses_movement_id", movementId)
    .maybeSingle();

  if (existing?.id) {
    throw new Error("Esta movimentação já foi estornada.");
  }
  if ((movement as any).reversed_at) {
    throw new Error("Esta movimentação já está marcada como estornada.");
  }

  return { movement, existingReversalId: null };
}

/** Marca a movimentação original como estornada e vincula a contrapartida. */
export async function linkReversal(params: {
  originalMovementId: string;
  reversalMovementId: string | null;
  reason?: string | null;
}) {
  const userId = await getCurrentUserId();
  await supabase
    .from("cash_movements")
    .update({
      reversed_at: new Date().toISOString(),
      reversed_by: userId,
      reversal_movement_id: params.reversalMovementId,
      reversal_reason: params.reason ?? null,
    } as any)
    .eq("id", params.originalMovementId);
}

/** Marca o evento original como estornado e vincula o evento de estorno. */
export async function linkEventReversal(params: {
  originalEventId: string;
  reversalEventId: string | null;
  reason?: string | null;
}) {
  const userId = await getCurrentUserId();
  await supabase
    .from("daily_events" as any)
    .update({
      reversed_at: new Date().toISOString(),
      reversed_by: userId,
      reversal_event_id: params.reversalEventId,
      reversal_reason: params.reason ?? null,
    } as any)
    .eq("id", params.originalEventId);
}

/**
 * Bloqueia estorno em dia com caixa FECHADO — exige reabertura oficial,
 * preservando o snapshot já gravado (nova versão é criada no novo fechamento).
 */
export async function assertCashDateOpenForReversal(
  cashDate: string,
  scope: { workerId?: string | null; adminId?: string | null } = {},
) {
  const { getCurrentDailyCashScope, applyDailyCashScope } = await import("@/lib/cash-utils");
  const resolved = await getCurrentDailyCashScope({
    workerId: scope.workerId ?? null,
    adminId: scope.adminId ?? null,
  });
  const { data } = await applyDailyCashScope(
    supabase.from("daily_cash").select("status").eq("cash_date", cashDate),
    resolved,
  ).maybeSingle();
  if ((data as any)?.status === "closed") {
    throw new Error(
      "O caixa deste dia está fechado. Solicite a reabertura antes de desfazer esta movimentação — o fechamento anterior é preservado em uma nova versão.",
    );
  }
}
