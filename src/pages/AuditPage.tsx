import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { Loader2 } from "lucide-react";
import AuditLogList from "@/components/AuditLogList";

export default function AuditPage() {
  const navigate = useNavigate();
  const { isAdmin, loading } = useAuth();

  useEffect(() => {
    if (!loading && !isAdmin) navigate("/");
  }, [loading, isAdmin, navigate]);

  if (loading) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }
  if (!isAdmin) return null;

  return (
    <div className="p-3 max-w-3xl mx-auto pb-24 space-y-3">
      <div>
        <h1 className="text-xl font-bold">Auditoria</h1>
        <p className="text-xs text-muted-foreground">
          Rastreamento de todas as ações sensíveis do sistema. Use os filtros para investigar alterações,
          pagamentos, exclusões, transferências e criação de usuários.
        </p>
      </div>
      <AuditLogList />
    </div>
  );
}
