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
import { updateCashBalance, createCashMovement, linkCashMovementToDailyEvent } from "@/lib/cash-utils";
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

  // Renewal data
  const [renewOldRemaining, setRenewOldRemaining] = useState<number>(0);
  const [renewPaidAmount, setRenewPaidAmount] = useState<string>("");

  const confirm = useConfirm();
  const draftKey = renewFromLoanId ? `renew:${renewFromLoanId}` : `new-loan:${clientId ?? "x"}`;
  const draftValue = {
    amount, interestType, interestValue, installmentCount, paymentType,
    loanDate, firstDueDate, fixedDates, observation, renewPaidAmount,
  };
  const draft = useFormDraft(draftKey, draftValue);
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    const saved = draft.restore();
    if (saved) {
      restoredRef.current = true;
      setAmount(saved.amount ?? "");
      setInterestType(saved.interestType ?? "percentage");
      setInterestValue(saved.interestValue ?? "");
      setInstallmentCount(saved.installmentCount ?? "");
      setPaymentType(saved.paymentType ?? "daily");
      setLoanDate(saved.loanDate ?? format(new Date(), "yyyy-MM-dd"));
      setFirstDueDate(saved.firstDueDate ?? "");
      setFixedDates(saved.fixedDates ?? []);
      setObservation(saved.observation ?? "");
      setRenewPaidAmount(saved.renewPaidAmount ?? "");
      toast.info("Rascunho restaurado", {
        action: { label: "Descartar", onClick: () => { draft.clear(); window.location.reload(); } },
      });
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

  const dueDates = useMemo(() => {
    if (paymentType === "fixed_dates") return fixedDates.filter((d) => d).map((d) => new Date(d + "T12:00:00"));
    if (!firstDueDate || numInstallments <= 0) return [];
    return generateDueDates(new Date(firstDueDate + "T12:00:00"), numInstallments, paymentType);
  }, [firstDueDate, numInstallments, paymentType, fixedDates]);

  const handleFixedDateChange = (index: number, value: string) => {
    const newDates = [...fixedDates];
    newDates[index] = value;
    setFixedDates(newDates);
  };

  useEffect(() => {
    if (paymentType === "fixed_dates" && numInstallments > 0) {
      setFixedDates((prev) => {
        const arr = [...prev];
        while (arr.length < numInstallments) arr.push("");
        return arr.slice(0, numInstallments);
      });
    }
  }, [numInstallments, paymentType]);

  // Renewal computed values
  const renewPaid = parseFloat(renewPaidAmount) || 0;
  const faltaQuitar = renewOldRemaining;
  // Quanto do principal do novo empréstimo será absorvido para quitar o antigo
  const absorvidoDoNovo = renewFromLoanId ? Math.max(0, faltaQuitar - renewPaid) : 0;
  // Dinheiro real liberado ao cliente
  const valorLiberado = renewFromLoanId ? Math.max(0, numAmount - absorvidoDoNovo) : numAmount;
  // Quanto a renovação consegue cobrir do antigo
  const cobreAntigo = renewPaid + numAmount;
  const renovacaoQuita = renewFromLoanId ? cobreAntigo + 0.01 >= faltaQuitar : true;

  const handleSave = async () => {
    if (!calc || numInstallments <= 0) { toast.error("Preencha todos os campos"); return; }
    if (paymentType !== "fixed_dates" && !firstDueDate) { toast.error("Informe a data do primeiro vencimento"); return; }
    if (paymentType === "fixed_dates" && fixedDates.some((d) => !d)) { toast.error("Preencha todas as datas de vencimento"); return; }

    if (renewFromLoanId && !renovacaoQuita) {
      toast.error(`Renovação insuficiente. Faltam ${formatCurrency(faltaQuitar - cobreAntigo)} para quitar o empréstimo atual.`);
      return;
    }

    // Confirmação para ações sensíveis: renovação ou liberação alta
    const cashOutPreview = renewFromLoanId ? valorLiberado : numAmount;
    const ok = await confirm({
      title: renewFromLoanId ? "Confirmar renovação?" : "Confirmar novo empréstimo?",
      description: renewFromLoanId
        ? "Esta ação encerra o contrato atual e abre um novo."
        : "Esta ação libera dinheiro e cria parcelas.",
      affected: [
        { label: "Cliente", value: clientName },
        { label: "Valor", value: formatCurrency(numAmount) },
        { label: "Parcelas", value: `${numInstallments}x ${formatCurrency(calc.installmentAmount)}` },
        { label: "Liberado em caixa", value: formatCurrency(cashOutPreview) },
      ],
      confirmText: renewFromLoanId ? "Renovar" : "Criar",
    });
    if (!ok) return;

    setSaving(true);

    // Guard: caixa do dia do empréstimo precisa estar aberto
    try {
      await assertCashOpen(loanDate);
    } catch (err: any) {
      toast.error(err?.message || "Caixa fechado para esta data");
      setSaving(false);
      return;
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

    // ===== RENOVAÇÃO: registrar pagamento em dinheiro do cliente no antigo (se houver) =====
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
      } catch (err) {
        console.error("Erro ao registrar pagamento da renovação:", err);
        toast.error("Erro ao registrar pagamento da renovação");
        setSaving(false);
        return;
      }
    }

    // ===== Criar novo empréstimo =====
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
        observation: observation || null,
        user_id: userId,
      } as any)
      .select()
      .single();

    if (loanError || !loan) { toast.error("Erro ao criar empréstimo"); setSaving(false); return; }

    const installments = dueDates.map((date, i) => ({
      loan_id: loan.id,
      number: i + 1,
      amount: calc.installmentAmount,
      due_date: format(date, "yyyy-MM-dd"),
      status: "pending" as const,
    }));

    const { error: instError } = await supabase.from("installments").insert(installments);
    if (instError) { toast.error("Erro ao criar parcelas"); setSaving(false); return; }

    // Cash balance: empréstimo novo sai numAmount em caixa.
    // Renovação: o que sai do caixa real é apenas valorLiberado.
    const interest = calc.totalAmount - numAmount;
    const cashOut = renewFromLoanId ? valorLiberado : numAmount;
    await updateCashBalance({
      available_cash: -cashOut,
      money_lent: numAmount,
      interest_receivable: interest,
    });

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
    if (movementId && evt?.id) {
      await linkCashMovementToDailyEvent(movementId, evt.id);
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
      },
      renewFromLoanId ? `Renovação - ${clientName}` : `Novo empréstimo - ${clientName}`,
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
            <Label>Data do Primeiro Vencimento</Label>
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
