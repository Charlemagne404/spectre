# Spectre

Spectre is a local-first desktop file investigation tool. BLACKBOX opens with five intentional empty panes, then links file identity, structure, strings, hex navigation, bookmarks, and optional two-file comparison into one workspace.

## Run and build

Install Node.js 22.12+ or 24 LTS, stable Rust, and the Tauri system dependencies for your OS. Use the host platform to build its native package. [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

```sh
npm ci
npm run tauri dev
```

`npm run tauri build` creates the release binary and host-specific bundles in `src-tauri/target/release/`. On macOS, `npm run tauri build -- --bundles app` builds the local application bundle. Use `npm run dev` for frontend development in a browser.

## Intake and inspection

Click **[1] BLACKBOX** or press **1**. Open a file through the system picker or drop it on the window. Use **Sample** to reopen the bundled WAVE file, **Reanalyze** to run the current file again, and **Open file** to replace it. A replacement terminates the current worker before starting the next one.

BLACKBOX identifies a file from its contents, compares its extension with the detected type, and calculates SHA-256. An extension discrepancy is shown as a filename mismatch; it is not a threat verdict. The file pane shows detected type, MIME, size, digest, parser status, and structural limitations.

The worker emits typed analysis events. The interface uses those events as its live state: entropy windows extend as their bytes are scanned, strings arrive in batches, frequency counts update from the same byte stream, and parser regions appear after their boundaries are read. Progress reports bytes actually scanned. Cancelling terminates the worker, and replacing a file invalidates stale messages.

| Shortcut | Action |
| --- | --- |
| **⌘/Ctrl+O** | Open a file |
| **⌘/Ctrl+F** | Focus the string filter |
| **Arrow keys** | Move through the focused hex inspector, string list, or chart |
| **Page Up / Page Down** | Move one hex page |
| **Home / End** | Move to the start or end of the current hex row or chart |
| **Ctrl/⌘+Home / Ctrl/⌘+End** | Jump to the first or last file byte |
| **Esc** | Leave the focused input, return to the launcher, or skip an animation |

The hex inspector reads one 1 KiB page around the selected offset, accepts precise hexadecimal jumps, keeps bounded back/forward selection history, and extends byte or range selections with Shift+arrows or Shift+click. Copy is capped at 4 KiB. Byte search supports exact hex, nibble and byte wildcards, ASCII, UTF-8, and UTF-16LE patterns; forward and backward searches wrap, scan 1 MiB slices, report actual progress, and can be cancelled. Matches are highlighted and share their selection with the other panes.

The data inspector interprets the selected bytes as signed or unsigned 8/16/32/64-bit integers, float32/float64, ASCII, UTF-8, UTF-16LE, binary, hex, Unix time, and Windows FILETIME. Integers use `BigInt` internally so 64-bit values stay exact. Values that exceed the selected bytes or contain invalid text remain explicitly unresolved. The strings pane filters indexed strings and navigates to exact ranges. Selecting a structure, string, entropy window, byte-frequency value, hex match, or embedded signature synchronizes the selected range and reveals overlapping structure context when the parser has it.

The **Embedded signatures** section scans a file on demand in bounded slices. It distinguishes a signature candidate from a structurally validated object and a bounded complete object; its notes call out checks that were not performed. Results navigate to the source bytes. It never extracts or executes detected content.

## Investigations and comparison

Use **Investigation** to create or reopen a local case, rename or delete it, add case and file notes, and revisit bookmarks. A file record stores its filename, byte size, SHA-256, detected format, inspection time, bounded analysis summary, notes, and bookmarks. The source file and full path are never copied into the investigation database. If a source is missing, its old metadata remains available; byte navigation is enabled again only after the user supplies a file whose SHA-256 and size match the stored fingerprint. One-off inspection still works without creating a case.

Investigation records use versioned IndexedDB transactions in the current browser or Tauri WebView profile. This keeps browser development and desktop use on the same offline storage mechanism without a native SQLite plugin or database dependency. Data stays in that local application profile and is not synchronized. Browser profile clearing or application-data removal can erase it; export a report when an external record is needed.

**Compare** opens a temporary two-file workspace. BLACKBOX identifies and hashes the second file, computes its statistics, and compares actual bytes in 1 MiB slices. The current algorithm is explicitly **offset-aligned**: it treats bytes at the same offset as counterparts and does not align insertions or deletions. It reports differing byte offsets, groups adjacent changes into ranges, keeps at most 10,000 ranges for navigation, and provides synchronized 256-byte hex windows. Difference ranges can be bookmarked on file A and comparison summaries are retained in the active investigation. Both files are read as data; neither is modified or executed.

The histogram follows the byte at the selection start. Selecting a histogram value navigates to its first observed offset. The desktop window follows the system's reduced-motion preference.

## Analysis coverage

- The analysis worker reads 512 KiB slices by default. `VITE_ANALYSIS_CHUNK_SIZE` can select a benchmarked value from 64 KiB to 4 MiB. One incremental pass calculates SHA-256, all 256 byte counts, first offsets, whole-file Shannon entropy, regional entropy, and printable ASCII and UTF-16LE strings. The file is never assembled into a full-file `ArrayBuffer`.
- Regional entropy is represented by at most 512 contiguous measurements. The in-memory string index contains at most 50,000 entries, each with a 240-character preview and original offset/length. When that cap is reached, the primary pass stops string-specific work and reports that more strings may exist; it does not claim an exact total. A separate worker searches the complete file, retains 1 MiB input chunks, and pages at most 50,000 matches per query. The interface renders 100 rows at a time and explains both limits.
- Progress and statistical updates are throttled; parser regions are emitted in batches of 32 and visual state flushes at most once per animation frame. The 256-value histogram is updated from the same byte stream. Progress reflects bytes actually read.
- Format parsers are dispatched through a typed registry and validate bounded offsets before reading. WAVE inspects up to 512 chunks and decodes `fmt `, `data`, and bounded `INFO` metadata; truncated RIFF bounds or missing required format/data chunks remain incomplete. PNG inspects up to 512 chunks, IHDR, bounded text, IDAT totals, and CRCs across at most 16 MiB of chunk contents. JPEG inspects up to 256 markers, frame/component details, bounded EXIF and ICC/JFIF metadata, and groups scan data. ZIP reads the end record and up to 16 MiB of central directory, lists up to 512 entries, and resolves ZIP64 sizes and offsets without extracting data. PDF follows a bounded classic xref table to sampled objects, page tree, info dictionary, and stream lengths; xref streams, object streams, and stream payloads remain unresolved. PE decodes headers, sections, and bounded imports/exports. ELF reads bounded program/section tables, names, and dynamic strings. SQLite validates page headers and samples up to 64 distinct b-tree pages and 128 `sqlite_schema` records. Mach-O decodes 32/64-bit byte orders, bounded universal slices, common load commands, segments and sections, linked libraries, build targets, entry-point metadata, UUID, and code-signing metadata presence; it does not verify signatures or execute binaries.
- Parser findings include labels, values, and source ranges. They appear in the existing file/structure pane and can navigate the hex view. Generic byte windows remain clearly labelled when no format parser can validate the structure. Parser failures are isolated from hashing and statistics.
- JSON and HTML reports include identity, timestamps, SHA-256, parser findings and warnings, regions, entropy, byte counts, and string-index status. When an investigation is open, reports also include its notes, file notes, bounded bookmarks, and comparison summaries. Private full paths are not included. HTML escapes imported values. Reports embed at most 1,000 indexed string previews by default and state how many indexed entries are omitted. If the 50,000-entry cap was reached, the exact file-wide string count is reported as unknown. Findings, statistical observations, and parser limitations remain distinct.

File contents stay on the device. The app reads source files as data and does not write to or execute them. Analysis requires no external network requests. Analysis selections stay in the current session; investigations persist locally in the application profile.

BLACKBOX opens with all five panes intentionally empty. The bundled WAVE is available from the explicit **Sample** control. For files up to 4 MiB, completed worker events are revealed across their real analysis stages over a bounded 1.5–2.5 second presentation. Processing status and byte progress remain tied to actual work; completed findings are labeled as revealing while the panes catch up. Larger files follow the live event stream, and reduced-motion preference skips the presentation pacing.

## Tests and recordings

```sh
npm test
npx playwright install chromium webkit
npm run test:e2e
npm run build
```

Unit tests cover independent SHA-256 comparisons, frequency totals, entropy, string offsets and limits, ZIP64, PNG CRCs, PDF xref/streams, Mach-O thin and universal variants, malformed input, embedded signatures across slice boundaries, parser isolation, cancellation, report bounds and escaping, exact 64-bit interpretation, wildcard and text search, comparison ranges, and reveal timing. Browser tests cover empty panes, actual navigation history and ranges, investigation CRUD and fingerprint-gated bookmarks, report export, embedded-signature navigation, offset-aligned comparison, intake, replacement, cancellation, a 128 MiB file, reduced motion, and 1920 × 1080, 1440 × 900, 1280 × 800, 1024 × 768, and 740 × 580 layouts in Chromium and WebKit.

The disk-backed large-file suite generates deterministic fixtures for 5 KiB, 10 MiB, 128 MiB, 500 MiB, and 1 GiB, including many strings, a structured PNG, high-entropy bytes, repeated binary bytes, and sparse text. It verifies the final digest, records event throughput and frame gaps, samples process-tree RSS, searches beyond the indexed strings, jumps near the end of the 1 GiB file, and measures cancellation latency.

```sh
SPECTRE_PERF=1 npx playwright test tests/large-files.perf.spec.ts --project=Chromium --workers=1
```

The same 128 MiB source size can be used to measure full-file byte search and an offset-aligned two-file comparison (the benchmark generates a temporary, single-byte difference). It exercises the inspection helpers through disk-backed bounded slices; it does not load the fixtures into memory or measure the browser UI:

```sh
npm run benchmark:inspection
```

The measured before/after results, performance targets, and measurement limits are recorded in [docs/large-file-performance.md](docs/large-file-performance.md). Generated recordings, screenshots, and performance fixtures are kept locally under `output/` and are not required to run the application or tests.

For the small-file demonstrations, start the Vite server with `npm run dev`, then run:

```sh
npm run record:demo
```

Mission III screen captures and short real-workflow recordings are created with:

```sh
npm run dev
npm run record:mission-3
```

The script captures the launcher, empty workspace, live analysis, completed workspaces at five viewport sizes, data and structure inspection, investigation navigation, bookmarks, and comparison. It also records real hex-search, investigation/bookmark, byte-comparison, and structural-analysis flows under `output/development-mission-3/`. It refuses to overwrite existing evidence files.

See [the Mission III implementation report](docs/development-mission-3-report.md) and [the live development log](docs/autonomous-development-log.md) for the verified scope, measurements, and remaining limits.

The existing script creates small-file demonstrations in `output/playwright/`. It does not overwrite existing recording assets. The dated performance recordings use generated test files and verify parser output and file hashes before delivery.
