/**
 * Comparação de nomes em português brasileiro: ignora maiúsculas/minúsculas
 * e acentos ("Ágata" fica junto de "Ana", antes de "Bruno"). Em nomes iguais
 * ao ignorar acentos, usa comparação completa como critério secundário
 * determinístico, sem alterar os registros.
 */
export function compareNamesPtBr(
  a: string | null | undefined,
  b: string | null | undefined
): number {
  const an = (a ?? "").trim();
  const bn = (b ?? "").trim();
  const base = an.localeCompare(bn, "pt-BR", { sensitivity: "base", numeric: true });
  if (base !== 0) return base;
  return an.localeCompare(bn, "pt-BR", { sensitivity: "variant", numeric: true });
}
