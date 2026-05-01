export function localPathBaseName(path: string, fallback = 'upload.bin') {
  const normalized = path.trim().replace(/[/\\]+$/, '')
  if (!normalized) {
    return fallback
  }

  return normalized.split(/[/\\]+/).filter(Boolean).at(-1) ?? fallback
}
