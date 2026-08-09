/**
 * Normalização visual de valores monetários.
 *
 * O saldo oficial é SEMPRE o retornado pelo banco — aqui nada é recalculado,
 * apenas normalizado para exibição:
 * - arredonda para 2 casas;
 * - resíduos |x| < 0,005 viram 0;
 * - elimina o -0 do JavaScript;
 * - valores inválidos (NaN, null, undefined, texto) viram 0;
 * - negativos reais NUNCA são escondidos.
 */
export function normalizeMoney(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!isFinite(n)) return 0;
  if (Math.abs(n) < 0.005) return 0;
  const rounded = Math.round(n * 100) / 100;
  if (rounded === 0) return 0; // remove -0
  return rounded;
}
