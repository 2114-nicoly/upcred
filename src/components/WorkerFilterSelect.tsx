import { useAuth } from "@/hooks/useAuth";
import { useWorkerFilter } from "@/hooks/useWorkerFilter";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Users } from "lucide-react";

/**
 * Worker filter dropdown — only renders for admin users.
 * Returns null for regular workers (they only see their own data via RLS).
 */
export default function WorkerFilterSelect({ className = "" }: { className?: string }) {
  const { isAdmin } = useAuth();
  const { selectedWorkerId, setSelectedWorkerId, workers } = useWorkerFilter();

  if (!isAdmin) return null;

  return (
    <div className={`flex items-center gap-2 ${className}`}>
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
  );
}
