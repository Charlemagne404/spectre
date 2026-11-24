import type { Analysis } from './model';

export interface ReportContext {
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  notes: string;
  fileNotes: string;
  bookmarks: Array<{ label: string; note: string; kind: string; offset: number; length: number; createdAt: string }>;
  comparisons: Array<{
    comparedAt: string; mode: 'offset-aligned'; firstFileName: string; firstSha256: string | null;
    secondFileName: string; secondSha256: string | null; identical: boolean; comparedBytes: number;
    differingBytes: number; differenceRangeCount: number; omittedDifferenceRanges: number;
  }>;
}

export interface AnalysisReport {
  reportVersion: 2;
  generatedAt: string;
  investigation?: ReportContext & { omittedBookmarks: number; omittedComparisons: number };
  detectedFacts: {
    fileName: string;
    byteLength: number;
    detectedType: string;
    detectedMime: string;
    sourceMime: string;
    extension: string;
    extensionMatch: boolean | null;
    lastModified: string | null;
    sha256: string;
    structure: Analysis['structure'];
    reportOmissions: { parserFindings: number; parserWarnings: number; regions: number; entropyWindows: number };
    analysisMetrics: Analysis['metrics'];
    entropy: { averageBitsPerByte: number; windowCount: number; windows: Analysis['entropy'] };
    byteFrequency: { counts: number[]; total: number; firstOffsets: number[] };
    strings: { totalFound: number | null; indexed: number; indexLimitReached: boolean; limit: number; included: number; omitted: number; values: Analysis['strings'] };
    regions: Analysis['regions'];
    analysisStartedAt: string;
    analysisCompletedAt: string;
  };
  interpretations: Array<{ subject: string; note: string }>;
}

export function buildReport(analysis: Analysis, generatedAt = new Date().toISOString(), context?: ReportContext): AnalysisReport {
  const reportStringLimit = 1_000;
  const reportFindingLimit = 1_000;
  const reportRegionLimit = 2_000;
  const reportEntropyLimit = 512;
  const reportStrings = analysis.strings.slice(0, reportStringLimit);
  const reportFindings = (analysis.structure.findings ?? []).slice(0, reportFindingLimit).map((finding) => ({
    ...finding, label: finding.label.slice(0, 256), value: finding.value.slice(0, 4_096),
  }));
  const reportWarnings = analysis.structure.warnings.slice(0, 64).map((warning) => warning.slice(0, 1_024));
  const reportRegions = analysis.regions.slice(0, reportRegionLimit).map((region) => ({ ...region, label: region.label.slice(0, 256) }));
  const reportEntropy = analysis.entropy.slice(0, reportEntropyLimit);
  const interpretations: AnalysisReport['interpretations'] = [];
  if (analysis.extensionMatch === false) {
    interpretations.push({
      subject: 'Filename extension',
      note: `The extension ${analysis.extension || '(none)'} differs from the type detected from file contents (${analysis.type}). This is a naming discrepancy and is not a maliciousness verdict.`,
    });
  }
  if (analysis.structure.limitation) interpretations.push({ subject: 'Structural parser', note: analysis.structure.limitation.slice(0, 4_096) });
  for (const warning of reportWarnings) interpretations.push({ subject: 'Parser warning', note: warning });
  if (analysis.stringIndexLimitReached) interpretations.push({ subject: 'String index limit',
    note: 'The primary pass retained 50,000 string previews and stopped counting additional strings to bound work. Full-file search remains available.' });
  return {
    reportVersion: 2,
    generatedAt,
    ...(context ? { investigation: {
      ...context,
      notes: context.notes.slice(0, 20_000),
      fileNotes: context.fileNotes.slice(0, 8_000),
      bookmarks: context.bookmarks.slice(0, 1_000),
      comparisons: context.comparisons.slice(0, 200),
      omittedBookmarks: Math.max(0, context.bookmarks.length - 1_000),
      omittedComparisons: Math.max(0, context.comparisons.length - 200),
    } } : {}),
    detectedFacts: {
      fileName: analysis.name,
      byteLength: analysis.size,
      detectedType: analysis.type,
      detectedMime: analysis.mime,
      sourceMime: analysis.sourceMime,
      extension: analysis.extension,
      extensionMatch: analysis.extensionMatch,
      lastModified: analysis.lastModified ? new Date(analysis.lastModified).toISOString() : null,
      sha256: analysis.sha256,
      structure: { ...analysis.structure, limitation: analysis.structure.limitation?.slice(0, 4_096) ?? null,
        warnings: reportWarnings, findings: reportFindings },
      reportOmissions: {
        parserFindings: Math.max(0, (analysis.structure.findings?.length ?? 0) - reportFindings.length),
        parserWarnings: Math.max(0, analysis.structure.warnings.length - reportWarnings.length),
        regions: Math.max(0, analysis.regions.length - reportRegions.length),
        entropyWindows: Math.max(0, analysis.entropy.length - reportEntropy.length),
      },
      analysisMetrics: analysis.metrics,
      entropy: { averageBitsPerByte: analysis.averageEntropy, windowCount: analysis.entropy.length, windows: reportEntropy },
      byteFrequency: { counts: analysis.histogram, total: analysis.histogram.reduce((sum, count) => sum + count, 0), firstOffsets: analysis.firstOffsets },
      strings: { totalFound: analysis.stringIndexLimitReached ? null : analysis.totalStrings,
        indexed: analysis.strings.length, indexLimitReached: analysis.stringIndexLimitReached, limit: 50_000,
        included: reportStrings.length, omitted: analysis.strings.length - reportStrings.length,
        values: reportStrings.map((item) => ({ ...item, text: item.text.slice(0, 240) })) },
      regions: reportRegions,
      analysisStartedAt: analysis.startedAt,
      analysisCompletedAt: analysis.completedAt,
    },
    interpretations,
  };
}

function escapeHtml(value: unknown) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}

function formatSize(size: number) {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  const unit = Math.min(units.length - 1, size ? Math.floor(Math.log(size) / Math.log(1024)) : 0);
  return (size / 1024 ** unit).toLocaleString('en', { maximumFractionDigits: unit ? 2 : 0 }) + ' ' + units[unit];
}

export function buildHtmlReport(analysis: Analysis, generatedAt = new Date().toISOString(), context?: ReportContext) {
  const report = buildReport(analysis, generatedAt, context);
  const facts = report.detectedFacts;
  const regions = facts.regions.map((item) => `<tr><td>${escapeHtml(item.label)}</td><td>0x${item.offset.toString(16).toUpperCase()}</td><td>${escapeHtml(formatSize(item.length))}</td><td>${escapeHtml(item.kind)}</td></tr>`).join('');
  const strings = facts.strings.values.map((item) => `<tr><td>0x${item.offset.toString(16).toUpperCase()}</td><td>${escapeHtml(item.encoding)}</td><td>${escapeHtml(item.text)}</td><td>${escapeHtml(item.length)}</td></tr>`).join('');
  const findings = (facts.structure.findings ?? []).map((item) => `<tr><td>${escapeHtml(item.label)}</td><td>${escapeHtml(item.value)}</td><td>${item.offset === undefined ? '—' : '0x' + item.offset.toString(16).toUpperCase()}</td><td>${item.length === undefined ? '—' : escapeHtml(formatSize(item.length))}</td></tr>`).join('');
  const entropy = facts.entropy.windows.map((item) => `<tr><td>0x${item.offset.toString(16).toUpperCase()}</td><td>${escapeHtml(item.length)}</td><td>${item.value.toFixed(4)}</td></tr>`).join('');
  const frequency = facts.byteFrequency.counts.map((count, byte) => `<tr><td>0x${byte.toString(16).toUpperCase().padStart(2, '0')}</td><td>${count}</td><td>${facts.byteFrequency.firstOffsets[byte] < 0 ? 'Not present' : '0x' + facts.byteFrequency.firstOffsets[byte].toString(16).toUpperCase()}</td></tr>`).join('');
  const stringCount = facts.strings.totalFound === null
    ? `${facts.strings.indexed.toLocaleString('en')} indexed; index limit reached`
    : `${facts.strings.totalFound.toLocaleString('en')} found, ${facts.strings.indexed.toLocaleString('en')} indexed`;
  const stringLimitNote = facts.strings.indexLimitReached
    ? ' The primary pass stopped counting at the 50,000-entry index limit to bound work; full-file search remains available in BLACKBOX.' : '';
  const interpretations = report.interpretations.length
    ? `<section><h2>Interpretations and limitations</h2><ul>${report.interpretations.map((item) => `<li><strong>${escapeHtml(item.subject)}:</strong> ${escapeHtml(item.note)}</li>`).join('')}</ul></section>`
    : '<section><h2>Interpretations and limitations</h2><p>No extension discrepancy or parser warnings were recorded.</p></section>';
  const extensionNote = facts.extensionMatch === false
    ? `<p class="notice">Filename extension ${escapeHtml(facts.extension || '(none)')} does not match the detected type. This is a naming discrepancy, not a maliciousness verdict.</p>` : '';
  const investigation = report.investigation;
  const investigationSection = investigation ? `<section><h2>Investigation · ${escapeHtml(investigation.name || 'Untitled investigation')}</h2>
<p>Local identifier ${escapeHtml(investigation.id)} · Created ${escapeHtml(investigation.createdAt)} · Modified ${escapeHtml(investigation.modifiedAt)}</p>
<p><strong>Investigation notes:</strong><br>${escapeHtml(investigation.notes || '(none)')}</p><p><strong>File notes:</strong><br>${escapeHtml(investigation.fileNotes || '(none)')}</p>
<h3>Bookmarks · ${investigation.bookmarks.length} included${investigation.omittedBookmarks ? ` · ${investigation.omittedBookmarks} omitted` : ''}</h3>
<table><thead><tr><th>Label / note</th><th>Kind</th><th>Offset</th><th>Length</th></tr></thead><tbody>${investigation.bookmarks.map((item) => `<tr><td>${escapeHtml(item.label)}<br>${escapeHtml(item.note)}</td><td>${escapeHtml(item.kind)}</td><td>0x${item.offset.toString(16).toUpperCase()}</td><td>${escapeHtml(formatSize(item.length))}</td></tr>`).join('') || '<tr><td colspan="4">No bookmarks were recorded</td></tr>'}</tbody></table>
<h3>Comparisons · ${investigation.comparisons.length} included${investigation.omittedComparisons ? ` · ${investigation.omittedComparisons} omitted` : ''}</h3>
<table><thead><tr><th>Mode / time</th><th>File A</th><th>File B</th><th>Result</th></tr></thead><tbody>${investigation.comparisons.map((item) => `<tr><td>${escapeHtml(item.mode)}<br>${escapeHtml(item.comparedAt)}</td><td>${escapeHtml(item.firstFileName)}<br>${escapeHtml(item.firstSha256 ?? '(no SHA-256)')}</td><td>${escapeHtml(item.secondFileName)}<br>${escapeHtml(item.secondSha256 ?? '(no SHA-256)')}</td><td>${item.identical ? 'Byte-identical' : `${item.differingBytes.toLocaleString('en')} differing offsets · ${item.differenceRangeCount.toLocaleString('en')} ranges`}<br>${escapeHtml(formatSize(item.comparedBytes))} compared</td></tr>`).join('') || '<tr><td colspan="4">No comparisons were recorded</td></tr>'}</tbody></table></section>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Spectre analysis — ${escapeHtml(facts.fileName)}</title><style>
body{margin:0;background:#10100f;color:#e8e8e5;font:14px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}main{max-width:1100px;margin:0 auto;padding:42px 28px 80px}h1{font-size:clamp(24px,4vw,38px);font-weight:500;overflow-wrap:anywhere}h2{margin-top:38px;padding-bottom:9px;border-bottom:1px solid #393733;font-size:15px;letter-spacing:.08em;text-transform:uppercase}h3{margin:20px 0 8px;font-size:13px;color:#edba74}p,.muted{color:#aaa9a5}code,td:first-child{color:#edba74}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:18px 28px;margin-top:28px}.grid span{display:block;color:#81807c;font-size:11px;text-transform:uppercase}.grid strong{display:block;overflow-wrap:anywhere;font-weight:500}.digest{word-break:break-all}.notice{padding:12px;border-left:2px solid #d49a4a;background:#241d15;color:#edba74}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;vertical-align:top;padding:7px 9px;border-bottom:1px solid #292825}th{color:#81807c;font-weight:500}td{overflow-wrap:anywhere}details{margin-top:12px}summary{cursor:pointer;color:#edba74}ul{padding-left:24px;color:#aaa9a5}li{margin:7px 0}@media(max-width:640px){main{padding:28px 16px 50px}table{font-size:10px}th,td{padding:6px 4px}}
</style></head><body><main><p class="muted">SPECTRE / BLACKBOX · ANALYSIS REPORT</p><h1>${escapeHtml(facts.fileName)}</h1><p class="muted">Generated ${escapeHtml(new Date(generatedAt).toLocaleString())} · Analysis ${escapeHtml(facts.analysisStartedAt)} to ${escapeHtml(facts.analysisCompletedAt)}</p>${extensionNote}${investigationSection}
<section class="grid"><div><span>Detected type</span><strong>${escapeHtml(facts.detectedType)}</strong></div><div><span>Detected MIME</span><strong>${escapeHtml(facts.detectedMime)}</strong></div><div><span>File size</span><strong>${escapeHtml(formatSize(facts.byteLength))} (${facts.byteLength.toLocaleString('en')} bytes)</strong></div><div><span>SHA-256</span><strong class="digest">${escapeHtml(facts.sha256)}</strong></div><div><span>File extension</span><strong>${escapeHtml(facts.extension || '(none)')} · ${facts.extensionMatch === null ? 'not assessed' : facts.extensionMatch ? 'matches detected type' : 'does not match detected type'}</strong></div><div><span>Source MIME</span><strong>${escapeHtml(facts.sourceMime || '(not provided)')}</strong></div><div><span>File modified</span><strong>${escapeHtml(facts.lastModified || '(not provided)')}</strong></div><div><span>Overall entropy</span><strong>${facts.entropy.averageBitsPerByte.toFixed(4)} bits per byte</strong></div></section>
<section><h2>Analysis runtime</h2><p>${facts.analysisMetrics.durationMs.toFixed(1)} ms · ${facts.analysisMetrics.eventCount.toLocaleString('en')} analysis events · ${facts.analysisMetrics.eventsPerSecond.toFixed(1)} events/s · ${escapeHtml(formatSize(facts.analysisMetrics.chunkSize))} chunks</p><p class="muted">Measured phase time · file ranges ${facts.analysisMetrics.phasesMs.fileRanges.toFixed(1)} ms · SHA-256 ${facts.analysisMetrics.phasesMs.sha256.toFixed(1)} ms · statistics and strings ${facts.analysisMetrics.phasesMs.statisticsAndStrings.toFixed(1)} ms · structure parser ${facts.analysisMetrics.phasesMs.structureParser.toFixed(1)} ms</p></section>
${interpretations}<section><h2>Structure · ${escapeHtml(facts.structure.parser)}</h2><p>${facts.structure.mode === 'format-aware' ? 'Format-aware boundaries' : 'Generic byte ranges'} · ${facts.structure.complete ? 'complete' : 'partial'}${facts.structure.limitation ? ' · ' + escapeHtml(facts.structure.limitation) : ''}</p><table><thead><tr><th>Region</th><th>Offset</th><th>Length</th><th>Kind</th></tr></thead><tbody>${regions || '<tr><td colspan="4">No regions (empty file)</td></tr>'}</tbody></table>${facts.reportOmissions.regions ? `<p>${facts.reportOmissions.regions.toLocaleString('en')} additional regions omitted from this bounded report.</p>` : ''}</section>
<section><h2>Confirmed parser findings · ${(facts.structure.findings ?? []).length}</h2><table><thead><tr><th>Finding</th><th>Value</th><th>Offset</th><th>Length</th></tr></thead><tbody>${findings || '<tr><td colspan="4">No format-aware findings were recorded</td></tr>'}</tbody></table>${facts.reportOmissions.parserFindings ? `<p>${facts.reportOmissions.parserFindings.toLocaleString('en')} additional findings omitted from this bounded report.</p>` : ''}${facts.reportOmissions.parserWarnings ? `<p>${facts.reportOmissions.parserWarnings.toLocaleString('en')} additional warnings omitted from this bounded report.</p>` : ''}</section>
<section><h2>Regional entropy · ${facts.entropy.windows.length} included of ${facts.entropy.windowCount} windows</h2><table><thead><tr><th>Offset</th><th>Bytes</th><th>Bits per byte</th></tr></thead><tbody>${entropy || '<tr><td colspan="3">No entropy windows (empty file)</td></tr>'}</tbody></table>${facts.reportOmissions.entropyWindows ? `<p>${facts.reportOmissions.entropyWindows.toLocaleString('en')} additional windows omitted from this bounded report.</p>` : ''}</section>
<section><h2>Printable strings · ${escapeHtml(stringCount)}</h2><p>Included ${facts.strings.included.toLocaleString('en')} entries; ${facts.strings.omitted.toLocaleString('en')} indexed entries omitted from this bounded report. Each indexed preview is at most 240 characters. The on-screen full-file search can find strings outside the 50,000-entry index.${escapeHtml(stringLimitNote)}</p><table><thead><tr><th>Offset</th><th>Encoding</th><th>Text</th><th>Byte length</th></tr></thead><tbody>${strings || '<tr><td colspan="4">No strings found</td></tr>'}</tbody></table></section>
<section><h2>Byte frequency · ${facts.byteFrequency.total.toLocaleString('en')} bytes counted</h2><details><summary>Show all 256 byte values</summary><table><thead><tr><th>Byte</th><th>Count</th><th>First offset</th></tr></thead><tbody>${frequency}</tbody></table></details></section>
<p class="muted">Facts are calculated from the selected file contents. Parser limitations and filename interpretation are listed separately. Imported files were read as data and were not executed or modified.</p></main></body></html>`;
}

function safeFilename(name: string) {
  return name.replace(/\.[^.]*$/, '').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'file';
}

export function downloadReport(analysis: Analysis, format: 'json' | 'html', context?: ReportContext) {
  const generatedAt = new Date().toISOString();
  const content = format === 'json'
    ? JSON.stringify(buildReport(analysis, generatedAt, context), null, 2)
    : buildHtmlReport(analysis, generatedAt, context);
  const mime = format === 'json' ? 'application/json' : 'text/html';
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'spectre-' + safeFilename(analysis.name) + '-analysis.' + format;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
