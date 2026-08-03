import { supabase } from "@/integrations/supabase/client";
import { updateCashBalance, createCashMovement, linkCashMovementToDailyEvent, recalculateCashBalanceForLoan, markCashMovementReversed } from "@/lib/cash-utils";
import { createDailyEvent, markDailyEventReversed } from "@/lib/daily-events";
import { formatCurrency } from "@/lib/loan-utils";
import { logAction, logReversal } from "@/lib/audit-utils";
import {
  INSTALLMENT_LOCKED_STATUSES,
  INSTALLMENT_COLLECTIBLE_STATUSES,
  INSTALLMENT_STATUS,
  LOAN_STATUS,
  isLoanActive,
} from "@/lib/status-constants";

import {
  assertReversible,
  assertCashDateOpenForReversal,
  linkReversal,
  linkEventReversal,
} from "@/lib/reversal";



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
export async function recalculateInstallments(loanId: string, paidAtDate?: string) {
  const { data: loan } = await supabase
    .from("loans")
    .select("total_amount, remaining_balance, is_imported_ongoing, initial_remaining_balance, amount_already_paid")
    .eq("id", loanId)
    .single();

  if (!loan) return;

  const importedInitialRemaining = (loan as any).initial_remaining_balance != null
    ? Number((loan as any).initial_remaining_balance)
    : Math.max(0, Number(loan.total_amount) - Number((loan as any).amount_already_paid || 0));
  const paidBase = (loan as any).is_imported_ongoing
    ? importedInitialRemaining
    : Number(loan.total_amount);
  const totalPaid = Math.max(0, paidBase - Number(loan.remaining_balance));
  const today = new Date().toISOString().split("T")[0];
  // Data real do pagamento: quando o pagamento é lançado numa cash_date
  // escolhida, paid_at deve refletir esse dia (meio-dia local), não "agora".
  const paidAtIso = paidAtDate
    ? new Date(paidAtDate + "T12:00:00").toISOString()
    : new Date().toISOString();

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
          paid_at: inst.paid_at || paidAtIso,
        }).eq("id", inst.id);
      }
      remaining -= instAmount;
    } else if (remaining > 0.01) {
      // Partially paid: never mark as paid until paid_amount reaches amount.
      const newPaid = remaining;
      await supabase.from("installments").update({
        paid_amount: newPaid,
        status: "partial",
        paid_at: paidAtIso,
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
 *
 * FONTE ÚNICA: toda a operação (empréstimo, parcelas, caixa, movimento,
 * evento diário e metadata imutável) acontece dentro da RPC transacional
 * `register_payment_tx`. Se qualquer etapa — inclusive a gravação do
 * metadata — falhar, NADA é gravado (rollback total no banco).
 *
 * O cliente NÃO repete nenhuma dessas alterações.
 * `cash_date` é o dia financeiro escolhido; `created_at` é o horário real.
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
  /** Observação livre gravada no movimento/evento do pagamento. */
  observation?: string;
}) {
  const { loanId, amount, clientId, cashDate, origin, installmentId, observation } = params;
  if (amount <= 0) return { applied: 0, newBalance: 0 };

  const { data, error } = await supabase.rpc("register_payment_tx" as any, {
    p_loan_id: loanId,
    p_amount: amount,
    p_client_id: clientId,
    p_cash_date: cashDate,
    p_origin: origin,
    p_installment_id: installmentId || null,
    p_observation: observation?.trim() ? observation.trim() : null,
  } as any);
  if (error) throw error;

  const result = (data ?? {}) as any;
  const applied = Number(result.applied ?? 0);
  const balanceAfter = Number(result.new_balance ?? 0);
  const metadata = (result.metadata ?? {}) as any;
  const movementId = (result.movement_id ?? null) as string | null;
  const eventId = (result.event_id ?? null) as string | null;
  const balanceBefore = Number(metadata.remaining_balance_before ?? balanceAfter + applied);
  const clientName = String(metadata.client_name ?? params.clientName ?? "");

  // Auditoria (log complementar; o histórico imutável já está no daily_event).
  await logAction(
    "pagamento",
    "payment",
    movementId,
    { remaining_balance: balanceBefore },
    {
      loan_id: loanId,
      client_id: clientId,
      client_name: clientName,
      installment_id: installmentId || null,
      payment_id: movementId,
      cash_movement_id: movementId,
      daily_event_id: eventId,
      amount: applied,
      cash_date: cashDate,
      remaining_balance: balanceAfter,
      timestamp: new Date().toISOString(),
    },
    `Pagamento ${formatCurrency(applied)} - ${clientName}`,
  );

  // Pagamento parcial na parcela referenciada: linha de auditoria dedicada,
  // lida do metadata congelado (sem reconsultar o estado atual).
  if (installmentId) {
    const affected = (metadata.affected_installments ?? []) as any[];
    const target = affected.find((i) => i.installment_id === installmentId);
    if (target && target.status_after !== "paid") {
      await logAction(
        "pagamento_parcial",
        "installment",
        installmentId,
        {
          remaining_balance: balanceBefore,
          installment_paid_before: Number(target.paid_amount_before ?? 0),
        },
        {
          loan_id: loanId,
          client_id: clientId,
          client_name: clientName,
          installment_id: installmentId,
          installment_number: target.number,
          installment_amount: Number(target.amount ?? 0),
          amount_paid: Number(target.amount_applied ?? applied),
          installment_remaining: Math.max(0, Number(target.amount ?? 0) - Number(target.paid_amount_after ?? 0)),
          payment_id: movementId,
          cash_movement_id: movementId,
          daily_event_id: eventId,
          remaining_balance_before: balanceBefore,
          remaining_balance_after: balanceAfter,
          cash_date: cashDate,
          timestamp: new Date().toISOString(),
        },
        `Pagamento parcial parcela #${target.number} - ${clientName} (${formatCurrency(Number(target.amount_applied ?? applied))}/${formatCurrency(Number(target.amount ?? 0))})`,
      );
    }
  }

  return { applied, newBalance: balanceAfter };
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
  let movement: any = null;
  let event: any = null;
  try {
    movement = await createCashMovement({
      type: "recebimento_multa",
      amount,
      client_id: clientId,
      loan_id: loanId,
      observation: `Pagamento de multa - ${clientName}`,
      cash_date: cashDate,
    }) as any;
    event = await createDailyEvent({
      cash_date: cashDate,
      event_type: "recebimento_multa",
      client_id: clientId,
      loan_id: loanId,
      amount_in: amount,
      observation: `Multa - ${clientName}`,
      origin,
      cash_movement_id: movement?.id || null,
    } as any) as any;
    if (!movement?.id || !event?.id) throw new Error("Pagamento de multa sem movimentação/evento financeiro vinculado.");
    await linkCashMovementToDailyEvent(movement.id, event.id);
    await updateCashBalance({ available_cash: amount, penalty_receivable: -amount });
    const { error: instError } = await supabase.from("installments").update({
      paid_amount: Math.min(newPaid, Number(penaltyInst.amount)),
      status: fullyPaid ? INSTALLMENT_STATUS.PAID : newPaid > 0.01 ? INSTALLMENT_STATUS.PARTIAL : penaltyInst.status,
      paid_at: fullyPaid ? new Date(cashDate + "T12:00:00").toISOString() : penaltyInst.paid_at,
    }).eq("id", penaltyInst.id);
    if (instError) throw instError;
  } catch (err) {
    if (event?.id) await supabase.from("daily_events" as any).delete().eq("id", event.id);
    if (movement?.id) await supabase.from("cash_movements").delete().eq("id", movement.id);
    await recalculateCashBalanceForLoan(loanId);
    throw err;
  }
  await recalculateCashBalanceForLoan(loanId);
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

  const regularUnpaid = (allUnpaid || []).filter((i: any) => !i.is_penalty);
  const penaltyUnpaid = (allUnpaid || []).filter((i: any) => i.is_penalty);
  if (realBalance > 0.01 && regularUnpaid.length === 0) {
    throw new Error("Empréstimo ativo sem parcelas cobraveis. Corrija as parcelas antes de quitar.");
  }
  if (realBalance <= 0.01 && penaltyUnpaid.length === 0) return { regularPaid: 0, penaltyPaid: 0 };

  // Apply remaining balance via RPC
  if (realBalance > 0) {
    const { error: rpcError } = await supabase.rpc("apply_loan_payment", { p_loan_id: loanId, p_amount: realBalance });
    if (rpcError) throw rpcError;

    // Cash balance
    const loanInterest = Number(loanData.total_amount) - Number(loanData.amount);
    const totalPaidBefore = Math.max(0, Number(loanData.total_amount) - Number(loanData.remaining_balance));
    const interestRemaining = Math.max(0, loanInterest - totalPaidBefore);
    const toInterest = Math.min(realBalance, interestRemaining);
    const toPrincipal = realBalance - toInterest;

    let movement: any = null;
    let event: any = null;
    try {
      movement = await createCashMovement({
        type: "recebimento_normal",
        amount: realBalance,
        client_id: clientId,
        loan_id: loanId,
        installment_id: installmentId || null,
        observation: `Quitação empréstimo - ${clientName}`,
        cash_date: cashDate,
      }) as any;
      event = await createDailyEvent({
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
      if (!movement?.id || !event?.id) throw new Error("Quitação sem movimentação/evento financeiro vinculado.");
      await linkCashMovementToDailyEvent(movement.id, event.id);
      await updateCashBalance({
        available_cash: realBalance,
        interest_receivable: -toInterest,
        money_lent: -toPrincipal,
      });
    } catch (err) {
      if (event?.id) await supabase.from("daily_events" as any).delete().eq("id", event.id);
      if (movement?.id) await supabase.from("cash_movements").delete().eq("id", movement.id);
      await supabase.rpc("reverse_loan_payment", { p_loan_id: loanId, p_amount: realBalance });
      await recalculateInstallments(loanId);
      throw err;
    }
  } else {
    // Balance already zero, just mark as paid
    const { error: paidError } = await supabase.from("loans").update({ status: "paid" }).eq("id", loanId);
    if (paidError) throw paidError;
  }

  // Mark all regular installments as paid after the financial movement is safely registered.
  for (const i of regularUnpaid) {
    const { error: instError } = await supabase.from("installments").update({
      paid_amount: Number(i.amount),
      status: INSTALLMENT_STATUS.PAID,
      paid_at: new Date(cashDate + "T12:00:00").toISOString(),
    }).eq("id", i.id);
    if (instError) throw instError;
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
    let movement: any = null;
    let event: any = null;
    try {
      movement = await createCashMovement({
        type: "recebimento_multa",
        amount: totalPenaltyPaying,
        client_id: clientId,
        loan_id: loanId,
        observation: `Quitação multa - ${clientName}`,
        cash_date: cashDate,
      }) as any;
      event = await createDailyEvent({
        cash_date: cashDate,
        event_type: "recebimento_multa",
        client_id: clientId,
        loan_id: loanId,
        amount_in: totalPenaltyPaying,
        observation: `Quitação multa - ${clientName}`,
        origin,
        cash_movement_id: movement?.id || null,
      } as any) as any;
      if (!movement?.id || !event?.id) throw new Error("Quitação de multa sem movimentação/evento financeiro vinculado.");
      await linkCashMovementToDailyEvent(movement.id, event.id);
      await updateCashBalance({ available_cash: totalPenaltyPaying, penalty_receivable: -totalPenaltyPaying });
    } catch (err) {
      if (event?.id) await supabase.from("daily_events" as any).delete().eq("id", event.id);
      if (movement?.id) await supabase.from("cash_movements").delete().eq("id", movement.id);
      await recalculateCashBalanceForLoan(loanId);
      throw err;
    }
  }

  await recalculateInstallments(loanId);
  await recalculateCashBalanceForLoan(loanId);

  await logAction(
    "quitar_emprestimo",
    "loan",
    loanId,
    { remaining_balance: realBalance, status: loanData.status },
    { status: "paid", remaining_balance: 0, regular_paid: realBalance, penalty_paid: totalPenaltyPaying, cash_date: cashDate },
    `Quitação ${formatCurrency(realBalance + totalPenaltyPaying)} - ${clientName}`,
  );

  return { regularPaid: realBalance, penaltyPaid: totalPenaltyPaying };
}

/**
 * Desfaz um pagamento/multa — REGRA ÚNICA E TRANSACIONAL.
 *
 * Toda a lógica (validação de escopo, caixa aberto, contrapartida, parcelas,
 * saldo do caixa e auditoria) roda dentro da RPC `reverse_cash_movement_tx`,
 * em uma única transação. Qualquer falha faz rollback total.
 *
 * O frontend NÃO grava cash_balance, reversed_at nem auditoria.
 */
export async function reversePayment(params: {
  movementId: string;
  reason?: string;
}) {
  const { movementId } = params;
  const reason = (params.reason || "").trim() || "Estorno solicitado pelo operador";

  const { data, error } = await supabase.rpc("reverse_cash_movement_tx" as any, {
    p_movement_id: movementId,
    p_reason: reason,
  } as any);
  if (error) throw error;

  const result = (data as any) || {};
  return Math.abs(Number(result.original_amount) || 0);
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

  // Capture old amount for audit
  const { data: oldMov } = await supabase
    .from("cash_movements").select("amount, cash_date").eq("id", movementId).single();
  const oldAmount = oldMov ? Number(oldMov.amount) : null;

  // Reverse only the selected financial movement, then create a fresh linked movement/event.
  await reversePayment({ movementId });

  const result = await registerPayment({
    loanId, amount: newAmount,
    clientId, clientName,
    cashDate, origin,
  });

  await logAction(
    "editar_pagamento",
    "payment",
    movementId,
    { amount: oldAmount, cash_date: (oldMov as any)?.cash_date ?? null },
    { amount: newAmount, cash_date: cashDate, loan_id: loanId },
    `Pagamento editado de ${oldAmount != null ? formatCurrency(oldAmount) : "?"} para ${formatCurrency(newAmount)} - ${clientName}`,
  );

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
  if (!isLoanActive(loan)) throw new Error("Empréstimo inativo não pode ser cancelado.");

  await markOpenDailyEventsReversed();
  await handleFinancialReversal(loan.client_id, isImportedOngoing);
  await cancelCollectibleInstallments();
  await removeNotPaidMarks();
  await markLoanCancelled(prevStatus, prevBalance);
  await writeAuditEvent(loan.client_id);
  await recalculateCashBalanceForLoan(loanId);

  await logAction(
    "excluir_emprestimo",
    "loan",
    loanId,
    { remaining_balance: prevBalance, status: prevStatus },
    { status: LOAN_STATUS.CANCELLED, remaining_balance: 0 },
    reason ? `Empréstimo cancelado: ${reason}` : "Empréstimo cancelado",
  );
}

/**
 * Absorb the remaining balance of an old loan into a renewal.
 *
 * The absorbed amount is NOT physical cash — it must NOT be:
 *  - registered as a payment (recebimento_normal / pagamento),
 *  - added to available_cash,
 *  - counted as "Recebido no dia" nor create a cash_movement.
 *
 * What it MUST do:
 *  - Zero the old loan's remaining_balance via apply_loan_payment RPC.
 *  - Reduce money_lent / interest_receivable so those receivables migrate to the new loan.
 *  - Mark collectible installments as paid.
 *  - Register an informative daily_event ("renovacao_absorvida", amount_in=0, amount_out=0)
 *    so the history/audit shows exactly how much was absorbed by the new contract.
 */
export async function absorbLoanBalance(params: {
  loanId: string;
  newLoanId?: string | null;
  clientId: string;
  clientName: string;
  cashDate: string;
}) {
  const { loanId, newLoanId, clientId, clientName, cashDate } = params;

  const { data: loanData } = await supabase
    .from("loans")
    .select("remaining_balance, amount, total_amount, status")
    .eq("id", loanId)
    .single();
  if (!loanData) throw new Error("Empréstimo não encontrado");
  if (!isLoanActive(loanData)) throw new Error("Empréstimo inativo não pode ser absorvido.");

  const absorbed = Math.max(0, Number(loanData.remaining_balance));

  // Nothing to absorb: just ensure status/installments are consistent.
  if (absorbed <= 0.01) {
    await supabase.from("loans").update({ status: LOAN_STATUS.PAID }).eq("id", loanId);
    await recalculateInstallments(loanId);
    return { absorbed: 0 };
  }

  // 1) Zero the old loan balance atomically.
  const { error: rpcError } = await supabase.rpc("apply_loan_payment", { p_loan_id: loanId, p_amount: absorbed });
  if (rpcError) throw rpcError;

  // 2) Migrate receivables from old loan (no available_cash change).
  const loanInterest = Number(loanData.total_amount) - Number(loanData.amount);
  const totalPaidBefore = Math.max(0, Number(loanData.total_amount) - Number(loanData.remaining_balance));
  const interestRemaining = Math.max(0, loanInterest - totalPaidBefore);
  const toInterest = Math.min(absorbed, interestRemaining);
  const toPrincipal = absorbed - toInterest;
  try {
    await updateCashBalance({
      interest_receivable: -toInterest,
      money_lent: -toPrincipal,
    });
  } catch (err) {
    // Roll back the RPC balance move on failure.
    await supabase.rpc("reverse_loan_payment", { p_loan_id: loanId, p_amount: absorbed });
    throw err;
  }

  // 3) Mark all collectible installments as paid.
  const { data: unpaid } = await supabase
    .from("installments")
    .select("id, amount, is_penalty")
    .eq("loan_id", loanId)
    .in("status", INSTALLMENT_COLLECTIBLE_STATUSES as unknown as string[]);
  for (const i of ((unpaid as any[]) || [])) {
    if (i.is_penalty) continue;
    await supabase.from("installments").update({
      paid_amount: Number(i.amount),
      status: INSTALLMENT_STATUS.PAID,
      paid_at: new Date(cashDate + "T12:00:00").toISOString(),
    }).eq("id", i.id);
  }

  // 4) Informative ledger event — NOT a payment, NOT cash. amount_in/out = 0.
  try {
    await createDailyEvent({
      cash_date: cashDate,
      event_type: "renovacao_absorvida" as any,
      client_id: clientId,
      loan_id: loanId,
      amount_in: 0,
      amount_out: 0,
      observation: `Saldo absorvido pela renovação - ${clientName} (${formatCurrency(absorbed)})`,
      origin: "renovacao",
      metadata: {
        absorbed_amount: absorbed,
        old_loan_id: loanId,
        new_loan_id: newLoanId || null,
        client_id: clientId,
        client_name: clientName,
        cash_date: cashDate,
        note: "Absorção contábil — não representa entrada de caixa.",
      },
    } as any);
  } catch (err) {
    console.warn("[absorbLoanBalance] evento informativo falhou", err);
  }

  await recalculateInstallments(loanId);
  await recalculateCashBalanceForLoan(loanId);

  await logAction(
    "renovacao_absorvida",
    "loan",
    loanId,
    { remaining_balance: absorbed, status: loanData.status },
    {
      status: LOAN_STATUS.PAID,
      remaining_balance: 0,
      absorbed_amount: absorbed,
      new_loan_id: newLoanId || null,
      client_id: clientId,
      client_name: clientName,
      cash_date: cashDate,
      cash_impact: 0,
      note: "Saldo absorvido pelo novo contrato — sem entrada de caixa.",
    },
    `Renovação: saldo absorvido ${formatCurrency(absorbed)} - ${clientName}`,
  );

  return { absorbed };
}


