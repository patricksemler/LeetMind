import type { HTMLAttributes } from "react";

export function BrandName({ className = "", ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={`font-display text-[15px] tracking-tight text-text ${className}`}
      translate="no"
      {...rest}
    >
      Leet<span className="text-accent">Mind</span>
    </span>
  );
}
