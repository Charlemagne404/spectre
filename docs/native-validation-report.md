# Native validation report

Date: 2026-11-24

This report records the Linux native validation performed for Mission IV. It distinguishes checks against the built Tauri application from browser coverage and from platforms that were not available here.

## Environment and build

- Host: Ubuntu 24.04.5 LTS, X11 (`DISPLAY=:1`), 1920 × 1080 desktop.
- Toolchain: Rust/Cargo 1.100.0, Node.js 22.23.4, npm 10.9.3.
- Tauri Linux development dependencies were installed: `libwebkit2gtk-4.1-dev`, `build-essential`, `curl`, `wget`, `file`, `libxdo-dev`, `libssl-dev`, `libayatana-appindicator3-dev`, and `librsvg2-dev`. `pkg-config` resolved WebKitGTK 2.52.6, GTK 3.24.41, GLib 2.80.0, Ayatana AppIndicator 0.5.90, and librsvg 2.58.0.
- `npm run build` passed.
- `cargo build --release` passed.
- `npm run tauri build -- --bundles deb` passed. It produced `src-tauri/target/release/spectre` and `src-tauri/target/release/bundle/deb/Spectre_0.1.0_amd64.deb` (3.01 MiB).
- The release executable was launched directly in the host graphical session. The `.deb` was built but not installed through the package manager.

The official [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/) match the development packages checked above.

## Native runtime checks

The actual Tauri window opened on the host X11 desktop and entered BLACKBOX. The exercised native workflows were:

- Loaded the bundled `relay_07.wav` sample and waited for analysis to complete. File identity, entropy, structure, strings, hex bytes, and byte-frequency views populated.
- Searched the ASCII string `Spectre` and the byte pattern `53 70 65 63 74 72 65`; both selected offset `0x0000005E` with length 7.
- Filtered strings for `reference capture` and selected a result. The linked hex view selected offset `0x38`, length 28.
- Created an investigation and a bookmark for that selection, closed the app, relaunched it, and reopened the investigation. The investigation and bookmark persisted. The source was marked as needed until the matching sample was loaded; after its fingerprint matched, the bookmark became available and restored its range.
- Exported JSON and HTML from the native app into an isolated XDG Downloads directory. The JSON parsed with `reportVersion: 2` and retained the investigation and bookmark; the HTML included its document header and investigation data. Re-exporting JSON created a numbered filename and preserved the first report.
- Closed and relaunched the native window. The normal Tauri title bar and 1440 × 900 content window rendered on the host display.

The native workflow exposed a bookmark-label defect: a string selection overlapping a structure inherited the structure name. The default now reflects the bookmark kind and offset, with a browser regression test.

### Native runtime limits

- Xvfb was not installed, and downloading its package was blocked by host DNS resolution. The real host X11 desktop was used for the checks above.
- The native system file chooser opened, but the shared desktop focus returned to an already active terminal while entering the test path. I stopped that interaction to avoid typing into the active session. Consequently, opening an arbitrary external file through the native picker is not claimed as verified here. The browser suite did pass the system-picker entry-point workflow.
- Native comparison, native cancellation/replacement, modified-source handling, and native analysis of empty, malformed, or large external files were not directly exercised. Browser coverage for comparison, cancellation/replacement, empty files, malformed structures, and 128 MiB analysis is listed below.
- The test used isolated XDG configuration, data, cache, state, and Downloads paths. Report export succeeded after configuring the isolated profile's Downloads directory. Read-only-directory and denied-permission behavior were not separately exercised.
- macOS and Windows compilation/runtime were not performed locally. The GitHub Actions workflow compiles on all three operating systems, but has not yet run on GitHub.

## Automated coverage

| Check | Result |
| --- | --- |
| `npm test` | 47 tests passed |
| `cargo test` | 2 tests passed |
| `npm run test:e2e` | 46 passed, 14 skipped |
| `SPECTRE_PERF=1 SPECTRE_PERF_SIZES=1GiB npx playwright test tests/large-files.perf.spec.ts --project=Chromium --workers=1` | 1 GiB analysis and 128 MiB cancellation passed |
| `npm run build` | Passed |
| `npm run tauri build -- --bundles deb` | Passed; 3.01 MiB Debian package |

The browser suite ran on Chromium and WebKit. It covered investigations and persistence, byte search and navigation, comparison and difference navigation, report content, empty-file intake, system-picker entry-point behavior, operation cancellation and replacement, malformed structural data, responsive layouts, and interaction during a 128 MiB file hash. The 14 skipped cases are opt-in large-file profiles in the default suite; the 128 MiB interaction case ran and passed in both browser engines.

The targeted 1 GiB Chromium profile generated a disk-backed fixture, matched its independently computed SHA-256, completed analysis in 20.179 seconds (20.579 seconds end to end), navigated near EOF in 364 ms, and recorded a 150 ms maximum animation-frame gap. Sampled process-tree RSS growth was 223.8 MiB. The companion 128 MiB cancellation test completed in 13 ms. RSS is a coarse process-tree sample, not an application-private memory measurement.

An earlier full browser run had one WebKit range-history failure. Its isolated rerun and ten repeated isolated runs passed, and the final full run above passed without failures.

## Product and release boundary

The verified Linux binary is a functioning native Tauri desktop window with persistent investigation data and native report saving. Native external-file picker behavior and several native-only edge cases still need direct verification. The multi-platform Actions workflow in `.github/workflows/native-build.yml` only compiles; it does not sign, publish, or create releases. No release readiness or macOS/Windows runtime claim is made by this report.
