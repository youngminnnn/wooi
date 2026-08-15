export function decodePostgresBytea(value: string): Uint8Array {
  if (!value.startsWith('\\x')) throw new Error('Invalid Postgres bytea value')
  const hex = value.slice(2)
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new Error('Invalid Postgres bytea hex')
  }
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

export function encodePostgresBytea(value: Uint8Array): string {
  let hex = ''
  for (const byte of value) hex += byte.toString(16).padStart(2, '0')
  return `\\x${hex}`
}
