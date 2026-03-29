import { Skeleton } from "@/components/ui/skeleton";

export function CardSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-1.5">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-lg border bg-card p-3">
          <div className="flex items-center justify-between mb-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-16" />
          </div>
          <Skeleton className="h-3 w-48 mb-1.5" />
          <Skeleton className="h-1.5 w-full rounded-full" />
        </div>
      ))}
    </div>
  );
}

export function ListSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-lg border bg-card p-3 flex items-center gap-3">
          <div className="flex-1">
            <Skeleton className="h-4 w-28 mb-1.5" />
            <Skeleton className="h-3 w-40" />
          </div>
          <Skeleton className="h-5 w-5 rounded" />
        </div>
      ))}
    </div>
  );
}

export function SummarySkeleton() {
  return (
    <div className="grid grid-cols-3 gap-1.5 mb-3">
      {[0, 1, 2].map(i => (
        <div key={i} className="rounded-lg border p-1.5 text-center">
          <Skeleton className="h-3 w-12 mx-auto mb-1" />
          <Skeleton className="h-6 w-8 mx-auto mb-1" />
          <Skeleton className="h-3 w-14 mx-auto" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  message,
  actionLabel,
  onAction,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex flex-col items-center py-12 text-center">
      {Icon && <Icon className="mb-3 h-10 w-10 text-muted-foreground/50" />}
      <p className="text-sm text-muted-foreground mb-3">{message}</p>
      {actionLabel && onAction && (
        <button
          onClick={onAction}
          className="text-sm font-medium text-primary hover:underline"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
