import { StringScanner } from './stringScanner';
import type { FileString } from './model';

type SearchRequest =
  | { type: 'START'; jobId: number; file: File; query: string; pageSize: number; maxMatches: number; contextRange: { offset: number; length: number } | null }
  | { type: 'NEXT_PAGE'; jobId: number };

interface SearchSession {
  jobId: number;
  file: File;
  cursor: number;
  query: string;
  pageSize: number;
  contextRange: { offset: number; length: number } | null;
  scanner: StringScanner;
  chunk: Uint8Array | null;
  chunkStart: number;
  chunkIndex: number;
  matches: FileString[];
  totalMatches: number;
  maxMatches: number;
  busy: boolean;
  complete: boolean;
  lastProgressAt: number;
}

let session: SearchSession | null = null;

function reply(message: Record<string, unknown>) {
  self.postMessage(message);
}

async function searchNextPage(current: SearchSession) {
  if (current.busy || current.complete || current.totalMatches >= current.maxMatches) return;
  current.busy = true;
  current.matches = [];
  try {
    while (current.cursor < current.file.size && current.matches.length < current.pageSize) {
      if (!current.chunk || current.chunkIndex >= current.chunk.length) {
        const start = current.cursor;
        const end = Math.min(current.file.size, start + 1024 * 1024);
        current.chunk = new Uint8Array(await current.file.slice(start, end).arrayBuffer());
        current.chunkStart = start;
        current.chunkIndex = 0;
        if (!current.chunk.length) break;
      }

      while (current.chunk && current.chunkIndex < current.chunk.length) {
        const offset = current.chunkStart + current.chunkIndex;
        const pause = current.scanner.consume(current.chunk[current.chunkIndex], offset);
        current.chunkIndex++;
        current.cursor = offset + 1;
        if (pause) break;
      }

      if (current.matches.length >= current.pageSize || current.totalMatches >= current.maxMatches) break;
      if (current.chunk && current.chunkIndex >= current.chunk.length) current.chunk = null;
      const now = performance.now();
      if (now - current.lastProgressAt >= 250) {
        reply({ type: 'PROGRESS', jobId: current.jobId, scannedBytes: current.cursor, totalBytes: current.file.size });
        current.lastProgressAt = now;
      }
    }

    if (current.cursor >= current.file.size) {
      current.scanner.finish();
      current.complete = true;
    }
    reply({
      type: 'PAGE', jobId: current.jobId, matches: current.matches,
      complete: current.complete, limitReached: current.totalMatches >= current.maxMatches && !current.complete,
      scannedBytes: current.cursor, totalBytes: current.file.size,
    });
  } catch (error) {
    reply({
      type: 'ERROR', jobId: current.jobId,
      message: error instanceof Error ? error.message : 'String search failed.',
    });
  } finally {
    current.busy = false;
  }
}

self.onmessage = ({ data }: MessageEvent<SearchRequest>) => {
  if (data.type === 'START') {
    const next: SearchSession = {
      jobId: data.jobId,
      file: data.file,
      cursor: 0,
      query: data.query.slice(0, 256),
      pageSize: Math.max(1, Math.min(500, data.pageSize)),
        contextRange: data.contextRange,
      scanner: new StringScanner((finding) => {
        const value = finding.value;
        const intersectsContext = !next.contextRange
          || value.offset < next.contextRange.offset + next.contextRange.length
            && next.contextRange.offset < value.offset + value.length;
        if (!finding.matchesQuery || !intersectsContext) return;
        next.matches.push(finding.value);
        next.totalMatches++;
        return next.matches.length >= next.pageSize || next.totalMatches >= next.maxMatches;
        }, data.query),
      chunk: null,
      chunkStart: 0,
      chunkIndex: 0,
      matches: [],
      totalMatches: 0,
      maxMatches: Math.max(1, Math.min(50_000, data.maxMatches)),
      busy: false,
      complete: false,
      lastProgressAt: 0,
    };
    session = next;
    void searchNextPage(next);
    return;
  }

  if (session?.jobId === data.jobId && data.type === 'NEXT_PAGE') void searchNextPage(session);
};
