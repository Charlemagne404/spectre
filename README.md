# Spectre

Spectre is a local-first desktop file inspection tool. BLACKBOX examines one file at a time and opens with five intentional empty panes.

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
| **Home / End** | Jump to the first or last byte or chart region |
| **Esc** | Leave the focused input, return to the launcher, or skip an animation |

The hex inspector reads only a 1 KiB page around the selected offset, accepts hexadecimal offset jumps, searches hexadecimal byte patterns in 1 MiB slices, and copies up to 4 KiB from the selected byte range. The strings pane filters indexed strings and navigates to their exact byte ranges. After analysis, a background worker can search the full file beyond the initial index and pages results without rendering them all at once. Selecting a structural region filters strings to that region; selecting a string, entropy window, hex byte, or present byte value updates the shared file range.

The histogram follows the byte at the selection start. Selecting a histogram value navigates to its first observed offset. The desktop window follows the system's reduced-motion preference.

## Analysis coverage

- The analysis worker reads 512 KiB slices by default. `VITE_ANALYSIS_CHUNK_SIZE` can select a benchmarked value from 64 KiB to 4 MiB. One incremental pass calculates SHA-256, all 256 byte counts, first offsets, whole-file Shannon entropy, regional entropy, and printable ASCII and UTF-16LE strings. The file is never assembled into a full-file `ArrayBuffer`.
- Regional entropy is represented by at most 512 contiguous measurements. The in-memory string index contains at most 50,000 entries, each with a 240-character preview and original offset/length. When that cap is reached, the primary pass stops string-specific work and reports that more strings may exist; it does not claim an exact total. A separate worker searches the complete file, retains 1 MiB input chunks, and pages at most 50,000 matches per query. The interface renders 100 rows at a time and explains both limits.
- Progress and statistical updates are throttled; parser regions are emitted in batches of 32 and visual state flushes at most once per animation frame. The 256-value histogram is updated from the same byte stream. Progress reflects bytes actually read.
- Format parsers are dispatched through a typed registry and validate bounded offsets before reading. WAVE inspects up to 512 chunks and decodes `fmt `, `data`, and bounded `INFO` metadata. PNG inspects up to 512 chunks, IHDR, bounded text, IDAT totals, and CRCs across at most 16 MiB of chunk contents. JPEG inspects up to 256 markers, frame/component details, bounded EXIF and ICC/JFIF metadata, and groups scan data. ZIP reads the end record and up to 16 MiB of central directory, lists up to 512 entries, and resolves ZIP64 sizes and offsets without extracting data. PDF follows a bounded classic xref table to sampled objects, page tree, info dictionary, and stream lengths; xref streams, object streams, and stream payloads remain unresolved. PE decodes headers, sections, and bounded imports/exports. ELF reads bounded program/section tables, names, and dynamic strings. SQLite validates page headers and samples up to 64 b-tree pages and 128 `sqlite_schema` records.
- Parser findings include labels, values, and source ranges. They appear in the existing file/structure pane and can navigate the hex view. Generic byte windows remain clearly labelled when no format parser can validate the structure. Parser failures are isolated from hashing and statistics.
- JSON and HTML reports include identity, timestamps, SHA-256, parser findings and warnings, regions, entropy, byte counts, and string-index status. Reports embed at most 1,000 indexed string previews by default and state how many indexed entries are omitted. If the 50,000-entry cap was reached, the exact file-wide string count is reported as unknown. Findings, statistical observations, and parser limitations remain distinct.

File contents stay on the device. The app reads source files as data and does not write to or execute them. Analysis requires no external network requests. Inspection lasts for the current app session.

BLACKBOX opens with all five panes intentionally empty. The bundled WAVE is available from the explicit **Sample** control. For files up to 4 MiB, completed worker events are revealed across their real analysis stages over a bounded 1.5–2.5 second presentation. Processing status and byte progress remain tied to actual work; completed findings are labeled as revealing while the panes catch up. Larger files follow the live event stream, and reduced-motion preference skips the presentation pacing.

## Tests and recordings

```sh
npm run test
npx playwright install chromium webkit
npm run test:e2e
npm run build
```

Unit tests cover independent SHA-256 comparisons, frequency totals, entropy, string offsets and limits, ZIP64, PNG CRCs, PDF xref/streams, malformed input, parser isolation, cancellation, report bounds, selection state, byte search, and reveal timing. Browser tests cover empty panes and explicit sample loading, paced small-file presentation, intake, replacement, cancellation, synchronized panes, a 128 MiB file, reduced motion, and the 1280 × 800, 1440 × 900, and 1920 × 1080 layouts in Chromium and WebKit.

The disk-backed large-file suite generates deterministic fixtures for 5 KiB, 10 MiB, 128 MiB, 500 MiB, and 1 GiB, including many strings, a structured PNG, high-entropy bytes, repeated binary bytes, and sparse text. It verifies the final digest, records event throughput and frame gaps, samples process-tree RSS, searches beyond the indexed strings, jumps near the end of the 1 GiB file, and measures cancellation latency.

```sh
SPECTRE_PERF=1 npx playwright test tests/large-files.perf.spec.ts --project=Chromium --workers=1
```

The measured before/after results, performance targets, and measurement limits are recorded in [docs/large-file-performance.md](docs/large-file-performance.md). Generated recordings, screenshots, and performance fixtures are kept locally under `output/` and are not required to run the application or tests.

For the small-file demonstrations, start the Vite server with `npm run dev`, then run:

```sh
npm run record:demo
```

The existing script creates small-file demonstrations in `output/playwright/`. It does not overwrite existing recording assets. The dated performance recordings use generated test files and verify parser output and file hashes before delivery.
