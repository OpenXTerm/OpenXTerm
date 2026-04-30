export type FileConflictAction = 'overwrite' | 'skip' | 'rename'

export interface FileConflictRequest {
  itemName: string
  targetPath: string
  suggestedName: string
  operation: 'download' | 'upload'
  allowApplyToAll: boolean
}

export interface FileConflictResolution {
  action: FileConflictAction
  applyToAll: boolean
  newName?: string
}

function splitName(name: string) {
  const dotIndex = name.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === name.length - 1) {
    return { stem: name, extension: '' }
  }

  return {
    stem: name.slice(0, dotIndex),
    extension: name.slice(dotIndex),
  }
}

export function uniqueConflictName(name: string, isTaken: (candidate: string) => boolean) {
  const { stem, extension } = splitName(name)
  for (let index = 1; index < 10_000; index += 1) {
    const suffix = index === 1 ? ' copy' : ` copy ${index}`
    const candidate = `${stem}${suffix}${extension}`
    if (!isTaken(candidate)) {
      return candidate
    }
  }

  return `${stem} copy ${crypto.randomUUID().slice(0, 8)}${extension}`
}

export function normalizedNameKey(name: string) {
  return name.trim().toLocaleLowerCase()
}
