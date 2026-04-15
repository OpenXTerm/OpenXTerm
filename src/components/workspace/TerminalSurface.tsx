import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'

interface TerminalSurfaceProps {
  tabId: string
  title: string
  chunks: string[]
  fontFamily?: string
  fontSize?: number
  foreground?: string
  background?: string
  interactive?: boolean
  stopped?: boolean
  onExitTab?: () => void
  onRestart?: () => void
  onInput?: (data: string) => void
  onResize?: (cols: number, rows: number) => void
}

const STOP_NOTICE = [
  '',
  '─────────────────────────────────────────────────────',
  '',
  'Session stopped',
  '    - Press <Return> to exit tab',
  '    - Press R to restart session',
  '    - Press S to save terminal output to file',
  '',
].join('\r\n')

function saveTerminalOutput(title: string, chunks: string[]) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safeTitle = title.trim().replace(/[^a-z0-9._-]+/gi, '_') || 'terminal'
  const blob = new Blob([chunks.join('').replace(/\r\n/g, '\n')], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${safeTitle}-${stamp}.log`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function TerminalSurface({
  tabId,
  title,
  chunks,
  fontFamily,
  fontSize,
  foreground,
  background,
  interactive = false,
  stopped = false,
  onExitTab,
  onRestart,
  onInput,
  onResize,
}: TerminalSurfaceProps) {
  const allowStoppedActions = Boolean(onExitTab || onRestart)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const writtenCountRef = useRef(0)
  const inputHandlerRef = useRef<typeof onInput>(onInput)
  const resizeHandlerRef = useRef<typeof onResize>(onResize)
  const exitHandlerRef = useRef<typeof onExitTab>(onExitTab)
  const restartHandlerRef = useRef<typeof onRestart>(onRestart)
  const chunksRef = useRef(chunks)
  const titleRef = useRef(title)
  const stoppedRef = useRef(false)
  const stopNoticeShownRef = useRef(false)

  useEffect(() => {
    inputHandlerRef.current = onInput
    resizeHandlerRef.current = onResize
    exitHandlerRef.current = onExitTab
    restartHandlerRef.current = onRestart
    chunksRef.current = chunks
    titleRef.current = title
  }, [chunks, onExitTab, onInput, onResize, onRestart, title])

  useEffect(() => {
    if (!hostRef.current) {
      return
    }

    const resolvedFontFamily = fontFamily?.trim() || '"SF Mono", "JetBrains Mono", Menlo, monospace'
    const resolvedFontSize = Number.isFinite(fontSize) && (fontSize ?? 0) >= 9 ? Number(fontSize) : 13
    const resolvedForeground = foreground?.trim() || '#d8dadb'
    const resolvedBackground = background?.trim() || '#111315'

    const terminal = new Terminal({
      fontFamily: resolvedFontFamily,
      fontSize: resolvedFontSize,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 4000,
      theme: {
        background: resolvedBackground,
        foreground: resolvedForeground,
        cursor: resolvedForeground,
        selectionBackground: '#1d5945',
        black: resolvedBackground,
        green: '#59f0ae',
        cyan: '#56d7ff',
        yellow: '#ffd25a',
        red: '#ff6d6d',
      },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(hostRef.current)
    fit.fit()
    resizeHandlerRef.current?.(terminal.cols, terminal.rows)

    const observer = new ResizeObserver(() => {
      fit.fit()
      resizeHandlerRef.current?.(terminal.cols, terminal.rows)
    })
    observer.observe(hostRef.current)
    const dataDisposable = (interactive || allowStoppedActions)
      ? terminal.onData((data) => {
        if (stoppedRef.current) {
          const normalized = data.toLowerCase()
          if (data === '\r' || data === '\n') {
            exitHandlerRef.current?.()
            return
          }
          if (normalized === 'r') {
            restartHandlerRef.current?.()
            return
          }
          if (normalized === 's') {
            saveTerminalOutput(titleRef.current, chunksRef.current)
            terminal.writeln('')
            terminal.writeln('[information] Terminal output saved to a local file.')
            return
          }

          return
        }

        if (interactive) {
          inputHandlerRef.current?.(data)
        }
      })
      : undefined
    const resizeDisposable = terminal.onResize(({ cols, rows }) => resizeHandlerRef.current?.(cols, rows))

    terminalRef.current = terminal
    writtenCountRef.current = 0
    stoppedRef.current = false
    stopNoticeShownRef.current = false

    return () => {
      observer.disconnect()
      dataDisposable?.dispose()
      resizeDisposable.dispose()
      terminal.dispose()
      terminalRef.current = null
    }
  }, [allowStoppedActions, background, fontFamily, fontSize, foreground, interactive, tabId])

  useEffect(() => {
    if (!terminalRef.current) {
      return
    }

    if (chunks.length < writtenCountRef.current) {
      terminalRef.current.reset()
      writtenCountRef.current = 0
      stoppedRef.current = false
      stopNoticeShownRef.current = false
    }

    const pending = chunks.slice(writtenCountRef.current)
    for (const chunk of pending) {
      terminalRef.current.write(chunk)
    }
    writtenCountRef.current = chunks.length

    stoppedRef.current = stopped

    if (stopped && !stopNoticeShownRef.current) {
      terminalRef.current.write(STOP_NOTICE)
      stopNoticeShownRef.current = true
    }
    if (!stopped) {
      stopNoticeShownRef.current = false
    }
  }, [chunks, stopped])

  return <div ref={hostRef} className="terminal-surface" />
}
