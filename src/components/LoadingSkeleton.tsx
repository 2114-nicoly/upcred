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
  description,
  actionLabel,
  onAction,
  compact,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  message: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  compact?: boolean;
}) {
  return (
    <div className={`flex flex-col items-center text-center ${compact ? "py-6" : "py-12"}`}>
      {Icon && (
        <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-muted/40">
          <Icon className="h-7 w-7 text-muted-foreground/70" />
        </div>
      )}
      <p className="text-sm font-medium text-foreground mb-1">{message}</p>
      {description && (
        <p className="text-xs text-muted-foreground mb-3 max-w-xs">{description}</p>
      )}
      {actionLabel && onAction && (
        <button
          onClick={onAction}
          className="mt-2 inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-sm hover:bg-primary/90"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
