import { useMemo, useState } from 'react'

import {
  DEFAULT_TERMINAL_FONT,
  displayFontName,
  PINNED_TERMINAL_FONTS,
  quoteFontFamily,
} from './sessionEditorHelpers'

interface FontFamilyPickerProps {
  availableFonts: string[]
  error: string
  loading: boolean
  value: string
  onChange: (value: string) => void
}

export function FontFamilyPicker({
  availableFonts,
  error,
  loading,
  value,
  onChange,
}: FontFamilyPickerProps) {
  const [query, setQuery] = useState('')
  const pinnedFonts = useMemo(
    () => PINNED_TERMINAL_FONTS.filter((font) => availableFonts.includes(font)),
    [availableFonts],
  )
  const filteredFonts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) {
      return availableFonts
    }
    return availableFonts.filter((font) => font.toLowerCase().includes(normalizedQuery))
  }, [availableFonts, query])
  const selectedName = useMemo(() => {
    if (!value.trim() || value === DEFAULT_TERMINAL_FONT) {
      return 'System Default'
    }
    return displayFontName(value)
  }, [value])
  const selectedOptionValue = useMemo(() => {
    if (!value.trim() || value === DEFAULT_TERMINAL_FONT) {
      return 'system'
    }
    return availableFonts.includes(selectedName) ? selectedName : 'custom'
  }, [availableFonts, selectedName, value])
  const customValue = query.trim()
  const filteredPinnedFonts = pinnedFonts.filter((font) => filteredFonts.includes(font))
  const filteredOtherFonts = filteredFonts.filter((font) => !filteredPinnedFonts.includes(font))

  return (
    <div className="font-picker">
      <div className="font-picker-head">
        <label className="editor-field">
          <span>{`Search fonts (${availableFonts.length} available)`}</span>
          <input
            placeholder={loading ? 'Loading system fonts...' : 'Type to filter fonts'}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        <label className="editor-field">
          <span>Font</span>
          <select
            value={selectedOptionValue}
            onChange={(event) => {
              const nextValue = event.target.value
              if (nextValue === 'system') {
                onChange(DEFAULT_TERMINAL_FONT)
                return
              }
              if (nextValue === 'custom') {
                return
              }
              onChange(quoteFontFamily(nextValue))
            }}
          >
            <option value="system">System Default</option>
            {filteredPinnedFonts.length > 0 && (
              <optgroup label="Common monospace">
                {filteredPinnedFonts.map((font) => (
                  <option key={font} value={font}>
                    {font}
                  </option>
                ))}
              </optgroup>
            )}
            {filteredOtherFonts.length > 0 && (
              <optgroup label="Matching fonts">
                {filteredOtherFonts.slice(0, 200).map((font) => (
                  <option key={font} value={font}>
                    {font}
                  </option>
                ))}
              </optgroup>
            )}
            <option value="custom">Custom...</option>
          </select>
        </label>
      </div>

      {selectedOptionValue === 'custom' && (
        <label className="editor-field">
          <span>Custom font family</span>
          <input
            placeholder={DEFAULT_TERMINAL_FONT}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
      )}

      {!error && customValue && selectedOptionValue !== 'custom' && !availableFonts.includes(customValue) && (
        <div className="font-picker-custom">
          <button className="ghost-button" type="button" onClick={() => onChange(quoteFontFamily(customValue))}>
            Use custom font: {customValue}
          </button>
        </div>
      )}

      {error && <div className="editor-hint">Could not load system fonts: {error}</div>}
      {!error && !loading && query && filteredFonts.length === 0 && <div className="editor-hint">No fonts matched this search.</div>}

      <div className="font-picker-preview" style={{ fontFamily: value || DEFAULT_TERMINAL_FONT }}>
        AaBbCc 123 // {selectedName}
      </div>
    </div>
  )
}
