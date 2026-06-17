import { clsx, type ClassValue } from "clsx";

export function cn(...values: ClassValue[]): string {
  return clsx(values);
}

export function SeqLabel({ start, end }: { start: number; end?: number }) {
  return (
    <span className="font-mono text-[11px] font-medium tabular-nums text-yard-muted">
      {end && end !== start ? `${start}-${end}` : start}
    </span>
  );
}

export function PanelHeader({
  title,
  meta,
  actions
}: {
  title: string;
  meta?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[46px] items-center justify-between gap-3 border-b border-yard-line bg-white px-3">
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold leading-5">{title}</h2>
        {meta ? <p className="truncate text-[11px] leading-4 text-yard-muted">{meta}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function IconButton({
  label,
  children,
  active,
  onClick
}: {
  label: string;
  children: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "grid h-8 w-8 place-items-center rounded border border-yard-line bg-white text-yard-muted transition hover:border-yard-teal/30 hover:text-yard-teal focus:outline-none focus:ring-2 focus:ring-yard-teal/20",
        active && "border-yard-teal/30 bg-yard-tealSoft text-yard-teal"
      )}
    >
      {children}
    </button>
  );
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
