import { useEffect, useState } from "react";
import AccessStatusBadge from "@/components/access/AccessStatusBadge";
import {
  fetchGrantorNames,
  WorkerAccessLicense,
  WorkerAccessPeriod,
  getAccessStatus,
  getEffectiveAccessStatus,
  daysRemaining,
  formatAccessDate,
  formatDateTime,
  formatMoney,
} from "@/lib/access-control";

type Props = {
  license?: WorkerAccessLicense | null;
  lastPeriod?: WorkerAccessPeriod | null;
  /** Compacto = usado dentro do card do trabalhador (Administrador). */
  title?: string;
  /** Empresa pausada — apenas exibição, não altera a licença individual. */
  companyPaused?: boolean;
};

/**
 * Bloco compartilhado (Administrador e SuperAdministrador) — somente leitura.
 */
export default function WorkerAccessSummary({ license, lastPeriod, title = "Acesso e mensalidade", companyPaused = false }: Props) {
  const status = getEffectiveAccessStatus(license, companyPaused);
  const licenseStatus = getAccessStatus(license);
  const days = daysRemaining(license);
  const pausedBy = license?.paused_by ?? null;
  const [pausedByName, setPausedByName] = useState<string | null>(null);

  useEffect(() => {
    if (!pausedBy) { setPausedByName(null); return; }
    void fetchGrantorNames([pausedBy]).then((m) => setPausedByName(m[pausedBy] ?? null));
  }, [pausedBy]);

  return (
    <div className="rounded-md border bg-muted/30 p-2 space-y-1">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-[11px] font-medium">{title}</span>
        <div className="flex items-center gap-1">
          <AccessStatusBadge status={status} />
          {companyPaused && status !== licenseStatus && (
            <span className="text-[9px] text-muted-foreground">Licença: {ACCESS_LABEL_FALLBACK(licenseStatus)}</span>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
        <span>Mensalidade: <span className="font-medium text-foreground">{formatMoney(license?.monthly_price)}</span></span>
        <span>Início: <span className="font-medium text-foreground">{formatAccessDate(license?.access_start)}</span></span>
        <span>Ativo até: <span className="font-medium text-foreground">{formatAccessDate(license?.access_end)}</span></span>
        <span>
          Dias restantes:{" "}
          <span className="font-medium text-foreground">
            {days == null ? "Não configurado" : days < 0 ? `${Math.abs(days)} em atraso` : days}
          </span>
        </span>
        {lastPeriod && (
          <>
            <span className="col-span-2">
              Último pagamento:{" "}
              <span className="font-medium text-foreground">
                {formatMoney(lastPeriod.amount_paid)} · {formatDateTime(lastPeriod.paid_at ?? lastPeriod.created_at)}
              </span>
            </span>
            <span className="col-span-2">
              Último período:{" "}
              <span className="font-medium text-foreground">
                {formatAccessDate(lastPeriod.period_start)} → {formatAccessDate(lastPeriod.period_end)}
              </span>
            </span>
          </>
        )}
        {!lastPeriod && <span className="col-span-2">Último pagamento: Não configurado</span>}
        {license?.manual_status === "paused" && (
          <>
            <span className="col-span-2">
              Motivo da pausa: <span className="font-medium text-foreground">{license.pause_reason || "—"}</span>
            </span>
            <span className="col-span-2">
              Pausado em <span className="font-medium text-foreground">{formatDateTime(license.paused_at)}</span>
              {" · por "}
              <span className="font-medium text-foreground">{pausedByName || "—"}</span>
            </span>
          </>
        )}
      </div>
    </div>
  );
}
