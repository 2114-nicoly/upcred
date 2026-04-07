import { useState, useMemo, useEffect } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { calculateLoan, generateDueDates, formatCurrency } from "@/lib/loan-utils";
import { updateCashBalance, createCashMovement } from "@/lib/cash-utils";
import { createDailyEvent } from "@/lib/daily-events";
import { ArrowLeft, Calculator, RefreshCw } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

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
  const [paymentType, setPaymentType] = useState<"daily" | "weekly" | "biweekly" | "monthly" | "fixed_dates">("monthly");
  const [loanDate, setLoanDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [firstDueDate, setFirstDueDate] = useState("");
  const [fixedDates, setFixedDates] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const fetchClient = async () => {
      const { data } = await supabase.from("clients").select("name").eq("id", clientId!).single();
      if (data) setClientName(data.name);
    };
    fetchClient();
  }, [clientId]);

  // Pre-fill from renewal loan
  useEffect(() => {
    if (!renewFromLoanId) return;
    const fetchRenewalLoan = async () => {
      const { data } = await supabase.from("loans").select("amount, interest_type, interest_value, payment_type, installment_count").eq("id", renewFromLoanId).single();
      if (data) {
        setAmount(String(data.amount));
        setInterestType(data.interest_type as "percentage" | "fixed");
        setInterestValue(String(data.interest_value));
        setPaymentType(data.payment_type as typeof paymentType);
        setInstallmentCount(String(data.installment_count));
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

  useMemo(() => {
    if (paymentType === "fixed_dates" && numInstallments > 0) {
      setFixedDates((prev) => {
        const arr = [...prev];
        while (arr.length < numInstallments) arr.push("");
        return arr.slice(0, numInstallments);
      });
    }
  }, [numInstallments, paymentType]);

  const handleSave = async () => {
    if (!calc || numInstallments <= 0) { toast.error("Preencha todos os campos"); return; }
    if (paymentType !== "fixed_dates" && !firstDueDate) { toast.error("Informe a data do primeiro vencimento"); return; }
    if (paymentType === "fixed_dates" && fixedDates.some((d) => !d)) { toast.error("Preencha todas as datas de vencimento"); return; }

    setSaving(true);

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

    // Update cash balance
    const interest = calc.totalAmount - numAmount;
    await updateCashBalance({
      available_cash: -numAmount,
      money_lent: numAmount,
      interest_receivable: interest,
    });

    // Create cash movement
    await createCashMovement({
      type: "emprestimo",
      amount: -numAmount,
      client_id: clientId!,
      loan_id: loan.id,
      observation: `${renewFromLoanId ? "Renovação" : "Empréstimo"} de ${formatCurrency(numAmount)} para ${clientName}`,
      cash_date: loanDate,
    });

    // If renewal, close old loan
    if (renewFromLoanId) {
      // Mark all unpaid installments as paid (closed)
      const { data: unpaidInsts } = await supabase
        .from("installments").select("*")
        .eq("loan_id", renewFromLoanId).neq("status", "paid");

      if (unpaidInsts && unpaidInsts.length > 0) {
        const now = new Date().toISOString();
        for (const inst of unpaidInsts) {
          await supabase.from("installments").update({
            status: "paid",
            paid_amount: Number(inst.amount),
            paid_at: now,
          }).eq("id", inst.id);
        }

        // Calculate remaining balances for old loan
        const { data: oldLoan } = await supabase.from("loans").select("amount, total_amount, client_id").eq("id", renewFromLoanId).single();
        if (oldLoan) {
          const regularUnpaid = unpaidInsts.filter((i: any) => !i.is_penalty);
          const penaltyUnpaid = unpaidInsts.filter((i: any) => i.is_penalty);

          let totalRegular = 0;
          for (const i of regularUnpaid) {
            totalRegular += Number(i.amount) - Number(i.paid_amount);
          }
          let totalPenalty = 0;
          for (const i of penaltyUnpaid) {
            totalPenalty += Number(i.amount) - Number(i.paid_amount);
          }

          if (totalRegular > 0) {
            const loanInterest = Number(oldLoan.total_amount) - Number(oldLoan.amount);
            const { data: allOldInsts } = await supabase
              .from("installments").select("paid_amount")
              .eq("loan_id", renewFromLoanId).eq("is_penalty", false);
            const totalPaidNow = (allOldInsts || []).reduce((s: number, i: any) => s + Number(i.paid_amount), 0);
            const totalPaidBefore = totalPaidNow - totalRegular;
            const interestRemaining = Math.max(0, loanInterest - totalPaidBefore);
            const toInterest = Math.min(totalRegular, interestRemaining);
            const toPrincipal = totalRegular - toInterest;

            await updateCashBalance({
              available_cash: totalRegular,
              interest_receivable: -toInterest,
              money_lent: -toPrincipal,
            });
            await createCashMovement({
              type: "recebimento_normal", amount: totalRegular,
              client_id: clientId!, loan_id: renewFromLoanId,
              observation: `Quitação por renovação - ${clientName}`,
              cash_date: loanDate,
            });
          }
          if (totalPenalty > 0) {
            await updateCashBalance({ available_cash: totalPenalty, penalty_receivable: -totalPenalty });
            await createCashMovement({
              type: "recebimento_multa", amount: totalPenalty,
              client_id: clientId!, loan_id: renewFromLoanId,
              observation: `Quitação multa por renovação - ${clientName}`,
              cash_date: loanDate,
            });
          }
        }
      }

      await supabase.from("loans").update({ status: "paid" }).eq("id", renewFromLoanId);
      toast.success("Empréstimo renovado com sucesso!");
    } else {
      toast.success("Empréstimo criado com sucesso!");
    }
    navigate("/");
  };

  return (
    <div className="mx-auto max-w-lg p-4">
      {renewFromLoanId && (
        <div className="mb-4 rounded-lg border border-primary/30 bg-primary/5 p-3 flex items-center gap-2">
          <RefreshCw className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium text-primary">Renovação de Empréstimo</span>
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
          {saving ? "Processando..." : renewFromLoanId ? "Renovar Empréstimo" : "Criar Empréstimo"}
        </Button>
      </div>
    </div>
  );
}
