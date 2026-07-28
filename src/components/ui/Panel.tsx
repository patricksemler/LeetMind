import type { HTMLAttributes } from "react";

export function Panel({ className = "", ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`rounded-lg border border-border bg-bg-raised ${className}`} {...rest} />;
}
