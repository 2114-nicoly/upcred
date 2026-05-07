import { useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { Loader2 } from "lucide-react";
import AdminFullPanel from "@/components/AdminFullPanel";

export default function SuperAdminDetailPage() {
  const { adminId } = useParams<{ adminId: string }>();
  const navigate = useNavigate();
  const { isSuperAdmin, loading } = useAuth();

  useEffect(() => {
    if (!loading && !isSuperAdmin) navigate("/");
  }, [loading, isSuperAdmin, navigate]);

  if (loading || !adminId) return <div className="flex h-64 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  return <AdminFullPanel adminId={adminId} />;
}
