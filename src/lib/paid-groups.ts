/**
 * FONTE ÚNICA de montagem dos cards "Pagos do Dia" da Rota.
 *
 * Regra: cada card é construído EXCLUSIVAMENTE a partir do metadata congelado
 * gravado por `register_payment_tx` no `daily_event`. Nunca consultamos
 * empréstimos, parcelas ou saldos atuais — assim um pagamento antigo jamais
 * muda quando um pagamento posterior é registrado.
 */

export const INCOMPLETE_HISTORY_LABEL = "Histórico antigo sem progresso congelado";

export type FrozenPaymentEvent = {
  id: string;
  cash_date: string;
  event_type: string;
  client_id: string | null;
  loan_id: string | null;
  cash_movement_id?: string | null;
  amount_in: number | string;
  amount_out?: number | string;
  created_at: string;
  reversed_at?: string | null;
  worker_id?: string | null;
  admin_id?: string | null;
  metadata?: Record<string, any> | null;
};

/** Movimento de caixa antigo (sem daily_event) — histórico incompleto. */
export type LegacyPaymentMovement = {
  id: string;
  loan_id: string | null;
  client_id?: string | null;
  amount: number | string;
  created_at: string;
  cash_date?: string | null;
  worker_id?: string | null;
  admin_id?: string | null;
  /** Quando preenchido, o movimento já pertence a um daily_event (não é legado). */
  daily_event_id?: string | null;
};

export type PaidGroup = {
  eventId: string | null;
  movementId: string;
  clientName: string;
  clientId: string;
  loanId: string;
  totalPaid: number;
  createdAt: string;
  cashDate: string;
  /** false → evento antigo sem metadata congelado completo. */
  hasFrozenProgress: boolean;
  instAmount: number | null;
  totalAmount: number | null;
  installmentCount: number | null;
  paidBefore: number | null;
  paidAfter: number | null;
  remainingBefore: number | null;
  remainingAfter: number | null;
  progressBeforeFormatted: string | null;
  progressAfterFormatted: string | null;
  progressDeltaFormatted: string | null;
  installmentsAdvanced: number | null;
  installmentIds: string[];
};

export type ScopeFilter = { workerId?: string | null; adminId?: string | null };

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function inScope(row: { worker_id?: string | null; admin_id?: string | null }, scope: ScopeFilter): boolean {
  if (scope.workerId && row.worker_id !== scope.workerId) return false;
  if (scope.adminId && row.admin_id !== scope.adminId) return false;
  return true;
}

/** "+1" / "+0,5" a partir do delta de unidades já congelado. */
function formatUnitsDelta(before: number | null, after: number | null): string | null {
  if (before === null || after === null) return null;
  const delta = Math.max(0, after - before);
  const rounded = Math.floor(delta * 10) / 10;
  if (Math.abs(rounded - Math.round(rounded)) < 0.05) return `+${Math.round(rounded)}`;
  return `+${rounded.toFixed(1).replace(".", ",")}`;
}

/**
 * Constrói os cards de "Pagos do Dia" a partir dos eventos congelados.
 * Função PURA: não consulta banco, não usa estado atual do empréstimo.
 */
export function buildPaidGroupsFromFrozenEvents(
  events: FrozenPaymentEvent[],
  opts: { scope?: ScopeFilter; cashDate?: string; legacyMovements?: LegacyPaymentMovement[] } = {},
): PaidGroup[] {
  const scope = opts.scope ?? {};
  const groups: PaidGroup[] = [];
  const seenMovementIds = new Set<string>();

  const validEvents = (events || []).filter((ev) => {
    if (!ev) return false;
    if (ev.event_type !== "pagamento") return false;
    if (ev.reversed_at) return false;
    if (opts.cashDate && ev.cash_date !== opts.cashDate) return false;
    if (!inScope(ev, scope)) return false;
    return true;
  });

  const sorted = [...validEvents].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  for (const ev of sorted) {
    const md = (ev.metadata || {}) as Record<string, any>;
    const movementId = (md.cash_movement_id as string) || ev.cash_movement_id || "";
    if (movementId) seenMovementIds.add(movementId);

    const remainingBefore = numOrNull(md.remaining_balance_before);
    const remainingAfter = numOrNull(md.remaining_balance_after);
    const progressBefore = typeof md.installment_progress_before === "string" ? md.installment_progress_before : null;
    const progressAfter = typeof md.installment_progress_after === "string" ? md.installment_progress_after : null;
    const totalInstallments = numOrNull(md.total_installments);
    const hasFrozenProgress =
      remainingBefore !== null && remainingAfter !== null &&
      progressBefore !== null && progressAfter !== null && totalInstallments !== null;

    const unitsBefore = numOrNull(md.progress_units_before);
    const unitsAfter = numOrNull(md.progress_units_after);
    const advanced = numOrNull(md.installments_advanced);
    const instAmount = numOrNull(md.installment_amount);
    const paymentAmount = numOrNull(md.payment_amount);

    const affected = Array.isArray(md.affected_installments) ? md.affected_installments : [];

    const totalAmount =
      hasFrozenProgress && instAmount !== null && totalInstallments !== null
        ? instAmount * totalInstallments
        : null;

    groups.push({
      eventId: ev.id,
      movementId,
      clientName: (md.client_name as string) || "Cliente",
      clientId: (md.client_id as string) || ev.client_id || "",
      loanId: (md.loan_id as string) || ev.loan_id || "",
      totalPaid: paymentAmount ?? num(ev.amount_in),
      createdAt: ev.created_at,
      cashDate: (md.cash_date as string) || ev.cash_date,
      hasFrozenProgress,
      instAmount: hasFrozenProgress ? instAmount : null,
      totalAmount,
      installmentCount: hasFrozenProgress ? totalInstallments : null,
      paidBefore: hasFrozenProgress && totalAmount !== null ? Math.max(0, totalAmount - (remainingBefore as number)) : null,
      paidAfter: hasFrozenProgress && totalAmount !== null ? Math.max(0, totalAmount - (remainingAfter as number)) : null,
      remainingBefore: hasFrozenProgress ? remainingBefore : null,
      remainingAfter: hasFrozenProgress ? remainingAfter : null,
      progressBeforeFormatted: hasFrozenProgress ? progressBefore : null,
      progressAfterFormatted: hasFrozenProgress ? progressAfter : null,
      progressDeltaFormatted: hasFrozenProgress
        ? (formatUnitsDelta(unitsBefore, unitsAfter) ?? (advanced !== null ? `+${advanced}` : null))
        : null,
      installmentsAdvanced: hasFrozenProgress ? advanced : null,
      installmentIds: affected
        .map((a: any) => a?.installment_id)
        .filter((id: any): id is string => typeof id === "string"),
    });
  }

  // Movimentos antigos sem daily_event: histórico incompleto, campos próprios.
  for (const mov of opts.legacyMovements || []) {
    if (!mov || seenMovementIds.has(mov.id)) continue;
    if (opts.cashDate && mov.cash_date && mov.cash_date !== opts.cashDate) continue;
    if (!inScope(mov, scope)) continue;
    groups.push({
      eventId: null,
      movementId: mov.id,
      clientName: "Cliente",
      clientId: mov.client_id || "",
      loanId: mov.loan_id || "",
      totalPaid: num(mov.amount),
      createdAt: mov.created_at,
      cashDate: mov.cash_date || opts.cashDate || "",
      hasFrozenProgress: false,
      instAmount: null,
      totalAmount: null,
      installmentCount: null,
      paidBefore: null,
      paidAfter: null,
      remainingBefore: null,
      remainingAfter: null,
      progressBeforeFormatted: null,
      progressAfterFormatted: null,
      progressDeltaFormatted: null,
      installmentsAdvanced: null,
      installmentIds: [],
    });
  }

  return groups.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

/** Normaliza grupos vindos do snapshot (dias fechados) para o formato de exibição. */
export function normalizeSnapshotPaidGroups(raw: any[]): PaidGroup[] {
  return (raw || []).map((g: any) => {
    const hasFrozenProgress =
      g?.progressBeforeFormatted != null && g?.progressAfterFormatted != null;
    return {
      eventId: g?.eventId ?? null,
      movementId: g?.movementId || "",
      clientName: g?.clientName || "Cliente",
      clientId: g?.clientId || "",
      loanId: g?.loanId || "",
      totalPaid: num(g?.totalPaid),
      createdAt: g?.createdAt || g?.created_at || "",
      cashDate: g?.cashDate || g?.cash_date || "",
      hasFrozenProgress,
      instAmount: numOrNull(g?.instAmount),
      totalAmount: numOrNull(g?.totalAmount),
      installmentCount: numOrNull(g?.installmentCount),
      paidBefore: numOrNull(g?.paidBefore),
      paidAfter: numOrNull(g?.paidAfter),
      remainingBefore: numOrNull(g?.remainingBefore),
      remainingAfter: numOrNull(g?.remainingAfter),
      progressBeforeFormatted: hasFrozenProgress ? g.progressBeforeFormatted : null,
      progressAfterFormatted: hasFrozenProgress ? g.progressAfterFormatted : null,
      progressDeltaFormatted: hasFrozenProgress ? (g?.progressDeltaFormatted ?? null) : null,
      installmentsAdvanced: numOrNull(g?.installmentsAdvanced),
      installmentIds: Array.isArray(g?.installmentIds) ? g.installmentIds : [],
    } as PaidGroup;
  });
}

/** Localiza o card pelo movementId (não pelo loanId) para desfazer só ele. */
export function findPaidGroupByMovement(groups: PaidGroup[], movementId: string): PaidGroup | undefined {
  return groups.find((g) => g.movementId === movementId);
}

/** Remove otimisticamente APENAS o card do movimento desfeito. */
export function removePaidGroupByMovement(groups: PaidGroup[], movementId: string): PaidGroup[] {
  return groups.filter((g) => g.movementId !== movementId);
}
