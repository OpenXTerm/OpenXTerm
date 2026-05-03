import { readClipboardText } from './bridge'

const EDITABLE_INPUT_TYPES = new Set([
  '',
  'email',
  'number',
  'password',
  'search',
  'tel',
  'text',
  'url',
])

export function isEditablePasteShortcut(event: KeyboardEvent) {
  return (
    ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v')
    || (event.shiftKey && event.key === 'Insert')
  )
}

export function installEditablePasteShortcut() {
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !isEditablePasteShortcut(event)) {
      return
    }

    const target = event.target
    const editable = target instanceof Element ? editableTargetFromElement(target) : null
    if (!editable) {
      return
    }

    event.preventDefault()
    void readClipboardText()
      .then((text) => {
        if (!text) {
          return
        }

        insertTextIntoEditable(editable, text)
      })
      .catch(() => {})
  }

  window.addEventListener('keydown', handleKeyDown, { capture: true })
  return () => {
    window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }
}

type EditableTarget = HTMLInputElement | HTMLTextAreaElement | HTMLElement

function editableTargetFromElement(element: Element): EditableTarget | null {
  if (element.closest('.terminal-surface')) {
    return null
  }

  if (element instanceof HTMLTextAreaElement && !element.readOnly && !element.disabled) {
    return element
  }

  if (
    element instanceof HTMLInputElement
    && !element.readOnly
    && !element.disabled
    && EDITABLE_INPUT_TYPES.has(element.type)
  ) {
    return element
  }

  const contentEditable = element.closest<HTMLElement>('[contenteditable=""], [contenteditable="true"]')
  if (contentEditable && contentEditable.isContentEditable) {
    return contentEditable
  }

  return null
}

function insertTextIntoEditable(editable: EditableTarget, text: string) {
  if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
    insertTextIntoFormControl(editable, text)
    return
  }

  insertTextIntoContentEditable(editable, text)
}

function insertTextIntoFormControl(editable: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const value = editable.value
  const selectionStart = editable.selectionStart ?? value.length
  const selectionEnd = editable.selectionEnd ?? selectionStart
  const nextValue = `${value.slice(0, selectionStart)}${text}${value.slice(selectionEnd)}`
  const nextCursor = selectionStart + text.length

  editable.value = nextValue
  editable.setSelectionRange(nextCursor, nextCursor)
  editable.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    data: text,
    inputType: 'insertFromPaste',
  }))
}

function insertTextIntoContentEditable(editable: HTMLElement, text: string) {
  editable.focus()
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) {
    editable.append(document.createTextNode(text))
    editable.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      data: text,
      inputType: 'insertFromPaste',
    }))
    return
  }

  const range = selection.getRangeAt(0)
  range.deleteContents()
  const node = document.createTextNode(text)
  range.insertNode(node)
  range.setStartAfter(node)
  range.setEndAfter(node)
  selection.removeAllRanges()
  selection.addRange(range)
  editable.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    data: text,
    inputType: 'insertFromPaste',
  }))
}
