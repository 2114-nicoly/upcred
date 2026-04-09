import { supabase } from "@/integrations/supabase/client";
import { updateCashBalance, createCashMovement, recalculateCashBalanceFromLedger } from "@/lib/cash-utils";
import { createDailyEvent, deleteDailyEvent } from "@/lib/daily-events";
import { formatCurrency } from "@/lib/loan-utils";

/**
 * Centralized payment functions - SINGLE SOURCE OF TRUTH
 * All screens MUST use these functions for payment operations.
 */

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
  const { loanId, amount, clientId, clientName, cashDate, origin, installmentId, startInstNumber } = params;
  if (amount <= 0) return { applied: 0, newBalance: 0 };

  // 1. Atomic RPC: update remaining_balance
  const { data: newBalance, error: rpcError } = await supabase.rpc("apply_loan_payment", {
    p_loan_id: loanId,
    p_amount: amount,
  });
  if (rpcError) throw rpcError;

  // 2. Update installment records (informational tracking)
  const { data: unpaidInsts } = await supabase
    .from("installments")
    .select("*")
    .eq("loan_id", loanId)
    .neq("status", "paid")
    .eq("is_penalty", false)
    .order("number");

  let remaining = amount;
  const toProcess = startInstNumber
    ? (unpaidInsts || []).filter((i: any) => i.number >= startInstNumber)
    : unpaidInsts || [];

  for (const inst of toProcess) {
    if (remaining <= 0.01) break;
    const instRemaining = Number(inst.amount) - Number(inst.paid_amount);
    const applying = Math.min(remaining, instRemaining);
    const newPaidAmount = Number(inst.paid_amount) + applying;
    const fullyPaid = newPaidAmount >= Number(inst.amount) - 0.01;
    await supabase.from("installments").update({
      paid_amount: newPaidAmount,
      status: fullyPaid ? "paid" : "partial",
      paid_at: new Date(cashDate + "T12:00:00").toISOString(),
    }).eq("id", inst.id);
    remaining -= applying;
  }

  // 3. Cash balance: interest first, then principal
  const { data: loanData } = await supabase
    .from("loans")
    .select("amount, total_amount")
    .eq("id", loanId)
    .single();

  if (loanData) {
    const loanInterest = Number(loanData.total_amount) - Number(loanData.amount);
    const { data: allInsts } = await supabase
      .from("installments")
      .select("paid_amount")
      .eq("loan_id", loanId)
      .eq("is_penalty", false);
    const totalPaidNow = (allInsts || []).reduce((s: number, i: any) => s + Number(i.paid_amount), 0);
    const totalPaidBefore = totalPaidNow - amount;
    const interestRemaining = Math.max(0, loanInterest - totalPaidBefore);
    const toInterest = Math.min(amount, interestRemaining);
    const toPrincipal = amount - toInterest;

    await updateCashBalance({
      available_cash: amount,
      interest_receivable: -toInterest,
      money_lent: -toPrincipal,
    });
  }

  // 4. Cash movement
  await createCashMovement({
    type: "recebimento_normal",
    amount,
    client_id: clientId,
    loan_id: loanId,
    installment_id: installmentId || null,
    observation: `Pagamento - ${clientName}`,
    cash_date: cashDate,
  });

  // 5. Daily event
  await createDailyEvent({
    cash_date: cashDate,
    event_type: "pagamento",
    client_id: clientId,
    loan_id: loanId,
    installment_id: installmentId || null,
    amount_in: amount,
    observation: `Pagamento - ${clientName}`,
    origin,
  });

  return { applied: amount, newBalance: Number(newBalance) };
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
    status: fullyPaid ? "paid" : penaltyInst.status,
    paid_at: fullyPaid ? new Date(cashDate + "T12:00:00").toISOString() : penaltyInst.paid_at,
  }).eq("id", penaltyInst.id);

  await updateCashBalance({ available_cash: amount, penalty_receivable: -amount });
  await createCashMovement({
    type: "recebimento_multa",
    amount,
    client_id: clientId,
    loan_id: loanId,
    observation: `Pagamento de multa - ${clientName}`,
    cash_date: cashDate,
  });
  await createDailyEvent({
    cash_date: cashDate,
    event_type: "recebimento_multa",
    client_id: clientId,
    loan_id: loanId,
    amount_in: amount,
    observation: `Multa - ${clientName}`,
    origin,
  });
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
    await createCashMovement({
      type: "recebimento_normal",
      amount: realBalance,
      client_id: clientId,
      loan_id: loanId,
      installment_id: installmentId || null,
      observation: `Quitação empréstimo - ${clientName}`,
      cash_date: cashDate,
    });
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
    await createCashMovement({
      type: "recebimento_multa",
      amount: totalPenaltyPaying,
      client_id: clientId,
      loan_id: loanId,
      observation: `Quitação multa - ${clientName}`,
      cash_date: cashDate,
    });
  }

  // Daily event for the full payoff
  const totalPaying = realBalance + totalPenaltyPaying;
  if (totalPaying > 0) {
    await createDailyEvent({
      cash_date: cashDate,
      event_type: "pagamento",
      client_id: clientId,
      loan_id: loanId,
      installment_id: installmentId || null,
      amount_in: totalPaying,
      observation: `Quitação - ${clientName}`,
      origin,
    });
  }

  return { regularPaid: realBalance, penaltyPaid: totalPenaltyPaying };
}

/**
 * Reverse a payment for a loan on a specific date.
 * Uses reverse_loan_payment RPC to restore remaining_balance.
 */
export async function reversePayment(params: {
  loanId: string;
  cashDate: string;
  installmentIds?: string[];
}) {
  const { loanId, cashDate, installmentIds } = params;

  // Get total from cash_movements
  const { data: movs } = await supabase
    .from("cash_movements")
    .select("amount, installment_id")
    .eq("type", "recebimento_normal")
    .eq("cash_date", cashDate)
    .eq("loan_id", loanId);

  const totalReversed = (movs || []).reduce((s: number, m: any) => s + Number(m.amount), 0);
  const affectedInstIds = [...new Set((movs || []).map((m: any) => m.installment_id).filter(Boolean))];

  // Reverse remaining_balance via RPC
  if (totalReversed > 0) {
    await supabase.rpc("reverse_loan_payment", { p_loan_id: loanId, p_amount: totalReversed });
  }

  // Delete cash_movements
  await supabase.from("cash_movements").delete()
    .eq("loan_id", loanId)
    .eq("cash_date", cashDate)
    .eq("type", "recebimento_normal");

  // Reset installments
  for (const instId of affectedInstIds) {
    await supabase.from("installments").update({
      status: "pending",
      paid_at: null,
      paid_amount: 0,
    }).eq("id", instId);
  }

  // Delete daily_events
  const { data: events } = await (supabase.from("daily_events" as any)
    .select("id")
    .eq("event_type", "pagamento")
    .eq("loan_id", loanId)
    .eq("cash_date", cashDate) as any);
  for (const ev of (events || [])) {
    await deleteDailyEvent(ev.id);
  }

  // Recalculate cash balance
  await recalculateCashBalanceFromLedger();

  // Update loan status
  const { data: loanInsts } = await supabase
    .from("installments")
    .select("status")
    .eq("loan_id", loanId);
  const allPaid = loanInsts?.every((i: any) => i.status === "paid");
  const hasOverdue = loanInsts?.some((i: any) => i.status === "overdue");
  await supabase.from("loans").update({
    status: allPaid ? "paid" : hasOverdue ? "overdue" : "open",
  }).eq("id", loanId);

  return totalReversed;
}

/**
 * Reverse a single installment payment (used in LoanDetail).
 */
export async function reverseInstallmentPayment(params: {
  installmentId: string;
  loanId: string;
}) {
  const { installmentId, loanId } = params;

  // Get the paid amount for this installment before resetting
  const { data: instData } = await supabase
    .from("installments")
    .select("paid_amount")
    .eq("id", installmentId)
    .single();

  const paidAmount = Number(instData?.paid_amount || 0);

  // Delete cash_movements for this installment
  await supabase.from("cash_movements").delete().eq("installment_id", installmentId);

  // Revert installment
  await supabase.from("installments").update({
    status: "pending",
    paid_at: null,
    paid_amount: 0,
  }).eq("id", installmentId);

  // Reverse remaining_balance via RPC
  if (paidAmount > 0) {
    await supabase.rpc("reverse_loan_payment", { p_loan_id: loanId, p_amount: paidAmount });
  }

  // Recalculate cash balance
  await recalculateCashBalanceFromLedger();

  // Update loan status
  const { data: loanInsts } = await supabase
    .from("installments")
    .select("status")
    .eq("loan_id", loanId);
  const allPaid = loanInsts?.every((i: any) => i.status === "paid");
  const hasOverdue = loanInsts?.some((i: any) => i.status === "overdue");
  await supabase.from("loans").update({
    status: allPaid ? "paid" : hasOverdue ? "overdue" : "open",
  }).eq("id", loanId);
}
