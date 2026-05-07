import { useAuth } from "@/hooks/useAuth";
import { useWorkerFilter } from "@/hooks/useWorkerFilter";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Users, Shield } from "lucide-react";

/**
 * Filtro hierárquico: super_admin escolhe admin → trabalhador.
 * Admin comum vê só select de trabalhadores.
 * Trabalhador: nada (RLS).
 */
export default function WorkerFilterSelect({ className = "" }: { className?: string }) {
  const { isAdmin, isSuperAdmin } = useAuth();
  const {
    selectedWorkerId, setSelectedWorkerId,
    selectedAdminId, setSelectedAdminId,
    workers, admins,
  } = useWorkerFilter();

  if (!isAdmin) return null;

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {isSuperAdmin && (
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-muted-foreground shrink-0" />
          <Select
            value={selectedAdminId ?? "__all__"}
            onValueChange={(v) => setSelectedAdminId(v === "__all__" ? null : v)}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Todos os administradores" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Todos os administradores</SelectItem>
              {admins.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.nome} {!a.active && "(inativo)"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Users className="h-4 w-4 text-muted-foreground shrink-0" />
        <Select
          value={selectedWorkerId ?? "__all__"}
          onValueChange={(v) => setSelectedWorkerId(v === "__all__" ? null : v)}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Todos os trabalhadores" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Todos os trabalhadores</SelectItem>
            {workers.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.nome} {!w.active && "(inativo)"} · {w.login_codigo}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
