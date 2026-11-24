# RECON completion report

## Result

RECON is available as Spectre's second module. It provides scoped passive domain collection through native Rust providers, progressive evidence-backed infrastructure relationships, an interactive Canvas 2D graph, evidence and timeline views, local history, snapshot comparison, notes, and JSON/HTML reports. The browser preview uses an explicitly labeled deterministic fixture and cannot claim live network findings. BLACKBOX remains available with its original launcher and workspace animations; ATLAS and GHOST remain unavailable.

## Git state

- Starting commit: `23d54fe3fcb0e8d4783cb9bd8dc92e13f9cac38a` — `Restore original animation choreography`.
- Implementation checkpoint: `e9ed68e2a08911656c1da32951a891f575d40371` — `feat(recon): add passive infrastructure investigation module`.
- Final handoff: this report is committed as a documentation-only checkpoint after the implementation commit. The checked-out branch is `codex/spectre-recon`; no push, merge, or deployment was performed.

## Implemented functionality

- Typed module registry and active-module lifecycle. Selecting RECON mounts its workspace; leaving it cancels active collection and releases its renderer. Keyboard selection, Escape navigation, and form-safe shortcuts remain supported.
- Domain target normalization and Rust-side validation, including IDNA and public-suffix-aware registrable-domain context. An entered subdomain remains the DNS scope; scope is not silently widened to sibling names.
- Native streaming investigation jobs with job IDs, monotonic event sequence, provider status, timestamps, cancellation tokens, bounded concurrency, timeouts, request limits, and independent partial-source failure handling.
- Progressive typed entities, relationships, provenance, relationship and entity selection, accessible DOM indexes, graph search and filters, evidence search and source filter, inspector, certificate timeline, and investigation notes.
- IndexedDB history isolated from BLACKBOX. Records are limited to 12 MiB and retain up to 40 snapshots; pruning the oldest snapshot is surfaced to the user. Comparison claims changes only for providers that completed in both compared snapshots.
- Structured JSON and escaped, self-contained HTML export. Native save uses create-new semantics, rejects unsupported paths and extensions, enforces a 12 MiB limit, and does not overwrite an existing file.

## Native architecture and data sources

The renderer calls a small named Tauri command surface. Rust owns target validation, provider requests, normalization, cancellation, and event emission. Provider responses are treated as untrusted data; no broad browser network or filesystem permission was added.

| Source | Collected evidence | Scope and limitations |
| --- | --- | --- |
| DNS via Hickory and the configured system resolver | A, AAAA, CNAME, MX, NS, TXT, SOA, and CAA observations | Queries the explicitly entered hostname; at most 64 retained answers per type. Negative/error states are distinct. PTR, DS, and DNSKEY are not implemented. |
| IANA RDAP bootstrap and the selected RDAP service | Bounded public registration summary, status, nameservers, event dates, registrar name, and redaction metadata | Queries the registrable domain. Contact values and raw response bodies are discarded. Bootstrap and service availability depend on upstream sources. |
| crt.sh Certificate Transparency search | Certificate identifiers, issuer, validity dates, and in-scope certificate names | Community-operated, best-effort index; names are historical or wildcard observations, not proof of current resolution or authorization. Results are bounded to 2 MiB, 2,000 scanned rows, and 160 certificate/name pairs. |
| RIPEstat `network-info` and `routing-status` | Prefix and announced route-origin ASN for public DNS IPs | At most eight public IPs per job. A route is represented as “announced by”; it does not establish domain ownership, address assignment, or hosting-provider identity. |

## Network security model

- The default workflow is passive. It makes DNS queries and requests to fixed provider hosts or HTTPS RDAP services selected through IANA bootstrap data. It does not connect to the target website, initiate TLS to it, scan ports, or crawl it.
- Rust validates target input. Provider hosts are resolved before connection; answer sets are bounded and private/reserved addresses rejected. HTTPS requests pin the validated public address, disable environment proxies, and do not follow redirects.
- DNS/HTTP operations have nine-second request limits, responses are capped at 2 MiB, each job has four request slots, at most two jobs run concurrently, and a job has a 60-second deadline. Selected transient failures receive one retry.
- The existing restrictive Content Security Policy is unchanged. No API keys are required. Provider content and investigator notes are rendered as text, and HTML export escapes data without remote resources or scripts.

## Graph, persistence, and performance

The graph uses a purpose-built deterministic, incremental Canvas 2D renderer without a graph package dependency. Node positions settle as evidence arrives. Entity and relationship indexes, inspection views, and evidence ledgers provide keyboard-accessible alternatives to canvas hit targets. Evidence identity preserves provider and query distinctions, and relationship semantics avoid presenting shared routing as ownership.

The synthetic harness ran at 1440×900 with chains of 20, 100, 500, and 2,000 nodes. Time from page navigation through module initialization to the first canvas frame in the final Playwright run:

| Nodes | Chromium | WebKit |
| ---: | ---: | ---: |
| 20 | 258 ms | 308 ms |
| 100 | 249 ms | 315 ms |
| 500 | 283 ms | 378 ms |
| 2,000 | 524 ms | 887 ms |

These are local browser smoke measurements and include page initialization; they are not packaged Tauri, device, memory, or sustained pan/zoom benchmarks. The 2,000-node graph rendered successfully in both browser engines.

## Verification

| Check | Result |
| --- | --- |
| `npm test` | 54 passed |
| `npm run build` | Passed, including TypeScript project build and Vite production build |
| `cargo test --manifest-path src-tauri/Cargo.toml --offline` | 13 passed |
| `cargo check --manifest-path src-tauri/Cargo.toml --offline` | Passed on this Linux host |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | Passed |
| `git diff --check` | Passed before the implementation checkpoint |
| `npm run test:e2e` | 58 passed, 14 skipped; Chromium and WebKit. Skips are opt-in large-file performance profiles. |
| Tauri desktop launch | With a temporary alternate-port configuration, the Linux target compiled and reached `Running target/debug/spectre`. The environment denied access to its X display, so the window could not be inspected or operated. |

The native test count is unit coverage, not a live provider integration test. A real investigation, IPC stream, cancellation from the running window, save/reopen through the native UI, and live provider response were not verified. Cross-platform compilation and packaging were not verified.

## Visual and animation evidence

All captures are generated under Git-ignored `output/`:

- RECON screenshots and walkthrough: `output/recon-evidence/` (launcher, empty state, desktop graph, selected entity, selected relationship, evidence view, certificate timeline, and responsive captures at 1920×1080, 1440×900, 1280×800, 1024×768, and 740×580).
- Original BLACKBOX recordings captured before integration: `output/animation-restoration/`.
- Matching post-integration BLACKBOX boot, ignition, and progressive-analysis recordings: `output/animation-restoration-after/`.

The final Playwright run passed BLACKBOX's boot, module activation, reduced-motion, responsive-layout, and progressive-analysis regression coverage. The animation recordings were generated without replacing the baseline videos.

## Remaining limits and technical debt

- The main validation gap is the absence of interactive native Tauri and live-provider verification. A desktop launch reached the Rust binary, but this host did not expose a usable X display to the session.
- crt.sh and public RDAP/RIPEstat endpoints can be unavailable, rate-limited, incomplete, or change response behavior. Results are source-specific observations, not completeness guarantees.
- Provider-result caching and live-expiration indicators are not implemented. Local investigation history is persistent, but it does not replace provider caching.
- PTR, DS/DNSKEY, CNAME-target expansion, IP/ASN RDAP, AS descriptions, and explicit active HTTP/TLS inspection are not implemented and have no active controls in the UI.
- WebKit's first-canvas frame at 2,000 synthetic nodes was 887 ms in this host-browser run. Sustained interaction, memory, and packaged WebView performance need measurement on representative devices.
- Native tests do not yet cover end-to-end cancellation, timeout recovery, redirect/rebinding behavior against a controlled local test server, or restart/reopen through the desktop window.

## Recommended next priorities

1. Run a native desktop smoke on a networked host with an accessible display, using an explicitly authorized controlled domain. Verify collection streaming, provider failure handling, cancellation, local save/reopen, snapshots, and report export.
2. Add native provider integration tests with controlled local DNS/HTTP fixtures for cancellation, timeouts, redirects, rebinding defenses, malformed responses, and request/response budgets.
3. Profile graph interaction and memory in packaged WebViews, then add virtualization or batching if larger evidence sets affect selection or pan/zoom.
4. Add additional passive evidence sources only with explicit scope, provider semantics, and failure behavior. Keep active HTTP/TLS inspection opt-in and separately scoped if it is later introduced.
