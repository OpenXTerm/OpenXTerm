import { useEffect, useRef, useState } from 'react'
import { SearchAddon } from '@xterm/addon-search'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'

import { readClipboardText } from '../../lib/bridge'

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
  commandRequest?: {
    action: 'clear' | 'reset' | 'search'
    nonce: number
    tabId: string
  } | null
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

function isKeyboardPasteShortcut(event: KeyboardEvent) {
  return event.type === 'keydown'
    && (
      ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v')
      || (event.shiftKey && event.key === 'Insert')
    )
}

function normalizePastedText(text: string) {
  return text.replace(/\r\n/g, '\r').replace(/\n/g, '\r')
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
  commandRequest,
}: TerminalSurfaceProps) {
  const allowStoppedActions = Boolean(onExitTab || onRestart)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const writtenCountRef = useRef(0)
  const inputHandlerRef = useRef<typeof onInput>(onInput)
  const resizeHandlerRef = useRef<typeof onResize>(onResize)
  const exitHandlerRef = useRef<typeof onExitTab>(onExitTab)
  const restartHandlerRef = useRef<typeof onRestart>(onRestart)
  const chunksRef = useRef(chunks)
  const titleRef = useRef(title)
  const stoppedRef = useRef(false)
  const stopNoticeShownRef = useRef(false)
  const processedCommandNonceRef = useRef<number | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false)
  const [searchFeedback, setSearchFeedback] = useState('')

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

    const hostElement = hostRef.current
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
    const searchAddon = new SearchAddon()
    terminal.loadAddon(fit)
    terminal.loadAddon(searchAddon)
    const pasteText = (text: string) => {
      if (!text || !interactive || stoppedRef.current) {
        return
      }

      inputHandlerRef.current?.(normalizePastedText(text))
    }

    terminal.attachCustomKeyEventHandler((event) => {
      const isFindShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f'
      if (isFindShortcut) {
        event.preventDefault()
        setSearchOpen(true)
        return false
      }
      if (isKeyboardPasteShortcut(event)) {
        if (!interactive || stoppedRef.current) {
          return true
        }

        event.preventDefault()
        void readClipboardText().then((text) => {
          pasteText(text)
        }).catch(() => {})
        return false
      }
      return true
    })
    terminal.open(hostElement)
    fit.fit()
    resizeHandlerRef.current?.(terminal.cols, terminal.rows)

    const observer = new ResizeObserver(() => {
      fit.fit()
      resizeHandlerRef.current?.(terminal.cols, terminal.rows)
    })
    observer.observe(hostElement)

    const handlePaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData('text/plain')
      if (!text || !interactive || stoppedRef.current) {
        return
      }

      event.preventDefault()
      pasteText(text)
    }
    hostElement.addEventListener('paste', handlePaste)

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
    searchAddonRef.current = searchAddon
    writtenCountRef.current = 0
    stoppedRef.current = false
    stopNoticeShownRef.current = false

    return () => {
      observer.disconnect()
      hostElement.removeEventListener('paste', handlePaste)
      dataDisposable?.dispose()
      resizeDisposable.dispose()
      terminal.dispose()
      searchAddonRef.current = null
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

  useEffect(() => {
    if (!terminalRef.current || !commandRequest) {
      return
    }

    if (processedCommandNonceRef.current === commandRequest.nonce) {
      return
    }

    processedCommandNonceRef.current = commandRequest.nonce

    if (commandRequest.action === 'search') {
      window.requestAnimationFrame(() => {
        setSearchOpen(true)
      })
      return
    }

    if (commandRequest.action === 'reset') {
      terminalRef.current.reset()
    } else {
      terminalRef.current.clear()
    }

    writtenCountRef.current = chunks.length

    if (stoppedRef.current) {
      terminalRef.current.write(STOP_NOTICE)
      stopNoticeShownRef.current = true
      return
    }

    stopNoticeShownRef.current = false
  }, [chunks.length, commandRequest])

  useEffect(() => {
    if (!searchOpen) {
      return
    }

    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    })
  }, [searchOpen])

  function runSearch(direction: 'next' | 'previous', queryOverride?: string) {
    const query = (queryOverride ?? searchQuery).trim()
    if (!query || !searchAddonRef.current) {
      setSearchFeedback('Type a search query.')
      return
    }

    const matched = direction === 'next'
      ? searchAddonRef.current.findNext(query, { caseSensitive: searchCaseSensitive })
      : searchAddonRef.current.findPrevious(query, { caseSensitive: searchCaseSensitive })

    setSearchFeedback(matched ? `Match ${direction === 'next' ? 'found' : 'selected'}.` : 'No matches in this terminal buffer.')
  }

  return (
    <div className="terminal-surface-shell">
      {searchOpen && (
        <div className="terminal-search-bar" role="search">
          <input
            ref={searchInputRef}
            value={searchQuery}
            placeholder="Search terminal output"
            onChange={(event) => {
              const nextQuery = event.target.value
              setSearchQuery(nextQuery)
              if (nextQuery.trim()) {
                runSearch('next', nextQuery)
              } else {
                setSearchFeedback('')
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                runSearch(event.shiftKey ? 'previous' : 'next')
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setSearchOpen(false)
                setSearchFeedback('')
              }
            }}
          />
          <label className="terminal-search-toggle">
            <input
              type="checkbox"
              checked={searchCaseSensitive}
              onChange={(event) => {
                setSearchCaseSensitive(event.target.checked)
                if (searchQuery.trim()) {
                  window.requestAnimationFrame(() => runSearch('next'))
                }
              }}
            />
            <span>Case</span>
          </label>
          <button type="button" onClick={() => runSearch('previous')}>
            Prev
          </button>
          <button type="button" onClick={() => runSearch('next')}>
            Next
          </button>
          <button
            type="button"
            onClick={() => {
              setSearchOpen(false)
              setSearchFeedback('')
            }}
          >
            Close
          </button>
          {searchFeedback && <span className="terminal-search-feedback">{searchFeedback}</span>}
        </div>
      )}
      <div ref={hostRef} className="terminal-surface" />
    </div>
  )
}
