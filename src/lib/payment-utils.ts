import { supabase } from "@/integrations/supabase/client";
import { updateCashBalance, createCashMovement, linkCashMovementToDailyEvent, recalculateCashBalanceFromLedger } from "@/lib/cash-utils";
import { createDailyEvent } from "@/lib/daily-events";
import { formatCurrency } from "@/lib/loan-utils";

/**
 * Centralized payment functions - SINGLE SOURCE OF TRUTH
 * All screens MUST use these functions for payment operations.
 */

/**
 * Recalculate installment paid_amount/status based on the loan's remaining_balance.
 * This is the SINGLE SOURCE OF TRUTH for installment progress.
 * totalPaid = total_amount - remaining_balance, then distributed in order.
 */
export async function recalculateInstallments(loanId: string) {
  const { data: loan } = await supabase
    .from("loans")
    .select("total_amount, remaining_balance")
    .eq("id", loanId)
    .single();

  if (!loan) return;

  const totalPaid = Math.max(0, Number(loan.total_amount) - Number(loan.remaining_balance));
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
    const instAmount = Number(inst.amount);
    if (remaining >= instAmount - 0.01) {
      // Fully paid
      const newPaid = instAmount;
      const needsUpdate = Number(inst.paid_amount) !== newPaid || inst.status !== "paid";
      if (needsUpdate) {
        await supabase.from("installments").update({
          paid_amount: newPaid,
          status: "paid",
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
    .select("amount, total_amount, remaining_balance")
    .eq("id", loanId)
    .single();

  if (!loanData) throw new Error("Empréstimo não encontrado");

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
    .select("remaining_balance, amount, total_amount")
    .eq("id", loanId)
    .single();

  if (!loanData) throw new Error("Empréstimo não encontrado");

  const realBalance = Number(loanData.remaining_balance);

  // Get all unpaid installments
  const { data: allUnpaid } = await supabase
    .from("installments")
    .select("*")
    .eq("loan_id", loanId)
    .neq("status", "paid")
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
}) {
  const { movementId } = params;

  const { data: movement, error } = await supabase
    .from("cash_movements")
    .select("id, type, amount, loan_id, installment_id, daily_event_id")
    .eq("id", movementId)
    .single();

  if (error || !movement?.loan_id) throw new Error("Lançamento de pagamento não encontrado");
  const loanId = movement.loan_id;
  const totalReversed = Number(movement.amount);

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

  await supabase.from("cash_movements").delete().eq("id", movementId);

  const { data: events } = await (supabase.from("daily_events" as any)
    .select("id")
    .or(`id.eq.${(movement as any).daily_event_id || "00000000-0000-0000-0000-000000000000"},cash_movement_id.eq.${movementId}`) as any);
  for (const ev of (events || [])) {
    await supabase.from("daily_events" as any).delete().eq("id", ev.id);
  }

  await recalculateCashBalanceFromLedger();
  await recalculateInstallments(loanId);

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
