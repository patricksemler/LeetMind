import { Link, NavLink } from "react-router-dom";

const LINKS = [
  { to: "/", label: "Today", end: true },
  { to: "/progress", label: "Progress" },
  { to: "/concepts", label: "Concepts" },
  { to: "/system", label: "System" },
];

export function NavBar({ onShowShortcuts }: { onShowShortcuts: () => void }) {
  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-bg px-4">
      <div className="flex items-center gap-6">
        <Link to="/" className="font-display text-[15px] tracking-tight text-text">
          Algo<span className="text-accent">Lift</span>
        </Link>
        <nav className="flex items-center gap-1">
          {LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={({ isActive }) =>
                `rounded px-2.5 py-1.5 text-sm transition-colors ${
                  isActive ? "bg-bg-overlay text-text" : "text-text-dim hover:text-text"
                }`
              }
            >
              {link.label}
            </NavLink>
          ))}
        </nav>
      </div>
      <button
        onClick={onShowShortcuts}
        className="rounded border border-border px-2 py-1 text-xs text-text-faint hover:border-border-strong hover:text-text-dim"
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts (?)"
      >
        ?
      </button>
    </header>
  );
}
