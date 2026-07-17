import { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FileText, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { getEventTypeLabel } from "@/lib/daily-events";

/**
 * Shared visual primitives for reports (Trabalhador, Administrador, Superadministrador).
 * Purely presentational — never touches data, cálculos ou regras financeiras.
 */

// Padronização de nomes amigáveis para tipos de evento.
export function formatEventLabel(type: string): string {
  return getEventTypeLabel(type);
}

export function ReportHeader({
  title,
  subject,
  period,
  badges,
  right,
}: {
  title: string;
  subject?: string;
  period?: string;
  badges?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary shrink-0" />
              <h2 className="text-base font-semibold truncate">{title}</h2>
            </div>
            {subject && (
              <p className="mt-1 text-sm font-medium truncate">{subject}</p>
            )}
            {period && (
              <p className="text-xs text-muted-foreground capitalize">{period}</p>
            )}
            {badges && <div className="mt-2 flex flex-wrap gap-1">{badges}</div>}
          </div>
          {right && <div className="shrink-0">{right}</div>}
        </div>
      </CardContent>
    </Card>
  );
}

export function ReportKpiGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">{children}</div>
  );
}

export function ReportKpiCard({
  label,
  value,
  tone = "neutral",
  icon,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "positive" | "negative" | "warning";
  icon?: ReactNode;
}) {
  const toneClass =
    tone === "positive"
      ? "text-success"
      : tone === "negative"
      ? "text-destructive"
      : tone === "warning"
      ? "text-warning"
      : "text-foreground";
  return (
    <Card>
      <CardContent className="p-2.5">
        <div className="flex items-center gap-1.5 mb-0.5 min-h-[16px]">
          {icon}
          <p className="text-[11px] text-muted-foreground leading-tight truncate">
            {label}
          </p>
        </div>
        <p className={`text-sm font-bold tabular-nums ${toneClass}`}>{value}</p>
      </CardContent>
    </Card>
  );
}

export function ReportSectionTitle({
  children,
  right,
}: {
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 mt-4 mb-2">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {children}
      </h3>
      {right}
    </div>
  );
}

export function ReportEmptyState({ message }: { message: string }) {
  return (
    <Card>
      <CardContent className="py-6 text-center text-xs text-muted-foreground">
        {message}
      </CardContent>
    </Card>
  );
}

/** Botão discreto "Ver auditoria" para separar auditoria técnica do relatório financeiro. */
export function AuditLink({ to = "/audit" }: { to?: string }) {
  return (
    <Button asChild size="sm" variant="ghost">
      <Link to={to}>
        <ShieldCheck className="h-4 w-4 mr-1" /> Ver auditoria
      </Link>
    </Button>
  );
}

/** Nomes padronizados de seções de relatórios (evitar divergências). */
export const REPORT_SECTIONS = {
  resumo: "Resumo do período",
  caixa: "Caixa do período",
  pagamentos: "Pagamentos",
  naoPagos: "Não pagamentos e pendências",
  novos: "Novos empréstimos",
  renovacoes: "Renovações",
  entradasSaidas: "Entradas e saídas",
  cancelamentosEstornos: "Cancelamentos e estornos",
} as const;
