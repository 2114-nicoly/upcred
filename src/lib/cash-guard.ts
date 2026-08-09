import { normalizeMoney } from "@/lib/money";

/**
 * Erro estruturado CASH_INSUFFICIENT emitido pelo banco.
 * O frontend NUNCA recalcula o saldo: apenas lê o que o banco informou.
 */
export type CashInsufficient = {
  code: "CASH_INSUFFICIENT";
  available_cash: number;
  operation_amount: number;
  missing_amount: number;
};

function pick(obj: any, key: string): any {
  return obj && typeof obj === "object" ? obj[key] : undefined;
}

/**
 * Detecta e extrai o payload estruturado de saldo insuficiente.
 * Retorna null quando o erro é de outra natureza.
 */
export function parseCashInsufficient(error: any): CashInsufficient | null {
  if (!error) return null;
  const hint = String(pick(error, "hint") ?? "");
  const detailRaw = pick(error, "details") ?? pick(error, "detail") ?? "";
  const message = String(pick(error, "message") ?? "");
  const blob = `${hint} ${detailRaw} ${message}`;
  if (!blob.includes("CASH_INSUFFICIENT") && !/saldo insuficiente no caixa/i.test(message)) {
    return null;
  }

  let parsed: any = null;
  const detail = String(detailRaw ?? "");
  const start = detail.indexOf("{");
  if (start >= 0) {
    try {
      parsed = JSON.parse(detail.slice(start));
    } catch {
      parsed = null;
    }
  }

  const num = (v: any) => normalizeMoney(v);
  if (parsed && parsed.code === "CASH_INSUFFICIENT") {
    return {
      code: "CASH_INSUFFICIENT",
      available_cash: num(parsed.available_cash),
      operation_amount: Math.abs(num(parsed.operation_amount)),
      missing_amount: Math.abs(num(parsed.missing_amount)),
    };
  }

  // Fallback: extrai os três valores da mensagem padronizada do banco.
  const nums = message.match(/R\$\s*(-?[\d.]+,?\d*)/g) || [];
  const toNumber = (s: string) => {
    const raw = s.replace(/R\$\s*/, "").trim().replace(/[^\d,.-]+$/, "").replace(/[.,]$/, "");
    // pt-BR ("1.234,56") ou formato simples do Postgres ("1234.56")
    const normalized = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
    return normalizeMoney(normalized);
  };
  return {
    code: "CASH_INSUFFICIENT",
    available_cash: nums[0] ? toNumber(nums[0]) : 0,
    operation_amount: nums[1] ? Math.abs(toNumber(nums[1])) : 0,
    missing_amount: nums[2] ? Math.abs(toNumber(nums[2])) : 0,
  };
}

export type CashGuardScope = { workerId?: string | null; adminId?: string | null } | null;

export type CashGuardRequest = {
  info: CashInsufficient;
  scope: CashGuardScope;
  /** Chamado depois que o usuário adiciona dinheiro ao caixa (nunca reexecuta a operação). */
  onCashAdded?: () => void | Promise<void>;
};

type Handler = (req: CashGuardRequest) => void;

let handler: Handler | null = null;

export function registerCashGuardHandler(fn: Handler | null) {
  handler = fn;
}

/**
 * Trata um erro financeiro. Se for CASH_INSUFFICIENT, abre o modal dedicado e
 * devolve `true` (o chamador NÃO deve exibir toast genérico).
 */
export function reportFinancialError(
  error: any,
  opts: { scope?: CashGuardScope; onCashAdded?: () => void | Promise<void> } = {},
): boolean {
  const info = parseCashInsufficient(error);
  if (!info) return false;
  if (handler) {
    handler({ info, scope: opts.scope ?? null, onCashAdded: opts.onCashAdded });
  }
  return true;
}
