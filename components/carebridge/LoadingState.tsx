export function LoadingState({ message = "Loading…" }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center" role="status">
      <span className="h-8 w-8 animate-spin rounded-full border-2 border-cb-border-strong border-t-cb-primary" aria-hidden />
      <p className="text-[13.5px] text-cb-muted">{message}</p>
    </div>
  );
}
