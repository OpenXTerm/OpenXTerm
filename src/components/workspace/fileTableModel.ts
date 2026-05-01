export type FileSortKey = 'name' | 'size' | 'modified' | 'owner' | 'group' | 'access'
export type SortDirection = 'asc' | 'desc'

interface FileTableColumn {
  key: FileSortKey
  label: string
}

export const FILE_TABLE_COLUMNS: FileTableColumn[] = [
  { key: 'name', label: 'Name' },
  { key: 'size', label: 'Size (KB)' },
  { key: 'modified', label: 'Last modified' },
  { key: 'owner', label: 'Owner' },
  { key: 'group', label: 'Group' },
  { key: 'access', label: 'Access' },
]

export const FILE_TABLE_DEFAULT_COLUMN_WIDTHS = [240, 82, 142, 86, 86, 108]
export const FILE_TABLE_MIN_COLUMN_WIDTHS = [150, 58, 96, 58, 58, 78]
