export function normalizeRemotePath(path: string) {
  const trimmed = path.trim()
  if (!trimmed || trimmed === '/') {
    return '/'
  }

  return `/${trimmed.replace(/^\/+/, '').replace(/\/{2,}/g, '/')}`.replace(/\/+$/, '') || '/'
}

export function joinRemotePath(parent: string, name: string) {
  const cleanName = name.split('/').filter(Boolean).join('/')
  if (!cleanName) {
    return normalizeRemotePath(parent || '/')
  }

  const normalizedParent = normalizeRemotePath(parent || '/')
  return normalizedParent === '/' ? `/${cleanName}` : `${normalizedParent}/${cleanName}`
}

export function parentPathOf(path: string) {
  const normalizedPath = normalizeRemotePath(path)
  if (normalizedPath === '/') {
    return '/'
  }

  const parts = normalizedPath.split('/').filter(Boolean)
  if (parts.length <= 1) {
    return '/'
  }

  return `/${parts.slice(0, -1).join('/')}`
}
