import type { HTMLAttributes } from "react";

export function Panel({ className = "", ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`rounded-lg border border-border bg-bg-raised ${className}`} {...rest} />;
}

export function PanelHeader({ className = "", ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`flex items-center justify-between gap-3 border-b border-border px-4 py-3 ${className}`}
      {...rest}
    />
  );
}

export function PanelTitle({ className = "", ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={`font-display text-sm tracking-wide text-text-dim ${className}`} {...rest} />;
}

export function PanelBody({ className = "", ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`p-4 ${className}`} {...rest} />;
}
