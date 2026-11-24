import type { FileIdentity, Region, StructureReport } from './model';

export interface ParserOutput {
  regions: Region[];
  structure: StructureReport;
}

export interface FormatParser {
  id: string;
  supports: (identity: FileIdentity) => boolean;
  parse: (file: File, signal?: AbortSignal) => Promise<ParserOutput | null>;
}

export interface ParserDispatch {
  parser: string | null;
  output: ParserOutput | null;
  error: string | null;
}

/** Runs one matching parser and isolates malformed-file failures from other analysis stages. */
export async function runParserRegistry(
  file: File,
  identity: FileIdentity,
  parsers: FormatParser[],
  signal?: AbortSignal,
): Promise<ParserDispatch> {
  const parser = parsers.find((candidate) => candidate.supports(identity));
  if (!parser) return { parser: null, output: null, error: null };
  try {
    return { parser: parser.id, output: await parser.parse(file, signal), error: null };
  } catch (error) {
    if (signal?.aborted || error instanceof Error && error.name === 'AbortError') throw error;
    const message = error instanceof Error ? error.message.slice(0, 180) : 'Unknown parser failure';
    return { parser: parser.id, output: null, error: message };
  }
}
