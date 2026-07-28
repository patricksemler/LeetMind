import { Link, NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { AppHeader } from "./AppHeader";
import { BrandName } from "./BrandName";

const LINKS = [
  { to: "/", label: "Practice", end: true },
  { to: "/concepts", label: "Concepts" },
];

/** No shortcuts button: the "?" key still opens the help dialog (wired in App), and the header is
 * otherwise empty until a session exists — a lone punctuation badge floating top-right read as a
 * stray avatar rather than as help. */
export function NavBar() {
  const { session, email, signOut } = useAuth();
  const navigate = useNavigate();
  const signedIn = Boolean(session);

  return (
    <AppHeader className="justify-between">
      <div className="flex min-w-0 items-center gap-3 sm:gap-6">
        <Link to="/">
          <BrandName />
        </Link>
        {signedIn && (
          <nav className="flex items-center gap-1">
            {LINKS.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.end}
                className={({ isActive }: { isActive: boolean }) =>
                  `touch-manipulation rounded px-2 py-1.5 text-sm transition-colors duration-150 motion-reduce:transition-none sm:px-2.5 ${
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
        {session && (
          <>
            <span
              className="hidden max-w-[18ch] truncate text-xs text-text-faint sm:inline"
              title={email ?? undefined}
            >
              {email}
            </span>
            <button
              onClick={async () => {
                await signOut();
                navigate("/login", { replace: true });
              }}
              className="touch-manipulation rounded border border-border px-2 py-1 text-xs text-text-faint transition-colors duration-150 hover:border-border-strong hover:text-text-dim motion-reduce:transition-none"
            >
              Sign out
            </button>
          </>
        )}
      </div>
    </AppHeader>
  );
}
