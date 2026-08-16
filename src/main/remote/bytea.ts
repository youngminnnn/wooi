export function toPgBytea(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return `\\x${hex}`
}

export function fromPgBytea(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !/^\\x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error('invalid bytea value')
  }
  const bytes = new Uint8Array((value.length - 2) / 2)
  for (let i = 2; i < value.length; i += 2) {
    bytes[(i - 2) / 2] = Number.parseInt(value.slice(i, i + 2), 16)
  }
  return bytes
}
