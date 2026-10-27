/** Saves data as a file through the browser's download. */
export function downloadFile(name: string, type: string, data: BlobPart | Uint8Array): void {
  // A copy guarantees a plain ArrayBuffer behind the bytes, which Blob requires.
  const part = data instanceof Uint8Array ? new Uint8Array(data) : data
  const url = URL.createObjectURL(new Blob([part], { type }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** A file name without characters Windows and macOS refuse. */
export function safeFileName(name: string): string {
  return name.replaceAll(UNSAFE_FILE_CHARS, '-').trim() || 'recording'
}

const UNSAFE_FILE_CHARS = /[<>:"/\\|?*]+/g
