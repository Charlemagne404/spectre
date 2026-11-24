# RECON development log

## Baseline — 2026-11-24

- Starting commit: `23d54fe3fcb0e8d4783cb9bd8dc92e13f9cac38a` (`Restore original animation choreography`).
- Starting branch: `codex/spectre-overnight`; working tree clean.
- Required animation restoration was verified at HEAD before work. The new branch `codex/spectre-recon` was created from that exact commit.
- Existing evidence at baseline: 27/27 unit tests, production build, and 32 enabled Playwright cases across Chromium/WebKit passed in the preceding mission. Rust/Tauri had not been verified there. The current host has Rust/Cargo 1.100 and Node 22 available; this mission will re-check actual build/test results.
- Protected behavior: 70-line startup trace, fixture animation names/delays, and 1,420 ms BLACKBOX activation are covered in `tests/blackbox.spec.ts`. `output/` is Git-ignored for recordings and screenshots.
- Research and decisions: see [`recon-architecture.md`](recon-architecture.md). Current official documentation was reviewed for Tauri IPC/channels, Hickory, IANA RDAP bootstrap/RFCs, CT data, RIPEstat, graph renderers, and SSRF defenses.

## Milestone A — complete

- Replaced the BLACKBOX-only launcher route with a typed four-module registry and active module mount. BLACKBOX and RECON are available; ATLAS and GHOST remain unavailable.
- Added a dedicated RECON workspace and kept the existing BLACKBOX component and animation CSS path intact.
- Keyboard/module routing and the restored BLACKBOX launcher/motion regression pass in the full cross-browser suite.

## Milestone B — complete

- Added Rust target validation, bounded system DNS, IANA-bootstrap RDAP, crt.sh CT evidence, and RIPEstat network/routing summaries. The renderer has no live browser fetch path.
- All external HTTPS hosts are resolved through Hickory and pinned to validated public IP addresses; redirects are disabled. Collection is limited to explicit DNS/CT scope and public IP routing enrichment.
- Added sequenced Tauri channel events, provider status, per-job cancellation, four concurrent requests per job, two-job limit, per-request and total deadlines, retries, and response limits.
- Added evidence-backed typed nodes/edges, a stable Canvas 2D graph, accessible entity and relationship indexes, filters, detail inspection, evidence ledger, certificate timeline, notes, snapshot comparison, IndexedDB history, and JSON/HTML export.
- Added explicit non-live browser fixture, which is not persisted as a live record and cannot start a real investigation from the browser preview.
- Added regression coverage for module selection, evidence identity, partial-source snapshot comparison, 40-snapshot retention, target validation, CT scope, RDAP bootstrap, RIPE normalization, public-IP checks, and report output bounds.
- Added a test-only synthetic graph harness for 20, 100, 500, and 2,000 nodes; actual Chromium/WebKit timings are recorded in `recon-architecture.md`. Generated benchmark data is never exposed through the application workflow.

## Verification and review

- `npm test`: 54 tests passed.
- `npm run build`: passed (`tsc -b && vite build`).
- `cargo test --manifest-path src-tauri/Cargo.toml --offline`: 13 tests passed.
- `cargo check --manifest-path src-tauri/Cargo.toml --offline`: passed on the current Linux host.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: passed; `git diff --check`: passed.
- Final `npm run test:e2e`: 58 passed, 14 skipped. The skipped cases are opt-in large-file performance profiles; BLACKBOX and RECON browser coverage passed in Chromium and WebKit.
- The graph harness covered 20/100/500/2,000 nodes at 1440×900. First canvas frame was 258/249/283/524 ms in Chromium and 308/315/378/887 ms in WebKit, including page and module initialization. This is a browser smoke profile, not a packaged desktop benchmark.
- Browser screenshots and a walkthrough are in ignored `output/recon-evidence/`. Original BLACKBOX recordings remain in `output/animation-restoration/`; post-integration boot, ignition, and progressive-analysis recordings are in `output/animation-restoration-after/`.
- A bounded Tauri dev launch with a temporary alternate-port config compiled and reached `Running target/debug/spectre`. This environment denied access to its X display, so the window, IPC, cancellation, local save/reopen, and live providers were not interactively smoke-tested. No live provider request was run.

## Remaining limits

- crt.sh availability and response shape are best-effort community-service behavior; a successful HTTP response is not a completeness guarantee.
- DNS and RIPEstat views are time-bound observations. RIPEstat routing visibility is based on RIPE RIS collectors and is not a complete global route view.
- PTR/DS/DNSKEY, CNAME-target expansion, IP/ASN RDAP, AS names/descriptions, provider-result caching, and active HTTP/TLS inspection are not implemented. They have no UI controls implying availability.
- Cross-platform native compilation, packaging, and desktop IPC behavior have not been verified here; only the current Linux target was checked.
- The 2,000-node profile used local Chromium/WebKit, not a packaged desktop WebView. A live native investigation was not run.

