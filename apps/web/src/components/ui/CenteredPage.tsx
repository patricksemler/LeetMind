import type { HTMLAttributes } from "react";

/** Full-route centering with responsive gutters shared by cards and empty states. */
export function CenteredPage({ className = "", ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`flex h-full min-w-0 items-center justify-center p-4 sm:p-6 ${className}`}
      {...rest}
    />
  );
}
