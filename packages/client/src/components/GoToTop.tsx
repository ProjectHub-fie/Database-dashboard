import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { cn } from '../lib/cn'

/**
 * "Go to top" floating action button, bottom-right corner. Appears once the
 * user scrolls down and smoothly scrolls the page (or the shell's scroll
 * container) back to the top. The arrow is an inline SVG so it always matches
 * the current stroke color.
 */
export function GoToTop() {
  const [visible, setVisible] = useState(false)
  const location = useLocation()

  useEffect(() => {
    setVisible(false)
    const root = document.getElementById('app-scroll')
    const listen = (e: Event) => {
      const el = e.target
      if (el instanceof HTMLElement) setVisible(el.scrollTop > 240)
    }
    const onWindowScroll = () => setVisible(window.scrollY > 240)
    root?.addEventListener('scroll', listen, { passive: true })
    window.addEventListener('scroll', onWindowScroll, { passive: true })
    // Initial state: whichever container actually scrolls the content.
    setVisible(window.scrollY > 240 || (root?.scrollTop ?? 0) > 240)
    return () => {
      root?.removeEventListener('scroll', listen)
      window.removeEventListener('scroll', onWindowScroll)
    }
  }, [location.pathname])

  if (!visible) return null

  return (
    <button
      type="button"
      aria-label="Go to top"
      title="Go to top"
      onClick={() => {
        const root = document.getElementById('app-scroll')
        if (root && root.scrollTop > 0) root.scrollTo({ top: 0, behavior: 'smooth' })
        if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'smooth' })
      }}
      className={cn(
        'fixed bottom-6 right-6 z-40 flex h-11 w-11 items-center justify-center rounded-full border shadow-lg transition-all',
        'border-slate-200 bg-white text-slate-600 hover:-translate-y-0.5 hover:border-indigo-300 hover:text-indigo-600',
        'dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-indigo-500 dark:hover:text-indigo-300',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2',
        'dark:focus-visible:ring-offset-slate-900',
      )}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-5 w-5"
        aria-hidden
      >
        <path d="m18 15-6-6-6 6" />
      </svg>
    </button>
  )
}