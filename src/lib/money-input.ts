import { z } from "zod";

/** Editable text only. Never use this parser on numeric ledger metadata. */
export const moneyInputSchema = z.string().trim().max(40).transform((text, ctx) => {
  const raw = text.replace(/^R\$\s*/, "");
  // A bare thousand separator ("2.000") is ambiguous: require "2.000,00".
  const brazilian = /^-?(?:\d+|\d{1,3}(?:\.\d{3})+),\d{1,2}$/;
  const plain = /^-?\d+(?:[,.]\d{1,2})?$/;
  if (!brazilian.test(raw) && !plain.test(raw)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Informe um valor válido, como 1.250,75, com até duas casas decimais." });
    return z.NEVER;
  }
  const normalized = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
  const [whole, fraction = ""] = normalized.replace(/^-/, "").split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Valor monetário fora do limite permitido." });
    return z.NEVER;
  }
  return (normalized.startsWith("-") ? -cents : cents) / 100;
});

export function parseMoneyInput(text: string): number | null {
  const result = moneyInputSchema.safeParse(text);
  return result.success ? result.data : null;
}

/** Defaults from numeric values, not from operator text. */
export function formatMoneyInput(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}