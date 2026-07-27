import { supabase } from "@/integrations/supabase/client";
import { format, differenceInCalendarDays } from "date-fns";
import { ptBR } from "date-fns/locale";
import { formatCurrency, getPaymentTypeLabel } from "@/lib/loan-utils";
import { DailyEvent, getEventTypeLabel } from "@/lib/daily-events";
import { INSTALLMENT_COLLECTIBLE_STATUSES, LOAN_ACTIVE_STATUSES } from "@/lib/status-constants";

/**
 * Camada de DETALHAMENTO dos relatórios (somente leitura).
 * Nunca altera cálculos financeiros, saldos, parcelas ou registros.
 * Apenas lê dados já existentes (daily_events, audit_logs, loans, installments,
 * loan_renegotiations, not_paid_marks) e monta linhas de exibição.
 */

export type DetailLine = { label: string; value: string };

export type ReportRecord = {
  id: string;
  kind: string;
  createdAt: string | null;
  time: string;
  clientName: string;
  workerName: string;
  title: string;
  summary: string;
  amountIn: number;
  amountOut: number;
  reversed: boolean;
  details: DetailLine[];
};

const nn = (v: any) => (v == null || v === "" ? null : v);
const money = (v: any) => formatCurrency(Number(v || 0));
const dt = (v: any) => (v ? format(new Date(String(v).slice(0, 10) + "T12:00:00"), "dd/MM/yyyy") : null);
const dtHour = (v: any) => (v ? format(new Date(v), "dd/MM/yyyy HH:mm") : null);

function push(lines: DetailLine[], label: string, value: string | number | null | undefined) {
  if (value == null || value === "" || value === "—") return;
  lines.push({ label, value: String(value) });
}

const INTERVAL_LABEL: Record<string, string> = {
  daily: "1 dia entre cobranças",
  weekly: "7 dias entre cobranças",
  biweekly: "15 dias entre cobranças",
  monthly: "1 mês entre cobranças",
  fixed_dates: "Datas fixas definidas no contrato",
};

const LOAN_STATUS_LABEL: Record<string, string> = {
  open: "Em dia",
  overdue: "Atrasado",
  paid: "Quitado",
  renegotiated: "Renegociado",
  renewed: "Renovado",
  cancelled: "Cancelado",
};

type Inst = {
  id: string; loan_id: string; number: number; amount: number;
  due_date: string; status: string; paid_at: string | null; paid_amount: number | null;
};

type Loan = any;

export type ReportDetailsData = {
  recordFor: (event: DailyEvent) => ReportRecord;
  /** Clientes previstos para o dia sem nenhuma ação registrada. */
  pendentesByDate: Record<string, ReportRecord[]>;
  /** Clientes com parcela vencida ainda em aberto (situação na data de referência). */
  atrasados: ReportRecord[];
  /** Pendentes/atrasados por trabalhador (relatórios consolidados). */
  pendentesByWorker: Record<string, number>;
  atrasadosByWorker: Record<string, number>;
};

const EMPTY: ReportDetailsData = {
  recordFor: () => ({
    id: "", kind: "", createdAt: null, time: "", clientName: "—", workerName: "—",
    title: "", summary: "", amountIn: 0, amountOut: 0, reversed: false, details: [],
  }),
  pendentesByDate: {},
  atrasados: [],
  pendentesByWorker: {},
  atrasadosByWorker: {},
};

export function emptyReportDetails(): ReportDetailsData {
  return EMPTY;
}

export async function fetchReportDetails(opts: {
  events: DailyEvent[];
  startDate: string;
  endDate: string;
  /** Escopo: um trabalhador, uma lista de trabalhadores ou um administrador. */
  workerId?: string | null;
  workerIds?: string[] | null;
  adminId?: string | null;
  /** Data de referência para dias em atraso (default: endDate). */
  referenceDate?: string;
}): Promise<ReportDetailsData> {
  const { events, startDate, endDate } = opts;
  const today = format(new Date(), "yyyy-MM-dd");
  const requestedReferenceDate = opts.referenceDate || endDate;
  const referenceDate = requestedReferenceDate > today ? today : requestedReferenceDate;

  const loanIds = Array.from(new Set(events.map((e) => e.loan_id).filter(Boolean) as string[]));

  // ---- Empréstimos e parcelas dos registros do período
  const loanMap: Record<string, Loan> = {};
  const instByLoan: Record<string, Inst[]> = {};
  if (loanIds.length) {
    const [{ data: loans }, { data: insts }] = await Promise.all([
      supabase.from("loans").select("*").in("id", loanIds),
      supabase.from("installments")
        .select("id, loan_id, number, amount, due_date, status, paid_at, paid_amount")
        .in("loan_id", loanIds).order("number", { ascending: true }),
    ]);
    (loans || []).forEach((l: any) => { loanMap[l.id] = l; });
    ((insts as any[]) || []).forEach((i: any) => {
      (instByLoan[i.loan_id] ||= []).push(i as Inst);
    });
  }

  // ---- Auditoria de pagamentos (saldo antes/depois já registrados)
  const auditByEvent: Record<string, any> = {};
  {
    const { data: audits } = await supabase.from("audit_logs")
      .select("action_type, old_value, new_value, created_at, observation")
      .in("action_type", ["pagamento", "pagamento_parcial", "quitar_emprestimo"])
      .gte("created_at", `${startDate}T00:00:00`)
      .lte("created_at", `${endDate}T23:59:59`)
      .limit(2000);
    (audits || []).forEach((a: any) => {
      const evId = a.new_value?.daily_event_id;
      if (evId) auditByEvent[evId] = a;
    });
  }

  // ---- Renovações / renegociações
  const renegByNew: Record<string, any> = {};
  const renegByOriginal: Record<string, any> = {};
  if (loanIds.length) {
    const { data: rows } = await supabase.from("loan_renegotiations").select("*")
      .or(`new_loan_id.in.(${loanIds.join(",")}),original_loan_id.in.(${loanIds.join(",")})`);
    (rows || []).forEach((r: any) => {
      if (r.new_loan_id) renegByNew[r.new_loan_id] = r;
      if (r.original_loan_id) renegByOriginal[r.original_loan_id] = r;
    });
  }

  // ---- Nomes de clientes e trabalhadores
  const clientIds = new Set<string>();
  events.forEach((e) => e.client_id && clientIds.add(e.client_id));
  Object.values(loanMap).forEach((l: any) => l?.client_id && clientIds.add(l.client_id));

  // ---- Parcelas em aberto no escopo (pendentes e atrasados)
  const collectible = INSTALLMENT_COLLECTIBLE_STATUSES as readonly string[];
  const activeLoanStatuses = [...LOAN_ACTIVE_STATUSES];
  let openQ: any = supabase.from("installments")
    .select("id, loan_id, number, amount, due_date, status, paid_amount, is_penalty, loans!inner(id, client_id, worker_id, admin_id, status, remaining_balance, installment_count, payment_type, total_amount, first_due_date, clients!inner(archived_at))")
    .in("status", collectible as string[])
    .lte("due_date", referenceDate)
    .eq("is_penalty", false)
    .in("loans.status", activeLoanStatuses)
    .gt("loans.remaining_balance", 0.01)
    .is("loans.clients.archived_at", null)
    .limit(2000);

  if (opts.workerId) openQ = openQ.eq("loans.worker_id", opts.workerId);
  else if (opts.workerIds && opts.workerIds.length) openQ = openQ.in("loans.worker_id", opts.workerIds);
  else if (opts.adminId) openQ = openQ.eq("loans.admin_id", opts.adminId);
  const { data: openInstRaw } = await openQ;
  const openInsts: any[] = (openInstRaw as any[]) || [];
  openInsts.forEach((i) => i.loans?.client_id && clientIds.add(i.loans.client_id));

  // Parcelas de todos os empréstimos envolvidos nos pendentes/atrasados (contagens)
  const extraLoanIds = Array.from(
    new Set(openInsts.map((i) => i.loan_id).filter((id) => !instByLoan[id])),
  );
  if (extraLoanIds.length) {
    const { data: insts } = await supabase.from("installments")
      .select("id, loan_id, number, amount, due_date, status, paid_at, paid_amount")
      .in("loan_id", extraLoanIds).order("number", { ascending: true });
    ((insts as any[]) || []).forEach((i: any) => { (instByLoan[i.loan_id] ||= []).push(i as Inst); });
  }

  // Marcas de "não pagou" no período (para não listar como pendente)
  const { data: npRows } = await supabase.from("not_paid_marks")
    .select("installment_id, mark_date, loan_id")
    .gte("mark_date", startDate).lte("mark_date", endDate).limit(3000);
  const notPaidKeys = new Set(
    ((npRows as any[]) || []).map((r) => `${r.installment_id}|${r.mark_date}`),
  );

  const clientNames: Record<string, string> = {};
  if (clientIds.size) {
    const { data: cs } = await supabase.from("clients").select("id, name")
      .in("id", Array.from(clientIds));
    (cs || []).forEach((c: any) => { clientNames[c.id] = c.name; });
  }

  const workerIdSet = new Set<string>();
  events.forEach((e) => e.worker_id && workerIdSet.add(e.worker_id));
  openInsts.forEach((i) => i.loans?.worker_id && workerIdSet.add(i.loans.worker_id));
  const workerNames: Record<string, string> = {};
  if (workerIdSet.size) {
    const { data: ws } = await supabase.from("workers").select("id, nome")
      .in("id", Array.from(workerIdSet));
    (ws || []).forEach((w: any) => { workerNames[w.id] = w.nome; });
  }

  const cName = (id: string | null | undefined) => (id ? clientNames[id] || "—" : "—");
  const wName = (id: string | null | undefined) => (id ? workerNames[id] || "—" : "—");

  // ---------- helpers de parcelas ----------
  const instStats = (loanId: string | null | undefined) => {
    const list = loanId ? instByLoan[loanId] || [] : [];
    const active = list.filter((i) => i.status !== "cancelled" && i.status !== "renegotiated");
    const paid = active.filter((i) => i.status === "paid");
    const pending = active.filter((i) => collectible.includes(i.status));
    const next = pending.slice().sort((a, b) => a.due_date.localeCompare(b.due_date))[0] || null;
    const lastPaid = paid
      .filter((i) => i.paid_at)
      .sort((a, b) => String(b.paid_at).localeCompare(String(a.paid_at)))[0] || null;
    return { list, active, paid, pending, next, lastPaid };
  };

  const paidUntil = (loanId: string | null | undefined, iso: string) => {
    const list = loanId ? instByLoan[loanId] || [] : [];
    return list.filter((i) => i.status === "paid" && i.paid_at && String(i.paid_at) <= iso).length;
  };

  // ---------- construtor de registro ----------
  const recordFor = (e: DailyEvent): ReportRecord => {
    const loan = e.loan_id ? loanMap[e.loan_id] : null;
    const st = instStats(e.loan_id);
    const meta = (e.metadata || {}) as any;
    const details: DetailLine[] = [];
    const clientName = cName(e.client_id || loan?.client_id);
    const workerName = wName(e.worker_id);
    const amountIn = Number(e.amount_in || 0);
    const amountOut = Number(e.amount_out || 0);
    let title = getEventTypeLabel(e.event_type);
    let summary = "";

    const totalInst = Number(loan?.installment_count || st.active.length || 0) || null;
    const instOfEvent = e.installment_id ? st.list.find((i) => i.id === e.installment_id) : null;
    const instAmount = instOfEvent?.amount ?? st.next?.amount ?? (loan && totalInst ? Number(loan.total_amount) / totalInst : null);

    if (e.event_type === "pagamento" || e.event_type === "recebimento_multa") {
      const audit = auditByEvent[e.id];
      const before = audit?.old_value?.remaining_balance;
      const after = audit?.new_value?.remaining_balance;
      const snapStatus = audit?.new_value?.loan_snapshot?.status;
      const paidBefore = paidUntil(e.loan_id, e.created_at) - 0;
      // parcelas cobertas: diferença entre pagas até o instante do pagamento e antes dele
      const paidAfter = st.paid.filter((i) => i.paid_at && String(i.paid_at) <= e.created_at).length;
      const paidBeforeCount = st.paid.filter((i) => i.paid_at && String(i.paid_at) < e.created_at).length;
      const covered = Math.max(0, paidAfter - paidBeforeCount);
      const restantes = totalInst != null ? Math.max(0, totalInst - paidAfter) : null;
      const isQuit = after != null && Number(after) <= 0.01;
      const isPartial = !isQuit && instAmount != null && amountIn + 0.01 < Number(instAmount);
      const tipo = isQuit ? "Quitação" : isPartial ? "Pagamento parcial" : "Parcela completa";
      title = e.event_type === "recebimento_multa" ? "Multa recebida" : tipo;

      push(details, "Cliente", clientName);
      push(details, "Data e hora", dtHour(e.created_at));
      push(details, "Valor recebido", money(amountIn));
      push(details, "Tipo do pagamento", tipo);
      push(details, "Situação do empréstimo antes", snapStatus ? LOAN_STATUS_LABEL[snapStatus] || snapStatus : null);
      if (before != null) push(details, "Saldo devedor antes", money(before));
      if (after != null) push(details, "Saldo devedor depois", money(after));
      push(details, "Total de parcelas", totalInst);
      push(details, "Parcelas pagas antes", paidBeforeCount);
      if (covered > 0) push(details, "Parcelas pagas com este recebimento", covered);
      push(details, "Parcelas pagas depois", paidAfter);
      push(details, "Parcelas restantes", restantes);
      if (instAmount != null) push(details, "Valor da parcela", money(instAmount));
      if (st.next && instAmount != null && Math.abs(Number(st.next.amount) - Number(instAmount)) > 0.01) {
        push(details, "Novo valor da parcela", money(st.next.amount));
      }
      push(details, "Número da parcela paga", instOfEvent ? `${instOfEvent.number}${totalInst ? ` de ${totalInst}` : ""}` : null);
      push(details, "Próxima data de pagamento", dt(st.next?.due_date));
      push(details, "Forma de pagamento", nn(meta.payment_method));
      push(details, "Observação", nn(e.observation));

      const partes: string[] = [];
      if (before != null && totalInst) partes.push(`Antes: ${paidBeforeCount} de ${totalInst} parcelas pagas${instAmount != null ? `, parcela de ${money(instAmount)}` : ""} e saldo de ${money(before)}.`);
      partes.push(`Pagamento: ${money(amountIn)}${covered > 0 ? `, correspondente a ${covered} parcela(s)` : ""}.`);
      if (after != null && totalInst) partes.push(`Depois: ${paidAfter} de ${totalInst} parcelas pagas, ${restantes} restantes, saldo de ${money(after)}${st.next ? ` e próxima cobrança em ${dt(st.next.due_date)}` : ""}.`);
      summary = partes.join(" ");
      return rec(e, { title, summary, details, clientName, workerName, amountIn, amountOut });
    }

    if (e.event_type === "emprestimo_novo" || e.event_type === "emprestimo_importado") {
      const lastDue = st.active.slice().sort((a, b) => a.due_date.localeCompare(b.due_date)).slice(-1)[0];
      const juros = loan
        ? (loan.interest_type === "percentage" ? `${Number(loan.interest_value)}%` : money(loan.interest_value))
        : null;
      title = e.event_type === "emprestimo_importado" ? "Empréstimo em andamento (importado)" : "Novo empréstimo";
      push(details, "Cliente", clientName);
      push(details, "Data de criação", dt(loan?.loan_date) || dtHour(e.created_at));
      push(details, "Valor emprestado", money(loan?.amount ?? meta.released_amount ?? amountOut));
      push(details, "Valor total a receber", money(loan?.total_amount ?? meta.total_amount));
      push(details, "Juros/acréscimo", juros);
      push(details, "Tipo de cobrança", loan ? getPaymentTypeLabel(loan.payment_type, loan.first_due_date) : null);
      push(details, "Intervalo entre cobranças", loan ? INTERVAL_LABEL[loan.payment_type] : null);
      push(details, "Total de parcelas", totalInst);
      push(details, "Valor de cada parcela", instAmount != null ? money(instAmount) : null);
      push(details, "Primeira parcela", dt(loan?.first_due_date ?? meta.first_due_date));
      push(details, "Última parcela prevista", dt(lastDue?.due_date));
      if (loan?.payment_type === "monthly") {
        push(details, "Dia do pagamento", dt(loan?.first_due_date)?.slice(0, 2));
      }
      push(details, "Parcelas já pagas", st.paid.length);
      push(details, "Parcelas restantes", st.pending.length);
      push(details, "Saldo devedor atual", loan ? money(loan.remaining_balance) : null);
      push(details, "Próxima data de pagamento", dt(st.next?.due_date));
      push(details, "Status", loanStatusLabel(loan, st.next?.due_date, referenceDate));
      push(details, "Observações", nn(loan?.observation) || nn(e.observation));
      summary = [
        money(loan?.amount ?? amountOut),
        totalInst ? `${totalInst}x${instAmount != null ? ` de ${money(instAmount)}` : ""}` : null,
        loan ? getPaymentTypeLabel(loan.payment_type, loan.first_due_date) : null,
        st.next ? `próxima em ${dt(st.next.due_date)}` : null,
      ].filter(Boolean).join(" · ");
      return rec(e, { title, summary, details, clientName, workerName, amountIn, amountOut });
    }

    if (e.event_type === "renovacao" || e.event_type === "renegociacao" || e.event_type === "renovacao_absorvida") {
      const r = (e.loan_id && (renegByNew[e.loan_id] || renegByOriginal[e.loan_id])) || null;
      const isReneg = e.event_type === "renegociacao" || r?.type === "renegotiation";
      title = isReneg ? "Renegociação" : "Renovação";
      const newLoan = r?.new_loan_id ? loanMap[r.new_loan_id] || loan : loan;
      const newInst = instStats(newLoan?.id);
      const newInstAmount = newInst.list[0]?.amount
        ?? (newLoan?.total_amount && newLoan?.installment_count ? Number(newLoan.total_amount) / Number(newLoan.installment_count) : null);

      push(details, "Cliente", clientName);
      push(details, `Data da ${isReneg ? "renegociação" : "renovação"}`, dtHour(e.created_at));
      // Antes
      push(details, "Contrato anterior", r?.original_loan_id ? `ID ${String(r.original_loan_id).slice(0, 8)}` : null);
      push(details, "Antes — situação", r ? "Contrato encerrado por " + (isReneg ? "renegociação" : "renovação") : null);
      push(details, "Antes — saldo devedor", r ? money(r.original_remaining_balance) : null);
      push(details, "Antes — total do contrato", r ? money(r.original_total_amount) : null);
      push(details, "Antes — parcelas do contrato", r?.original_installment_count);
      push(details, "Antes — valor da parcela", r?.original_total_amount && r?.original_installment_count
        ? money(Number(r.original_total_amount) / Number(r.original_installment_count)) : null);
      push(details, "Antes — frequência", r?.original_payment_type ? getPaymentTypeLabel(r.original_payment_type) : null);
      push(details, "Valor quitado pelo cliente", r ? money(r.client_paid_amount) : null);
      push(details, "Valor absorvido no novo contrato", r ? money(r.absorbed_from_new) : null);
      push(details, "Valor adicional liberado", r ? money(r.released_to_client) : null);
      // Depois
      push(details, "Depois — novo valor emprestado", r ? money(r.new_amount) : (newLoan ? money(newLoan.amount) : null));
      push(details, "Depois — novo total a receber", r ? money(r.new_total_amount) : (newLoan ? money(newLoan.total_amount) : null));
      push(details, "Depois — parcelas", r?.new_installment_count ?? newLoan?.installment_count);
      push(details, "Depois — valor da parcela", newInstAmount != null ? money(newInstAmount) : null);
      push(details, "Depois — frequência", (r?.new_payment_type || newLoan?.payment_type)
        ? getPaymentTypeLabel(r?.new_payment_type || newLoan?.payment_type, newLoan?.first_due_date) : null);
      push(details, "Depois — primeira parcela", dt(newLoan?.first_due_date));
      push(details, "Depois — próxima data de pagamento", dt(newInst.next?.due_date));
      push(details, "Depois — saldo devedor atual", newLoan ? money(newLoan.remaining_balance) : null);
      push(details, "Motivo/observação", nn(r?.reason) || nn(e.observation));
      summary = [
        r ? `Saldo anterior ${money(r.original_remaining_balance)}` : null,
        r ? `novo contrato ${money(r.new_amount)}` : null,
        r?.new_installment_count ? `${r.new_installment_count}x` : null,
        r && Number(r.released_to_client) > 0 ? `adicional ${money(r.released_to_client)}` : null,
      ].filter(Boolean).join(" · ") || nn(e.observation) || title;
      return rec(e, { title, summary, details, clientName, workerName, amountIn, amountOut });
    }

    if (e.event_type === "nao_pagou") {
      title = "Não pagou";
      const inst = instOfEvent || st.next;
      const dias = inst ? Math.max(0, differenceInCalendarDays(new Date(e.cash_date + "T12:00:00"), new Date(inst.due_date + "T12:00:00"))) : null;
      push(details, "Cliente", clientName);
      push(details, "Data do registro", dtHour(e.created_at));
      push(details, "Parcela", inst && totalInst ? `Parcela ${inst.number} de ${totalInst}` : inst ? `Parcela ${inst.number}` : null);
      push(details, "Valor esperado", inst ? money(inst.amount) : null);
      push(details, "Vencimento", dt(inst?.due_date));
      if (dias != null) push(details, "Dias em atraso", `${dias} dia${dias === 1 ? "" : "s"} em atraso`);
      push(details, "Parcelas pagas", st.paid.length);
      push(details, "Parcelas restantes", st.pending.length);
      push(details, "Saldo devedor", loan ? money(loan.remaining_balance) : null);
      push(details, "Trabalhador responsável", workerName);
      push(details, "Observação", nn(e.observation));
      summary = [
        inst && totalInst ? `Parcela ${inst.number} de ${totalInst}` : null,
        inst ? money(inst.amount) : null,
        inst ? `vencida em ${dt(inst.due_date)}` : null,
      ].filter(Boolean).join(" · ") || (nn(e.observation) ?? "");
      return rec(e, { title, summary, details, clientName, workerName, amountIn, amountOut });
    }

    if (e.event_type === "despesa") {
      title = "Despesa";
      push(details, "Data e hora", dtHour(e.created_at));
      push(details, "Valor", money(amountOut));
      push(details, "Categoria/descrição", nn(e.observation));
      push(details, "Trabalhador responsável", workerName);
      summary = `${money(amountOut)}${e.observation ? ` · ${e.observation}` : ""}`;
      return rec(e, { title, summary, details, clientName, workerName, amountIn, amountOut });
    }

    // Genérico (entradas/saídas manuais, estornos, ajustes, cancelamentos)
    push(details, "Data e hora", dtHour(e.created_at));
    if (amountIn > 0) push(details, "Entrada", money(amountIn));
    if (amountOut > 0) push(details, "Saída", money(amountOut));
    push(details, "Cliente", e.client_id ? clientName : null);
    push(details, "Trabalhador responsável", workerName);
    push(details, "Observação", nn(e.observation));
    if (e.reversed_at) push(details, "Estornado em", dtHour(e.reversed_at));
    summary = [amountIn > 0 ? `+ ${money(amountIn)}` : null, amountOut > 0 ? `- ${money(amountOut)}` : null, nn(e.observation)]
      .filter(Boolean).join(" · ");
    return rec(e, { title, summary, details, clientName, workerName, amountIn, amountOut });
  };

  function rec(e: DailyEvent, p: {
    title: string; summary: string; details: DetailLine[];
    clientName: string; workerName: string; amountIn: number; amountOut: number;
  }): ReportRecord {
    return {
      id: e.id,
      kind: e.event_type,
      createdAt: e.created_at,
      time: format(new Date(e.created_at), "HH:mm"),
      clientName: p.clientName,
      workerName: p.workerName,
      title: p.title,
      summary: p.summary,
      amountIn: p.amountIn,
      amountOut: p.amountOut,
      reversed: !!e.reversed_at,
      details: p.details,
    };
  }

  // ---------- Pendentes de registro e atrasados ----------
  const eventInstKeys = new Set<string>();
  const eventLoanKeys = new Set<string>();
  events.forEach((e) => {
    if (e.reversed_at) return;
    if (e.installment_id) eventInstKeys.add(`${e.installment_id}|${e.cash_date}`);
    if (e.loan_id) eventLoanKeys.add(`${e.loan_id}|${e.cash_date}`);
  });

  const pendentesByDate: Record<string, ReportRecord[]> = {};
  const atrasados: ReportRecord[] = [];
  const pendentesByWorker: Record<string, number> = {};
  const atrasadosByWorker: Record<string, number> = {};
  type OverdueGroup = {
    clientId: string; workerId: string | null; adminId: string | null;
    clientName: string; workerName: string;
    insts: { i: any; l: any; due: string; diasAtraso: number }[];
    loanIds: Set<string>;
  };
  const overdueGroups: Record<string, OverdueGroup> = {};


  openInsts.forEach((i) => {
    const l = i.loans;
    if (!l) return;
    const pendingAmount = Math.max(Number(i.amount || 0) - Number(i.paid_amount || 0), 0);
    if (pendingAmount <= 0.01) return;
    const st = instStats(i.loan_id);
    const totalI = Number(l.installment_count || st.active.length || 0) || null;
    const clientName = cName(l.client_id);
    const workerName = wName(l.worker_id);
    const due = String(i.due_date);
    const diasAtraso = Math.max(0, differenceInCalendarDays(
      new Date(referenceDate + "T12:00:00"), new Date(due + "T12:00:00"),
    ));
    const base: DetailLine[] = [];
    push(base, "Cliente", clientName);
    push(base, "Valor esperado da parcela", money(i.amount));
    push(base, "Valor pendente da parcela", money(pendingAmount));
    push(base, "Data prevista para cobrança", dt(due));
    push(base, "Parcela", totalI ? `Parcela ${i.number} de ${totalI}` : `Parcela ${i.number}`);
    push(base, "Total de parcelas", totalI);
    push(base, "Parcelas pagas", st.paid.length);
    push(base, "Parcelas restantes", st.pending.length);
    push(base, "Valor atual da parcela", money(i.amount));
    push(base, "Saldo devedor", money(l.remaining_balance));
    push(base, "Frequência de cobrança", l.payment_type ? getPaymentTypeLabel(l.payment_type, l.first_due_date) : null);
    push(base, "Trabalhador responsável", workerName);

    const isPendingDay = due >= startDate && due <= endDate
      && !eventInstKeys.has(`${i.id}|${due}`)
      && !eventLoanKeys.has(`${i.loan_id}|${due}`)
      && !notPaidKeys.has(`${i.id}|${due}`);

    if (isPendingDay) {
      const details = [...base];
      if (diasAtraso > 0) push(details, "Dias em atraso", `${diasAtraso} dia${diasAtraso === 1 ? "" : "s"} em atraso`);
      push(details, "Status", "Pendente de registro");
      (pendentesByDate[due] ||= []).push({
        id: `pend-${i.id}-${due}`,
        kind: "pendente",
        createdAt: null,
        time: "—",
        clientName,
        workerName,
        title: "Pendente de registro",
        summary: `${totalI ? `Parcela ${i.number} de ${totalI}` : `Parcela ${i.number}`} · ${money(i.amount)} · prevista em ${dt(due)}${diasAtraso > 0 ? ` · ${diasAtraso} dia(s) em atraso` : ""}`,
        amountIn: 0,
        amountOut: 0,
        reversed: false,
        details,
      });
      if (l.worker_id) pendentesByWorker[l.worker_id] = (pendentesByWorker[l.worker_id] || 0) + 1;
    }

    if (diasAtraso > 0) {
      if (!l.client_id) return;
      const key = `${l.worker_id || "-"}|${l.client_id}`;
      const g = (overdueGroups[key] ||= {
        clientId: l.client_id, workerId: l.worker_id || null, adminId: l.admin_id || null,
        clientName, workerName, insts: [], loanIds: new Set<string>(),
      });
      g.insts.push({ i, l, due, diasAtraso });
      g.loanIds.add(String(i.loan_id));
    }
  });

  // ---- Um único registro por CLIENTE atrasado (nunca por parcela)
  Object.values(overdueGroups).forEach((g) => {
    const oldest = g.insts.slice().sort((a, b) => a.due.localeCompare(b.due))[0];
    const diasAtraso = oldest.diasAtraso;
    const valorVencido = g.insts.reduce(
      (s, x) => s + Math.max(0, Number(x.i.amount || 0) - Number(x.i.paid_amount || 0)), 0,
    );
    const loanIds = Array.from(g.loanIds);
    const saldoDevedor = loanIds.reduce((s, id) => {
      const li = g.insts.find((x) => String(x.i.loan_id) === id);
      return s + Number(li?.l?.remaining_balance || 0);
    }, 0);
    let totalParcelas = 0, pagas = 0, restantes = 0;
    let lastPaid: Inst | null = null;
    let next: Inst | null = null;
    loanIds.forEach((id) => {
      const st = instStats(id);
      const li = g.insts.find((x) => String(x.i.loan_id) === id);
      totalParcelas += Number(li?.l?.installment_count || st.active.length || 0);
      pagas += st.paid.length;
      restantes += st.pending.length;
      if (st.lastPaid && (!lastPaid || String(st.lastPaid.paid_at) > String(lastPaid.paid_at))) lastPaid = st.lastPaid;
      if (st.next && (!next || st.next.due_date < next.due_date)) next = st.next;
    });
    const lp: Inst | null = lastPaid;
    const nx: Inst | null = next;

    const details: DetailLine[] = [];
    push(details, "Cliente", g.clientName);
    push(details, "Trabalhador responsável", g.workerName);
    push(details, "Parcelas vencidas", g.insts.length);
    push(details, "Total de parcelas", totalParcelas || null);
    push(details, "Parcelas pagas", pagas);
    push(details, "Parcelas restantes", restantes);
    push(details, "Valor total vencido", money(valorVencido));
    push(details, "Saldo devedor total", money(saldoDevedor));
    push(details, "Vencimento mais antigo", dt(oldest.due));
    push(details, "Dias em atraso", `${diasAtraso} dia${diasAtraso === 1 ? "" : "s"} em atraso`);
    if (loanIds.length > 1) push(details, "Empréstimos atrasados", loanIds.length);
    push(details, "Último pagamento", lp?.paid_at ? dtHour(lp.paid_at) : "Nenhum pagamento registrado");
    if (lp) {
      push(details, "Última parcela paga", `Parcela ${lp.number}`);
      push(details, "Valor da última parcela paga", money(lp.paid_amount ?? lp.amount));
    }
    push(details, "Próxima parcela prevista", nx ? dt(nx.due_date) : null);

    g.insts
      .slice()
      .sort((a, b) => a.due.localeCompare(b.due))
      .forEach((x, idx) => {
        const pago = Number(x.i.paid_amount || 0);
        const pend = Math.max(0, Number(x.i.amount || 0) - pago);
        const emp = loanIds.length > 1 ? ` · Empréstimo ${loanIds.indexOf(String(x.i.loan_id)) + 1}` : "";
        push(
          details,
          `Parcela vencida ${idx + 1}`,
          `Nº ${x.i.number}${emp} · venc. ${dt(x.due)} · ${x.diasAtraso} dia${x.diasAtraso === 1 ? "" : "s"} · ${money(x.i.amount)}${pago > 0 ? ` · pago ${money(pago)}` : ""} · pendente ${money(pend)}`,
        );
      });

    atrasados.push({
      id: `atr-${g.clientId}-${g.workerId || "-"}`,
      kind: "atrasado",
      createdAt: null,
      time: "—",
      clientName: g.clientName,
      workerName: g.workerName,
      title: `${diasAtraso} dia${diasAtraso === 1 ? "" : "s"} em atraso`,
      summary: `${g.insts.length} parcela${g.insts.length === 1 ? "" : "s"} vencida${g.insts.length === 1 ? "" : "s"}${loanIds.length > 1 ? ` · ${loanIds.length} empréstimos atrasados` : ""} · atraso mais antigo de ${diasAtraso} dia${diasAtraso === 1 ? "" : "s"} · ${money(valorVencido)} vencidos · ${lp?.paid_at ? `última parcela paga em ${dt(lp.paid_at)}` : "nenhum pagamento registrado"}`,
      amountIn: 0,
      amountOut: 0,
      reversed: false,
      details,
    });
    if (g.workerId) atrasadosByWorker[g.workerId] = (atrasadosByWorker[g.workerId] || 0) + 1;
  });

  atrasados.sort((a, b) => b.title.localeCompare(a.title, "pt-BR", { numeric: true }));

  return { recordFor, pendentesByDate, atrasados, pendentesByWorker, atrasadosByWorker };
}


function loanStatusLabel(loan: any, nextDue: string | undefined, referenceDate: string): string | null {
  if (!loan) return null;
  if (loan.status === "paid") return "Quitado";
  if (loan.status === "renegotiated") return "Renegociado";
  if (loan.status === "cancelled") return "Cancelado";
  if (loan.renewed_from_loan_id && loan.status !== "open" && loan.status !== "overdue") return "Renovado";
  if (!nextDue) return LOAN_STATUS_LABEL[loan.status] || loan.status;
  if (nextDue === referenceDate) return "Vence hoje";
  if (nextDue < referenceDate) return "Atrasado";
  return "Em dia";
}

/** Rótulo de período em português (uso em cabeçalhos e PDF). */
export function periodTextLabel(startDate: string, endDate: string): string {
  const f = (d: string) => format(new Date(d + "T12:00:00"), "dd/MM/yyyy");
  return startDate === endDate
    ? format(new Date(endDate + "T12:00:00"), "dd 'de' MMMM 'de' yyyy", { locale: ptBR })
    : `${f(startDate)} — ${f(endDate)}`;
}
