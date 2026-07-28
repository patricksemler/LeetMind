import type { HTMLAttributes } from "react";

/** Shared workspace rail; its fixed height keeps adjacent pane borders aligned. */
export function Toolbar({ className = "", ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`flex h-12 shrink-0 items-center border-b border-border bg-bg ${className}`}
      {...rest}
    />
  );
}
