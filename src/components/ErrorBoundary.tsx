import React, { Component, ErrorInfo, ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  fallbackMessage?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center gap-4 p-8 text-center">
          <AlertTriangle className="h-12 w-12 text-destructive" />
          <h2 className="text-lg font-semibold text-foreground">
            {this.props.fallbackMessage || "Algo deu errado"}
          </h2>
          <p className="text-sm text-muted-foreground max-w-md">
            Ocorreu um erro inesperado. Tente recarregar a página.
          </p>
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

// Wrapper for individual routes
export function PageErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary fallbackMessage="Erro ao carregar esta página">
      {children}
    </ErrorBoundary>
  );
}
