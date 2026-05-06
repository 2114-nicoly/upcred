import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import AppLayout from "@/components/AppLayout";
import { ErrorBoundary, PageErrorBoundary } from "@/components/ErrorBoundary";
import { AuthProvider, useAuth } from "@/hooks/useAuth";
import DailyCashPage from "@/pages/DailyCashPage";
import DailyCashHistoryPage from "@/pages/DailyCashHistoryPage";
import ClientsPage from "@/pages/ClientsPage";
import ClientDetailPage from "@/pages/ClientDetailPage";
import NewLoanPage from "@/pages/NewLoanPage";
import LoanDetailPage from "@/pages/LoanDetailPage";
import PaymentHistoryPage from "@/pages/PaymentHistoryPage";
import ActiveLoansPage from "@/pages/ActiveLoansPage";
import ReportsPage from "@/pages/ReportsPage";
import OverdueLoansPage from "@/pages/OverdueLoansPage";
import TodaySummaryPage from "@/pages/TodaySummaryPage";
import AuthPage from "@/pages/AuthPage";
import NotFound from "./pages/NotFound";
import UnpaidInstallmentsPage from "@/pages/UnpaidInstallmentsPage";
import LoanOverdueDetailPage from "@/pages/LoanOverdueDetailPage";
import NewLoanSelectClientPage from "@/pages/NewLoanSelectClientPage";
import CaixaPage from "@/pages/CaixaPage";
import CashHistoryPage from "@/pages/CashHistoryPage";
import AdminPage from "@/pages/AdminPage";
import WorkersPage from "@/pages/WorkersPage";
import AdminPanelPage from "@/pages/AdminPanelPage";
import AdminWorkerDetailPage from "@/pages/AdminWorkerDetailPage";
import { WorkerFilterProvider } from "@/hooks/useWorkerFilter";
import { Loader2 } from "lucide-react";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function WrappedRoute({ element }: { element: React.ReactNode }) {
  return <PageErrorBoundary>{element}</PageErrorBoundary>;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }
  if (!session) {
    return <Navigate to="/auth" replace state={{ from: location }} />;
  }
  return <>{children}</>;
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { isAdmin, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }
  if (!isAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/auth" element={<AuthPage />} />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <AppLayout>
              <Routes>
                <Route path="/" element={<WrappedRoute element={<DailyCashPage />} />} />
                <Route path="/daily-cash-history" element={<WrappedRoute element={<DailyCashHistoryPage />} />} />
                <Route path="/clients" element={<WrappedRoute element={<ClientsPage />} />} />
                <Route path="/clients/:clientId" element={<WrappedRoute element={<ClientDetailPage />} />} />
                <Route path="/clients/:clientId/new-loan" element={<WrappedRoute element={<NewLoanPage />} />} />
                <Route path="/loans/:loanId" element={<WrappedRoute element={<LoanDetailPage />} />} />
                <Route path="/loans/:loanId/unpaid" element={<WrappedRoute element={<UnpaidInstallmentsPage />} />} />
                <Route path="/loans/:loanId/overdue" element={<WrappedRoute element={<LoanOverdueDetailPage />} />} />
                <Route path="/new-loan" element={<WrappedRoute element={<NewLoanSelectClientPage />} />} />
                <Route path="/active-loans" element={<WrappedRoute element={<ActiveLoansPage />} />} />
                <Route path="/overdue" element={<WrappedRoute element={<OverdueLoansPage />} />} />
                <Route path="/today-summary" element={<WrappedRoute element={<TodaySummaryPage />} />} />
                <Route path="/payment-history" element={<WrappedRoute element={<PaymentHistoryPage />} />} />
                <Route path="/caixa" element={<WrappedRoute element={<CaixaPage />} />} />
                <Route path="/cash-history" element={<WrappedRoute element={<CashHistoryPage />} />} />
                <Route path="/reports" element={<WrappedRoute element={<ReportsPage />} />} />
                <Route path="/admin-tools" element={<AdminRoute><WrappedRoute element={<AdminPage />} /></AdminRoute>} />
                <Route path="/workers" element={<AdminRoute><WrappedRoute element={<WorkersPage />} /></AdminRoute>} />
                <Route path="/admin" element={<AdminRoute><WrappedRoute element={<AdminPanelPage />} /></AdminRoute>} />
                <Route path="/admin/worker/:id" element={<AdminRoute><WrappedRoute element={<AdminWorkerDetailPage />} /></AdminRoute>} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </AppLayout>
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <ErrorBoundary>
          <AuthProvider>
            <WorkerFilterProvider>
              <AppRoutes />
            </WorkerFilterProvider>
          </AuthProvider>
        </ErrorBoundary>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
