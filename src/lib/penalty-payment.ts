/**
 * Decisão pura do modal PAGOU da Rota do Dia quando há multa.
 * - multa = 0 → fluxo normal (registerPayment), sem escolha extra.
 * - multa > 0 → exige escolha explícita entre "Parcela + multa" e "Somente multa".
 */
export type PenaltyMode = "regular_and_penalty" | "penalty_only";

export type PenaltyPaymentPlan =
  | { kind: "invalid"; error: string }
  | { kind: "normal"; regular: number }
  | { kind: "needs_mode" }
  | { kind: "regular_and_penalty"; regular: number; penalty: number }
  | { kind: "penalty_only"; regular: 0; penalty: number };

export const PENALTY_MODE_REQUIRED_MESSAGE =
  "Escolha se o cliente pagou a parcela junto com a multa ou somente a multa.";

export function parsePenaltyInput(raw: string): number | null {
  if (!raw || !raw.trim()) return 0;
  const n = Number(raw.replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

export function resolvePenaltyPaymentPlan(input: {
  penaltyRaw: string;
  mode: PenaltyMode | null;
  regularAmount: number;
}): PenaltyPaymentPlan {
  const penalty = parsePenaltyInput(input.penaltyRaw);
  if (penalty === null) return { kind: "invalid", error: "Valor de multa inválido" };
  if (penalty <= 0) return { kind: "normal", regular: input.regularAmount };
  if (!input.mode) return { kind: "needs_mode" };
  if (input.mode === "penalty_only") return { kind: "penalty_only", regular: 0, penalty };
  if (!(input.regularAmount > 0)) return { kind: "invalid", error: "Informe o valor da parcela." };
  return { kind: "regular_and_penalty", regular: input.regularAmount, penalty };
}

export function newOperationId(): string {
  return crypto.randomUUID();
}
