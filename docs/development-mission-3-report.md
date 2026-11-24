# BLACKBOX development mission III report

**Status:** substantial investigation workflows implemented and browser-tested; the full mission is not complete because native desktop compilation remains blocked and insertion-aware diff is not implemented.

## Delivered

### Advanced byte inspection

- Random-access hex view renders one 1 KiB page at a time and uses direct `File.slice` reads, including for 1 GiB files. The user can enter a precise hex offset, move across bytes and pages, select/extend ranges with the keyboard or Shift+click, return through bounded selection history, jump to file start/end, and copy at most 4 KiB.
- Data interpretation covers signed and unsigned 8/16/32/64-bit integers, float32/float64, ASCII, strict UTF-8/UTF-16LE, binary, hexadecimal, Unix time and Windows FILETIME. `BigInt` keeps 64-bit integer values exact; incomplete and malformed inputs have explicit states.
- Hex pattern search supports exact bytes and byte/nibble wildcards, ASCII, UTF-8 and UTF-16LE. It searches bounded 1 MiB slices, carries patterns across slice boundaries, wraps forward/backward, reports actual scan progress, supports cancellation and highlights the match in the shared selection.
- Selections reveal overlapping structure labels and are shared with the structure, entropy, strings and frequency panes. Parser findings, strings and embedded signatures navigate to source byte ranges.

### Investigations and reports

- Added create/open/rename/delete flows, investigation and per-file notes, examined-file records, bookmarks with labels/notes, and comparison summaries. One-off analysis remains available without a saved investigation.
- Persistence uses versioned IndexedDB transactions, so browser development and Tauri WebView share the frontend storage mechanism without a native SQLite plugin. Records contain filenames, size, SHA-256, detected format, inspection time, bounded analysis summary, notes and bookmarks. They never contain source bytes or full paths.
- A recorded file is considered available only when the current analysis matches both its saved SHA-256 and size. Old metadata survives when a file is absent. The user must provide a replacement source; bookmarks cannot navigate unless the fingerprint matches.
- JSON and HTML reports add investigation notes, bookmarks, and comparison summaries to file identity, timings, parser findings and limits, statistics, and strings. HTML escapes imported values. Parser findings, warnings, regions, entropy windows, strings, bookmarks, and comparisons have explicit output limits and omission counts. Full filesystem paths and large byte dumps are excluded.

### Binary comparison

- Comparison reads two files in 1 MiB slices, hashes and summarizes both, checks actual bytes at corresponding offsets, and reports differing byte offsets and contiguous ranges. It retains at most 10,000 ranges for navigation and exposes progress and cancellation.
- The overlay provides synchronized 256-byte hex views, region context and previous/next difference navigation. A selected difference can be bookmarked and annotated on file A and appears with the comparison summary in reports.
- This is an **offset-aligned** diff. Insertions and deletions shift later offsets; the tool does not claim insertion-aware alignment or byte identity from metadata alone.

### Format intelligence and interface

- Mach-O parsing covers thin and universal binaries, 32/64-bit headers, little/big endian, bounded load commands, segments and sections, linked libraries, UUID, build target, entry-point-related command metadata, and code-signing metadata presence. It never executes the input and does not verify signatures.
- Embedded-signature scanning checks bounded slices and labels results as candidates, validated structures or bounded complete objects. It validates selected signatures where practical, reports validation gaps and limits, and never extracts the object.
- Existing parser support remains bounded and reports partial coverage honestly. In particular PDF xref streams, object streams and stream payloads remain unresolved.
- The compact investigation drawer and temporary comparison overlay preserve the existing BLACKBOX five-pane layout. Visual fixes keep parser findings in a scrollable pane and work at small viewports without horizontal overflow.

## Architecture and decisions

- Kept the existing worker-driven analysis engine and analysis-event flow. New search/comparison operations read `File.slice` windows and yield between chunks; no full-file `ArrayBuffer` is introduced.
- Selected IndexedDB over a native SQLite plugin to avoid adding an OS-specific native persistence dependency and to keep browser development and Tauri on one offline storage path. Transactional edits, schema-versioned records, explicit missing-source handling, and origin/profile data-loss limits are documented. There is no cloud sync or account system.
- Selected offset-aligned comparison because it has a precise, bounded contract and can be verified with simple exact offsets. An insertion-aware diff is a separate future capability.
- Inspected Tauri 2 Linux prerequisites against the actual host. Rust/Cargo are installed, while the GLib/GTK/WebKit development metadata is missing. The account requires interactive sudo, so no installation or native compilation was attempted.

## Verification

- **Build:** `npm run build` — passed.
- **Unit tests:** `npm test -- --reporter=dot` — 47 passed across 3 files.
- **Browser tests:** `npm run test:e2e -- --workers=1` — 44 passed across Chromium and WebKit; 14 opt-in large-file profiling tests skipped by default. The full suite includes the 128 MiB file interaction check, investigation persistence/missing-source/fingerprint gates, comparison and report integration, embedded signatures, navigation history, reduced motion, and five responsive sizes.
- **Large-file operation benchmark:** 128 MiB disk-backed source; offset-aligned compare with one injected byte change **2.54 s**, full-file no-match search **0.96 s**. This uses the production helpers from Node/Vitest and is not a browser/native timing result. The prior browser analysis observations remain documented in [large-file-performance.md](large-file-performance.md): 128 MiB 2.7 s, 500 MiB 7.5 s, 1 GiB 19.9 s on the Ubuntu host.
- **Parser fixtures and malformed inputs:** WAVE, PNG, JPEG, ZIP/ZIP64, PDF classic xref and bounded streams, PE, ELF, SQLite, and Mach-O thin/fat variants. Tests include truncation, unsafe ranges, malformed commands, CRC warnings, parser isolation and embedded-signature boundary cases.
- **Visual evidence:** actual launcher, empty, progress, completed, inspector, parser, investigation, bookmark and comparison captures, plus four real-workflow recordings. Assets are in the ignored local `output/development-mission-3/` directory.

  | Viewport | Completed workspace |
  | --- | --- |
  | 1920 × 1080 | [Screenshot](../output/development-mission-3/completed-1920x1080.png) |
  | 1440 × 900 | [Screenshot](../output/development-mission-3/completed-1440x900.png) |
  | 1280 × 800 | [Screenshot](../output/development-mission-3/completed-1280x800.png) |
  | 1024 × 768 | [Screenshot](../output/development-mission-3/completed-1024x768.png) |
  | 740 × 580 | [Screenshot](../output/development-mission-3/completed-740x580.png) |

  Other captures: [launcher](../output/development-mission-3/launcher-1440x900.png), [live analysis](../output/development-mission-3/analysis-progress-1440x900.png), [data inspector](../output/development-mission-3/data-inspector-1440x900.png), [structure](../output/development-mission-3/structure-analysis-1440x900.png), [investigation navigation](../output/development-mission-3/investigation-navigation-1440x900.png), [bookmarks](../output/development-mission-3/bookmarks-1440x900.png), and [comparison](../output/development-mission-3/binary-comparison-1440x900.png).

  Recordings: [hex inspection](../output/development-mission-3/advanced-hex-inspection.webm), [investigation and bookmarks](../output/development-mission-3/investigation-bookmarks.webm), [binary comparison](../output/development-mission-3/binary-comparison.webm), and [structural analysis](../output/development-mission-3/structural-file-analysis.webm).
- **Native build:** blocked, not verified. Rust 1.100.0 and Cargo 1.100.0 are present. `pkg-config` cannot find `glib-2.0`, `gtk+-3.0`, or `webkit2gtk-4.1`; `sudo -n true` reports that a password is required. No privileged command was attempted. When an administrator can install the supported Tauri 2 prerequisites, use:

  ```sh
  sudo apt update
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```

  The package list follows the [official Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/). Native compilation and runtime remain unverified until those packages are installed and the build is run.
- **Git:** starting point was branch `codex/spectre-overnight` at `0041b9be3c4ba21a2fd54b7e3d6e3567c4d64acd`. Final commit hashes will be recorded after the verified changes are committed.

## Limitations and next priorities

1. Install the documented Ubuntu Tauri prerequisites through an authorized interactive administrator and verify a real native build/runtime.
2. Consider an optional insertion-aware diff after defining an explicit resource budget and test corpus; keep the current offset-aligned mode labeled.
3. Add portable investigation backup/import if required; current reports are summaries and IndexedDB profile data is not a restorable case database.
4. Extend parsers with additional malformed/truncated fixtures and richer PDF xref-stream/object-stream handling before making broader completeness claims.
5. Re-run browser performance at 500 MiB and 1 GiB for compare/search only if a future implementation changes their slice strategy; current helper benchmark covers 128 MiB.
