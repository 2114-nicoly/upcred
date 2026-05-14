import { useLocation, useNavigate } from "react-router-dom";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { Home } from "lucide-react";

const NotFound = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { isAdmin, isSuperAdmin } = useAuth();

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  const goHome = () => {
    if (isSuperAdmin) navigate("/super-admin", { replace: true });
    else if (isAdmin) navigate("/admin", { replace: true });
    else navigate("/", { replace: true });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="text-center max-w-sm">
        <h1 className="mb-2 text-5xl font-bold text-foreground">404</h1>
        <p className="mb-1 text-lg font-medium text-foreground">Página não encontrada</p>
        <p className="mb-6 text-sm text-muted-foreground break-all">
          {location.pathname}
        </p>
        <div className="flex flex-col gap-2">
          <Button onClick={goHome} className="w-full">
            <Home className="mr-2 h-4 w-4" />
            Voltar para início
          </Button>
          <Button variant="outline" onClick={() => navigate(-1)} className="w-full">
            Voltar à página anterior
          </Button>
        </div>
      </div>
    </div>
  );
};

export default NotFound;
