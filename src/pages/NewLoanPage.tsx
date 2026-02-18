import { useState, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { calculateLoan, generateDueDates, formatCurrency } from "@/lib/loan-utils";
import { ArrowLeft, Calculator } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

export default function NewLoanPage() {
  const { clientId } = useParams();
  const navigate = useNavigate();

  const [amount, setAmount] = useState("");
  const [interestType, setInterestType] = useState<"percentage" | "fixed">("percentage");
  const [interestValue, setInterestValue] = useState("");
  const [installmentCount, setInstallmentCount] = useState("");
  const [paymentType, setPaymentType] = useState<"daily" | "weekly" | "biweekly" | "monthly" | "fixed_dates">("monthly");
  const [loanDate, setLoanDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [firstDueDate, setFirstDueDate] = useState("");
  const [fixedDates, setFixedDates] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const numAmount = parseFloat(amount) || 0;
  const numInterest = parseFloat(interestValue) || 0;
  const numInstallments = parseInt(installmentCount) || 0;

  const calc = useMemo(() => {
    if (numAmount <= 0 || numInstallments <= 0) return null;
    return calculateLoan(numAmount, interestType, numInterest, numInstallments);
  }, [numAmount, interestType, numInterest, numInstallments]);

  const dueDates = useMemo(() => {
    if (paymentType === "fixed_dates") return fixedDates.map((d) => new Date(d));
    if (!firstDueDate || numInstallments <= 0) return [];
    return generateDueDates(new Date(firstDueDate), numInstallments, paymentType);
  }, [firstDueDate, numInstallments, paymentType, fixedDates]);

  const handleFixedDateChange = (index: number, value: string) => {
    const newDates = [...fixedDates];
    newDates[index] = value;
    setFixedDates(newDates);
  };

  // Update fixedDates array when installment count changes for fixed_dates type
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
    if (!calc || numInstallments <= 0) {
      toast.error("Preencha todos os campos");
      return;
    }

    if (paymentType !== "fixed_dates" && !firstDueDate) {
      toast.error("Informe a data do primeiro vencimento");
      return;
    }

    if (paymentType === "fixed_dates" && fixedDates.some((d) => !d)) {
      toast.error("Preencha todas as datas de vencimento");
      return;
    }

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
      })
      .select()
      .single();

    if (loanError || !loan) {
      toast.error("Erro ao criar empréstimo");
      setSaving(false);
      return;
    }

    const installments = dueDates.map((date, i) => ({
      loan_id: loan.id,
      number: i + 1,
      amount: calc.installmentAmount,
      due_date: format(date, "yyyy-MM-dd"),
      status: "pending" as const,
    }));

    const { error: instError } = await supabase.from("installments").insert(installments);

    if (instError) {
      toast.error("Erro ao criar parcelas");
      setSaving(false);
      return;
    }

    toast.success("Empréstimo criado com sucesso!");
    navigate(`/loans/${loan.id}`);
  };

  return (
    <div className="mx-auto max-w-lg p-4">
      <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="mb-2">
        <ArrowLeft className="mr-1 h-4 w-4" /> Voltar
      </Button>

      <h1 className="mb-4 text-2xl font-bold">Novo Empréstimo</h1>

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
          <Label>Quantidade de Parcelas</Label>
          <Input type="number" value={installmentCount} onChange={(e) => setInstallmentCount(e.target.value)} placeholder="0" />
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

        {/* Preview do cálculo */}
        {calc && (
          <Card className="border-primary/30 bg-accent">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center text-base">
                <Calculator className="mr-2 h-4 w-4" /> Cálculo Automático
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span>Valor emprestado:</span>
                <span className="font-semibold">{formatCurrency(numAmount)}</span>
              </div>
              <div className="flex justify-between">
                <span>Juros:</span>
                <span className="font-semibold">{formatCurrency(calc.interest)}</span>
              </div>
              <div className="flex justify-between border-t pt-1">
                <span className="font-bold">Valor final:</span>
                <span className="font-bold text-primary">{formatCurrency(calc.totalAmount)}</span>
              </div>
              <div className="flex justify-between">
                <span>Valor de cada parcela:</span>
                <span className="font-semibold">{formatCurrency(calc.installmentAmount)}</span>
              </div>
              {dueDates.length > 0 && (
                <div className="mt-2 border-t pt-2">
                  <p className="mb-1 font-medium">Vencimentos previstos:</p>
                  {dueDates.map((d, i) => (
                    <p key={i} className="text-muted-foreground">
                      Parcela {i + 1}: {format(d, "dd/MM/yyyy")}
                    </p>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <Button onClick={handleSave} disabled={saving} className="w-full" size="lg">
          {saving ? "Salvando..." : "Criar Empréstimo"}
        </Button>
      </div>
    </div>
  );
}
