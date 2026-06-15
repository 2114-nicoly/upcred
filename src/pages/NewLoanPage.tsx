import { useState, useMemo, useEffect, useRef } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { calculateLoan, generateDueDates, formatCurrency } from "@/lib/loan-utils";
import { updateCashBalance, createCashMovement, linkCashMovementToDailyEvent, recalculateCashBalanceFromLedger } from "@/lib/cash-utils";
import { createDailyEvent } from "@/lib/daily-events";
import { settleLoan, registerPayment } from "@/lib/payment-utils";
import { getActiveLoanForClient } from "@/lib/loan-utils";
import { assertCashOpen } from "@/lib/cash-lock";
import { logAction } from "@/lib/audit-utils";
import { Calculator, RefreshCw, AlertTriangle } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { useFormDraft } from "@/hooks/useFormDraft";
import { useConfirm } from "@/hooks/useConfirm";

export default function NewLoanPage() {
  const { clientId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const renewFromLoanId = searchParams.get("renewFrom");

  const [clientName, setClientName] = useState("");
  const [amount, setAmount] = useState("");
  const [interestType, setInterestType] = useState<"percentage" | "fixed">("percentage");
  const [interestValue, setInterestValue] = useState("");
  const [installmentCount, setInstallmentCount] = useState("");
  const [paymentType, setPaymentType] = useState<"daily" | "weekly" | "biweekly" | "monthly" | "fixed_dates">("daily");
  const [loanDate, setLoanDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [firstDueDate, setFirstDueDate] = useState("");
  const [fixedDates, setFixedDates] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [observation, setObservation] = useState("");

  // Tipo de cadastro: novo ou em andamento (importado)
  const [registrationType, setRegistrationType] = useState<"new" | "ongoing">("new");
  const [amountAlreadyPaid, setAmountAlreadyPaid] = useState("");

  // Renewal data
  const [renewOldRemaining, setRenewOldRemaining] = useState<number>(0);
  const [renewPaidAmount, setRenewPaidAmount] = useState<string>("");

  const confirm = useConfirm();
  const draftKey = renewFromLoanId ? `renew:${renewFromLoanId}` : `new-loan:${clientId ?? "x"}`;
  const draftValue = {
    amount, interestType, interestValue, installmentCount, paymentType,
    loanDate, firstDueDate, fixedDates, observation, renewPaidAmount,
    registrationType, amountAlreadyPaid,
  };
  const draft = useFormDraft(draftKey, draftValue);
  const restoredRef = useRef(false);
  const resetForm = () => {
    setAmount("");
    setInterestType("percentage");
    setInterestValue("");
    setInstallmentCount("");
    setPaymentType("daily");
    setLoanDate(format(new Date(), "yyyy-MM-dd"));
    setFirstDueDate("");
    setFixedDates([]);
    setObservation("");
    setRegistrationType("new");
    setAmountAlreadyPaid("");
    setRenewPaidAmount("");
  };
  useEffect(() => {
    if (restoredRef.current) return;
    try {
      const saved = draft.restore() as Partial<typeof draftValue> | null;
      if (saved && typeof saved === "object") {
        restoredRef.current = true;
        if (typeof saved.amount === "string") setAmount(saved.amount);
        if (saved.interestType === "percentage" || saved.interestType === "fixed") setInterestType(saved.interestType);
        if (typeof saved.interestValue === "string") setInterestValue(saved.interestValue);
        if (typeof saved.installmentCount === "string") setInstallmentCount(saved.installmentCount);
        if (typeof saved.paymentType === "string") setPaymentType(saved.paymentType as typeof paymentType);
        if (typeof saved.loanDate === "string") setLoanDate(saved.loanDate);
        if (typeof saved.firstDueDate === "string") setFirstDueDate(saved.firstDueDate);
        if (Array.isArray(saved.fixedDates)) setFixedDates(saved.fixedDates);
        if (typeof saved.observation === "string") setObservation(saved.observation);
        if (typeof saved.renewPaidAmount === "string") setRenewPaidAmount(saved.renewPaidAmount);
        if (saved.registrationType === "new" || saved.registrationType === "ongoing") setRegistrationType(saved.registrationType);
        if (typeof saved.amountAlreadyPaid === "string") setAmountAlreadyPaid(saved.amountAlreadyPaid);
        toast.info("Rascunho restaurado", {
          action: { label: "Descartar", onClick: () => { draft.clear(); resetForm(); } },
        });
      }
    } catch (err) {
      console.warn("[NewLoanPage] Falha ao restaurar rascunho, ignorando:", err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const fetchClient = async () => {
      const { data } = await supabase.from("clients").select("name").eq("id", clientId!).single();
      if (data) setClientName(data.name);
    };
    fetchClient();
  }, [clientId]);

  // Pre-fill from renewal loan + fetch remaining_balance for "Falta para quitar"
  useEffect(() => {
    if (!renewFromLoanId) return;
    const fetchRenewalLoan = async () => {
      const { data } = await supabase
        .from("loans")
        .select("amount, interest_type, interest_value, payment_type, installment_count, remaining_balance")
        .eq("id", renewFromLoanId)
        .single();
      if (data) {
        setAmount(String(data.amount));
        setInterestType(data.interest_type as "percentage" | "fixed");
        setInterestValue(String(data.interest_value));
        setPaymentType(data.payment_type as typeof paymentType);
        setInstallmentCount(String(data.installment_count));
        setRenewOldRemaining(Number(data.remaining_balance) || 0);
      }
    };
    fetchRenewalLoan();
  }, [renewFromLoanId]);

  const numAmount = parseFloat(amount) || 0;
  const numInterest = parseFloat(interestValue) || 0;
  const numInstallments = parseInt(installmentCount) || 0;

  const calc = useMemo(() => {
    if (numAmount <= 0 || numInstallments <= 0) return null;
    return calculateLoan(numAmount, interestType, numInterest, numInstallments);
  }, [numAmount, interestType, numInterest, numInstallments]);

  // Ongoing (importado) helpers — declared early so dueDates can size by pendingCount
  const isOngoing = registrationType === "ongoing" && !renewFromLoanId;
  const numAlreadyPaid = parseFloat(amountAlreadyPaid) || 0;
  const ongoingRemaining = calc ? Math.max(0, calc.totalAmount - numAlreadyPaid) : 0;

  // Sequência correta das parcelas para importado:
  // - fullPaid = parcelas inteiras já quitadas antes do cadastro
  // - hasPartial = existe uma parcela parcialmente paga
  // - partialRemaining = quanto falta na parcela parcial atual
  // - firstPendingNumber = número REAL da próxima parcela a cobrar (continua a numeração do contrato)
  // - pendingCount = quantas parcelas precisam ser criadas
  const ongoingPlan = useMemo(() => {
    if (!isOngoing || !calc || numInstallments <= 0) return null;
    const value = calc.installmentAmount;
    const fullPaid = Math.min(numInstallments, Math.floor((numAlreadyPaid + 0.0001) / value));
    const partialPaid = +(numAlreadyPaid - fullPaid * value).toFixed(2);
    const hasPartial = partialPaid > 0.01 && fullPaid < numInstallments;
    const partialRemaining = hasPartial ? +(value - partialPaid).toFixed(2) : 0;
    const firstPendingNumber = fullPaid + 1;
    const pendingCount = Math.max(0, numInstallments - fullPaid);
    return { value, fullPaid, partialPaid, hasPartial, partialRemaining, firstPendingNumber, pendingCount };
  }, [isOngoing, calc, numInstallments, numAlreadyPaid]);

  // Quantas datas o formulário precisa coletar:
  // - novo: numInstallments
  // - em andamento: apenas pendingCount (datas correspondem às parcelas pendentes reais)
  const datesNeeded = isOngoing ? (ongoingPlan?.pendingCount ?? 0) : numInstallments;

  const dueDates = useMemo(() => {
    if (paymentType === "fixed_dates") return fixedDates.filter((d) => d).map((d) => new Date(d + "T12:00:00"));
    if (!firstDueDate || datesNeeded <= 0) return [];
    return generateDueDates(new Date(firstDueDate + "T12:00:00"), datesNeeded, paymentType);
  }, [firstDueDate, datesNeeded, paymentType, fixedDates]);

  const handleFixedDateChange = (index: number, value: string) => {
    const newDates = [...fixedDates];
    newDates[index] = value;
    setFixedDates(newDates);
  };

  useEffect(() => {
    if (paymentType === "fixed_dates" && datesNeeded > 0) {
      setFixedDates((prev) => {
        const arr = [...prev];
        while (arr.length < datesNeeded) arr.push("");
        return arr.slice(0, datesNeeded);
      });
    }
  }, [datesNeeded, paymentType]);

  // Renewal computed values
  const renewPaid = parseFloat(renewPaidAmount) || 0;
  const faltaQuitar = renewOldRemaining;
  const absorvidoDoNovo = renewFromLoanId ? Math.max(0, faltaQuitar - renewPaid) : 0;
  const valorLiberado = renewFromLoanId ? Math.max(0, numAmount - absorvidoDoNovo) : numAmount;
  const cobreAntigo = renewPaid + numAmount;
  const renovacaoQuita = renewFromLoanId ? cobreAntigo + 0.01 >= faltaQuitar : true;

  // Função única para montar parcelas de empréstimo importado.
  // Garante:
  //  - numeração continua do contrato original (firstPendingNumber, +1, +2, ...)
  //  - nunca cria parcelas já quitadas antes do cadastro
  //  - primeira parcela parcial vale apenas o restante
  //  - última parcela absorve qualquer resíduo de arredondamento para que
  //    soma das parcelas === remaining_balance
  const buildOngoingInstallments = (loanId: string, dates: Date[]) => {
    if (!ongoingPlan) return [];
    const { value, hasPartial, partialRemaining, firstPendingNumber, pendingCount } = ongoingPlan;
    if (pendingCount === 0 || dates.length === 0) return [];
    const amounts: number[] = [];
    for (let i = 0; i < pendingCount; i++) {
      if (i === 0 && hasPartial) amounts.push(partialRemaining);
      else amounts.push(value);
    }
    const sum = +amounts.reduce((a, b) => a + b, 0).toFixed(2);
    const diff = +(ongoingRemaining - sum).toFixed(2);
    if (Math.abs(diff) >= 0.01) {
      amounts[amounts.length - 1] = +(amounts[amounts.length - 1] + diff).toFixed(2);
    }
    return dates.slice(0, pendingCount).map((date, i) => ({
      loan_id: loanId,
      number: firstPendingNumber + i,
      amount: amounts[i],
      due_date: format(date, "yyyy-MM-dd"),
      status: "pending",
      paid_amount: 0,
      paid_at: null,
    }));
  };




  const handleSave = async () => {
    if (!calc || numInstallments <= 0) { toast.error("Preencha todos os campos"); return; }
    if (paymentType !== "fixed_dates" && !firstDueDate) { toast.error(isOngoing ? "Informe a data da próxima cobrança" : "Informe a data do primeiro vencimento"); return; }
    if (paymentType === "fixed_dates" && fixedDates.some((d) => !d)) { toast.error("Preencha todas as datas de vencimento"); return; }

    if (isOngoing && numAlreadyPaid > calc.totalAmount + 0.01) {
      toast.error(`Valor já pago (${formatCurrency(numAlreadyPaid)}) é maior que o valor total (${formatCurrency(calc.totalAmount)}).`);
      return;
    }
    if (isOngoing && calc.totalAmount - numAlreadyPaid <= 0.01) {
      toast.error("Este empréstimo já está quitado. Cadastre apenas empréstimos em andamento com saldo restante.");
      return;
    }

    if (renewFromLoanId && !renovacaoQuita) {
      toast.error(`Renovação insuficiente. Faltam ${formatCurrency(faltaQuitar - cobreAntigo)} para quitar o empréstimo atual.`);
      return;
    }

    // Confirmação para ações sensíveis: renovação ou liberação alta
    const cashOutPreview = renewFromLoanId ? valorLiberado : numAmount;
    const ok = await confirm({
      title: renewFromLoanId ? "Confirmar renovação?" : isOngoing ? "Cadastrar empréstimo em andamento?" : "Confirmar novo empréstimo?",
      description: renewFromLoanId
        ? "Esta ação encerra o contrato atual e abre um novo."
        : isOngoing
          ? "Cadastra um empréstimo já existente. Não movimenta o caixa do dia."
          : "Esta ação libera dinheiro e cria parcelas.",
      affected: [
        { label: "Cliente", value: clientName },
        { label: "Valor", value: formatCurrency(numAmount) },
        { label: "Parcelas", value: `${numInstallments}x ${formatCurrency(calc.installmentAmount)}` },
        isOngoing
          ? { label: "Saldo restante", value: formatCurrency(ongoingRemaining) }
          : { label: "Liberado em caixa", value: formatCurrency(cashOutPreview) },
      ],
      confirmText: renewFromLoanId ? "Renovar" : isOngoing ? "Cadastrar" : "Criar",
    });
    if (!ok) return;

    setSaving(true);

    // Guard: caixa do dia do empréstimo precisa estar aberto (não exigir para importado)
    if (!isOngoing) {
      try {
        await assertCashOpen(loanDate);
      } catch (err: any) {
        toast.error(err?.message || "Caixa fechado para esta data");
        setSaving(false);
        return;
      }
    }

    // Guard: only 1 active loan per client (renewal allowed when targeting the existing active loan)
    const activeLoan = await getActiveLoanForClient(clientId!);
    if (activeLoan && (!renewFromLoanId || renewFromLoanId !== activeLoan.id)) {
      toast.error("Cliente já possui empréstimo ativo. Quite ou renove antes de criar outro.");
      setSaving(false);
      navigate(`/loans/${activeLoan.id}`);
      return;
    }

    const { data: { session } } = await supabase.auth.getSession();
    const userId = session?.user?.id;
    if (!userId) { toast.error("Sessão expirada"); setSaving(false); return; }

    // (renovação: o pagamento do antigo é registrado SÓ após o novo empréstimo estar criado com sucesso)


    // ===== Criar novo empréstimo =====
    const importedObs = isOngoing
      ? `Empréstimo em andamento cadastrado no sistema. Valor já pago antes do cadastro: ${formatCurrency(numAlreadyPaid)}.`
      : null;
    const finalObservation = [observation, importedObs].filter(Boolean).join("\n") || null;

    const { data: loan, error: loanError } = await supabase
      .from("loans")
      .insert({
        client_id: clientId!,
        amount: numAmount,
        interest_type: interestType,
        interest_value: numInterest,
        total_amount: calc.totalAmount,
        installment_count: numInstallments,
        payment_type: paymentType,
        loan_date: loanDate,
        first_due_date: paymentType !== "fixed_dates" ? firstDueDate : null,
        renewed_from_loan_id: renewFromLoanId || null,
        observation: finalObservation,
        user_id: userId,
        is_imported_ongoing: isOngoing,
        amount_already_paid: isOngoing ? numAlreadyPaid : 0,
        imported_at: isOngoing ? new Date().toISOString() : null,
        initial_remaining_balance: isOngoing ? ongoingRemaining : null,
      } as any)
      .select()
      .single();

    if (loanError || !loan) {
      console.error("Erro ao criar empréstimo:", loanError);
      toast.error(`Erro ao criar empréstimo${loanError?.message ? `: ${loanError.message}` : ""}`);
      setSaving(false);
      return;
    }

    const createdMovementIds: string[] = [];
    const createdEventIds: string[] = [];

    // Helper: rollback the just-created loan if any subsequent step fails.
    const rollbackLoan = async () => {
      try {
        if (createdEventIds.length > 0) await supabase.from("daily_events" as any).delete().in("id", createdEventIds as any);
        if (createdMovementIds.length > 0) await supabase.from("cash_movements").delete().in("id", createdMovementIds);
        await supabase.from("installments").delete().eq("loan_id", loan.id);
        await supabase.from("loans").delete().eq("id", loan.id);
        await recalculateCashBalanceFromLedger();
      } catch (e) {
        console.error("[NewLoan] rollback falhou:", e);
      }
    };

    // Para empréstimos importados, ajustar remaining_balance para refletir o saldo já abatido
    if (isOngoing && numAlreadyPaid > 0) {
      const { error: balErr } = await supabase
        .from("loans")
        .update({ remaining_balance: ongoingRemaining } as any)
        .eq("id", loan.id);
      if (balErr) {
        console.error("Erro ao ajustar saldo do empréstimo importado:", balErr);
        await rollbackLoan();
        toast.error(`Erro ao ajustar saldo: ${balErr.message}`);
        setSaving(false);
        return;
      }
    }

    // Build installments.
    // - Empréstimo NOVO: cria todas as parcelas (pending, paid_amount=0).
    // - Empréstimo EM ANDAMENTO (importado): cria apenas parcelas pendentes
    //   cuja soma seja igual ao saldo restante (última parcela pode ser menor).
    //   Não marca parcelas como pagas — o valor já pago é apenas ajuste inicial.
    let installments: any[];
    if (isOngoing) {
      const needed = ongoingPlan!.pendingCount;
      let dates = dueDates.slice(0, needed);
      if (dates.length < needed && (paymentType === "daily" || paymentType === "weekly" || paymentType === "biweekly" || paymentType === "monthly") && firstDueDate) {
        dates = generateDueDates(new Date(firstDueDate + "T12:00:00"), needed, paymentType);
      }
      installments = buildOngoingInstallments(loan.id, dates);
    } else {
      installments = dueDates.map((date, i) => ({
        loan_id: loan.id,
        number: i + 1,
        amount: calc.installmentAmount,
        due_date: format(date, "yyyy-MM-dd"),
        status: "pending",
        paid_amount: 0,
        paid_at: null,
      }));
    }


    if (installments.length === 0) {
      await rollbackLoan();
      toast.error("Erro ao criar parcelas. O empréstimo não foi salvo.");
      setSaving(false);
      return;
    }

    if (installments.length > 0) {
      const { error: instError } = await supabase.from("installments").insert(installments as any);
      if (instError) {
        console.error("Erro ao criar parcelas:", instError);
        await rollbackLoan();
        toast.error(`Erro ao criar parcelas. O empréstimo não foi salvo.${instError.message ? ` (${instError.message})` : ""}`);
        setSaving(false);
        return;
      }
    }

    // Para importados: NÃO movimentar caixa, NÃO criar daily_event de empréstimo novo.
    if (!isOngoing) {
      try {
        const interest = calc.totalAmount - numAmount;
        const cashOut = renewFromLoanId ? valorLiberado : numAmount;

        let movementId: string | null = null;
        if (cashOut > 0) {
          const mv = await createCashMovement({
            type: "emprestimo",
            amount: -cashOut,
            client_id: clientId!,
            loan_id: loan.id,
            observation: `${renewFromLoanId ? "Renovação - liberado" : "Empréstimo"} ${formatCurrency(cashOut)} para ${clientName}`,
            cash_date: loanDate,
          }) as any;
          movementId = mv?.id || null;
          if (!movementId) throw new Error("Movimentação de caixa não foi criada.");
          createdMovementIds.push(movementId);
        }

        const renewObs = renewFromLoanId
          ? `Renovação - ${clientName} - Pago: ${formatCurrency(renewPaid)} | Faltava: ${formatCurrency(faltaQuitar)} | Novo: ${formatCurrency(numAmount)} | Liberado: ${formatCurrency(valorLiberado)}`
          : `Novo empréstimo - ${clientName} - ${numInstallments}x ${formatCurrency(calc.installmentAmount)}`;

        const evt = await createDailyEvent({
          cash_date: loanDate,
          event_type: renewFromLoanId ? "renovacao" : "emprestimo_novo",
          client_id: clientId!,
          loan_id: loan.id,
          amount_in: 0,
          amount_out: cashOut,
          observation: renewObs,
          origin: "novo_emprestimo",
          cash_movement_id: movementId,
        }) as any;
        if (!evt?.id) throw new Error("Evento diário não foi criado.");
        createdEventIds.push(evt.id);

        if (movementId) await linkCashMovementToDailyEvent(movementId, evt.id);

        await updateCashBalance({
          available_cash: -cashOut,
          money_lent: numAmount,
          interest_receivable: interest,
        });
      } catch (err: any) {
        console.error("Erro ao criar movimentação/evento do empréstimo:", err);
        await rollbackLoan();
        toast.error(`Erro ao registrar movimentação financeira. O empréstimo não foi salvo.${err?.message ? ` (${err.message})` : ""}`);
        setSaving(false);
        return;
      }
    }

    // ===== RENOVAÇÃO: novo empréstimo já criado com sucesso → registra pagamento do antigo =====
    if (renewFromLoanId && renewPaid > 0) {
      try {
        await registerPayment({
          loanId: renewFromLoanId,
          amount: Math.min(renewPaid, faltaQuitar),
          clientId: clientId!,
          clientName: clientName,
          cashDate: loanDate,
          origin: "renovacao",
        });
      } catch (err: any) {
        console.error("Erro ao registrar pagamento da renovação:", err);
        await rollbackLoan();
        toast.error(`Erro ao registrar pagamento da renovação. Renovação cancelada.${err?.message ? ` (${err.message})` : ""}`);
        setSaving(false);
        return;
      }
    }

    // Se ainda restou saldo no antigo após o pagamento, quitar (absorvido pelo novo)
    if (renewFromLoanId) {
      const { data: oldLoanState } = await supabase
        .from("loans")
        .select("remaining_balance")
        .eq("id", renewFromLoanId)
        .single();
      const stillOwed = Number(oldLoanState?.remaining_balance) || 0;
      if (stillOwed > 0.01) {
        await settleLoan({
          loanId: renewFromLoanId,
          clientId: clientId!,
          clientName: clientName,
          cashDate: loanDate,
          origin: "renovacao",
        });
      } else {
        await supabase.from("loans").update({ status: "paid" }).eq("id", renewFromLoanId);
      }
      toast.success("Empréstimo renovado com sucesso!");
    } else if (isOngoing) {
      // ===== Empréstimo IMPORTADO (em andamento) =====
      // Regras: NÃO movimenta caixa, NÃO cria cash_movement, NÃO marca valor já pago como recebido.
      // O que falta receber entra em A Receber (money_lent + interest_receivable) e
      // gera um daily_event INFORMATIVO no histórico (amount_in=0, amount_out=0).
      try {
        const interestPortion = Math.max(0, calc.totalAmount - numAmount);
        const totalPaidBefore = Math.max(0, numAlreadyPaid);
        const interestPaid = Math.min(interestPortion, totalPaidBefore);
        const principalPaid = Math.max(0, totalPaidBefore - interestPaid);
        const principalReceivable = Math.max(0, numAmount - principalPaid);
        const interestReceivable = Math.max(0, interestPortion - interestPaid);

        await updateCashBalance({
          money_lent: principalReceivable,
          interest_receivable: interestReceivable,
        });

        const firstPending = ongoingPlan?.firstPendingNumber ?? null;
        const nextDueStr = paymentType !== "fixed_dates" ? firstDueDate : (fixedDates[0] || null);
        const importInfo = [
          `Empréstimo importado - ${clientName}`,
          `Valor original: ${formatCurrency(numAmount)}`,
          `Total com juros: ${formatCurrency(calc.totalAmount)}`,
          `Já pago antes do cadastro: ${formatCurrency(numAlreadyPaid)}`,
          `Valor a receber adicionado: ${formatCurrency(ongoingRemaining)}`,
          `Principal a receber: ${formatCurrency(principalReceivable)}`,
          `Juros a receber: ${formatCurrency(interestReceivable)}`,
          firstPending != null ? `Primeira parcela pendente: ${firstPending}` : null,
          nextDueStr ? `Próxima cobrança: ${nextDueStr}` : null,
        ].filter(Boolean).join(" | ");

        const evt = await createDailyEvent({
          cash_date: loanDate,
          event_type: "emprestimo_importado",
          client_id: clientId!,
          loan_id: loan.id,
          amount_in: 0,
          amount_out: 0,
          observation: importInfo,
          origin: "emprestimo_em_andamento",
        }) as any;
        if (!evt?.id) throw new Error("Evento informativo do empréstimo importado não foi criado.");
        createdEventIds.push(evt.id);
      } catch (err: any) {
        console.error("[NewLoan] Falha ao registrar empréstimo importado em A Receber:", err);
        await rollbackLoan();
        toast.error(`Erro ao registrar empréstimo importado no A Receber. O empréstimo não foi salvo.${err?.message ? ` (${err.message})` : ""}`);
        setSaving(false);
        return;
      }

      // Safety net: garante consistência total de A Receber a partir do ledger.
      try { await recalculateCashBalanceFromLedger(); } catch (e) { console.warn("[NewLoan] recalc ledger falhou:", e); }
      toast.success("Empréstimo em andamento cadastrado!");
    } else {
      toast.success("Empréstimo criado com sucesso!");
    }

    // Audit
    await logAction(
      renewFromLoanId ? "renovar_emprestimo" : "criar_emprestimo",
      "loan",
      loan.id,
      renewFromLoanId ? { from_loan_id: renewFromLoanId, falta_quitar: faltaQuitar } : null,
      {
        amount: numAmount,
        total_amount: calc.totalAmount,
        installment_count: numInstallments,
        payment_type: paymentType,
        loan_date: loanDate,
        released: renewFromLoanId ? valorLiberado : numAmount,
        ...(isOngoing ? {
          imported_ongoing: true,
          amount_already_paid: numAlreadyPaid,
          initial_remaining_balance: ongoingRemaining,
          first_pending_installment: ongoingPlan?.firstPendingNumber ?? null,
          partial_remaining: ongoingPlan?.partialRemaining ?? 0,
        } : {}),
      },
      renewFromLoanId ? `Renovação - ${clientName}` : isOngoing ? `Empréstimo em andamento - ${clientName}` : `Novo empréstimo - ${clientName}`,
    );


    draft.clear();
    navigate("/");
  };

  return (
    <div className="mx-auto max-w-lg p-4">
      {renewFromLoanId && (
        <div className="mb-4 rounded-lg border border-primary/30 bg-primary/5 p-3">
          <div className="flex items-center gap-2 mb-1">
            <RefreshCw className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold text-primary">Renovação de Empréstimo</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Falta para quitar empréstimo atual: <span className="font-bold text-foreground">{formatCurrency(faltaQuitar)}</span>
          </p>
        </div>
      )}
      {clientName && <p className="mb-4 text-sm text-muted-foreground">Cliente: <span className="font-medium text-foreground">{clientName}</span></p>}

      <div className="space-y-4">
        {!renewFromLoanId && (
          <div>
            <Label>Tipo de cadastro</Label>
            
            <div className="grid grid-cols-2 gap-2 mt-1">
              <button
                type="button"
                onClick={() => setRegistrationType("new")}
                className={`rounded-md border px-3 py-2 text-sm ${registrationType === "new" ? "bg-primary text-primary-foreground border-primary" : "bg-background"}`}
              >
                Empréstimo novo
              </button>
              <button
                type="button"
                onClick={() => setRegistrationType("ongoing")}
                className={`rounded-md border px-3 py-2 text-sm ${registrationType === "ongoing" ? "bg-primary text-primary-foreground border-primary" : "bg-background"}`}
              >
                Empréstimo em andamento
              </button>
            </div>
            {isOngoing && (
              <p className="text-[11px] text-muted-foreground mt-1">
                Cadastro de empréstimo antigo. Não exige caixa aberto e não movimenta o caixa de hoje.
              </p>
            )}
          </div>
        )}

        <div>
          <Label>Valor Emprestado (R$)</Label>
          <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Tipo de Juros</Label>
            <Select value={interestType} onValueChange={(v) => setInterestType(v as "percentage" | "fixed")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="percentage">Porcentagem (%)</SelectItem>
                <SelectItem value="fixed">Valor Fixo (R$)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>{interestType === "percentage" ? "Juros (%)" : "Juros (R$)"}</Label>
            <Input type="number" value={interestValue} onChange={(e) => setInterestValue(e.target.value)} placeholder="0" />
          </div>
        </div>

        <div>
          <Label>Tipo de Pagamento</Label>
          <Select value={paymentType} onValueChange={(v) => setPaymentType(v as typeof paymentType)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">Diário</SelectItem>
              <SelectItem value="weekly">Semanal</SelectItem>
              <SelectItem value="biweekly">Quinzenal</SelectItem>
              <SelectItem value="monthly">Mensal</SelectItem>
              <SelectItem value="fixed_dates">Data Fixa</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label>Quantidade de Parcelas</Label>
          <Input type="number" value={installmentCount} onChange={(e) => setInstallmentCount(e.target.value)} placeholder="0" />
        </div>

        <div>
          <Label>Data do Empréstimo</Label>
          <Input type="date" value={loanDate} onChange={(e) => setLoanDate(e.target.value)} />
        </div>

        {paymentType !== "fixed_dates" && (
          <div>
            <Label>{isOngoing ? "Data da próxima cobrança" : "Data do Primeiro Vencimento"}</Label>
            <Input type="date" value={firstDueDate} onChange={(e) => setFirstDueDate(e.target.value)} />
          </div>
        )}

        {paymentType === "fixed_dates" && numInstallments > 0 && (
          <div className="space-y-2">
            <Label>Datas de Vencimento</Label>
            {fixedDates.map((d, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-16 text-sm text-muted-foreground">Parcela {i + 1}</span>
                <Input type="date" value={d} onChange={(e) => handleFixedDateChange(i, e.target.value)} />
              </div>
            ))}
          </div>
        )}


        {renewFromLoanId && (
          <Card className="border-warning/40 bg-warning/5">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center text-base">
                <RefreshCw className="mr-2 h-4 w-4 text-warning" /> Pagamento na Renovação
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span>Falta para quitar:</span>
                <span className="font-bold">{formatCurrency(faltaQuitar)}</span>
              </div>
              <div>
                <Label>Valor pago na renovação (R$)</Label>
                <Input
                  type="number"
                  value={renewPaidAmount}
                  onChange={(e) => setRenewPaidAmount(e.target.value)}
                  placeholder="0,00"
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Quanto o cliente está pagando agora para abater o empréstimo atual.
                </p>
              </div>

              <div className="border-t pt-2 space-y-1">
                <div className="flex justify-between"><span>Pago agora:</span><span>{formatCurrency(renewPaid)}</span></div>
                <div className="flex justify-between"><span>Novo empréstimo:</span><span>{formatCurrency(numAmount)}</span></div>
                <div className="flex justify-between"><span>Absorvido p/ quitar antigo:</span><span>{formatCurrency(absorvidoDoNovo)}</span></div>
                <div className="flex justify-between font-bold">
                  <span>Liberado ao cliente:</span>
                  <span className={valorLiberado > 0 ? "text-success" : "text-muted-foreground"}>{formatCurrency(valorLiberado)}</span>
                </div>
                {!renovacaoQuita && (
                  <div className="flex items-start gap-1.5 mt-2 rounded border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>
                      Pago + novo empréstimo não cobrem o saldo de {formatCurrency(faltaQuitar)}. Faltam {formatCurrency(faltaQuitar - cobreAntigo)}.
                    </span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        <div>
          <Label>Observação (opcional)</Label>
          <Textarea
            value={observation}
            onChange={(e) => setObservation(e.target.value)}
            placeholder="Anote condições, garantias, contexto do empréstimo..."
            rows={3}
          />
        </div>

        {isOngoing && (
          <Card className="border-warning/40 bg-warning/5">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Empréstimo em andamento</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div>
                <Label>Valor já pago antes do cadastro (R$)</Label>
                <Input
                  type="number"
                  value={amountAlreadyPaid}
                  onChange={(e) => setAmountAlreadyPaid(e.target.value)}
                  placeholder="0,00"
                />
              </div>
              {calc && (
                <div className="border-t pt-2 space-y-1">
                  <div className="flex justify-between"><span>Valor total:</span><span>{formatCurrency(calc.totalAmount)}</span></div>
                  <div className="flex justify-between"><span>Já pago:</span><span>{formatCurrency(numAlreadyPaid)}</span></div>
                  <div className="flex justify-between font-bold">
                    <span>Saldo restante:</span>
                    <span className="text-primary">{formatCurrency(ongoingRemaining)}</span>
                  </div>

                  {ongoingPlan && ongoingRemaining > 0.01 && (
                    <div className="border-t pt-2 mt-2 space-y-1">
                      <div className="flex justify-between">
                        <span>Parcelas quitadas:</span>
                        <span className="font-medium">{ongoingPlan.fullPaid} de {numInstallments}</span>
                      </div>
                      {ongoingPlan.hasPartial && (
                        <>
                          <div className="flex justify-between">
                            <span>Parcela parcial:</span>
                            <span className="font-medium">#{ongoingPlan.firstPendingNumber}</span>
                          </div>
                          <div className="flex justify-between">
                            <span>Saldo da parcial:</span>
                            <span className="font-medium text-warning">{formatCurrency(ongoingPlan.partialRemaining)}</span>
                          </div>
                        </>
                      )}
                      <div className="flex justify-between">
                        <span>Próxima cobrança:</span>
                        <span className="font-medium">
                          Parcela #{ongoingPlan.firstPendingNumber}
                          {firstDueDate ? ` em ${format(new Date(firstDueDate + "T12:00:00"), "dd/MM/yyyy")}` : ""}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>Parcelas pendentes:</span>
                        <span className="font-medium">{ongoingPlan.pendingCount}</span>
                      </div>
                    </div>
                  )}

                  {numAlreadyPaid > calc.totalAmount + 0.01 && (
                    <div className="flex items-start gap-1.5 mt-2 rounded border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                      <span>Valor já pago é maior que o valor total do empréstimo.</span>
                    </div>
                  )}
                  {calc.totalAmount - numAlreadyPaid <= 0.01 && numAlreadyPaid > 0 && (
                    <div className="flex items-start gap-1.5 mt-2 rounded border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                      <span>Este empréstimo já está quitado.</span>
                    </div>
                  )}
                </div>

              )}
            </CardContent>
          </Card>
        )}

        {calc && (
          <Card className="border-primary/30 bg-accent">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center text-base">
                <Calculator className="mr-2 h-4 w-4" /> Cálculo Automático
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <div className="flex justify-between"><span>Valor emprestado:</span><span className="font-semibold">{formatCurrency(numAmount)}</span></div>
              <div className="flex justify-between"><span>Juros:</span><span className="font-semibold">{formatCurrency(calc.interest)}</span></div>
              <div className="flex justify-between border-t pt-1"><span className="font-bold">Valor final:</span><span className="font-bold text-primary">{formatCurrency(calc.totalAmount)}</span></div>
              <div className="flex justify-between"><span>Valor de cada parcela:</span><span className="font-semibold">{formatCurrency(calc.installmentAmount)}</span></div>
              {dueDates.length > 0 && (
                <div className="mt-2 border-t pt-2">
                  <p className="mb-1 font-medium">Vencimentos previstos:</p>
                  {dueDates.map((d, i) => (
                    <p key={i} className="text-muted-foreground">Parcela {i + 1}: {format(d, "dd/MM/yyyy")}</p>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <Button onClick={handleSave} disabled={saving} className="w-full" size="lg">
          {saving ? "Processando..." : renewFromLoanId ? "Renovar" : "Criar Empréstimo"}
        </Button>
      </div>
    </div>
  );
}
