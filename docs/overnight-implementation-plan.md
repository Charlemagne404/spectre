# SPECTRE overnight implementation plan

## Baseline

- Source: `codex/spectre-overnight` at `026ed10`, with no pre-existing working-tree changes.
- Existing BLACKBOX already has a typed worker event stream, incremental SHA-256 and byte statistics, bounded string indexing and full-file string search, 1 KiB hex pages, byte-pattern search, eight format-aware parsers, cross-pane selection, cancellation, and bounded JSON/HTML reports.
- `npm ci` succeeds with no reported vulnerabilities. Baseline unit tests pass (27/27), production build succeeds, and the default Playwright suite passes (24/24 across Chromium and WebKit; 14 opt-in performance cases are skipped).
- Baseline screenshots and viewport measurements are being used to guide visual changes. Native compilation is unavailable on this host because Rust/Cargo are not installed.

## Work sequence

1. Preserve the working local-first analysis path and avoid a parser, state-management, or native rewrite without measured evidence.
2. Make boot messaging describe real application readiness, shorten its sequence, and keep it skippable.
3. Refine BLACKBOX activation into a short, coordinated pane sequence. Keep controls usable while visual activation continues and preserve reduced-motion behavior.
4. Extend responsive browser checks to 1024×768 and the configured 740×580 minimum. Require no horizontal overflow and verify the stacked minimum-size workspace remains reachable by scrolling.
5. Run focused tests while refining, then the full unit, browser, build, and feasible native checks. Capture final launcher, empty, in-progress, and completed BLACKBOX screenshots.
6. Measure the existing large-file suite on this host before and after UI changes; record hardware/environment, digest verification, responsiveness, memory estimates, cancellation, and unverified targets without comparing unlike machines as if they were equivalent.
7. Complete `docs/overnight-research.md`, update `docs/large-file-performance.md`, and write `docs/overnight-completion-report.md` from verified results.

## Acceptance checks

- No regression to parsing, streamed analysis, selection/search, cancellation, report export, or local-only processing.
- Pane activation is skippable and does not block file intake or navigation.
- Reduced motion avoids staged transitions.
- 1440×900, 1280×800, 1024×768, and 740×580 have no horizontal overflow; smaller layouts expose all panes through the normal vertical scroll area.
- Unit, browser, and production-build results are reported exactly; native build status is explicit.
- Screenshots and benchmark numbers come from the actual post-change application and current host.

## Completion status — 2026-11-24

The planned boot, activation, status-label, report-metric, responsive-layout, visual-evidence, architecture-review, and benchmark work is complete. Browser and unit verification passed; the native build is unavailable because Rust/Cargo are absent. The 1 GiB file completed and passed its digest check, but exceeded the 45-second target on the current host. See [overnight-completion-report.md](overnight-completion-report.md) and [large-file-performance.md](large-file-performance.md) for final evidence and limits.
