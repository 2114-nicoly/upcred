import { supabase } from "@/integrations/supabase/client";
import { getCurrentDailyCashScope, applyDailyCashScope } from "@/lib/cash-utils";
import { getDailyEvents, DailyEvent } from "@/lib/daily-events";
import { getCurrentActorIdentity } from "@/lib/audit-utils";

/**
 * Payload jsonb stored in `daily_cash_snapshots`. This is the frozen picture
 * of the Rota do Dia + Caixa do Dia at the moment the day was closed.
 *
 * Any change on the app to live data (payments, new loans, deletions, etc.)
 * MUST NOT change what is shown for a closed day. Consumers of a closed day
 * must read from this payload — never from live tables.
 *
 * Version bump if the shape changes so future readers can adapt.
 */
export const DAILY_SNAPSHOT_VERSION = 1;

export type SnapshotClientNames = Record<string, string>;

export type SnapshotPaidGroup = {
  movementId: string;
  clientName: string;
  clientId: string;
  loanId: string;
  totalPaid: number;
  accumulatedPaid: number;
  remainingBalance: number;
  instAmount: number;
  installmentIds: string[];
  totalAmount: number;
  installmentCount: number;
  paidBefore: number;
  paidAfter: number;
  remainingBefore: number;
  remainingAfter: number;
  progressBeforeFormatted: string;
  progressAfterFormatted: string;
  progressDeltaFormatted: string;
};

export type SnapshotNotPaidMark = {
  id: string;
  mark_date: string;
  installment_id: string;
  loan_id: string;
  client_id: string;
  observation: string | null;
  created_at: string;
  installment?: any;
};

export type SnapshotNewLoan = {
  id: string;
  amount: number;
  total_amount: number;
  remaining_balance: number;
  status: string;
  installment_count: number;
  payment_type: string;
  loan_date: string;
  renewed_from_loan_id: string | null;
  clients: { id: string; name: string } | null;
};

export type DailyCashSnapshotPayload = {
  version: number;
  cash_date: string;
  scope: { worker_id: string | null; admin_id: string | null };
  closed_at: string;
  closed_by: { id: string | null; name: string | null; role: string | null };
  observation: string | null;
  reopen_reason?: string | null;
  totals: {
    opening_balance: number;
    expected_worker_cash: number;   // dinheiro do trabalhador esperado
    counted_cash: number;           // dinheiro contado no caixa
    final_cash: number;             // caixa disponível no final do dia
    received: number;
    penalty: number;
    manual_in: number;
    manual_out: number;
    expenses: number;
    new_loans: number;
    renewals: number;
    lent: number;
    total_in: number;
    total_out: number;
    not_paid_count: number;
    events_count: number;
    penalty_paid_today: number;
  };
  daily_summary: {
    expectedToReceiveToday: number;
    receivedToday: number;
    pendingToReceiveToday: number;
    cashExpectedForClosing: number;
  } | null;
  events: DailyEvent[];              // non-reversed
  reversed_events: DailyEvent[];     // reversed only
  renewal_events: DailyEvent[];      // event_type = renovacao
  client_names: SnapshotClientNames;
  paid_groups: SnapshotPaidGroup[];
  not_paid_marks: SnapshotNotPaidMark[];
  new_loans: SnapshotNewLoan[];
  expense_breakdown: Record<string, number>;
};

export type DailyCashSnapshotVersion = {
  id: string;
  daily_cash_id: string;
  version: number;
  closed_at: string;
  closed_by: string | null;
  reopen_reason: string | null;
  payload: DailyCashSnapshotPayload;
  created_at: string;
};

// --- helpers copied from DailyCashPage to build paid groups identically ---
function formatInstFraction(paid: number, instAmount: number): string {
  if (!instAmount || instAmount <= 0) return "0";
  const frac = paid / instAmount;
  const rounded = Math.round(frac * 10) / 10;
  if (Math.abs(rounded - Math.round(rounded)) < 0.05) return Math.round(rounded).toString();
  return rounded.toFixed(1).replace(".", ",");
}
function formatProgress(paid: number, instAmount: number, count: number): string {
  return `${formatInstFraction(paid, instAmount)}/${count}`;
}
function formatDelta(deltaPaid: number, instAmount: number): string {
  if (!instAmount || instAmount <= 0 || deltaPaid <= 0) return "+0";
  return `+${formatInstFraction(deltaPaid, instAmount)}`;
}

async function loadDailyCollectionSummary(cashDate: string, scope: { worker_id: string | null; admin_id: string | null }) {
  try {
    const { getDailyCollectionSummary } = await import("@/lib/daily-totals");
    return await getDailyCollectionSummary(cashDate, {
      workerId: scope.worker_id || null,
      adminId: scope.admin_id || null,
    });
  } catch (err) {
    console.warn("[daily-snapshot] daily summary failed", err);
    return null;
  }
}

/**
 * Build the payload from live data. Call this at close time, BEFORE any
 * further mutation can happen.
 */
export async function buildDailyCashSnapshotPayload(cashDate: string, extra: {
  opening_balance: number;
  expected_worker_cash: number;
  counted_cash: number;
  final_cash: number;
  received: number;
  penalty: number;
  manual_in: number;
  manual_out: number;
  expenses: number;
  new_loans: number;
  renewals: number;
  lent: number;
  total_in: number;
  total_out: number;
  not_paid_count: number;
  events_count: number;
  observation: string | null;
}): Promise<DailyCashSnapshotPayload> {
  const scope = await getCurrentDailyCashScope();
  const actor = await getCurrentActorIdentity();

  const [
    liveEvents,
    allEventsIncReversed,
    npRes,
    newLoansRes,
    paidMovesRes,
    penaltyMovesRes,
  ] = await Promise.all([
    getDailyEvents(cashDate),
    getDailyEvents(cashDate, { includeReversed: true }),
    supabase.from("not_paid_marks").select("*").eq("mark_date", cashDate),
    supabase.from("loans")
      .select("id, amount, total_amount, remaining_balance, status, installment_count, payment_type, loan_date, renewed_from_loan_id, clients:client_id(id, name)")
      .eq("loan_date", cashDate),
    supabase.from("cash_movements")
      .select("id, loan_id, installment_id, amount, created_at")
      .eq("cash_date", cashDate)
      .eq("type", "recebimento_normal")
      .is("reversed_at", null),
    supabase.from("cash_movements")
      .select("amount")
      .eq("cash_date", cashDate)
      .eq("type", "recebimento_multa")
      .is("reversed_at", null),
  ]);

  const events = (liveEvents || []) as DailyEvent[];
  const reversed = ((allEventsIncReversed || []) as DailyEvent[]).filter(e => e.reversed_at != null);
  const renewalEvents = events.filter(e => e.event_type === "renovacao");

  // client_names — for any event or paid loan
  const clientIds = new Set<string>();
  for (const e of events) if (e.client_id) clientIds.add(e.client_id);
  for (const e of reversed) if (e.client_id) clientIds.add(e.client_id);
  const newLoans = ((newLoansRes.data as any[]) || []) as SnapshotNewLoan[];
  for (const l of newLoans) if (l.clients?.id) clientIds.add(l.clients.id);
  const clientNames: SnapshotClientNames = {};
  if (clientIds.size > 0) {
    const { data: cs } = await supabase.from("clients").select("id, name").in("id", [...clientIds]);
    for (const c of (cs || [])) clientNames[c.id] = c.name;
  }

  // Paid groups (mirrors DailyCashPage logic)
  const paidMovements = (paidMovesRes.data || []) as Array<{ id: string; loan_id: string | null; installment_id: string | null; amount: number; created_at: string }>;
  const paidLoanIds = new Set<string>();
  const paidMovementsByLoan = new Map<string, typeof paidMovements>();
  for (const mov of paidMovements) {
    if (!mov.loan_id) continue;
    paidLoanIds.add(mov.loan_id);
    const arr = paidMovementsByLoan.get(mov.loan_id) || [];
    arr.push(mov);
    paidMovementsByLoan.set(mov.loan_id, arr);
  }
  // Also account for pagamento events without cash_movement link (legacy)
  const paidEventsByLoan = new Map<string, number>();
  for (const ev of events) {
    if (ev.event_type === "pagamento" && ev.loan_id) {
      paidLoanIds.add(ev.loan_id);
      paidEventsByLoan.set(ev.loan_id, (paidEventsByLoan.get(ev.loan_id) || 0) + Number(ev.amount_in));
    }
  }

  const paidGroups: SnapshotPaidGroup[] = [];
  if (paidLoanIds.size > 0) {
    const { data: paidLoansData } = await supabase
      .from("loans")
      .select("id, client_id, amount, total_amount, remaining_balance, installment_count, payment_type, clients:client_id(id, name)")
      .in("id", [...paidLoanIds]);
    for (const loan of ((paidLoansData as any[]) || [])) {
      const totalAmount = Number(loan.total_amount);
      const instCount = Number(loan.installment_count);
      const instAmount = instCount > 0 ? totalAmount / instCount : 0;
      const currentRemaining = Number(loan.remaining_balance);
      const accumulatedPaid = Math.max(0, totalAmount - currentRemaining);
      const movements = [...(paidMovementsByLoan.get(loan.id) || [])].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
      const baseStatic = {
        clientName: loan.clients?.name || "Cliente",
        clientId: loan.client_id,
        loanId: loan.id,
        accumulatedPaid,
        remainingBalance: currentRemaining,
        instAmount,
        installmentIds: (movements.map(m => m.installment_id).filter(Boolean) as string[]),
        totalAmount,
        installmentCount: instCount,
      };
      const buildProgress = (totalPaid: number, remainingAfter: number) => {
        const remainingBefore = Math.min(totalAmount, remainingAfter + totalPaid);
        const paidBefore = Math.max(0, totalAmount - remainingBefore);
        const paidAfter = Math.max(0, totalAmount - remainingAfter);
        return {
          paidBefore, paidAfter, remainingBefore, remainingAfter,
          progressBeforeFormatted: formatProgress(paidBefore, instAmount, instCount),
          progressAfterFormatted: formatProgress(paidAfter, instAmount, instCount),
          progressDeltaFormatted: formatDelta(paidAfter - paidBefore, instAmount),
        };
      };
      if (movements.length > 0) {
        const totalToday = movements.reduce((s, m) => s + Number(m.amount), 0);
        let runningRemaining = Math.min(totalAmount, currentRemaining + totalToday);
        for (const mov of movements) {
          const amt = Number(mov.amount);
          const after = Math.max(0, runningRemaining - amt);
          paidGroups.push({
            ...baseStatic,
            movementId: mov.id,
            totalPaid: amt,
            ...buildProgress(amt, after),
          });
          runningRemaining = after;
        }
      } else {
        const totalPaid = paidEventsByLoan.get(loan.id) || 0;
        paidGroups.push({
          ...baseStatic,
          movementId: "",
          totalPaid,
          ...buildProgress(totalPaid, currentRemaining),
        });
      }
    }
  }

  // Not paid marks + installment enrichment
  const npMarks = ((npRes.data as any[]) || []) as SnapshotNotPaidMark[];
  const npInstIds = [...new Set(npMarks.map(m => m.installment_id).filter(Boolean))];
  let npInstMap: Record<string, any> = {};
  if (npInstIds.length > 0) {
    const { data: npInstData } = await supabase
      .from("installments")
      .select("*, loans(id, client_id, amount, total_amount, remaining_balance, installment_count, payment_type, clients(id, name))")
      .in("id", npInstIds);
    for (const i of ((npInstData as any[]) || [])) npInstMap[i.id] = i;
  }
  const enrichedNp = npMarks.map(m => ({ ...m, installment: npInstMap[m.installment_id] }));

  const penaltyPaidToday = ((penaltyMovesRes.data as any[]) || []).reduce((s, m) => s + Number(m.amount || 0), 0);

  // Expenses breakdown from events
  const expenseBreakdown: Record<string, number> = {};
  for (const ev of events) {
    if (ev.event_type === "despesa") {
      const cat = (ev.metadata?.category as string) || "Outros";
      expenseBreakdown[cat] = (expenseBreakdown[cat] || 0) + Number(ev.amount_out || 0);
    }
  }

  const dailySummary = await loadDailyCollectionSummary(cashDate, scope);

  return {
    version: DAILY_SNAPSHOT_VERSION,
    cash_date: cashDate,
    scope,
    closed_at: new Date().toISOString(),
    closed_by: { id: actor.id ?? null, name: actor.name ?? null, role: actor.role ?? null },
    observation: extra.observation,
    totals: {
      opening_balance: extra.opening_balance,
      expected_worker_cash: extra.expected_worker_cash,
      counted_cash: extra.counted_cash,
      final_cash: extra.final_cash,
      received: extra.received,
      penalty: extra.penalty,
      manual_in: extra.manual_in,
      manual_out: extra.manual_out,
      expenses: extra.expenses,
      new_loans: extra.new_loans,
      renewals: extra.renewals,
      lent: extra.lent,
      total_in: extra.total_in,
      total_out: extra.total_out,
      not_paid_count: extra.not_paid_count,
      events_count: extra.events_count,
      penalty_paid_today: penaltyPaidToday,
    },
    daily_summary: dailySummary
      ? {
          expectedToReceiveToday: dailySummary.expectedToReceiveToday,
          receivedToday: dailySummary.receivedToday,
          pendingToReceiveToday: dailySummary.pendingToReceiveToday,
          cashExpectedForClosing: dailySummary.cashExpectedForClosing,
        }
      : null,
    events,
    reversed_events: reversed,
    renewal_events: renewalEvents,
    client_names: clientNames,
    paid_groups: paidGroups,
    not_paid_marks: enrichedNp,
    new_loans: newLoans,
    expense_breakdown: expenseBreakdown,
  };
}

/**
 * Save a new snapshot version for the given closed daily_cash. Each call
 * creates a NEW row (version = last + 1). Old versions are preserved.
 * Returns the new version number.
 */
export async function saveDailyCashSnapshot(cashDate: string, payload: DailyCashSnapshotPayload): Promise<number> {
  const scope = await getCurrentDailyCashScope();
  // Locate the daily_cash id for this date/scope
  const { data: dcRow, error: dcErr } = await applyDailyCashScope(
    supabase.from("daily_cash").select("id, closed_at, closed_by").eq("cash_date", cashDate),
    scope
  ).maybeSingle();
  if (dcErr) throw dcErr;
  const dailyCashId = (dcRow as any)?.id;
  if (!dailyCashId) throw new Error("daily_cash não encontrado para snapshot");

  // Compute next version for this daily_cash_id
  const { data: last } = await supabase
    .from("daily_cash_snapshots" as any)
    .select("version")
    .eq("daily_cash_id", dailyCashId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextVersion = ((last as any)?.version || 0) + 1;

  // Look up latest reopen reason since the previous snapshot (from audit_logs).
  let reopenReason: string | null = null;
  if (nextVersion > 1) {
    try {
      const { data: reopenLogs } = await supabase
        .from("audit_logs")
        .select("new_value, created_at")
        .eq("action_type", "reabrir_caixa")
        .order("created_at", { ascending: false })
        .limit(10);
      const match = (reopenLogs || []).find((l: any) => (l?.new_value?.cash_date === cashDate));
      reopenReason = (match as any)?.new_value?.reason || null;
    } catch { reopenReason = null; }
  }

  const versionedPayload: DailyCashSnapshotPayload = { ...payload, reopen_reason: reopenReason };

  const row = {
    daily_cash_id: dailyCashId,
    cash_date: cashDate,
    worker_id: scope.worker_id,
    admin_id: scope.admin_id,
    closed_at: payload.closed_at,
    closed_by: payload.closed_by.id,
    version: nextVersion,
    reopen_reason: reopenReason,
    payload: versionedPayload as any,
  };

  const { error } = await supabase
    .from("daily_cash_snapshots" as any)
    .insert(row as any);
  if (error) throw error;
  return nextVersion;
}

/**
 * Load the LATEST snapshot version for a given closed day, if any. Returns
 * null when no snapshot exists (e.g. day closed before this feature shipped).
 */
export async function loadDailyCashSnapshot(cashDate: string): Promise<DailyCashSnapshotPayload | null> {
  const scope = await getCurrentDailyCashScope();
  let q: any = supabase.from("daily_cash_snapshots" as any)
    .select("payload, version")
    .eq("cash_date", cashDate);
  if (scope.worker_id) q = q.eq("worker_id", scope.worker_id);
  else if (scope.admin_id) q = q.eq("admin_id", scope.admin_id).is("worker_id", null);
  const { data, error } = await q.order("version", { ascending: false }).limit(1).maybeSingle();
  if (error) {
    console.warn("[daily-snapshot] load failed", error);
    return null;
  }
  if (!data) return null;
  return (data as any).payload as DailyCashSnapshotPayload;
}

/**
 * List all snapshot versions for a given closed day (ordered newest → oldest).
 */
export async function listDailyCashSnapshotVersions(cashDate: string): Promise<DailyCashSnapshotVersion[]> {
  const scope = await getCurrentDailyCashScope();
  let q: any = supabase.from("daily_cash_snapshots" as any)
    .select("id, daily_cash_id, version, closed_at, closed_by, reopen_reason, payload, created_at")
    .eq("cash_date", cashDate);
  if (scope.worker_id) q = q.eq("worker_id", scope.worker_id);
  else if (scope.admin_id) q = q.eq("admin_id", scope.admin_id).is("worker_id", null);
  const { data, error } = await q.order("version", { ascending: false });
  if (error) {
    console.warn("[daily-snapshot] list versions failed", error);
    return [];
  }
  return ((data as any[]) || []) as DailyCashSnapshotVersion[];
}
