import type { HTMLAttributes } from "react";

/** Quiet uppercase heading used to introduce compact workspace sections. */
export function SectionLabel({ className = "", ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={`text-xs font-medium uppercase tracking-wide text-text-faint ${className}`}
      {...rest}
    />
  );
}
