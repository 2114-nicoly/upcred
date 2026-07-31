import { supabase } from "@/integrations/supabase/client";
import { format, differenceInCalendarDays } from "date-fns";
import { formatCurrency } from "@/lib/loan-utils";
import { DailyEvent } from "@/lib/daily-events";
import { computeCoreTotals } from "@/lib/finance-totals";
import { computeDailyTotals } from "@/lib/daily-totals";
import {
  type DailyCashSnapshotPayload,
  type SnapshotOverdueClient,
  type SnapshotPendingInstallment,
  type SnapshotPortfolioState,
} from "@/lib/daily-snapshot";
import {
  fetchReportDetails, emptyReportDetails,
  type ReportDetailsData, type ReportRecord, type DetailLine,
} from "@/lib/report-details";

/**
 * FONTE HISTÓRICA ÚNICA DOS RELATÓRIOS (Trabalhador, Administrador, SuperAdmin).
 *
 * Regra central: o relatório deve mostrar exatamente o que foi registrado no dia.
 * - Dia FECHADO  → lê somente o snapshot oficial (`daily_cash_snapshots`).
 *                  Nada é recalculado a partir das tabelas vivas.
 * - Dia ABERTO   → lê os dados atuais (ainda podem mudar).
 * - Pagamentos   → detalhes vêm do metadata gravado no momento do pagamento.
 * - Pendentes/atrasados de um dia fechado → snapshot v2.
 * - Período longo → soma dia a dia (caixa inicial do 1º dia, final do último).
 */

export type FrozenSource = "snapshot" | "live" | "incomplete";

export type FrozenDayTotals = {
  opening: number;
  finalCash: number;
  counted: number | null;
  expected: number | null;
  diff: number | null;
  received: number;
  penalties: number;
  receivedTotal: number;
  lent: number;
  manualIn: number;
  manualOut: number;
  expenses: number;
  estornos: number;
  estornosCount: number;
  notPaidCount: number;
  eventsCount: number;
};

export type FrozenDay = {
  date: string;
  workerId: string | null;
  workerName: string;
  adminId: string | null;
  /** Origem dos dados exibidos para o dia. */
  source: FrozenSource;
  status: "closed" | "open" | "none";
  reopened: boolean;
  snapshotVersion: number | null;
  /** Snapshot v1 (sem pendentes/atrasados congelados). */
  incompleteSnapshot: boolean;
  totals: FrozenDayTotals;
  events: DailyEvent[];
  pendentes: ReportRecord[];
  atrasados: ReportRecord[];
  portfolio: SnapshotPortfolioState | null;
  closingObs: string | null;
};

export type FrozenPeriodTotals = FrozenDayTotals & {
  daysCount: number;
  closedDays: number;
  openDays: number;
};

export type FrozenReportPeriod = {
  startDate: string;
  endDate: string;
  days: FrozenDay[];               // mais recente → mais antigo
  totals: FrozenPeriodTotals;
  events: DailyEvent[];            // todos os eventos congelados do período
  pendentesByDate: Record<string, ReportRecord[]>;
  pendentesByWorker: Record<string, number>;
  atrasados: ReportRecord[];       // situação congelada do último dia com dado
  atrasadosByWorker: Record<string, number>;
  /** Detalhamento (recordFor) para montar linhas dos eventos. */
  details: ReportDetailsData;
  portfolio: SnapshotPortfolioState | null;
  warnings: string[];
};

const money = (v: any) => formatCurrency(Number(v || 0));
const dt = (v: any) => (v ? format(new Date(String(v).slice(0, 10) + "T12:00:00"), "dd/MM/yyyy") : null);

function emptyTotals(): FrozenDayTotals {
  return {
    opening: 0, finalCash: 0, counted: null, expected: null, diff: null,
    received: 0, penalties: 0, receivedTotal: 0, lent: 0,
    manualIn: 0, manualOut: 0, expenses: 0,
    estornos: 0, estornosCount: 0, notPaidCount: 0, eventsCount: 0,
  };
}

export function emptyFrozenPeriod(startDate = "", endDate = ""): FrozenReportPeriod {
  return {
    startDate, endDate, days: [],
    totals: { ...emptyTotals(), daysCount: 0, closedDays: 0, openDays: 0 },
    events: [], pendentesByDate: {}, pendentesByWorker: {},
    atrasados: [], atrasadosByWorker: {},
    details: emptyReportDetails(), portfolio: null, warnings: [],
  };
}

function push(lines: DetailLine[], label: string, value: string | number | null | undefined) {
  if (value == null || value === "" || value === "—") return;
  lines.push({ label, value: String(value) });
}

/** Pendente congelado (snapshot v2) → linha de relatório. */
export function pendingRecordFromSnapshot(p: SnapshotPendingInstallment, date: string): ReportRecord {
  const details: DetailLine[] = [];
  push(details, "Cliente", p.client_name);
  push(details, "Valor esperado da parcela", money(p.installment_amount));
  push(details, "Valor pendente", money(p.pending_amount));
  push(details, "Data prevista para cobrança", dt(p.due_date));
  push(details, "Parcela", `Parcela ${p.installment_number}${p.total_installments ? ` de ${p.total_installments}` : ""}`);
  push(details, "Progresso no fechamento", p.progress_at_close);
  push(details, "Saldo devedor", money(p.loan_remaining_balance));
  if (p.overdue_days > 0) push(details, "Dias em atraso", `${p.overdue_days} dia${p.overdue_days === 1 ? "" : "s"} em atraso`);
  push(details, "Trabalhador responsável", p.worker_name);
  push(details, "Status", p.status || "Pendente no fechamento");
  return {
    id: `snap-pend-${p.installment_id}-${date}`,
    kind: "pendente",
    createdAt: null,
    time: "—",
    clientName: p.client_name || "—",
    workerName: p.worker_name || "—",
    title: "Pendente no fechamento",
    summary: `Parcela ${p.installment_number}${p.total_installments ? ` de ${p.total_installments}` : ""} · ${money(p.installment_amount)} · prevista em ${dt(p.due_date)}${p.overdue_days > 0 ? ` · ${p.overdue_days} dia(s) em atraso` : ""}`,
    amountIn: 0, amountOut: 0, reversed: false, details,
  };
}

/** Atraso congelado (snapshot v2) → linha de relatório. */
export function overdueRecordFromSnapshot(o: SnapshotOverdueClient, date: string): ReportRecord {
  const details: DetailLine[] = [];
  push(details, "Cliente", o.client_name);
  push(details, "Trabalhador responsável", o.worker_name);
  push(details, "Parcelas vencidas", o.overdue_installments_count);
  push(details, "Valor total vencido", money(o.overdue_total));
  push(details, "Saldo devedor total", money(o.loan_remaining_balance));
  push(details, "Vencimento mais antigo", dt(o.oldest_due_date));
  push(details, "Dias em atraso", `${o.overdue_days} dia${o.overdue_days === 1 ? "" : "s"} em atraso`);
  push(details, "Último pagamento", o.last_payment?.date
    ? `${dt(o.last_payment.date)}${o.last_payment.amount != null ? ` · ${money(o.last_payment.amount)}` : ""}`
    : "Nenhum pagamento registrado");
  (o.installments || []).forEach((x, idx) => {
    push(details, `Parcela vencida ${idx + 1}`,
      `Nº ${x.number} · venc. ${dt(x.due_date)} · ${x.overdue_days} dia${x.overdue_days === 1 ? "" : "s"} · ${money(x.amount)}${Number(x.paid_amount) > 0 ? ` · pago ${money(x.paid_amount)}` : ""} · pendente ${money(x.pending_amount)}`);
  });
  push(details, "Situação congelada em", dt(date));
  return {
    id: `snap-atr-${o.client_id}-${date}`,
    kind: "atrasado",
    createdAt: null,
    time: "—",
    clientName: o.client_name || "—",
    workerName: o.worker_name || "—",
    title: `${o.overdue_days} dia${o.overdue_days === 1 ? "" : "s"} em atraso`,
    summary: `${o.overdue_installments_count} parcela(s) vencida(s) · ${money(o.overdue_total)} vencidos · mais antigo em ${dt(o.oldest_due_date)}${o.last_payment?.date ? ` · último pagamento em ${dt(o.last_payment.date)}` : " · nenhum pagamento registrado"}`,
    amountIn: 0, amountOut: 0, reversed: false, details,
  };
}

function totalsFromSnapshot(payload: DailyCashSnapshotPayload, cashRow: any): FrozenDayTotals {
  const t = payload.totals || ({} as any);
  const events = (payload.events || []) as DailyEvent[];
  const reversed = (payload.reversed_events || []) as DailyEvent[];
  const counted = cashRow?.counted_closing_balance != null
    ? Number(cashRow.counted_closing_balance)
    : (t.counted_cash != null ? Number(t.counted_cash) : null);
  const expected = cashRow?.expected_closing_balance != null
    ? Number(cashRow.expected_closing_balance)
    : (t.expected_worker_cash != null ? Number(t.expected_worker_cash) : null);
  return {
    opening: Number(t.opening_balance || 0),
    finalCash: Number(t.final_cash ?? counted ?? expected ?? 0),
    counted,
    expected,
    diff: cashRow?.closing_difference != null
      ? Number(cashRow.closing_difference)
      : (counted != null && expected != null ? counted - expected : null),
    received: Number(t.received || 0),
    penalties: Number(t.penalty || 0),
    receivedTotal: Number(t.received || 0) + Number(t.penalty || 0),
    lent: Number(t.lent || 0),
    manualIn: Number(t.manual_in || 0),
    manualOut: Number(t.manual_out || 0),
    expenses: Number(t.expenses || 0),
    estornos: reversed.reduce((s, e) => s + Number(e.amount_in || 0) + Number(e.amount_out || 0), 0),
    estornosCount: reversed.length,
    notPaidCount: Number(t.not_paid_count || 0),
    eventsCount: Number(t.events_count ?? events.length),
  };
}

function totalsFromEvents(events: DailyEvent[], cashRow: any): FrozenDayTotals {
  const core = computeCoreTotals(events as any);
  const t = computeDailyTotals(events as any, 0);
  const opening = cashRow ? Number(cashRow.opening_balance || 0) : 0;
  const counted = cashRow?.counted_closing_balance != null ? Number(cashRow.counted_closing_balance) : null;
  const expected = cashRow?.expected_closing_balance != null ? Number(cashRow.expected_closing_balance) : null;
  const previsto = opening + core.recebidoTotal + t.entradasManuais - core.emprestado - t.saidasManuais - t.despesas;
  const reversedEvents = events.filter((e) => e.reversed_at);
  return {
    opening,
    finalCash: counted ?? expected ?? previsto,
    counted,
    expected,
    diff: cashRow?.closing_difference != null
      ? Number(cashRow.closing_difference)
      : (counted != null && expected != null ? counted - expected : null),
    received: core.recebidoPrincipal,
    penalties: core.multasRecebidas,
    receivedTotal: core.recebidoTotal,
    lent: core.emprestado,
    manualIn: t.entradasManuais,
    manualOut: t.saidasManuais,
    expenses: t.despesas,
    estornos: reversedEvents.reduce((s, e) => s + Number(e.amount_in || 0) + Number(e.amount_out || 0), 0),
    estornosCount: reversedEvents.length,
    notPaidCount: t.naoPagos,
    eventsCount: events.filter((e) => !e.reversed_at).length,
  };
}

export type FrozenScope = {
  startDate: string;
  endDate: string;
  workerId?: string | null;
  workerIds?: string[] | null;
  adminId?: string | null;
};

/**
 * Carrega o período já congelado. Mesmo retorno para tela e PDF —
 * os relatórios nunca recalculam nada por conta própria.
 */
export async function loadFrozenReportPeriod(scope: FrozenScope): Promise<FrozenReportPeriod> {
  const { startDate, endDate } = scope;
  const workerIds = scope.workerId
    ? [scope.workerId]
    : (scope.workerIds && scope.workerIds.length ? scope.workerIds : null);

  const warnings: string[] = [];

  // ---- Caixas do período (escopo explícito)
  let cashQ: any = supabase.from("daily_cash").select("*")
    .gte("cash_date", startDate).lte("cash_date", endDate);
  if (workerIds) cashQ = cashQ.in("worker_id", workerIds);
  else if (scope.adminId) cashQ = cashQ.eq("admin_id", scope.adminId).is("worker_id", null);
  const { data: cashRaw, error: cashErr } = await cashQ;
  if (cashErr) throw cashErr;
  const cashRows = (cashRaw as any[]) || [];

  // ---- Eventos vivos (usados apenas para dias abertos / sem snapshot)
  let evQ: any = supabase.from("daily_events" as any).select("*")
    .gte("cash_date", startDate).lte("cash_date", endDate);
  if (workerIds) evQ = evQ.in("worker_id", workerIds);
  else if (scope.adminId) evQ = evQ.eq("admin_id", scope.adminId).is("worker_id", null);
  const { data: evRaw, error: evErr } = await evQ.order("created_at", { ascending: true });
  if (evErr) throw evErr;
  const liveEvents = ((evRaw as unknown as DailyEvent[]) || []);

  // ---- Snapshots oficiais dos dias fechados (última versão de cada caixa)
  const closedIds = cashRows.filter((c) => c.status === "closed").map((c) => c.id);
  const snapByCash = new Map<string, { version: number; payload: DailyCashSnapshotPayload }>();
  if (closedIds.length) {
    const { data: snaps, error: snapErr } = await supabase
      .from("daily_cash_snapshots" as any)
      .select("daily_cash_id, version, payload")
      .in("daily_cash_id", closedIds)
      .order("version", { ascending: true });
    if (snapErr) throw snapErr;
    ((snaps as any[]) || []).forEach((s) => {
      snapByCash.set(s.daily_cash_id, { version: Number(s.version || 1), payload: s.payload as DailyCashSnapshotPayload });
    });
  }

  // ---- Nomes de trabalhadores do escopo
  const workerNames: Record<string, string> = {};
  const wIds = Array.from(new Set([
    ...(workerIds || []),
    ...cashRows.map((c) => c.worker_id).filter(Boolean),
  ])) as string[];
  if (wIds.length) {
    const { data: ws } = await supabase.from("workers").select("id, nome").in("id", wIds);
    (ws || []).forEach((w: any) => { workerNames[w.id] = w.nome; });
  }

  // ---- Chaves (dia + trabalhador)
  type Key = string;
  const keyOf = (date: string, workerId: string | null) => `${date}|${workerId || "-"}`;
  const keys = new Map<Key, { date: string; workerId: string | null }>();
  cashRows.forEach((c) => keys.set(keyOf(c.cash_date, c.worker_id), { date: c.cash_date, workerId: c.worker_id }));
  liveEvents.forEach((e) => {
    const k = keyOf(String(e.cash_date), e.worker_id || null);
    if (!keys.has(k)) keys.set(k, { date: String(e.cash_date), workerId: e.worker_id || null });
  });

  // Dias que precisam de dados vivos (abertos ou fechados sem snapshot).
  const liveDates = new Set<string>();
  const liveWorkerIds = new Set<string>();
  keys.forEach(({ date, workerId }) => {
    const cash = cashRows.find((c) => c.cash_date === date && (c.worker_id || null) === workerId);
    const snap = cash ? snapByCash.get(cash.id) : undefined;
    const needsLive = !cash || cash.status !== "closed" || !snap
      || !(snap.payload?.pending_installments || snap.payload?.overdue_clients);
    if (needsLive) {
      liveDates.add(date);
      if (workerId) liveWorkerIds.add(workerId);
    }
  });

  // ---- Detalhamento (recordFor + pendentes/atrasados vivos apenas para dias não congelados)
  let details: ReportDetailsData = emptyReportDetails();
  try {
    details = await fetchReportDetails({
      events: liveEvents,
      startDate,
      endDate,
      workerId: scope.workerId || null,
      workerIds: scope.workerId ? null : (scope.workerIds || null),
      adminId: workerIds ? null : (scope.adminId || null),
    });
  } catch (err) {
    console.warn("[frozen-report] detalhamento indisponível", err);
    warnings.push("Detalhamento parcial: não foi possível carregar registros complementares.");
  }

  // ---- Monta cada dia
  const days: FrozenDay[] = [];
  keys.forEach(({ date, workerId }) => {
    const cash = cashRows.find((c) => c.cash_date === date && (c.worker_id || null) === workerId) || null;
    const snapEntry = cash ? snapByCash.get(cash.id) : undefined;
    const closed = cash?.status === "closed";
    const payload = closed ? snapEntry?.payload || null : null;

    let source: FrozenSource = closed ? (payload ? "snapshot" : "incomplete") : "live";
    const dayLive = liveEvents.filter(
      (e) => String(e.cash_date) === date && (e.worker_id || null) === workerId,
    );

    let events: DailyEvent[];
    let totals: FrozenDayTotals;
    let pendentes: ReportRecord[] = [];
    let atrasados: ReportRecord[] = [];
    let portfolio: SnapshotPortfolioState | null = null;
    let incompleteSnapshot = false;

    if (payload) {
      events = [...((payload.events || []) as DailyEvent[]), ...((payload.reversed_events || []) as DailyEvent[])];
      totals = totalsFromSnapshot(payload, cash);
      const snapPending = payload.pending_installments;
      const snapOverdue = payload.overdue_clients;
      if (snapPending || snapOverdue) {
        pendentes = (snapPending || []).map((p) => pendingRecordFromSnapshot(p, date));
        atrasados = (snapOverdue || []).map((o) => overdueRecordFromSnapshot(o, date));
      } else {
        // Snapshot v1: não congelou pendentes/atrasados. NUNCA completar com o
        // estado atual — o histórico só mostra o que foi realmente gravado.
        incompleteSnapshot = true;
        pendentes = [];
        atrasados = [];
        warnings.push(`Dia ${dt(date)}: este fechamento antigo não possui histórico congelado completo — pendentes e atrasados: informação histórica indisponível.`);
      }
      portfolio = payload.portfolio_state || null;
    } else {
      events = dayLive;
      totals = totalsFromEvents(dayLive, cash);
      if (closed) {
        // Dia fechado sem snapshot: apenas os eventos históricos gravados.
        incompleteSnapshot = true;
        pendentes = [];
        atrasados = [];
        warnings.push(`Dia ${dt(date)}: este fechamento antigo não possui histórico congelado completo — informação histórica indisponível para pendentes, atrasados e carteira.`);
      } else {
        pendentes = details.pendentesByDate[date] || [];
      }
    }


    days.push({
      date,
      workerId,
      workerName: workerId ? (workerNames[workerId] || payload?.scope_names?.worker_name || "—") : "—",
      adminId: cash?.admin_id || null,
      source,
      status: closed ? "closed" : cash ? "open" : "none",
      reopened: !!cash?.reopened_at,
      snapshotVersion: snapEntry?.version ?? null,
      incompleteSnapshot,
      totals,
      events,
      pendentes,
      atrasados,
      portfolio,
      closingObs: cash?.closing_note || payload?.observation || null,
    });
  });

  days.sort((a, b) => (a.date === b.date
    ? a.workerName.localeCompare(b.workerName)
    : b.date.localeCompare(a.date)));

  // ---- Totais do período: soma dia a dia.
  const totals: FrozenPeriodTotals = { ...emptyTotals(), daysCount: 0, closedDays: 0, openDays: 0 };
  const dates = Array.from(new Set(days.map((d) => d.date))).sort();
  totals.daysCount = dates.length;
  const firstDate = dates[0];
  const lastDate = dates[dates.length - 1];
  let diffSum = 0;
  let hasDiff = false;
  days.forEach((d) => {
    const t = d.totals;
    totals.received += t.received;
    totals.penalties += t.penalties;
    totals.receivedTotal += t.receivedTotal;
    totals.lent += t.lent;
    totals.manualIn += t.manualIn;
    totals.manualOut += t.manualOut;
    totals.expenses += t.expenses;
    totals.estornos += t.estornos;
    totals.estornosCount += t.estornosCount;
    totals.notPaidCount += t.notPaidCount;
    totals.eventsCount += t.eventsCount;
    if (t.diff != null) { diffSum += t.diff; hasDiff = true; }
    if (d.status === "closed") totals.closedDays += 1;
    else if (d.status === "open") totals.openDays += 1;
    // Caixa inicial = 1º dia do período; caixa final = último dia.
    if (d.date === firstDate) totals.opening += t.opening;
    if (d.date === lastDate) {
      totals.finalCash += t.finalCash;
      if (t.counted != null) totals.counted = (totals.counted || 0) + t.counted;
      if (t.expected != null) totals.expected = (totals.expected || 0) + t.expected;
    }
  });
  totals.diff = hasDiff ? diffSum : null;

  // ---- Pendentes e atrasados consolidados (congelados por dia)
  const pendentesByDate: Record<string, ReportRecord[]> = {};
  const pendentesByWorker: Record<string, number> = {};
  days.forEach((d) => {
    if (!d.pendentes.length) return;
    (pendentesByDate[d.date] ||= []).push(...d.pendentes);
    if (d.workerId) pendentesByWorker[d.workerId] = (pendentesByWorker[d.workerId] || 0) + d.pendentes.length;
  });

  // Atrasados: situação congelada do dia mais recente de cada trabalhador.
  const atrasados: ReportRecord[] = [];
  const atrasadosByWorker: Record<string, number> = {};
  const seenWorker = new Set<string>();
  days.forEach((d) => {
    const wk = d.workerId || "-";
    if (seenWorker.has(wk)) return;
    if (d.source === "snapshot" && d.atrasados.length === 0 && d.status !== "closed") return;
    if (d.source === "snapshot") {
      seenWorker.add(wk);
      atrasados.push(...d.atrasados);
      if (d.workerId) atrasadosByWorker[d.workerId] = d.atrasados.length;
    }
  });
  // Trabalhadores sem snapshot no período: situação atual (dia aberto).
  const liveAtrasados = details.atrasados.filter((r) => true);
  if (!atrasados.length) {
    atrasados.push(...liveAtrasados);
    Object.assign(atrasadosByWorker, details.atrasadosByWorker);
  } else {
    Object.entries(details.atrasadosByWorker).forEach(([wid, count]) => {
      if (seenWorker.has(wid)) return;
      atrasadosByWorker[wid] = count;
    });
    liveAtrasados.forEach((r) => {
      const wid = Object.keys(details.atrasadosByWorker).find((id) => workerNames[id] === r.workerName);
      if (wid && seenWorker.has(wid)) return;
      atrasados.push(r);
    });
  }

  const portfolio = days.find((d) => d.portfolio)?.portfolio || null;

  const allEvents = days.flatMap((d) => d.events)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

  return {
    startDate, endDate, days, totals, events: allEvents,
    pendentesByDate, pendentesByWorker,
    atrasados, atrasadosByWorker,
    details, portfolio,
    warnings: Array.from(new Set(warnings)),
  };
}

/** Rótulo curto da origem do dia (tela e PDF usam o mesmo texto). */
export function frozenSourceLabel(day: FrozenDay): string {
  if (day.source === "snapshot") return day.reopened ? "Reaberto e fechado (registro congelado)" : "Fechado (registro congelado)";
  if (day.source === "incomplete") return "Fechado (registro congelado indisponível)";
  return day.status === "open" ? "Caixa ainda aberto" : "Sem caixa";
}

/** Dias em atraso entre duas datas ISO (uso em rótulos congelados). */
export function overdueDaysBetween(dueISO: string, refISO: string): number {
  return Math.max(0, differenceInCalendarDays(
    new Date(refISO + "T12:00:00"), new Date(dueISO + "T12:00:00"),
  ));
}
