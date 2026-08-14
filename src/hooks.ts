import { useCallback, useEffect, useState } from 'react'

/** Close on Escape — same contract as the hook in evs-app. */
export function useEscapeKey(handler: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handler()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [handler, enabled])
}

/**
 * Tab state kept in location.hash, so every tab is linkable and survives a
 * reload — cheaper than pulling in a router for four panels.
 */
export function useHashTab<T extends string>(tabs: readonly T[], fallback: T) {
  const read = useCallback((): T => {
    const h = window.location.hash.replace(/^#/, '')
    return (tabs as readonly string[]).includes(h) ? (h as T) : fallback
  }, [tabs, fallback])

  const [tab, setTab] = useState<T>(read)

  useEffect(() => {
    const onHash = () => setTab(read())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [read])

  const select = useCallback((t: T) => {
    window.location.hash = t
    setTab(t)
  }, [])

  return [tab, select] as const
}
