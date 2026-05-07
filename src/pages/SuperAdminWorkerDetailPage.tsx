import { useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { Loader2 } from "lucide-react";
import WorkerFullPanel from "@/components/WorkerFullPanel";

export default function SuperAdminWorkerDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isSuperAdmin, loading } = useAuth();

  useEffect(() => {
    if (!loading && !isSuperAdmin) navigate("/");
  }, [loading, isSuperAdmin, navigate]);

  if (loading || !id) return <div className="flex h-64 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  return <WorkerFullPanel workerId={id} />;
}
