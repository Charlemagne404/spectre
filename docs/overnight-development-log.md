# Spectre autonomous development log

Date: 2026-11-24
Branch: `codex/spectre-overnight`
No push, merge, or deployment is part of this work.

## Checkpoint and verified starting state

- Confirmed the requested branch and retained all previous-session changes.
- Checkpointed the prior-session launcher, status, responsive-layout, report-metric, research, and handoff work as `f21c694` (`Refine startup readiness and document release candidate`).
- Verified that checkpoint: `npm test` passed 27/27; `npm run build` passed; `npm run test:e2e` passed 32 enabled Chromium/WebKit cases, with 14 opt-in performance cases skipped.
- The checkpointed report's prior 1 GiB result was 50.437 s. A fresh serial baseline on this Ubuntu host measured 51.566 s total / 51.138 s in the worker, including 42.572 s for statistics and string scanning.

## Native development environment

### Rust toolchain installed

- **Problem:** Rust and Cargo were absent, so a project-native build could not be attempted.
- **Approach:** Installed the official stable toolchain with rustup for the current user, using the minimal profile.
- **Result:** `rustup 1.29.3`, `rustc 1.100.0`, and `cargo 1.100.0` are installed under `/home/charlie/.cargo`. The Codex shell does not add `.cargo/bin` to its default `PATH`; the absolute binaries work, and `/home/charlie/.cargo/env` supplies the intended user-local path setup.
- **Native build:** `npm run tauri build -- --bundles deb` rebuilt the frontend and compiled Rust dependencies until `glib-sys` could not find `glib-2.0.pc`. Tauri's [official Ubuntu prerequisites](https://v2.tauri.app/start/prerequisites/) list `libwebkit2gtk-4.1-dev`, `build-essential`, `curl`, `wget`, `file`, `libxdo-dev`, `libssl-dev`, `libayatana-appindicator3-dev`, and `librsvg2-dev`; the WebKit/GTK development packages provide the missing GLib metadata. `pkg-config` confirms that metadata is missing. `sudo -n true` reports that a password is required, so the current account cannot install the packages. Runtime GTK, WebKitGTK and AppIndicator libraries are present. The host has an X11 session; there is no built native binary to execute.
- **Verified boundary:** Frontend build is verified. The Rust toolchain is installed, but the Spectre Rust crate did not finish compiling. No Tauri bundle was produced, and desktop execution is unverified.

## Iteration 1 — reduce the large-file statistics hot loop

- **Problem:** A 1 GiB sparse-text file spent 42.572 s in the combined statistics/string loop, missing the 45 s target overall.
- **Baseline:** On the same host and browser, 10 MiB took 0.914 s total, 128 MiB 4.301 s, 500 MiB 14.076 s, and 1 GiB 51.566 s. The 1 GiB run used 257 MiB sampled process-tree RSS growth, had a 116.7 ms maximum animation-frame gap, and reached a near-EOF byte page in 167 ms. Its digest matched the independent fixture digest.
- **Investigation:** A temporary, uncommitted scan-disable benchmark showed that statistics-only work took 33.206 s before optimization. This diagnostic switch was removed after measurement.
- **Implementation:** Use `Uint32Array` counters when the file or entropy window fits the exact 32-bit count range, with `Float64Array` fallback for larger files. Reuse the histogram's prior count to detect a first byte occurrence. Finalize a partial entropy window at the end of the final read instead of comparing against EOF for every byte.
- **Verification:** The 1 GiB scan-only diagnostic fell to 6.346 s (from 33.206 s). With string extraction enabled, the first optimized run completed in 26.151 s total / 25.562 s worker time, with a correct digest.
- **Remaining issue:** Sparse files still call the string scanner for every byte even when long zero runs contain no active string state.

## Iteration 2 — skip inert NUL runs in string scanning

- **Problem:** `StringScanner.consume()` walked multiple state branches for every NUL byte in sparse files.
- **Approach:** Added a fast return only when the byte is zero and both ASCII and UTF-16LE scanner states are inactive. Active ASCII candidates and UTF-16LE transitions still use the full state machine.
- **Implementation:** Added the fast path and a regression fixture with long zero runs between ASCII and UTF-16LE findings.
- **Verification:** The scanner regression passed. A full 1 GiB analysis completed in 20.202 s total / 19.657 s worker time, with the independent digest. Statistics/string scanning took 11.480 s, file-range reads 3.654 s, SHA-256 4.496 s, and structure parsing 0.2 ms. Sampled process-tree RSS grew 212 MiB; maximum frame gap was 116.7 ms; near-EOF navigation was 236 ms. `/usr/bin/time -v` reported 32% average CPU utilization for the overall test command. The byte scan itself processed about 52.1 MiB/s.
- **Result:** Relative to the fresh 51.566 s baseline, this single optimized run was 60.8% faster end-to-end (2.55× throughput) and met the 45 s target with substantial margin. Repeat measurements remain necessary.

## Iteration 3 — endianness-aware numeric inspection

- **Problem:** The hex pane navigated bytes and copied ranges, but could not interpret multi-byte values while inspecting headers and fields.
- **Approach:** Keep the feature in the hex footer so it follows the current shared byte selection and does not introduce a new pane.
- **Implementation:** Added U8, U16, U32, and U64 views with an explicit little-/big-endian toggle. The value reader fetches at most eight bytes from the selected offset, displays the exact unsigned hexadecimal value, and provides its decimal value in the control title. Incomplete values are reported instead of being padded or read past EOF.
- **Verification:** Unit tests cover known RIFF bytes, both byte orders, 64-bit values, and truncated input. Chromium and WebKit interaction tests verify the default U32 little-endian view, byte-order switch, U64 view, and U8 behavior.
- **Result:** The final footer fit all five requested viewports without document overflow; screenshots and browser interactions are recorded below.

## Iteration 4 — tighten parser bounds and HTML report safety

- **Problem:** A short RIFF declaration could be accepted as a complete WAVE structure, and SQLite b-tree traversal could enqueue the same page repeatedly. The report path also needed a hostile-input regression for imported names and printable bytes.
- **Implementation:** WAVE completeness now requires a valid RIFF boundary, all declared bytes, both `fmt ` and `data` chunks, and at least a complete 16-byte format header; malformed and truncated declarations remain partial with warnings. SQLite tracks unique queued page numbers and uses a cursor instead of repeated `Array.shift()`, with a 64-distinct-page cap. Added an HTML export regression that injects markup through both a filename and file string.
- **Verification:** Unit fixtures cover RIFF sizes below the required header, beyond EOF, missing required chunks, undersized format headers, repeated SQLite child pointers, and a traversal reaching the page cap. The report regression verifies names and printable contents are escaped. Existing Tauri CSP has `connect-src 'none'`, no capabilities, and file intake remains local; the app does not execute or extract imported content.
- **Limits:** Parser surveys are bounded format inspections, not full validators. PNG CRC reads cap at 16 MiB; PNG/WAVE/JPEG/ZIP records, PDF objects, PE/ELF tables, and SQLite pages/schema records each have explicit limits. PDF xref streams, object streams, and stream payloads remain unresolved.

## Iteration 5 — unsigned numeric interpretation in the hex inspector

- **Problem:** The hex pane showed raw bytes but required mental conversion for multi-byte headers and fields.
- **Implementation:** Added U8/U16/U32/U64 interpretation at the selected byte with explicit LE/BE order. It reads at most eight bytes, preserves exact U64 values with `BigInt`, and reports truncated values without reading past EOF. Controls remain in the shared hex footer.
- **Verification:** Unit tests cover RIFF's known U32 value, both byte orders, U64, and insufficient bytes. Chromium and WebKit interaction tests cover width and endianness controls. Final screenshots were inspected at 1920×1080, 1440×900, 1280×800, 1024×768, and 740×580; the footer stayed within the viewport and no horizontal document overflow appeared. Launcher, empty, active-analysis, and completed workspaces were also captured.
- **Visual evidence:** `output/overnight-visual-evidence-final/` contains the final screenshots. The browser evidence covers Chromium/WebKit emulation, not physical display hardware or assistive technology.

## Final validation and remaining backlog

1. **Blocked by host permissions — native Linux packaging:** Stable Rust is installed, but Tauri's Linux development metadata is missing. `glib-sys` cannot find `glib-2.0.pc`; this user cannot use `sudo` without a password. Frontend compilation and bundle verification are separate and are recorded below. No native app execution is claimed.
2. **Target met — near-EOF interaction latency:** The final run measured 170 ms after earlier optimized runs of 241 ms and 306 ms. Repeat under lower host load only if a stricter target than the current 1-second limit is adopted.
3. **Follow-up — parser breadth:** The supported parsers intentionally remain bounded and partial. Mach-O support and deeper conformance work are candidates only if they materially serve the target workflow; no new shallow parsers were added.

### Final command results

- `npm test`: 32/32 unit tests passed, including scanner-state, WAVE/SQLite bounds, HTML report escaping, and integer interpretation.
- `npm run build`: TypeScript check and Vite production build passed.
- `npm run test:e2e -- --workers=1`: 34 passed across Chromium and WebKit, 14 opt-in performance cases skipped by default.
- `SPECTRE_PERF=1 SPECTRE_PERF_SIZES=10MiB,128MiB,500MiB,1GiB npx playwright test tests/large-files.perf.spec.ts --project=Chromium --workers=1`: 5/5 passed, including cancellation. Final totals were 0.819 s, 2.709 s, 7.527 s, and 19.925 s; the 1 GiB digest was verified and near-EOF navigation took 170 ms. Full phase results and repeated measurements are in `large-file-performance.md`.
- `git diff --check`: passed after final source/doc edits; final commit and clean-tree confirmation are recorded in `overnight-completion-report.md`.
- Screenshots in `output/overnight-visual-evidence-final/` cover launcher, empty state, active analysis, and completed state at all five requested viewport sizes. These are local browser captures.

The final command results, commit IDs, report links, and clean-tree check are recorded in `overnight-completion-report.md`. Performance environment, phase timings, repeated runs, and limitations are in `large-file-performance.md`.

## Release status

Spectre is **not declared release-ready**. The frontend and browser workflows are verified and the TypeScript worker now meets the measured large-file targets on this Ubuntu host. The native Tauri Rust build, bundle, and desktop execution remain unverified because the required system development headers cannot be installed with the current account privileges.
