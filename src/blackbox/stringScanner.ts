import type { FileString } from './model';

export const STRING_PREVIEW_LENGTH = 240;
export const MIN_ASCII_STRING_BYTES = 5;
export const MIN_UTF16LE_STRING_BYTES = 10;

export type StringFinding = { value: FileString; matchesQuery: boolean };

/** Incremental printable string scanner. It retains only a short preview and query window. */
export class StringScanner {
  private asciiOffset = -1;
  private asciiLength = 0;
  private asciiPreview = '';
  private asciiTail = '';
  private asciiMatch = false;
  private asciiCapture = false;

  private utfMode: 'candidate' | 'high' | 'low' | null = null;
  private utfCandidateOffset = -1;
  private utfCandidateByte = 0;
  private utfOffset = -1;
  private utfLength = 0;
  private utfPreview = '';
  private utfTail = '';
  private utfMatch = false;
  private utfCapture = false;
  private utfPendingByte = 0;
  private finished = false;
  private findingCount = 0;
  private readonly needle: string;

  constructor(
    private readonly onFinding: (finding: StringFinding) => boolean | void,
    query = '',
    private readonly maxFindings = Number.POSITIVE_INFINITY,
  ) {
    this.needle = query.slice(0, 256).toLowerCase();
  }

  get totalFindings() {
    return this.findingCount;
  }

  consume(byte: number, offset: number) {
    if (this.finished) throw new Error('Cannot feed a finished string scanner.');
    let pause = false;
    if (byte >= 0x20 && byte <= 0x7e) {
      if (this.asciiLength === 0) {
        this.asciiOffset = offset;
        this.asciiCapture = this.findingCount < this.maxFindings;
      }
      if (this.asciiCapture && this.asciiPreview.length < STRING_PREVIEW_LENGTH) this.asciiPreview += String.fromCharCode(byte);
      this.asciiLength++;
      if (this.needle && !this.asciiMatch) {
        this.asciiTail = (this.asciiTail + String.fromCharCode(byte)).slice(-this.needle.length);
        this.asciiMatch = this.asciiTail.toLowerCase().includes(this.needle);
      }
    } else if (this.asciiLength) {
      pause = this.finishAscii();
    }

    if (this.utfMode === 'candidate') {
      if (offset === this.utfCandidateOffset + 1 && byte === 0) {
        this.utfOffset = this.utfCandidateOffset;
        this.utfLength = 2;
        this.utfCapture = this.findingCount < this.maxFindings;
        this.appendUtf(this.utfCandidateByte);
        this.utfMode = 'low';
      } else {
        this.setUtfCandidate(byte, offset);
      }
    } else if (this.utfMode === 'high') {
      if (byte === 0) {
        this.utfLength += 2;
        this.appendUtf(this.utfPendingByte);
        this.utfMode = 'low';
      } else {
        pause = this.finishUtf() || pause;
        this.setUtfCandidate(byte, offset);
      }
    } else if (this.utfMode === 'low') {
      if (byte >= 0x20 && byte <= 0x7e) {
        this.utfPendingByte = byte;
        this.utfMode = 'high';
      } else {
        pause = this.finishUtf() || pause;
      }
    } else if (byte >= 0x20 && byte <= 0x7e) {
      this.utfCandidateOffset = offset;
      this.utfCandidateByte = byte;
      this.utfMode = 'candidate';
    }

    return pause;
  }

  finish() {
    if (this.finished) return false;
    this.finished = true;
    const asciiPause = this.asciiLength ? this.finishAscii() : false;
    const utfPause = this.utfLength ? this.finishUtf() : false;
    this.utfMode = null;
    return asciiPause || utfPause;
  }

  private appendUtf(byte: number) {
    const character = String.fromCharCode(byte);
    if (this.utfCapture && this.utfPreview.length < STRING_PREVIEW_LENGTH) this.utfPreview += character;
    if (this.needle && !this.utfMatch) {
      this.utfTail = (this.utfTail + character).slice(-this.needle.length);
      this.utfMatch = this.utfTail.toLowerCase().includes(this.needle);
    }
  }

  private setUtfCandidate(byte: number, offset: number) {
    if (byte >= 0x20 && byte <= 0x7e) {
      this.utfCandidateOffset = offset;
      this.utfCandidateByte = byte;
      this.utfMode = 'candidate';
    } else {
      this.utfMode = null;
    }
  }

  private finishAscii() {
    let pause = false;
    if (this.asciiLength >= MIN_ASCII_STRING_BYTES) {
      this.findingCount++;
      if (this.asciiCapture && this.findingCount <= this.maxFindings) {
        pause = this.onFinding({
          value: { offset: this.asciiOffset, length: this.asciiLength, text: this.asciiPreview, encoding: 'ASCII' },
          matchesQuery: this.asciiMatch,
        }) === true;
      }
    }
    this.asciiOffset = -1;
    this.asciiLength = 0;
    this.asciiPreview = '';
    this.asciiTail = '';
    this.asciiMatch = false;
    this.asciiCapture = false;
    return pause;
  }

  private finishUtf() {
    let pause = false;
    if (this.utfLength >= MIN_UTF16LE_STRING_BYTES) {
      this.findingCount++;
      if (this.utfCapture && this.findingCount <= this.maxFindings) {
        pause = this.onFinding({
          value: { offset: this.utfOffset, length: this.utfLength, text: this.utfPreview, encoding: 'UTF-16LE' },
          matchesQuery: this.utfMatch,
        }) === true;
      }
    }
    this.utfMode = null;
    this.utfCandidateOffset = -1;
    this.utfOffset = -1;
    this.utfLength = 0;
    this.utfPreview = '';
    this.utfTail = '';
    this.utfMatch = false;
    this.utfCapture = false;
    this.utfPendingByte = 0;
    return pause;
  }
}
