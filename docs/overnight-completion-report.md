# SPECTRE release-candidate completion report

Date: 2026-11-24  
Branch: `codex/spectre-overnight` at `026ed10`  
Scope: local release-candidate refinement and verification; no push or deployment

## What changed

- Replaced the fabricated boot sequence with short, skippable messages tied to actual renderer, file-input, worker, first-frame, font, and ready states. Elapsed times use the running app clock. Reduced-motion preference still skips the sequence.
- Refined BLACKBOX activation into a brief amber pane-edge trace. The panes and file controls remain visible and usable during the trace.
- Corrected the live progress label so it says `HASHING + BYTE STATISTICS` until the digest is ready, then reports statistics work accurately.
- Added measured elapsed time for file-range reads, SHA-256, statistics/string scanning, and structure parsing. The phase timings are included in JSON and HTML reports.
- Added browser coverage for actual boot messaging, file intake during activation, reduced-motion behavior, and 1024×768 / 740×580 layout. At the minimum viewport, the workspace stacks vertically and remains reachable by normal scrolling without horizontal overflow.

The existing local-first design remains intact: streamed worker analysis, incremental SHA-256, bounded string indexing and full-file search, entropy and byte statistics, format parsers, random-access hex pages, byte search, cross-pane byte-range selection, cancellation, and JSON/HTML reports. No dependency or data-store was added. The app remains silent, does not execute imported content, and does not extract archives. Architecture and product-scope decisions are in [overnight-research.md](overnight-research.md).

## Verification

| Check | Result |
| --- | --- |
| `npm test` | 27/27 unit tests passed |
| `npm run build` | TypeScript and Vite production build passed |
| `npm run test:e2e` | 32 enabled cases passed across Chromium and WebKit; 14 opt-in performance cases skipped by default |
| Opt-in Chromium performance suite | All six file fixtures and the cancellation case exercised across two runs; all test assertions passed |
| `git diff --check` | Passed |
| Native Tauri build | Not available on this host: Rust and Cargo are not installed |

The latest large-file table and reproduction steps are in [large-file-performance.md](large-file-performance.md). On this Ubuntu host, the 500 MiB fixture completed in 14.277 s total / 13.565 s worker time. The 1 GiB fixture completed with the correct digest in 50.437 s total / 49.968 s worker time, about 5.4 seconds over the 45-second target. Its statistics-and-strings phase was 41.623 s, the largest observed optimization opportunity. The 1 GiB scan remained responsive (116.7 ms maximum frame gap), grew the sampled Playwright process-tree RSS by 245.4 MiB, and jumped near EOF in 193 ms. The 500 MiB run used 312.6 MiB sampled RSS growth and had a 133.5 ms maximum frame gap. Both met the memory, frame-gap, and random-access targets.

These are single-run browser measurements on an Intel i5-9400F system with memory and swap pressure; they are not statistical guarantees and are not directly comparable with the historical Apple M2 runs in the performance document. RSS is sampled process-tree memory, not app-private memory. The native desktop build and physical WebView performance are unverified on this host.

## Visual evidence

Production-preview screenshots were saved under the gitignored `output/overnight-visual-evidence/` directory:

- [Launcher](../output/overnight-visual-evidence/launcher-1440x900.png)
- [Boot readiness](../output/overnight-visual-evidence/boot-readiness-1440x900.png)
- [Empty workspace](../output/overnight-visual-evidence/blackbox-empty-1440x900.png)
- [Activation trace](../output/overnight-visual-evidence/blackbox-activation-1440x900.png)
- [128 MiB analysis in progress](../output/overnight-visual-evidence/blackbox-analysis-128MiB-1440x900.png)
- [Completed sample analysis](../output/overnight-visual-evidence/blackbox-completed-1440x900.png)
- [Minimum viewport](../output/overnight-visual-evidence/blackbox-minimum-740x580.png)

The worktree is left modified and uncommitted on `codex/spectre-overnight`. No remote branch was updated and no deployment was performed.
