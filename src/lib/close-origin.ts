/**
 * Origem do fechamento do caixa diário (`daily_cash.close_origin`).
 *
 * - `manual`                 → fechado pelo trabalhador/administrador.
 * - `automatic_opened`       → estava aberto e foi fechado pela rotina do servidor.
 * - `automatic_not_opened`   → nunca foi aberto; a rotina criou o dia já fechado.
 *
 * Fechamentos automáticos são sempre somente leitura: para alterar o dia é
 * obrigatório o fluxo de solicitação de reabertura.
 */
export type CloseOrigin =
  | "manual"
  | "automatic_opened"
  | "automatic_not_opened"
  | "legacy_auto_reconciliation";

export const CLOSE_ORIGIN_LABEL: Record<CloseOrigin, string> = {
  manual: "Fechado manualmente",
  automatic_opened: "Fechado automaticamente",
  automatic_not_opened: "Caixa não foi aberto e foi fechado automaticamente",
  legacy_auto_reconciliation: "Fechado automaticamente — histórico antigo incompleto",
};

export function normalizeCloseOrigin(value?: string | null): CloseOrigin {
  return value === "automatic_opened" ||
    value === "automatic_not_opened" ||
    value === "legacy_auto_reconciliation"
    ? value
    : "manual";
}

/** Rótulo exibível da origem do fechamento (padrão: manual). */
export function getCloseOriginLabel(value?: string | null): string {
  return CLOSE_ORIGIN_LABEL[normalizeCloseOrigin(value)];
}

/** Fechamentos automáticos nunca podem ser editados diretamente. */
export function isAutomaticClose(value?: string | null): boolean {
  return normalizeCloseOrigin(value) !== "manual";
}

/** Dias antigos reconciliados não possuem histórico congelado completo. */
export function isLegacyIncompleteClose(value?: string | null): boolean {
  return normalizeCloseOrigin(value) === "legacy_auto_reconciliation";
}

