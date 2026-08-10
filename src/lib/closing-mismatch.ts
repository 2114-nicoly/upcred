/**
 * Leitura da mensagem de divergência de fechamento vinda do banco
 * (_assert_closing_consistency). A mensagem original NUNCA é escondida:
 * ela é exibida junto do detalhamento numérico.
 */
import { formatCurrency } from "@/lib/loan-utils";

export type ClosingMismatch = {
  opening: number;
  dayNet: number;
  expected: number;
  available: number;
  difference: number;
};

const NUM = /-?\d+(?:\.\d+)?/g;

/** Extrai abertura, movimento do dia, disponível e diferença da mensagem do banco. */
export function parseClosingMismatch(message: unknown): ClosingMismatch | null {
  const msg = String((message as any)?.message ?? message ?? "");
  if (!/Fechamento cancelado: saldo de abertura/i.test(msg)) return null;
  const nums = msg.match(NUM);
  if (!nums || nums.length < 4) return null;
  const [opening, dayNet, available, difference] = nums.slice(0, 4).map(Number);
  if ([opening, dayNet, available, difference].some(n => !Number.isFinite(n))) return null;
  return {
    opening,
    dayNet,
    expected: Math.round((opening + dayNet) * 100) / 100,
    available,
    difference,
  };
}

/** Texto completo exibido ao usuário, incluindo a mensagem original do banco. */
export function formatClosingMismatch(message: unknown): string | null {
  const m = parseClosingMismatch(message);
  if (!m) return null;
  const original = String((message as any)?.message ?? message ?? "");
  return [
    "Não foi possível fechar o caixa.",
    `Caixa inicial: ${formatCurrency(m.opening)}.`,
    `Movimento líquido do dia: ${formatCurrency(m.dayNet)}.`,
    `Caixa esperado: ${formatCurrency(m.expected)}.`,
    `Caixa gravado: ${formatCurrency(m.available)}.`,
    `Diferença: ${formatCurrency(m.difference)}.`,
    "O caixa continua aberto para conferência.",
    "",
    `Mensagem do banco: ${original}`,
  ].join("\n");
}
