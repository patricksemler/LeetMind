import { Link, NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../../lib/auth";

const LINKS = [
  { to: "/", label: "Practice", end: true },
  { to: "/progress", label: "Progress" },
  { to: "/concepts", label: "Concepts" },
];

export function NavBar({ onShowShortcuts }: { onShowShortcuts: () => void }) {
  const { session, authRequired, email, signOut } = useAuth();
  const navigate = useNavigate();
  // With auth off (single-user local stack) there is no session to have, and hiding the nav would
  // leave that build with no navigation at all.
  const signedIn = !authRequired || Boolean(session);

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-bg px-4">
      <div className="flex items-center gap-6">
        <Link to="/" className="font-display text-[15px] tracking-tight text-text">
          Leet<span className="text-accent">Mind</span>
        </Link>
        {signedIn && (
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
        )}
      </div>
      <div className="flex items-center gap-2">
        {authRequired && session && (
          <>
            <span className="hidden max-w-[18ch] truncate text-xs text-text-faint sm:inline" title={email ?? undefined}>
              {email}
            </span>
            <button
              onClick={() => {
                void signOut().then(() => navigate("/login", { replace: true }));
              }}
              className="rounded border border-border px-2 py-1 text-xs text-text-faint hover:border-border-strong hover:text-text-dim"
            >
              Sign out
            </button>
          </>
        )}
        <button
          onClick={onShowShortcuts}
          className="rounded border border-border px-2 py-1 text-xs text-text-faint hover:border-border-strong hover:text-text-dim"
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
        >
          ?
        </button>
      </div>
    </header>
  );
}
