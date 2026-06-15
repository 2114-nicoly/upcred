import { supabase } from "@/integrations/supabase/client";
import { updateCashBalance, createCashMovement, linkCashMovementToDailyEvent, recalculateCashBalanceFromLedger, markCashMovementReversed } from "@/lib/cash-utils";
import { createDailyEvent, markDailyEventReversed } from "@/lib/daily-events";
import { formatCurrency } from "@/lib/loan-utils";
import { logAction } from "@/lib/audit-utils";
import {
  INSTALLMENT_LOCKED_STATUSES,
  INSTALLMENT_COLLECTIBLE_STATUSES,
  INSTALLMENT_STATUS,
  LOAN_STATUS,
  isLoanActive,
} from "@/lib/status-constants";


/**
 * Centralized payment functions - SINGLE SOURCE OF TRUTH
 * All screens MUST use these functions for payment operations.
 */

/**
 * Recalculate installment paid_amount/status based on the loan's remaining_balance.
 * This is the SINGLE SOURCE OF TRUTH for installment progress.
 * Normal loan: paidInsideApp = total_amount - remaining_balance.
 * Imported/ongoing loan: paidInsideApp = initial_remaining_balance - remaining_balance.
 */
export async function recalculateInstallments(loanId: string) {
  const { data: loan } = await supabase
    .from("loans")
    .select("total_amount, remaining_balance, is_imported_ongoing, initial_remaining_balance")
    .eq("id", loanId)
    .single();

  if (!loan) return;

  const paidBase = (loan as any).is_imported_ongoing
    ? Number((loan as any).initial_remaining_balance ?? loan.remaining_balance)
    : Number(loan.total_amount);
  const totalPaid = Math.max(0, paidBase - Number(loan.remaining_balance));
  const today = new Date().toISOString().split("T")[0];

  const { data: insts } = await supabase
    .from("installments")
    .select("*")
    .eq("loan_id", loanId)
    .eq("is_penalty", false)
    .order("number");

  if (!insts || insts.length === 0) return;

  let remaining = totalPaid;

  for (const inst of insts) {
    if ((INSTALLMENT_LOCKED_STATUSES as readonly string[]).includes(inst.status)) continue;
    const instAmount = Number(inst.amount);
    if (remaining >= instAmount - 0.01) {
      // Fully paid
      const newPaid = instAmount;
      const needsUpdate = Number(inst.paid_amount) !== newPaid || inst.status !== INSTALLMENT_STATUS.PAID;
      if (needsUpdate) {
        await supabase.from("installments").update({
          paid_amount: newPaid,
          status: INSTALLMENT_STATUS.PAID,
          paid_at: inst.paid_at || new Date().toISOString(),
        }).eq("id", inst.id);
      }
      remaining -= instAmount;
    } else if (remaining > 0.01) {
      // Partially paid: never mark as paid until paid_amount reaches amount.
      const newPaid = remaining;
      await supabase.from("installments").update({
        paid_amount: newPaid,
        status: "partial",
        paid_at: new Date().toISOString(),
      }).eq("id", inst.id);
      remaining = 0;
    } else {
      const isOverdue = inst.due_date < today;
      const newStatus = isOverdue ? "overdue" : "pending";
      if (Number(inst.paid_amount) !== 0 || inst.status !== newStatus || inst.paid_at) {
        await supabase.from("installments").update({
          paid_amount: 0,
          status: newStatus,
          paid_at: null,
        }).eq("id", inst.id);
      }
    }
  }
}

/**
 * Register a regular payment against a loan.
 * 1. Calls apply_loan_payment RPC (remaining_balance -= amount)
 * 2. Updates installment records (informational)
 * 3. Updates cash balance (interest/principal split)
 * 4. Creates cash movement
 * 5. Creates daily event
 */
export async function registerPayment(params: {
  loanId: string;
  amount: number;
  clientId: string;
  clientName: string;
  cashDate: string;
  origin: string;
  installmentId?: string;
  /** Starting installment number for overflow */
  startInstNumber?: number;
}) {
  const { loanId, amount, clientId, clientName, cashDate, origin, installmentId } = params;
  if (amount <= 0) return { applied: 0, newBalance: 0 };

  const { data: loanData } = await supabase
    .from("loans")
    .select("amount, total_amount, remaining_balance, status")
    .eq("id", loanId)
    .single();

  if (!loanData) throw new Error("Empréstimo não encontrado");
  if (!isLoanActive(loanData)) throw new Error("Empréstimo inativo não pode receber pagamento.");

  const applied = Math.min(amount, Math.max(0, Number(loanData.remaining_balance)));
  if (applied <= 0.01) return { applied: 0, newBalance: Number(loanData.remaining_balance) };

  // 1. Atomic RPC: update remaining_balance
  const { data: newBalance, error: rpcError } = await supabase.rpc("apply_loan_payment", {
    p_loan_id: loanId,
    p_amount: applied,
  });
  if (rpcError) throw rpcError;

  // 2. Cash balance: interest first, then principal
  if (loanData) {
    const loanInterest = Number(loanData.total_amount) - Number(loanData.amount);
    const totalPaidBefore = Math.max(0, Number(loanData.total_amount) - Number(loanData.remaining_balance));
    const interestRemaining = Math.max(0, loanInterest - totalPaidBefore);
    const toInterest = Math.min(applied, interestRemaining);
    const toPrincipal = applied - toInterest;

    await updateCashBalance({
      available_cash: applied,
      interest_receivable: -toInterest,
      money_lent: -toPrincipal,
    });
  }

  // 3. Linked cash movement + daily event
  const movement = await createCashMovement({
    type: "recebimento_normal",
    amount: applied,
    client_id: clientId,
    loan_id: loanId,
    installment_id: installmentId || null,
    observation: `Pagamento - ${clientName}`,
    cash_date: cashDate,
  }) as any;
  const event = await createDailyEvent({
    cash_date: cashDate,
    event_type: "pagamento",
    client_id: clientId,
    loan_id: loanId,
    installment_id: installmentId || null,
    amount_in: applied,
    observation: `Pagamento - ${clientName}`,
    origin,
    cash_movement_id: movement?.id || null,
  } as any) as any;
  if (movement?.id && event?.id) await linkCashMovementToDailyEvent(movement.id, event.id);

  // Recalculate installment distribution based on remaining_balance
  await recalculateInstallments(loanId);
  await recalculateCashBalanceFromLedger();

  await logAction(
    "pagamento",
    "payment",
    movement?.id ?? null,
    null,
    { loan_id: loanId, amount: applied, cash_date: cashDate, client_id: clientId },
    `Pagamento ${formatCurrency(applied)} - ${clientName}`,
  );

  return { applied, newBalance: Number(newBalance) };
}

/**
 * Register a penalty payment.
 */
export async function registerPenaltyPayment(params: {
  loanId: string;
  amount: number;
  clientId: string;
  clientName: string;
  cashDate: string;
  origin: string;
}) {
  const { loanId, amount, clientId, clientName, cashDate, origin } = params;
  if (amount <= 0) return;

  const { data: loanData } = await supabase
    .from("loans")
    .select("status, remaining_balance")
    .eq("id", loanId)
    .single();
  if (!loanData) throw new Error("Empréstimo não encontrado");
  if (!isLoanActive(loanData)) throw new Error("Empréstimo inativo não pode receber pagamento de multa.");

  const { data: penaltyInsts } = await supabase
    .from("installments")
    .select("*")
    .eq("loan_id", loanId)
    .eq("is_penalty", true);

  const penaltyInst = penaltyInsts?.[0];
  if (!penaltyInst) throw new Error("Nenhuma multa registrada para abater");

  const newPaid = Number(penaltyInst.paid_amount) + amount;
  const fullyPaid = newPaid >= Number(penaltyInst.amount) - 0.01;
  await supabase.from("installments").update({
    paid_amount: Math.min(newPaid, Number(penaltyInst.amount)),
    status: fullyPaid ? "paid" : newPaid > 0.01 ? "partial" : penaltyInst.status,
    paid_at: fullyPaid ? new Date(cashDate + "T12:00:00").toISOString() : penaltyInst.paid_at,
  }).eq("id", penaltyInst.id);

  await updateCashBalance({ available_cash: amount, penalty_receivable: -amount });
  const movement = await createCashMovement({
    type: "recebimento_multa",
    amount,
    client_id: clientId,
    loan_id: loanId,
    observation: `Pagamento de multa - ${clientName}`,
    cash_date: cashDate,
  }) as any;
  const event = await createDailyEvent({
    cash_date: cashDate,
    event_type: "recebimento_multa",
    client_id: clientId,
    loan_id: loanId,
    amount_in: amount,
    observation: `Multa - ${clientName}`,
    origin,
    cash_movement_id: movement?.id || null,
  } as any) as any;
  if (movement?.id && event?.id) await linkCashMovementToDailyEvent(movement.id, event.id);
  await recalculateCashBalanceFromLedger();
}

/**
 * Settle a loan in full (quitar).
 * Pays remaining_balance + any penalty balance.
 */
export async function settleLoan(params: {
  loanId: string;
  clientId: string;
  clientName: string;
  cashDate: string;
  origin: string;
  installmentId?: string;
}) {
  const { loanId, clientId, clientName, cashDate, origin, installmentId } = params;

  // Get real remaining balance
  const { data: loanData } = await supabase
    .from("loans")
    .select("remaining_balance, amount, total_amount, status")
    .eq("id", loanId)
    .single();

  if (!loanData) throw new Error("Empréstimo não encontrado");
  if (!isLoanActive(loanData)) throw new Error("Empréstimo inativo não pode ser quitado.");

  const realBalance = Number(loanData.remaining_balance);

  // Get all collectible installments (pending/partial/overdue) — never touch cancelled/renegotiated
  const { data: allUnpaid } = await supabase
    .from("installments")
    .select("*")
    .eq("loan_id", loanId)
    .in("status", INSTALLMENT_COLLECTIBLE_STATUSES as unknown as string[])
    .order("number");


  if (!allUnpaid || allUnpaid.length === 0) return { regularPaid: 0, penaltyPaid: 0 };

  const regularUnpaid = allUnpaid.filter((i: any) => !i.is_penalty);
  const penaltyUnpaid = allUnpaid.filter((i: any) => i.is_penalty);

  // Mark all regular installments as paid
  for (const i of regularUnpaid) {
    await supabase.from("installments").update({
      paid_amount: Number(i.amount),
      status: "paid",
      paid_at: new Date(cashDate + "T12:00:00").toISOString(),
    }).eq("id", i.id);
  }

  // Apply remaining balance via RPC
  if (realBalance > 0) {
    await supabase.rpc("apply_loan_payment", { p_loan_id: loanId, p_amount: realBalance });

    // Cash balance
    const loanInterest = Number(loanData.total_amount) - Number(loanData.amount);
    const { data: allInsts } = await supabase
      .from("installments")
      .select("paid_amount")
      .eq("loan_id", loanId)
      .eq("is_penalty", false);
    const totalPaidNow = (allInsts || []).reduce((s: number, i: any) => s + Number(i.paid_amount), 0);
    const totalPaidBefore = totalPaidNow - realBalance;
    const interestRemaining = Math.max(0, loanInterest - totalPaidBefore);
    const toInterest = Math.min(realBalance, interestRemaining);
    const toPrincipal = realBalance - toInterest;

    await updateCashBalance({
      available_cash: realBalance,
      interest_receivable: -toInterest,
      money_lent: -toPrincipal,
    });
    const movement = await createCashMovement({
      type: "recebimento_normal",
      amount: realBalance,
      client_id: clientId,
      loan_id: loanId,
      installment_id: installmentId || null,
      observation: `Quitação empréstimo - ${clientName}`,
      cash_date: cashDate,
    }) as any;
    const event = await createDailyEvent({
      cash_date: cashDate,
      event_type: "pagamento",
      client_id: clientId,
      loan_id: loanId,
      installment_id: installmentId || null,
      amount_in: realBalance,
      observation: `Quitação empréstimo - ${clientName}`,
      origin,
      cash_movement_id: movement?.id || null,
    } as any) as any;
    if (movement?.id && event?.id) await linkCashMovementToDailyEvent(movement.id, event.id);
  } else {
    // Balance already zero, just mark as paid
    await supabase.from("loans").update({ status: "paid" }).eq("id", loanId);
  }

  // Handle penalties
  let totalPenaltyPaying = 0;
  for (const i of penaltyUnpaid) {
    const rem = Number(i.amount) - Number(i.paid_amount);
    if (rem <= 0.01) continue;
    totalPenaltyPaying += rem;
    await supabase.from("installments").update({
      paid_amount: Number(i.amount),
      status: "paid",
      paid_at: new Date(cashDate + "T12:00:00").toISOString(),
    }).eq("id", i.id);
  }

  if (totalPenaltyPaying > 0) {
    await updateCashBalance({ available_cash: totalPenaltyPaying, penalty_receivable: -totalPenaltyPaying });
    const movement = await createCashMovement({
      type: "recebimento_multa",
      amount: totalPenaltyPaying,
      client_id: clientId,
      loan_id: loanId,
      observation: `Quitação multa - ${clientName}`,
      cash_date: cashDate,
    }) as any;
    const event = await createDailyEvent({
      cash_date: cashDate,
      event_type: "recebimento_multa",
      client_id: clientId,
      loan_id: loanId,
      amount_in: totalPenaltyPaying,
      observation: `Quitação multa - ${clientName}`,
      origin,
      cash_movement_id: movement?.id || null,
    } as any) as any;
    if (movement?.id && event?.id) await linkCashMovementToDailyEvent(movement.id, event.id);
  }

  await recalculateInstallments(loanId);
  await recalculateCashBalanceFromLedger();

  return { regularPaid: realBalance, penaltyPaid: totalPenaltyPaying };
}

/**
 * Reverse a payment for a loan on a specific date.
 * Uses reverse_loan_payment RPC to restore remaining_balance.
 */
export async function reversePayment(params: {
  movementId: string;
  reason?: string;
}) {
  const { movementId, reason } = params;

  const { data: movement, error } = await supabase
    .from("cash_movements")
    .select("id, type, amount, loan_id, client_id, cash_date, installment_id, daily_event_id")
    .eq("id", movementId)
    .single();

  if (error || !movement?.loan_id) throw new Error("Lançamento de pagamento não encontrado");
  const loanId = movement.loan_id;
  const totalReversed = Number(movement.amount);
  const cashDate = (movement as any).cash_date || new Date().toISOString().slice(0, 10);

  if (movement.type === "recebimento_normal" && totalReversed > 0) {
    await supabase.rpc("reverse_loan_payment", { p_loan_id: loanId, p_amount: totalReversed });
  } else if (movement.type === "recebimento_multa" && totalReversed > 0) {
    const { data: penaltyInsts } = await supabase
      .from("installments")
      .select("id, amount, paid_amount, due_date, paid_at")
      .eq("loan_id", loanId)
      .eq("is_penalty", true)
      .order("number");
    let remainingToReverse = totalReversed;
    for (const inst of (penaltyInsts || [])) {
      if (remainingToReverse <= 0.01) break;
      const currentPaid = Number(inst.paid_amount);
      const subtracting = Math.min(currentPaid, remainingToReverse);
      const newPaid = Math.max(0, currentPaid - subtracting);
      await supabase.from("installments").update({
        paid_amount: newPaid,
        status: newPaid >= Number(inst.amount) - 0.01 ? "paid" : newPaid > 0.01 ? "partial" : (inst.due_date < new Date().toISOString().split("T")[0] ? "overdue" : "pending"),
        paid_at: newPaid >= Number(inst.amount) - 0.01 ? inst.paid_at : null,
      }).eq("id", inst.id);
      remainingToReverse -= subtracting;
    }
  } else {
    throw new Error("Tipo de lançamento não pode ser desfeito automaticamente");
  }

  // AUDIT TRAIL: never delete. Mark original as reversed and create a counter-entry.
  await markCashMovementReversed(movementId);

  // Mark linked daily_event(s) as reversed
  const linkedEventIds = new Set<string>();
  if ((movement as any).daily_event_id) linkedEventIds.add((movement as any).daily_event_id);
  const { data: linkedEvents } = await (supabase.from("daily_events" as any)
    .select("id").eq("cash_movement_id", movementId) as any);
  for (const e of (linkedEvents || []) as any[]) linkedEventIds.add(e.id);
  for (const eid of linkedEventIds) await markDailyEventReversed(eid);

  const reasonSuffix = reason ? ` — Motivo: ${reason}` : "";
  // Counter-movement (negative)
  const reversalMovement = await createCashMovement({
    type: "estorno_pagamento",
    amount: -totalReversed,
    client_id: (movement as any).client_id || null,
    loan_id: loanId,
    installment_id: (movement as any).installment_id || null,
    observation: `Estorno de ${movement.type === "recebimento_multa" ? "multa" : "pagamento"}${reasonSuffix}`,
    cash_date: cashDate,
  }) as any;

  // Counter-event (amount_out = reversed value)
  const reversalEvent = await createDailyEvent({
    cash_date: cashDate,
    event_type: "estorno_pagamento" as any,
    client_id: (movement as any).client_id || null,
    loan_id: loanId,
    installment_id: (movement as any).installment_id || null,
    amount_in: 0,
    amount_out: totalReversed,
    observation: `Estorno de ${movement.type === "recebimento_multa" ? "multa" : "pagamento"}${reasonSuffix}`,
    origin: "estorno",
    cash_movement_id: reversalMovement?.id || null,
  } as any) as any;
  if (reversalMovement?.id && reversalEvent?.id) {
    await linkCashMovementToDailyEvent(reversalMovement.id, reversalEvent.id);
  }

  await recalculateCashBalanceFromLedger();
  await recalculateInstallments(loanId);

  await logAction(
    "desfazer_pagamento",
    "payment",
    movementId,
    { amount: totalReversed, loan_id: loanId },
    { reversed: true, reason: reason || null },
    reason ? `Pagamento estornado: ${reason}` : "Pagamento estornado",
  );

  return totalReversed;
}

/**
 * Edit a payment: reverse the old amount and apply the new amount.
 * Updates remaining_balance, installments, cash movements, and daily events.
 */
export async function editPayment(params: {
  loanId: string;
  clientId: string;
  clientName: string;
  cashDate: string;
  newAmount: number;
  origin: string;
  movementId: string;
}) {
  const { loanId, clientId, clientName, cashDate, newAmount, origin, movementId } = params;
  if (newAmount <= 0) throw new Error("Valor deve ser maior que zero");

  // Reverse only the selected financial movement, then create a fresh linked movement/event.
  await reversePayment({ movementId });

  const result = await registerPayment({
    loanId, amount: newAmount,
    clientId, clientName,
    cashDate, origin,
  });

  return result;
}

/**
 * Safely cancel a loan WITHOUT deleting financial history.
 * Split into small internal helpers; every step checks Supabase errors and
 * any failure throws (no fake success toast).
 *
 * For loan.is_imported_ongoing = true:
 *  - the original disbursement never moved cash, so it is NOT counter-entered;
 *  - only real payments received after creation are reversed.
 */
export async function cancelLoan(params: {
  loanId: string;
  reason?: string;
}) {
  const { loanId, reason } = params;
  const cancelDate = new Date().toISOString().slice(0, 10);

  const throwIfError = (step: string, error: unknown) => {
    if (!error) return;
    console.error(`[cancelLoan] ${step} failed`, error);
    const message = (error as any)?.message || "erro desconhecido";
    throw new Error(`${step}: ${message}`);
  };

  // --- helpers -----------------------------------------------------------
  const fetchLoan = async () => {
    const { data, error } = await supabase
      .from("loans")
      .select("id, client_id, remaining_balance, status, is_imported_ongoing, amount_already_paid, initial_remaining_balance")
      .eq("id", loanId)
      .single();
    throwIfError("Buscar empréstimo", error);
    if (!data) throw new Error("Empréstimo não encontrado");
    return data;
  };

  const markOpenDailyEventsReversed = async () => {
    const { data: events, error } = await (supabase.from("daily_events" as any)
      .select("id").eq("loan_id", loanId).is("reversed_at", null) as any);
    throwIfError("Buscar eventos do empréstimo", error);
    for (const e of (events || []) as any[]) {
      const { error: upErr } = await (supabase.from("daily_events" as any)
        .update({ reversed_at: new Date().toISOString() } as any)
        .eq("id", e.id) as any);
      throwIfError("Marcar evento como estornado", upErr);
    }
  };

  const handleFinancialReversal = async (clientId: string, isImportedOngoing: boolean) => {
    const { data: movements, error } = await supabase
      .from("cash_movements")
      .select("id, type, amount")
      .eq("loan_id", loanId)
      .is("reversed_at", null);
    throwIfError("Buscar movimentações do empréstimo", error);

    for (const mov of (movements || []) as any[]) {
      if (mov.type === "recebimento_normal" || mov.type === "recebimento_multa") {
        // Real money came in — always reverse with counter-entry.
        await reversePayment({ movementId: mov.id });
        continue;
      }

      if (isImportedOngoing && mov.type === "emprestimo") {
        // Imported/ongoing: original disbursement never moved cash. Just flag it.
        const { error: upErr } = await supabase
          .from("cash_movements")
          .update({ reversed_at: new Date().toISOString() } as any)
          .eq("id", mov.id);
        throwIfError("Marcar liberação importada como estornada", upErr);
        continue;
      }

      // emprestimo (normal) / other: mark reversed + counter-entry
      const { error: upErr } = await supabase
        .from("cash_movements")
        .update({ reversed_at: new Date().toISOString() } as any)
        .eq("id", mov.id);
      throwIfError("Marcar movimentação como estornada", upErr);

      const reversal = await createCashMovement({
        type: "estorno_manual" as any,
        amount: -Number(mov.amount),
        loan_id: loanId,
        observation: `Cancelamento de empréstimo`,
        cash_date: cancelDate,
      }) as any;
      const evt = await createDailyEvent({
        cash_date: cancelDate,
        event_type: "cancelamento" as any,
        loan_id: loanId,
        client_id: clientId,
        amount_in: Number(mov.amount) < 0 ? -Number(mov.amount) : 0,
        amount_out: Number(mov.amount) > 0 ? Number(mov.amount) : 0,
        observation: `Estorno por cancelamento`,
        origin: "cancelamento",
        cash_movement_id: reversal?.id || null,
      } as any) as any;
      if (reversal?.id && evt?.id) {
        const { error: linkError } = await supabase
          .from("cash_movements")
          .update({ daily_event_id: evt.id } as any)
          .eq("id", reversal.id);
        throwIfError("Vincular estorno ao evento diário", linkError);
      }
    }
  };

  const cancelCollectibleInstallments = async () => {
    // Only collectible installments become cancelled — never overwrite paid/renegotiated.
    const { error } = await supabase
      .from("installments")
      .update({ status: INSTALLMENT_STATUS.CANCELLED } as any)
      .eq("loan_id", loanId)
      .in("status", INSTALLMENT_COLLECTIBLE_STATUSES as unknown as string[]);
    throwIfError("Cancelar parcelas pendentes", error);
  };

  const removeNotPaidMarks = async () => {
    const { error } = await supabase.from("not_paid_marks").delete().eq("loan_id", loanId);
    throwIfError("Remover marcações de não pagou", error);
  };

  const markLoanCancelled = async (prevStatus: string, prevBalance: number) => {
    const { error } = await supabase
      .from("loans")
      .update({ status: LOAN_STATUS.CANCELLED, remaining_balance: 0 } as any)
      .eq("id", loanId);
    throwIfError("Cancelar empréstimo", error);

    const { data: check, error: validateError } = await supabase
      .from("loans")
      .select("status, remaining_balance")
      .eq("id", loanId)
      .single();
    throwIfError("Validar cancelamento", validateError);
    if (check?.status !== LOAN_STATUS.CANCELLED || Number(check?.remaining_balance) > 0.01) {
      console.error("[cancelLoan] cancellation validation failed", check);
      throw new Error("Cancelamento não foi aplicado no banco.");
    }
    return { prevStatus, prevBalance };
  };

  const writeAuditEvent = async (clientId: string) => {
    await createDailyEvent({
      cash_date: cancelDate,
      event_type: "cancelamento" as any,
      loan_id: loanId,
      client_id: clientId,
      amount_in: 0,
      amount_out: 0,
      observation: reason ? `Empréstimo cancelado: ${reason}` : "Empréstimo cancelado",
      origin: "cancelamento",
    } as any);
  };

  // --- pipeline ----------------------------------------------------------
  const loan = await fetchLoan();
  const isImportedOngoing = Boolean((loan as any).is_imported_ongoing);
  const prevStatus = String(loan.status);
  const prevBalance = Number(loan.remaining_balance);

  await markOpenDailyEventsReversed();
  await handleFinancialReversal(loan.client_id, isImportedOngoing);
  await cancelCollectibleInstallments();
  await removeNotPaidMarks();
  await markLoanCancelled(prevStatus, prevBalance);
  await writeAuditEvent(loan.client_id);
  await recalculateCashBalanceFromLedger();

  await logAction(
    "excluir_emprestimo",
    "loan",
    loanId,
    { remaining_balance: prevBalance, status: prevStatus },
    { status: LOAN_STATUS.CANCELLED, remaining_balance: 0 },
    reason ? `Empréstimo cancelado: ${reason}` : "Empréstimo cancelado",
  );
}

