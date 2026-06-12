import React, { Component, ErrorInfo, ReactNode, useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  fallbackMessage?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Always log the full error + component stack so it isn't hidden by the boundary
    console.error("[ErrorBoundary] Caught error:", error);
    if (error?.stack) console.error("[ErrorBoundary] Stack:\n", error.stack);
    if (errorInfo?.componentStack) {
      console.error("[ErrorBoundary] Component stack:", errorInfo.componentStack);
    }
    this.setState({ errorInfo });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render() {
    if (this.state.hasError) {
      const isDev = import.meta.env.DEV;
      return (
        <div className="flex flex-col items-center justify-center gap-4 p-8 text-center">
          <AlertTriangle className="h-12 w-12 text-destructive" />
          <h2 className="text-lg font-semibold text-foreground">
            {this.props.fallbackMessage || "Algo deu errado"}
          </h2>
          <p className="text-sm text-muted-foreground max-w-md">
            Ocorreu um erro inesperado. Tente recarregar a página.
          </p>
          {isDev && this.state.error && (
            <pre className="max-w-2xl overflow-auto rounded border border-destructive/30 bg-destructive/5 p-3 text-left text-xs text-destructive">
              {this.state.error.message}
              {this.state.error.stack ? `\n\n${this.state.error.stack}` : ""}
              {this.state.errorInfo?.componentStack
                ? `\n\nComponent stack:${this.state.errorInfo.componentStack}`
                : ""}
            </pre>
          )}
          <div className="flex gap-2">
            <Button onClick={this.handleReset} variant="outline" size="sm">
              <RefreshCw className="mr-2 h-4 w-4" />
              Tentar novamente
            </Button>
            <Button onClick={() => window.location.reload()} size="sm">
              Recarregar página
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// Wrapper for individual routes. Auto-resets when the URL changes so a stale
// error from a previous page never leaks into the new one.
export function PageErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  const boundaryRef = useRef<ErrorBoundary>(null);
  useEffect(() => {
    boundaryRef.current?.handleReset();
  }, [location.pathname, location.search]);
  return (
    <ErrorBoundary ref={boundaryRef} fallbackMessage="Erro ao carregar esta página">
      {children}
    </ErrorBoundary>
  );
}
