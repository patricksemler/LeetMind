import type { HTMLAttributes } from "react";

export function AppHeader({ className = "", ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <header
      className={`flex h-12 shrink-0 items-center border-b border-border bg-bg px-4 ${className}`}
      {...rest}
    />
  );
}
