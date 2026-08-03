import { formatCurrency } from "@/lib/loan-utils";

/**
 * Seletor de pagamento: por QUANTIDADE de parcelas (quantidade × valor CHEIO
 * da parcela) ou por VALOR MANUAL digitado.
 *
 * Regras:
 * - a quantidade SEMPRE multiplica o valor cheio (`amount`) da parcela,
 *   nunca o saldo pendente (`amount - paid_amount`);
 * - multas NUNCA entram neste cálculo (campo separado);
 * - o total nunca pode ultrapassar o `remaining_balance` do empréstimo.
 */

export type PaymentAmountMode = "quantity" | "manual";

export type PaymentAmountState = {
  mode: PaymentAmountMode;
  quantity: number;
  manualValue: string;
  observation: string;
  /** true quando o usuário editou/apagou a observação sugerida */
  observationTouched?: boolean;
};

export const initialPaymentAmountState: PaymentAmountState = {
  mode: "quantity",
  quantity: 1,
  manualValue: "",
  observation: "",
  observationTouched: false,
};

export function createPaymentAmountState(): PaymentAmountState {
  return { ...initialPaymentAmountState };
}

/** Aceita "125", "125,50" e "125.50". Retorna null quando inválido. */
export function parseAmountInput(input: string): number | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/\s/g, "").replace(/\./g, (m, i, s) =>
    s.includes(",") ? "" : m,
  ).replace(",", ".");
  const value = Number(normalized);
  if (!isFinite(value) || isNaN(value)) return null;
  return value;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Valor do pagamento conforme o modo selecionado. */
export function computePaymentAmount(
  state: PaymentAmountState,
  installmentAmount: number,
): number {
  if (state.mode === "quantity") {
    const qty = Math.floor(Number(state.quantity) || 0);
    if (qty <= 0) return 0;
    return round2(qty * Number(installmentAmount || 0));
  }
  const parsed = parseAmountInput(state.manualValue);
  if (parsed === null) return 0;
  return round2(parsed);
}

/** "Equivale a 2 parcelas completas + R$ 25,00" */
export function describeManualAmount(amount: number, installmentAmount: number) {
  const base = Number(installmentAmount || 0);
  if (base <= 0 || amount <= 0) {
    return { fullCount: 0, rest: round2(amount), isBroken: amount > 0 };
  }
  const fullCount = Math.floor(round2(amount) / base + 1e-9);
  const rest = round2(round2(amount) - fullCount * base);
  return { fullCount, rest, isBroken: rest > 0.001 };
}

export function describeManualAmountLabel(amount: number, installmentAmount: number) {
  const { fullCount, rest } = describeManualAmount(amount, installmentAmount);
  if (fullCount <= 0) return `Pagamento parcial de ${formatCurrency(amount)}`;
  const plural = fullCount === 1 ? "parcela completa" : "parcelas completas";
  return rest > 0.001
    ? `Equivale a ${fullCount} ${plural} + ${formatCurrency(rest)}`
    : `Equivale a ${fullCount} ${plural}`;
}

export function suggestedPartialObservation(amount: number) {
  return `Pagamento parcial — valor informado manualmente: ${formatCurrency(amount)}.`;
}

export type PaymentAmountValidation = {
  amount: number;
  error: string | null;
  valid: boolean;
};

export function validatePaymentAmount(
  state: PaymentAmountState,
  installmentAmount: number,
  remainingBalance: number,
): PaymentAmountValidation {
  const amount = computePaymentAmount(state, installmentAmount);
  if (amount <= 0) {
    return { amount, error: "Informe um valor válido", valid: false };
  }
  const balance = Number(remainingBalance || 0);
  if (balance > 0 && amount > round2(balance) + 0.009) {
    return {
      amount,
      error:
        `O total (${formatCurrency(amount)}) ultrapassa o saldo devedor (${formatCurrency(balance)}). ` +
        `Reduza a quantidade, use "Digitar valor" ou "Quitar empréstimo".`,
      valid: false,
    };
  }
  return { amount, error: null, valid: true };
}

/** Observação final enviada ao registerPayment (undefined quando vazia). */
export function resolveObservation(
  state: PaymentAmountState,
  installmentAmount: number,
): string | undefined {
  const text = (state.observation ?? "").trim();
  return text ? text : undefined;
}
