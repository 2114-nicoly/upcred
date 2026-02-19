import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { RouteProvider, useRoute } from "@/contexts/RouteContext";
import AppLayout from "@/components/AppLayout";
import LoginPage from "@/pages/LoginPage";
import RouteRequestPage from "@/pages/RouteRequestPage";
import AdminPage from "@/pages/AdminPage";
import TodayPage from "@/pages/TodayPage";
import ClientsPage from "@/pages/ClientsPage";
import ClientDetailPage from "@/pages/ClientDetailPage";
import NewLoanPage from "@/pages/NewLoanPage";
import LoanDetailPage from "@/pages/LoanDetailPage";
import PaymentHistoryPage from "@/pages/PaymentHistoryPage";
import ActiveLoansPage from "@/pages/ActiveLoansPage";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { route, loading } = useRoute();
  if (loading) return <p className="p-8 text-center">Carregando...</p>;
  if (!route) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

const AppRoutes = () => (
  <Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route path="/route-request" element={<RouteRequestPage />} />
    <Route path="/admin" element={<AdminPage />} />
    <Route
      path="/*"
      element={
        <ProtectedRoute>
          <AppLayout>
            <Routes>
              <Route path="/" element={<TodayPage />} />
              <Route path="/clients" element={<ClientsPage />} />
              <Route path="/clients/:clientId" element={<ClientDetailPage />} />
              <Route path="/clients/:clientId/new-loan" element={<NewLoanPage />} />
              <Route path="/loans/:loanId" element={<LoanDetailPage />} />
              <Route path="/active-loans" element={<ActiveLoansPage />} />
              <Route path="/payment-history" element={<PaymentHistoryPage />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </AppLayout>
        </ProtectedRoute>
      }
    />
  </Routes>
);

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <RouteProvider>
          <AppRoutes />
        </RouteProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
