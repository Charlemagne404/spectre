// Deterministic, valid PCM WAVE. The inspector treats this exactly like an imported file.
export function demonstrationFile() {
  const encoder = new TextEncoder();
  const tag = (value: string) => encoder.encode(value);
  function chunk(name: string, payload: Uint8Array) {
    const result = new Uint8Array(8 + payload.length + payload.length % 2);
    result.set(tag(name));
    new DataView(result.buffer).setUint32(4, payload.length, true);
    result.set(payload, 8);
    return result;
  }

  const format = new Uint8Array(16);
  const formatView = new DataView(format.buffer);
  formatView.setUint16(0, 1, true);
  formatView.setUint16(2, 1, true);
  formatView.setUint32(4, 16000, true);
  formatView.setUint32(8, 16000, true);
  formatView.setUint16(12, 1, true);
  formatView.setUint16(14, 8, true);

  const info = new Uint8Array(716);
  info.set(tag('INFO'));
  const fields = [
    ['INAM', 'RELAY 07 / reference capture'],
    ['IART', 'Spectre Laboratory'],
    ['ICMT', 'Deterministic signal for the BLACKBOX inspector'],
    ['ISFT', 'Spectre fixture generator'],
    ['IPRD', 'Signal studies / volume one'],
    ['IGNR', 'Calibration'],
    ['IKEY', 'carrier; silence; impulse; noise'],
    ['ISBJ', 'Single channel reference waveform'],
    ['ISRC', 'Internally generated'],
  ];
  let cursor = 4;
  for (const [key, value] of fields) {
    const entry = chunk(key, tag(value + '\0'));
    info.set(entry, cursor);
    cursor += entry.length;
  }
  info.set(chunk('JUNK', new Uint8Array(info.length - cursor - 8)), cursor);

  const pcm = new Uint8Array(84 * 1024);
  let seed = 0x6db5ca12;
  const levels = [0, 5, 25, 45, 50, 12, 32, 4, 4, 84, 94, 100, 82, 55, 11, 38, 48, 49, 15, 6, 55, 92, 68, 22, 4, 1, 34, 66, 91, 59, 12, 2];
  for (let index = 0; index < pcm.length; index++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const position = index / pcm.length * (levels.length - 1);
    const step = Math.floor(position);
    const fraction = position - step;
    const amplitude = levels[step] * (1 - fraction) + (levels[step + 1] ?? 0) * fraction;
    const carrier = Math.sin(index * 0.094) * 0.32;
    const noise = ((seed >>> 0) / 0xffffffff - 0.5) * 1.8;
    pcm[index] = Math.round(128 + amplitude * (carrier + noise));
  }

  const padding = new Uint8Array(10 * 1024);
  padding.set(tag('END OF REFERENCE CAPTURE\0'));
  const chunks = [chunk('fmt ', format), chunk('LIST', info), chunk('data', pcm), chunk('JUNK', padding)];
  const header = new Uint8Array(12);
  header.set(tag('RIFF'));
  new DataView(header.buffer).setUint32(4, 4 + chunks.reduce((sum, part) => sum + part.length, 0), true);
  header.set(tag('WAVE'), 8);
  return new File([header, ...chunks], 'relay_07.wav', { type: 'audio/wav', lastModified: 0 });
}
