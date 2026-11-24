export type IntegerWidth = 1 | 2 | 4 | 8;
export type ByteOrder = 'little' | 'big';

export interface IntegerInterpretation {
  hexadecimal: string;
  decimal: string;
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
