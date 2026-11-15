// Light / dark theme. Default = follow the system setting. The choice is remembered in this browser.
// The CSS already has both palettes: :root[data-theme="dark"] / [data-theme="light"], and a
// prefers-color-scheme media query that applies when no data-theme is set ("system").

import { useEffect, useState } from 'react'

export type ThemeChoice = 'system' | 'light' | 'dark'
const KEY = 'jiraPulse.theme'
export const THEME_ORDER: ThemeChoice[] = ['system', 'light', 'dark']

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

export function useTheme() {
  const [theme, setTheme] = useState<ThemeChoice>(read)
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
    try { localStorage.setItem(KEY, theme) } catch { /* private mode: fine */ }
  }, [theme])
  const next = () => setTheme((t) => THEME_ORDER[(THEME_ORDER.indexOf(t) + 1) % THEME_ORDER.length])
  return { theme, setTheme, next }
}
