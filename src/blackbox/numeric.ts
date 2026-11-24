export type IntegerWidth = 1 | 2 | 4 | 8;
export type ByteOrder = 'little' | 'big';
export type DataFormat = 'U8' | 'I8' | 'U16' | 'I16' | 'U32' | 'I32' | 'U64' | 'I64'
  | 'F32' | 'F64' | 'ASCII' | 'UTF8' | 'UTF16LE' | 'BINARY' | 'HEX' | 'UNIX32' | 'UNIX64' | 'FILETIME64';

export interface IntegerInterpretation {
  hexadecimal: string;
  decimal: string;
}

export interface DataInterpretation {
  value: string;
  detail?: string;
}

/** Interpret a bounded byte prefix as an unsigned integer in the selected byte order. */
export function interpretUnsigned(
  bytes: ArrayLike<number>,
  width: IntegerWidth,
  order: ByteOrder,
): IntegerInterpretation | null {
  if (bytes.length < width) return null;
  let value = 0n;
  for (let index = 0; index < width; index++) {
    const byteIndex = order === 'little' ? width - index - 1 : index;
    value = (value << 8n) | BigInt(bytes[byteIndex]);
  }
  return {
    hexadecimal: '0x' + value.toString(16).toUpperCase().padStart(width * 2, '0'),
    decimal: value.toString(10),
  };
}

function escapeText(value: string) {
  return [...value].map((character) => {
    const code = character.codePointAt(0)!;
    if (code === 0) return '\\0';
    if (code === 9) return '\\t';
    if (code === 10) return '\\n';
    if (code === 13) return '\\r';
    if (code < 32 || code === 127) return `\\u${code.toString(16).padStart(4, '0')}`;
    return character;
  }).join('');
}

function widthFor(format: DataFormat): IntegerWidth | null {
  if (format === 'U8' || format === 'I8') return 1;
  if (format === 'ASCII' || format === 'UTF8' || format === 'UTF16LE' || format === 'BINARY' || format === 'HEX') return null;
  if (format.endsWith('16')) return 2;
  if (format.endsWith('32')) return 4;
  return 8;
}

function signedValue(bytes: ArrayLike<number>, width: IntegerWidth, order: ByteOrder) {
  const unsigned = interpretUnsigned(bytes, width, order);
  if (!unsigned) return null;
  const raw = BigInt(unsigned.decimal);
  const sign = 1n << BigInt(width * 8 - 1);
  return raw & sign ? raw - (1n << BigInt(width * 8)) : raw;
}

function bytesForView(bytes: ArrayLike<number>, width: number) {
  const view = new DataView(new ArrayBuffer(width));
  const byteView = new Uint8Array(view.buffer);
  for (let index = 0; index < width; index++) byteView[index] = bytes[index];
  return view;
}

function unixDate(seconds: bigint): string {
  const millis = seconds * 1000n;
  if (millis > 8_640_000_000_000_000n || millis < -8_640_000_000_000_000n) return 'OUT OF DATE RANGE';
  return new Date(Number(millis)).toISOString();
}

/** Decode a selected byte range without coercing 64-bit integers through Number. */
export function interpretData(bytes: ArrayLike<number>, format: DataFormat, order: ByteOrder): DataInterpretation | null {
  if (!bytes.length) return null;
  if (format === 'HEX') {
    return { value: Array.from({ length: bytes.length }, (_, index) => bytes[index].toString(16).toUpperCase().padStart(2, '0')).join(' '), detail: `${bytes.length} selected byte${bytes.length === 1 ? '' : 's'}` };
  }
  if (format === 'BINARY') {
    return { value: Array.from({ length: bytes.length }, (_, index) => bytes[index].toString(2).padStart(8, '0')).join(' '), detail: `${bytes.length} selected byte${bytes.length === 1 ? '' : 's'}` };
  }
  if (format === 'ASCII') {
    const value = Array.from({ length: bytes.length }, (_, index) => {
      const byte = bytes[index];
      return byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : byte === 0 ? '\\0' : `\\x${byte.toString(16).padStart(2, '0').toUpperCase()}`;
    }).join('');
    return { value, detail: `${bytes.length} ASCII byte${bytes.length === 1 ? '' : 's'}` };
  }
  if (format === 'UTF8' || format === 'UTF16LE') {
    if (format === 'UTF16LE' && bytes.length % 2) return { value: 'INVALID · odd UTF-16LE byte count' };
    try {
      const buffer = Uint8Array.from({ length: bytes.length }, (_, index) => bytes[index]);
      const text = new TextDecoder(format === 'UTF8' ? 'utf-8' : 'utf-16le', { fatal: true }).decode(buffer);
      return { value: escapeText(text), detail: `${bytes.length} selected byte${bytes.length === 1 ? '' : 's'}` };
    } catch {
      return { value: `INVALID · ${format === 'UTF8' ? 'malformed UTF-8' : 'malformed UTF-16LE'}` };
    }
  }

  const width = widthFor(format);
  if (!width || bytes.length < width) return null;
  if (format === 'F32' || format === 'F64') {
    const view = bytesForView(bytes, width);
    const number = format === 'F32' ? view.getFloat32(0, order === 'little') : view.getFloat64(0, order === 'little');
    const value = Number.isNaN(number) ? 'NaN' : number === Infinity ? '+Infinity' : number === -Infinity ? '−Infinity' : Object.is(number, -0) ? '-0' : number.toString();
    const raw = interpretUnsigned(bytes, width, order)?.hexadecimal;
    return { value, detail: raw ? `${raw} · ${order.toUpperCase()}` : undefined };
  }
  if (format === 'UNIX32' || format === 'UNIX64') {
    const integer = interpretUnsigned(bytes, width, order);
    if (!integer) return null;
    const seconds = BigInt(integer.decimal);
    return { value: unixDate(seconds), detail: `${integer.decimal} Unix seconds · ${order.toUpperCase()}` };
  }
  if (format === 'FILETIME64') {
    const integer = interpretUnsigned(bytes, 8, order);
    if (!integer) return null;
    const unixMillis = (BigInt(integer.decimal) - 116_444_736_000_000_000n) / 10_000n;
    if (unixMillis > 8_640_000_000_000_000n || unixMillis < -8_640_000_000_000_000n) return { value: 'OUT OF DATE RANGE' };
    return { value: new Date(Number(unixMillis)).toISOString(), detail: `${integer.decimal} Windows FILETIME ticks · ${order.toUpperCase()}` };
  }

  if (format.startsWith('I')) {
    const value = signedValue(bytes, width, order);
    if (value === null) return null;
    return { value: value.toString(10), detail: interpretUnsigned(bytes, width, order)?.hexadecimal };
  }
  const integer = interpretUnsigned(bytes, width, order);
  return integer ? { value: integer.decimal, detail: integer.hexadecimal } : null;
}
