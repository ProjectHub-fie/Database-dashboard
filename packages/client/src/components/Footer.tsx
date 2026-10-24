import { Link } from 'react-router-dom'

/**
 * Site footer shared by the dashboard shell, the connect screen and the
 * legal pages. Legal pages are routed (react-router) so users stay inside
 * the SPA; the ProjectHub brand link is an external site.
 */
export function Footer() {
  return (
    <footer className="shrink-0 border-t border-slate-200 bg-white px-6 pb-16 pt-4 sm:pb-4 dark:border-slate-800 dark:bg-slate-950">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-[11.5px] text-slate-500 dark:text-slate-400 sm:justify-between">
        <p className="text-center">
          © {new Date().getFullYear()}{' '}
          <a
            href="https://projecthub-me.vercel.app"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-slate-700 transition-colors hover:text-indigo-600 dark:text-slate-300 dark:hover:text-indigo-400"
          >
            ProjectHub
          </a>
        </p>
        <nav className="flex items-center gap-2" aria-label="Legal">
          <Link to="/privacy" className="transition-colors hover:text-indigo-600 dark:hover:text-indigo-400">
            Privacy Policy
          </Link>
          <span aria-hidden className="text-slate-300 dark:text-slate-600">
            •
          </span>
          <Link to="/terms" className="transition-colors hover:text-indigo-600 dark:hover:text-indigo-400">
            Terms of Service
          </Link>
        </nav>
      </div>
    </footer>
  )
}