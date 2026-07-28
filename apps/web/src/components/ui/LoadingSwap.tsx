import type { ReactNode } from "react";
import { Spinner } from "./Spinner";

export function LoadingSwap({
  loading,
  label,
  children,
  className = "",
  spinnerClassName = "",
  spinnerTestId,
}: {
  loading: boolean;
  label: string;
  children: ReactNode;
  className?: string;
  spinnerClassName?: string;
  spinnerTestId?: string;
}) {
  const transition =
    "transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none";

  return (
    <div className={`inline-grid place-items-center ${className}`}>
      <div
        aria-hidden={loading || undefined}
        className={`[grid-area:1/1] ${transition} ${
          loading
            ? "pointer-events-none translate-y-px scale-95 opacity-0"
            : "translate-y-0 scale-100 opacity-100"
        }`}
      >
        {children}
      </div>
      <Spinner
        label={loading ? label : undefined}
        data-testid={loading ? spinnerTestId : undefined}
        className={`[grid-area:1/1] ${transition} ${spinnerClassName} ${
          loading
            ? "translate-y-0 scale-100 opacity-100"
            : "pointer-events-none -translate-y-px scale-90 opacity-0"
        }`}
      />
    </div>
  );
}
