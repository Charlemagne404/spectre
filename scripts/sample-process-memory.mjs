import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const rootPid = Number(process.argv[2]);
const outputPath = process.argv[3];
const intervalMs = Number(process.argv[4] ?? 250);
const durationMs = Number(process.argv[5] ?? 0);
if (!Number.isSafeInteger(rootPid) || rootPid <= 0 || !outputPath || !Number.isFinite(intervalMs) || intervalMs < 50 ||
  !Number.isFinite(durationMs) || durationMs < 0) {
  throw new Error('Usage: node scripts/sample-process-memory.mjs <root-pid> <output-json> [interval-ms] [duration-ms]');
}

const startedAt = new Date().toISOString();
const started = performance.now();
const samples = [];
let finished = false;

function readProcessTree() {
  const rows = execFileSync('ps', ['-Ao', 'pid=,ppid=,rss='], { encoding: 'utf8' })
    .trim().split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((row) => row.length === 3 && row.every(Number.isFinite));
  const tree = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of rows) {
      if (tree.has(parent) && !tree.has(pid)) {
        tree.add(pid);
        changed = true;
      }
    }
  }
  const selected = rows.filter(([pid]) => tree.has(pid));
  return {
    rssKiB: selected.reduce((sum, [, , rss]) => sum + rss, 0),
    processCount: selected.length,
  };
}

const timer = setInterval(() => {
  try {
    samples.push({ elapsedMs: Math.round(performance.now() - started), ...readProcessTree() });
  } catch {
    samples.push({ elapsedMs: Math.round(performance.now() - started), rssKiB: null, processCount: 0 });
  }
}, intervalMs);

async function finish() {
  if (finished) return;
  finished = true;
  clearInterval(timer);
  const valid = samples.filter((sample) => sample.rssKiB !== null);
  const peak = valid.reduce((best, sample) => !best || sample.rssKiB > best.rssKiB ? sample : best, null);
  const result = {
    rootPid,
    startedAt,
    endedAt: new Date().toISOString(),
    intervalMs,
    sampleCount: samples.length,
    baselineRssKiB: valid[0]?.rssKiB ?? null,
    peakRssKiB: peak?.rssKiB ?? null,
    peakAtMs: peak?.elapsedMs ?? null,
    peakProcessCount: peak?.processCount ?? null,
    samples,
  };
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
}

process.on('SIGINT', () => { void finish().then(() => process.exit(0)); });
process.on('SIGTERM', () => { void finish().then(() => process.exit(0)); });
if (durationMs > 0) setTimeout(() => { void finish(); }, durationMs);
console.log(`Sampling PID ${rootPid} process-tree RSS every ${intervalMs} ms; press Ctrl-C to save ${outputPath}`);
