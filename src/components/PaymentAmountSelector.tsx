import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Minus, Plus } from "lucide-react";
import { formatCurrency } from "@/lib/loan-utils";
import {
  PaymentAmountState,
  computePaymentAmount,
  describeManualAmount,
  describeManualAmountLabel,
  suggestedPartialObservation,
  validatePaymentAmount,
} from "@/lib/payment-amount";

type Props = {
  /** Valor CHEIO da próxima parcela regular (nunca amount - paid_amount). */
  installmentAmount: number;
  /** Saldo devedor do empréstimo. */
  remainingBalance: number;
  state: PaymentAmountState;
  onChange: (next: PaymentAmountState) => void;
  disabled?: boolean;
};

export default function PaymentAmountSelector({
  installmentAmount,
  remainingBalance,
  state,
  onChange,
  disabled,
}: Props) {
  const base = Number(installmentAmount || 0);
  const amount = computePaymentAmount(state, base);
  const { error } = validatePaymentAmount(state, base, remainingBalance);
  const manualInfo = describeManualAmount(amount, base);

  const setQuantity = (qty: number) => {
    const q = Math.max(1, Math.floor(qty || 1));
    onChange({ ...state, quantity: q });
  };

  const setManual = (value: string) => {
    const next: PaymentAmountState = { ...state, manualValue: value };
    const nextAmount = computePaymentAmount(next, base);
    const info = describeManualAmount(nextAmount, base);
    if (!state.observationTouched) {
      next.observation = info.isBroken && nextAmount > 0
        ? suggestedPartialObservation(nextAmount)
        : "";
    }
    onChange(next);
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          size="sm"
          variant={state.mode === "quantity" ? "default" : "outline"}
          disabled={disabled}
          onClick={() => onChange({ ...state, mode: "quantity" })}
        >
          Por quantidade
        </Button>
        <Button
          type="button"
          size="sm"
          variant={state.mode === "manual" ? "default" : "outline"}
          disabled={disabled}
          onClick={() => onChange({ ...state, mode: "manual" })}
        >
          Digitar valor
        </Button>
      </div>

      {state.mode === "quantity" ? (
        <div className="space-y-2">
          <Label>Quantidade de parcelas</Label>
          <div className="flex items-center gap-2">
            <Button
              type="button" size="icon" variant="outline" disabled={disabled || state.quantity <= 1}
              aria-label="Diminuir quantidade"
              onClick={() => setQuantity(state.quantity - 1)}
            >
              <Minus className="h-4 w-4" />
            </Button>
            <Input
              type="number"
              min={1}
              className="text-center"
              value={String(state.quantity)}
              disabled={disabled}
              onChange={(e) => setQuantity(parseInt(e.target.value, 10))}
            />
            <Button
              type="button" size="icon" variant="outline" disabled={disabled}
              aria-label="Aumentar quantidade"
              onClick={() => setQuantity(state.quantity + 1)}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Valor da parcela: {formatCurrency(base)}
          </p>
          <p className="text-sm font-medium">
            {state.quantity} × {formatCurrency(base)} = {formatCurrency(amount)}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <Label>Valor recebido</Label>
          <Input
            inputMode="decimal"
            placeholder="Ex.: 125,50"
            value={state.manualValue}
            disabled={disabled}
            onChange={(e) => setManual(e.target.value)}
          />
          {amount > 0 && (
            <div className="space-y-1">
              <p className="text-sm font-medium">{formatCurrency(amount)}</p>
              <p className="text-xs text-muted-foreground">
                {describeManualAmountLabel(amount, base)}
              </p>
              {manualInfo.isBroken && (
                <p className="text-xs text-warning">Pagamento parcial / valor quebrado</p>
              )}
            </div>
          )}
        </div>
      )}

      <div className="space-y-1">
        <Label>Observação do pagamento (opcional)</Label>
        <Textarea
          rows={2}
          value={state.observation}
          disabled={disabled}
          onChange={(e) => onChange({ ...state, observation: e.target.value, observationTouched: true })}
        />
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
