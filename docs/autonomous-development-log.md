# Autonomous development log

## 2026-11-24 · BLACKBOX investigation workbench

- Verified the working branch was `codex/spectre-overnight` at `0041b9be`; preserved its history and unrelated work.
- Reworked the hex pane into a bounded 1 KiB random-access view with offset jumps, byte/range selection, navigation history, keyboard movement, bounded copy, synchronized structure context, and signed/unsigned, float, text, raw-byte, and timestamp interpretation. 64-bit values retain exact `BigInt` precision.
- Added cancellable bounded search for hexadecimal (including byte and nibble wildcards), ASCII, UTF-8, and UTF-16LE. Search wraps in either direction, reports scanned progress, and links matches into shared selection.
- Added local, versioned IndexedDB investigations with transactional record updates, notes, file metadata, comparison summaries, and SHA-256/size-gated bookmarks. File bytes and full paths are not stored; a missing source must be selected again and fingerprint-matched before bookmark navigation.
- Added an offset-aligned comparison workflow. It reads 1 MiB slices, calculates independent digests and statistics, caps retained difference ranges at 10,000, supports side-by-side byte windows and navigation, and clearly states that insertions/deletions are not aligned.
- Added thin/fat 32/64-bit Mach-O parsing in both byte orders, bounded embedded-signature discovery, parser-region navigation, and escaped/bounded reports with omission counts.
- Captured actual launcher, empty, progress, completed, inspector, structural, investigation, bookmark, and comparison screens at 1920×1080, 1440×900, 1280×800, 1024×768, and 740×580. Recorded four real workflows. Evidence is local under `output/development-mission-3/` and ignored by Git.
- Disk-backed 128 MiB helper benchmark: offset-aligned comparison **2.54 s** (one changed byte correctly identified); full-file no-match search **0.96 s**. This is a Node/Vitest helper measurement, not a Chromium or native application benchmark.
- `npm run build` passed; `npm test -- --reporter=dot` passed 47 tests; `npm run test:e2e -- --workers=1` passed 44 tests across Chromium and WebKit with 14 opt-in profiling cases skipped; `git diff --check` passed. A WebKit-only history race found in the first full run was fixed by recording action-driven navigation synchronously; the subsequent full run passed.
- Native Linux build remains blocked: `glib-2.0.pc`, `gtk+-3.0.pc`, and `webkit2gtk-4.1.pc` are unavailable; unattended sudo is unavailable. No privileged install was attempted. The supported prerequisite command is recorded in the mission report.

### Remaining work and limits

- No insertion-aware binary diff, native desktop compile/runtime validation, database export/import, or persisted full difference map. Difference ranges beyond the 10,000 retained navigation cap are counted but not browsable.
- Investigation persistence is local to the browser/WebView origin and profile; browser-data removal can erase it. JSON/HTML reports provide a portable summary, not a restorable database backup.
- Existing format parsers remain intentionally bounded; PDF xref streams, object streams, and stream payloads remain unresolved. Mach-O code-signing presence is reported, not cryptographically verified.
