import { useCallback, useEffect, useState } from 'react'

import { inspectLocalX11Support, listSystemFontFamilies } from '../../lib/bridge'
import type { LocalX11Support, SessionDraft } from '../../types/domain'

export function useSystemFonts(open: boolean) {
  const [fonts, setFonts] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) {
      return
    }

    let disposed = false

    void (async () => {
      await Promise.resolve()
      if (disposed) {
        return
      }

      setBusy(true)
      setError('')

      try {
        const nextFonts = await listSystemFontFamilies()
        if (!disposed) {
          setFonts(nextFonts)
        }
      } catch (nextError) {
        if (!disposed) {
          setFonts([])
          setError(nextError instanceof Error ? nextError.message : String(nextError))
        }
      } finally {
        if (!disposed) {
          setBusy(false)
        }
      }
    })()

    return () => {
      disposed = true
    }
  }, [open])

  return {
    busy,
    error,
    fonts,
  }
}

export function useX11Support(open: boolean, draft: SessionDraft) {
  const [support, setSupport] = useState<LocalX11Support | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const inspect = useCallback(async () => {
    setBusy(true)
    setError('')

    try {
      const payload = await inspectLocalX11Support(draft.x11Display.trim() || undefined)
      setSupport(payload)
    } catch (nextError) {
      setSupport(null)
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    } finally {
      setBusy(false)
    }
  }, [draft.x11Display])

  useEffect(() => {
    if (!open || draft.kind !== 'ssh' || !draft.x11Forwarding) {
      return
    }

    let disposed = false

    void (async () => {
      await Promise.resolve()
      if (disposed) {
        return
      }

      setBusy(true)
      setError('')

      try {
        const payload = await inspectLocalX11Support(draft.x11Display.trim() || undefined)
        if (!disposed) {
          setSupport(payload)
        }
      } catch (nextError) {
        if (!disposed) {
          setSupport(null)
          setError(nextError instanceof Error ? nextError.message : String(nextError))
        }
      } finally {
        if (!disposed) {
          setBusy(false)
        }
      }
    })()

    return () => {
      disposed = true
    }
  }, [draft.kind, draft.x11Display, draft.x11Forwarding, open])

  return {
    busy,
    error,
    inspect,
    support,
  }
}
