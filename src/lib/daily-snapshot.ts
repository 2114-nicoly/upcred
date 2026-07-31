import { supabase } from "@/integrations/supabase/client";
import { getCurrentDailyCashScope, applyDailyCashScope, type ExplicitScope } from "@/lib/cash-utils";
import { DailyEvent } from "@/lib/daily-events";
import { getCurrentActorIdentity } from "@/lib/audit-utils";
import { formatProgress, formatDelta, installmentAmountOf, loanProgressAt } from "@/lib/progress-utils";

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
export const DAILY_SNAPSHOT_VERSION = 2;

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

/** v2 — pendente no fechamento (cliente que ficou sem nenhuma ação no dia). */
export type SnapshotPendingInstallment = {
  installment_id: string;
  loan_id: string;
  client_id: string | null;
  client_name: string;
  worker_id: string | null;
  worker_name: string | null;
  installment_number: number;
  total_installments: number;
  installment_amount: number;
  paid_amount: number;
  pending_amount: number;
  due_date: string;
  overdue_days: number;
  loan_remaining_balance: number;
  progress_at_close: string;
  status: "Pendente no fechamento";
};

/** v2 — atraso congelado na data do fechamento. */
export type SnapshotOverdueClient = {
  client_id: string;
  client_name: string;
  worker_id: string | null;
  worker_name: string | null;
  overdue_installments_count: number;
  overdue_total: number;
  oldest_due_date: string;
  overdue_days: number;
  loan_remaining_balance: number;
  last_payment: { date: string | null; amount: number | null } | null;
  installments: Array<{
    installment_id: string;
    loan_id: string;
    number: number;
    amount: number;
    paid_amount: number;
    pending_amount: number;
    due_date: string;
    overdue_days: number;
  }>;
};

/** v2 — situação da carteira ao final do dia. */
export type SnapshotPortfolioState = {
  available_cash: number;
  saldo_na_rua: number;
  clientes_ativos: number;
  emprestimos_ativos: number;
  clientes_atrasados: number;
  valor_atrasado: number;
  parcelas_vencidas: number;
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
    receivedFromExpected?: number;
    pendingToReceiveToday: number;
    overdueAmount?: number;
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
  /** v2 — opcionais para manter leitura compatível com snapshots v1. */
  pending_installments?: SnapshotPendingInstallment[];
  overdue_clients?: SnapshotOverdueClient[];
  portfolio_state?: SnapshotPortfolioState | null;
  scope_names?: { worker_name: string | null; admin_name: string | null };
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

// Progresso: MESMA função usada no pagamento e na Rota.
const daysBetween = (fromISO: string, toISO: string) => {
  const a = new Date(fromISO + "T12:00:00").getTime();
  const b = new Date(toISO + "T12:00:00").getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
};

/** Nomes congelados do escopo (trabalhador / empresa-administrador). */
async function loadScopeNames(scope: { worker_id: string | null; admin_id: string | null }) {
  let workerName: string | null = null;
  let adminName: string | null = null;
  try {
    if (scope.worker_id) {
      const { data } = await supabase.from("workers").select("nome").eq("id", scope.worker_id).maybeSingle();
      workerName = (data as any)?.nome ?? null;
    }
    if (scope.admin_id) {
      const { data } = await supabase.from("admins").select("nome").eq("id", scope.admin_id).maybeSingle();
      adminName = (data as any)?.nome ?? null;
    }
  } catch { /* nomes são informativos */ }
  return { worker_name: workerName, admin_name: adminName };
}


export type SnapshotScope = { worker_id: string | null; admin_id: string | null };

/**
 * Isolamento OBRIGATÓRIO do snapshot. Não depende da RLS:
 * - caixa de trabalhador: worker_id = scope.worker_id (+ admin_id quando existir)
 * - caixa próprio do administrador: worker_id IS NULL + admin_id = scope.admin_id
 */
function applyStrictScope(query: any, scope: SnapshotScope): any {
  let q = query;
  if (scope.worker_id) {
    q = q.eq("worker_id", scope.worker_id);
    if (scope.admin_id) q = q.eq("admin_id", scope.admin_id);
    return q;
  }
  q = q.is("worker_id", null);
  if (scope.admin_id) q = q.eq("admin_id", scope.admin_id);
  else q = q.is("admin_id", null);
  return q;
}

/** Verdadeiro quando a linha pertence exatamente ao escopo do caixa. */
function inScope(row: any, scope: SnapshotScope): boolean {
  const w = row?.worker_id ?? null;
  const a = row?.admin_id ?? null;
  if (scope.worker_id) {
    if (w !== scope.worker_id) return false;
  } else if (w !== null) return false;
  if (scope.admin_id && a !== null && a !== scope.admin_id) return false;
  if (!scope.admin_id && scope.worker_id === null && a !== null) return false;
  return true;
}

const OUT_OF_SCOPE_MESSAGE =
  "Foram encontrados dados fora do escopo deste caixa. O fechamento foi cancelado.";

function assertAllInScope(rows: any[] | null | undefined, scope: SnapshotScope, label: string) {
  for (const r of rows || []) {
    if (!inScope(r, scope)) {
      console.error(`[daily-snapshot] registro fora do escopo em ${label}`, { id: r?.id, scope });
      throw new Error(OUT_OF_SCOPE_MESSAGE);
    }
  }
}

async function fetchScopedEvents(cashDate: string, scope: SnapshotScope, includeReversed: boolean) {
  let q: any = supabase.from("daily_events" as any).select("*").eq("cash_date", cashDate);
  q = applyStrictScope(q, scope);
  if (!includeReversed) q = q.is("reversed_at", null);
  const { data, error } = await q.order("created_at", { ascending: false });
  if (error) throw error;
  return ((data as unknown as DailyEvent[]) || []);
}


export const SNAPSHOT_INCOMPLETE_MESSAGE =
  "Não foi possível congelar todas as informações. O caixa continua aberto.";

async function loadDailyCollectionSummary(cashDate: string, scope: { worker_id: string | null; admin_id: string | null }) {
  const { getDailyCollectionSummary } = await import("@/lib/daily-totals");
  return await getDailyCollectionSummary(cashDate, {
    workerId: scope.worker_id || null,
    adminId: scope.admin_id || null,
  });
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
    fetchScopedEvents(cashDate, scope, false),
    fetchScopedEvents(cashDate, scope, true),
    applyStrictScope(supabase.from("not_paid_marks").select("*").eq("mark_date", cashDate), scope),
    applyStrictScope(
      supabase.from("loans")
        .select("id, worker_id, admin_id, amount, total_amount, remaining_balance, status, installment_count, payment_type, loan_date, renewed_from_loan_id, clients:client_id(id, name)")
        .eq("loan_date", cashDate),
      scope,
    ),
    applyStrictScope(
      supabase.from("cash_movements")
        .select("id, worker_id, admin_id, loan_id, installment_id, amount, created_at")
        .eq("cash_date", cashDate)
        .eq("type", "recebimento_normal")
        .is("reversed_at", null),
      scope,
    ),
    applyStrictScope(
      supabase.from("cash_movements")
        .select("amount, worker_id, admin_id")
        .eq("cash_date", cashDate)
        .eq("type", "recebimento_multa")
        .is("reversed_at", null),
      scope,
    ),
  ]);


  const events = (liveEvents || []) as DailyEvent[];
  const reversed = ((allEventsIncReversed || []) as DailyEvent[]).filter(e => e.reversed_at != null);
  const renewalEvents = events.filter(e => e.event_type === "renovacao");

  assertAllInScope(events, scope, "daily_events");
  assertAllInScope(reversed, scope, "daily_events (estornados)");
  assertAllInScope((npRes.data as any[]) || [], scope, "not_paid_marks");
  assertAllInScope((newLoansRes.data as any[]) || [], scope, "loans do dia");
  assertAllInScope((paidMovesRes.data as any[]) || [], scope, "cash_movements (pagamentos)");
  assertAllInScope((penaltyMovesRes.data as any[]) || [], scope, "cash_movements (multas)");

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
  // 1) Fonte primária: metadata VERDADEIRO gravado no momento do pagamento.
  //    Nunca reconstruímos um pagamento antigo a partir do remaining_balance atual.
  const paymentEvents = events
    .filter(e => e.event_type === "pagamento" && e.loan_id)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const loansWithMetadata = new Set<string>();
  for (const ev of paymentEvents) {
    const md: any = ev.metadata || null;
    if (!md || md.remaining_balance_before == null || md.remaining_balance_after == null) continue;
    loansWithMetadata.add(ev.loan_id!);
    const totalAmount = Number(md.total_amount ?? (Number(md.installment_amount || 0) * Number(md.total_installments || 0)));
    const instCount = Number(md.total_installments || 0);
    const instAmount = Number(md.installment_amount || (instCount > 0 ? totalAmount / instCount : 0));
    const remainingBefore = Number(md.remaining_balance_before);
    const remainingAfter = Number(md.remaining_balance_after);
    const paidBefore = Math.max(0, totalAmount - remainingBefore);
    const paidAfter = Math.max(0, totalAmount - remainingAfter);
    paidGroups.push({
      movementId: ev.cash_movement_id || "",
      clientName: (ev.client_id && clientNames[ev.client_id]) || "Cliente",
      clientId: ev.client_id || "",
      loanId: ev.loan_id!,
      totalPaid: Number(md.payment_amount ?? ev.amount_in),
      accumulatedPaid: paidAfter,
      remainingBalance: remainingAfter,
      instAmount,
      installmentIds: ((md.affected_installments || []) as any[]).map(a => a.installment_id).filter(Boolean),
      totalAmount,
      installmentCount: instCount,
      paidBefore,
      paidAfter,
      remainingBefore,
      remainingAfter,
      progressBeforeFormatted: md.installment_progress_before || formatProgress(paidBefore, instAmount, instCount),
      progressAfterFormatted: md.installment_progress_after || formatProgress(paidAfter, instAmount, instCount),
      progressDeltaFormatted: formatDelta(paidAfter - paidBefore, instAmount),
    });
  }

  // 2) Compatibilidade: pagamentos antigos sem metadata continuam sendo
  //    reconstruídos pela sequência de movimentações do dia.
  const legacyLoanIds = [...paidLoanIds].filter(id => !loansWithMetadata.has(id));
  if (legacyLoanIds.length > 0) {
    const { data: paidLoansData } = await supabase
      .from("loans")
      .select("id, client_id, amount, total_amount, remaining_balance, installment_count, payment_type, clients:client_id(id, name)")
      .in("id", legacyLoanIds);
    for (const loan of ((paidLoansData as any[]) || [])) {
      const totalAmount = Number(loan.total_amount);
      const instCount = Number(loan.installment_count);
      const instAmount = installmentAmountOf(loan);
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

  // ===== v2: pendentes, atrasados, carteira e nomes do escopo =====
  // Loans "tratados" hoje: qualquer ação válida registrada no dia.
  const ACTION_TYPES = new Set([
    "pagamento", "recebimento_multa", "nao_pagou", "renovacao",
    "renegociacao", "quitacao", "emprestimo_novo",
  ]);
  const treatedLoanIds = new Set<string>();
  for (const ev of events) if (ev.loan_id && ACTION_TYPES.has(ev.event_type)) treatedLoanIds.add(ev.loan_id);
  for (const m of npMarks) if (m.loan_id) treatedLoanIds.add(m.loan_id);

  const scopeNames = await loadScopeNames(scope);
  let pendingInstallments: SnapshotPendingInstallment[] = [];
  let overdueClients: SnapshotOverdueClient[] = [];
  let portfolioState: SnapshotPortfolioState | null = null;
  try {
    const loansQ = applyStrictScope(
      supabase.from("loans")
        .select("id, client_id, worker_id, admin_id, total_amount, remaining_balance, installment_count, status, is_imported_ongoing, initial_remaining_balance, amount_already_paid, clients:client_id(id, name)")
        .in("status", ["open", "overdue"]),
      scope,
    );
    const { data: activeLoansData } = await loansQ;
    assertAllInScope((activeLoansData as any[]) || [], scope, "empréstimos ativos");
    const activeLoans = ((activeLoansData as any[]) || []).filter(l => Number(l.remaining_balance) > 0.01);
    const loanById = new Map<string, any>(activeLoans.map(l => [l.id, l]));


    let instRows: any[] = [];
    if (activeLoans.length > 0) {
      const { data } = await supabase
        .from("installments")
        .select("id, loan_id, number, amount, paid_amount, due_date, status, is_penalty")
        .in("loan_id", activeLoans.map(l => l.id))
        .eq("is_penalty", false)
        .in("status", ["pending", "partial", "overdue"])
        .order("number");
      instRows = (data as any[]) || [];
    }

    // --- Pendentes no fechamento: parcela mais antiga vencida/para hoje,
    //     de empréstimo SEM nenhuma ação registrada no dia.
    const firstDueByLoan = new Map<string, any>();
    for (const i of instRows) {
      if (i.due_date > cashDate) continue;
      const prev = firstDueByLoan.get(i.loan_id);
      if (!prev || Number(i.number) < Number(prev.number)) firstDueByLoan.set(i.loan_id, i);
    }
    for (const [loanId, inst] of firstDueByLoan) {
      if (treatedLoanIds.has(loanId)) continue;
      const loan = loanById.get(loanId);
      if (!loan) continue;
      const progress = loanProgressAt(loan, Number(loan.remaining_balance));
      pendingInstallments.push({
        installment_id: inst.id,
        loan_id: loanId,
        client_id: loan.client_id ?? null,
        client_name: loan.clients?.name || clientNames[loan.client_id] || "Cliente",
        worker_id: loan.worker_id ?? null,
        worker_name: scopeNames.worker_name,
        installment_number: Number(inst.number),
        total_installments: Number(loan.installment_count),
        installment_amount: Number(inst.amount),
        paid_amount: Number(inst.paid_amount || 0),
        pending_amount: Math.max(0, Number(inst.amount) - Number(inst.paid_amount || 0)),
        due_date: inst.due_date,
        overdue_days: inst.due_date < cashDate ? daysBetween(inst.due_date, cashDate) : 0,
        loan_remaining_balance: Number(loan.remaining_balance),
        progress_at_close: progress.formatted,
        status: "Pendente no fechamento",
      });
    }
    pendingInstallments.sort((a, b) => a.due_date.localeCompare(b.due_date));

    // --- Clientes atrasados congelados na data do fechamento
    const overdueByClient = new Map<string, SnapshotOverdueClient>();
    let overdueInstCount = 0;
    let overdueTotal = 0;
    for (const i of instRows) {
      if (!(i.due_date < cashDate)) continue;
      const loan = loanById.get(i.loan_id);
      if (!loan) continue;
      const pending = Math.max(0, Number(i.amount) - Number(i.paid_amount || 0));
      if (pending <= 0.01) continue;
      overdueInstCount += 1;
      overdueTotal += pending;
      const key = `${loan.worker_id ?? "null"}|${loan.client_id ?? "null"}`;
      let entry = overdueByClient.get(key);
      if (!entry) {
        entry = {
          client_id: loan.client_id,
          client_name: loan.clients?.name || clientNames[loan.client_id] || "Cliente",
          worker_id: loan.worker_id ?? null,
          worker_name: scopeNames.worker_name,
          overdue_installments_count: 0,
          overdue_total: 0,
          oldest_due_date: i.due_date,
          overdue_days: 0,
          loan_remaining_balance: 0,
          last_payment: null,
          installments: [],
        };
        overdueByClient.set(key, entry);
      }
      entry.overdue_installments_count += 1;
      entry.overdue_total += pending;
      if (i.due_date < entry.oldest_due_date) entry.oldest_due_date = i.due_date;
      entry.overdue_days = daysBetween(entry.oldest_due_date, cashDate);
      entry.loan_remaining_balance += 0; // somado abaixo por empréstimo único
      entry.installments.push({
        installment_id: i.id,
        loan_id: i.loan_id,
        number: Number(i.number),
        amount: Number(i.amount),
        paid_amount: Number(i.paid_amount || 0),
        pending_amount: pending,
        due_date: i.due_date,
        overdue_days: daysBetween(i.due_date, cashDate),
      });
    }
    // saldo devedor por cliente (empréstimos únicos) + último pagamento conhecido
    for (const entry of overdueByClient.values()) {
      const loanIds = [...new Set(entry.installments.map(i => i.loan_id))];
      entry.loan_remaining_balance = loanIds.reduce(
        (s, id) => s + Number(loanById.get(id)?.remaining_balance || 0), 0,
      );
    }
    if (overdueByClient.size > 0) {
      const clientIdList = [...new Set([...overdueByClient.values()].map(e => e.client_id))].filter(Boolean);
      const { data: lastPays } = await applyStrictScope(
        supabase
          .from("cash_movements")
          .select("client_id, amount, cash_date, worker_id, admin_id")
          .in("client_id", clientIdList)
          .eq("type", "recebimento_normal")
          .is("reversed_at", null)
          .lte("cash_date", cashDate),
        scope,
      )
        .order("cash_date", { ascending: false })
        .limit(500);

      const seen = new Map<string, { date: string; amount: number }>();
      for (const p of ((lastPays as any[]) || [])) {
        if (!p.client_id || seen.has(p.client_id)) continue;
        seen.set(p.client_id, { date: p.cash_date, amount: Number(p.amount) });
      }
      for (const entry of overdueByClient.values()) {
        const lp = seen.get(entry.client_id);
        entry.last_payment = lp ? { date: lp.date, amount: lp.amount } : null;
      }
    }
    overdueClients = [...overdueByClient.values()].sort((a, b) => b.overdue_days - a.overdue_days);

    // --- Situação da carteira ao final do dia (obrigatória)
    const { getCashBalance } = await import("@/lib/cash-utils");
    const cb = await getCashBalance({
      workerId: scope.worker_id,
      adminId: scope.admin_id,
    } as any);
    const availableCash = Number((cb as any)?.available_cash || 0);

    portfolioState = {
      available_cash: availableCash,
      saldo_na_rua: activeLoans.reduce((s, l) => s + Number(l.remaining_balance || 0), 0),
      clientes_ativos: new Set(activeLoans.map(l => l.client_id).filter(Boolean)).size,
      emprestimos_ativos: activeLoans.length,
      clientes_atrasados: overdueClients.length,
      valor_atrasado: Number(overdueTotal.toFixed(2)),
      parcelas_vencidas: overdueInstCount,
    };
  } catch (err) {
    if (err instanceof Error && err.message === OUT_OF_SCOPE_MESSAGE) throw err;
    console.error("[daily-snapshot] falha ao congelar seções obrigatórias", err);
    throw new Error(SNAPSHOT_INCOMPLETE_MESSAGE);
  }


  // ===== Validação final de isolamento (nada fora do escopo) =====
  assertAllInScope(events, scope, "daily_events");
  assertAllInScope(reversed, scope, "daily_events (estornados)");
  assertAllInScope(npMarks, scope, "not_paid_marks");
  assertAllInScope(newLoans as any[], scope, "loans do dia");
  assertAllInScope(paidMovements as any[], scope, "cash_movements");

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
          receivedFromExpected: dailySummary.receivedFromExpected,
          pendingToReceiveToday: dailySummary.pendingToReceiveToday,
          overdueAmount: dailySummary.overdueAmount,
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
    pending_installments: pendingInstallments,
    overdue_clients: overdueClients,
    portfolio_state: portfolioState,
    scope_names: scopeNames,

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
export async function loadDailyCashSnapshot(cashDate: string, explicit?: ExplicitScope): Promise<DailyCashSnapshotPayload | null> {
  const scope = await getCurrentDailyCashScope(explicit);
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
export async function listDailyCashSnapshotVersions(cashDate: string, explicit?: ExplicitScope): Promise<DailyCashSnapshotVersion[]> {
  const scope = await getCurrentDailyCashScope(explicit);
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
