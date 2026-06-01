import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Lock, LockOpen, Users, CheckCircle2, XCircle, Clock, ArrowDownCircle, ArrowUpCircle, AlertTriangle, Wallet } from "lucide-react";
import { formatCurrency } from "@/lib/loan-utils";

export type WorkerDashboardData = {
  cashStatus: "open" | "closed";
  treatedCount: number;
  paidCount: number;
  notPaidCount: number;
  remainingPending: number;
  totalReceived: number;
  totalLent: number;
  totalPenaltyReceived: number;
  expectedBalance: number;
};

type StatProps = {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "default" | "positive" | "negative" | "warning";
};

function Stat({ icon, label, value, tone = "default" }: StatProps) {
  const toneCls =
    tone === "positive" ? "text-green-700 dark:text-green-400"
    : tone === "negative" ? "text-destructive"
    : tone === "warning" ? "text-amber-700 dark:text-amber-400"
    : "text-foreground";
  return (
    <Card className="shadow-none">
      <CardContent className="p-2.5">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          <span className="opacity-80">{icon}</span>
          <span className="truncate">{label}</span>
        </div>
        <p className={`text-sm font-semibold leading-tight mt-0.5 ${toneCls}`}>{value}</p>
      </CardContent>
    </Card>
  );
}

/**
 * Painel compacto de produção do trabalhador.
 * Mobile-first, 2 colunas; reaproveita semantic tokens.
 */
export default function WorkerDashboard({ data }: { data: WorkerDashboardData }) {
  const closed = data.cashStatus === "closed";
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Produção do dia</p>
        <Badge variant={closed ? "secondary" : "default"} className="text-[10px] h-5 gap-1">
          {closed ? <Lock className="h-3 w-3" /> : <LockOpen className="h-3 w-3" />}
          {closed ? "Caixa fechado" : "Caixa aberto"}
        </Badge>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Stat icon={<Users className="h-3 w-3" />} label="Tratados" value={String(data.treatedCount)} />
        <Stat icon={<Clock className="h-3 w-3" />} label="Pendentes" value={String(data.remainingPending)} tone={data.remainingPending > 0 ? "warning" : "default"} />
        <Stat icon={<CheckCircle2 className="h-3 w-3" />} label="Pagos" value={String(data.paidCount)} tone="positive" />
        <Stat icon={<XCircle className="h-3 w-3" />} label="Não pagos" value={String(data.notPaidCount)} tone={data.notPaidCount > 0 ? "negative" : "default"} />
        <Stat icon={<ArrowDownCircle className="h-3 w-3" />} label="Recebido" value={formatCurrency(data.totalReceived)} tone="positive" />
        <Stat icon={<ArrowUpCircle className="h-3 w-3" />} label="Liberado" value={formatCurrency(data.totalLent)} tone="negative" />
        <Stat icon={<AlertTriangle className="h-3 w-3" />} label="Multas" value={formatCurrency(data.totalPenaltyReceived)} tone="positive" />
        <Stat icon={<Wallet className="h-3 w-3" />} label="Saldo esperado" value={formatCurrency(data.expectedBalance)} />
      </div>
    </div>
  );
}
