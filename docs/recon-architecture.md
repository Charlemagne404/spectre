# RECON architecture

## Mission baseline

- Starting commit: `23d54fe3fcb0e8d4783cb9bd8dc92e13f9cac38a` (`Restore original animation choreography`, 2026-11-24).
- Development branch: `codex/spectre-recon`, created from the clean starting commit.
- The protected BLACKBOX animation contract is recorded by `tests/blackbox.spec.ts`: the five pane fixture names and delays, the 1,420 ms activation window, and the 70-line startup trace. RECON must add its own lifecycle and choreography without changing those rules.

## Product boundaries

The shell owns module identity, launcher selection, screen transitions, and the active module mount. BLACKBOX keeps its existing local file-analysis implementation. RECON owns its investigation model, provider orchestration, graph, local history, and report generation. ATLAS and GHOST remain unavailable first-party module definitions rather than partially implemented workspaces.

The module registry is a typed, static list, not a plugin loader. A module is mounted only while selected; leaving RECON cancels any active job and unmounts its renderer. Escape returns to the launcher from either workspace, while form editing and graph navigation retain their normal keyboard behavior.

## Collection boundary

The frontend invokes a small Tauri command surface. It never fetches provider APIs directly and does not receive an arbitrary native HTTP proxy. A native job has a UUID, a monotonic sequence, a phase, provider, timestamp, and typed payload. Structured progress is delivered through a Tauri channel; cancellation is keyed by the job UUID and signals all provider tasks before the investigation is considered stopped.

The default workflow is passive. It queries the configured DNS resolver and public information providers only. No target HTTP request, TLS handshake, port probe, or crawl starts implicitly. Provider endpoints are fixed or discovered through IANA RDAP bootstrap data; dynamic endpoints must be HTTPS, redirects are disabled, response size and duration are bounded, and provider content is parsed as data. A provider failure is recorded independently and cannot discard successful findings from another provider.

### Providers and semantics

- **DNS:** system-configured recursive resolver by default, using Hickory's Tokio resolver. The initial query is limited to the explicitly entered hostname and eight record types, with at most 64 returned records retained per type. Responses preserve type, value, queried name, TTL, resolver, timestamp, and negative/error status when supported. NXDOMAIN, NODATA, timeout, and SERVFAIL are distinct observations; none means a hostname never existed.
- **RDAP:** IANA bootstrap data selects a service for the registrable domain. Requests follow RFC 9082 query paths and responses are read as RFC 9083 JSON. The UI retains a bounded summary of public fields (domain name, status, handle, nameservers, event dates, registrar name, and redacted-field names); raw responses and contact values are discarded. Redacted fields remain unavailable.
- **Certificate Transparency:** crt.sh is an initial community index, not a guaranteed service. Results are bounded to 2 MiB, 2,000 scanned rows, and 160 in-scope certificate/name pairs. Certificate IDs, validity dates, and issuer names are kept as evidence. Names are historical or wildcard observations and are never resolved automatically; they do not imply current DNS resolution or authorization to expand scope.
- **Routing:** RIPEstat `network-info` and `routing-status` enrich at most eight discovered public IPs per job. A route origin ASN is represented as an announced-by relationship; it is not asserted to own the investigated domain or the address allocation. Current scope does not add AS organization/description lookups.

## Graph and views

The investigation graph stores typed entities and evidence-backed relationships separately. Evidence carries provider, kind, query, retrieval time, source time where supplied, status, original value, normalized value, source reference, and limitations. Stable evidence IDs distinguish certificate IDs and DNS record types so snapshots can compare like-for-like observations. Duplicate observations may support the same entity or relationship without being misrepresented as independent corroboration.

The implementation uses a purpose-built Canvas 2D renderer with a deterministic, incremental layout. This avoids a large rendering dependency for the expected investigation scale, supports Tauri WebViews with Canvas 2D, and allows settled nodes to keep their positions as provider events arrive. DOM entity and relationship indexes, search, selection details, and the evidence table provide keyboard-accessible equivalents to canvas hit targets. Labels are prioritized and culled at dense zoom levels. The graph can be rebuilt from persisted normalized records and does not own investigation data.

The test-only harness profiles 20, 100, 500, and 2,000 nodes with a chain of 19, 99, 499, and 1,999 relationships at a 1440×900 viewport. In the final full Playwright run, time from page navigation through module initialization and the first rendered Canvas frame was 258/249/283/524 ms in Chromium and 308/315/378/887 ms in WebKit. This includes browser/page initialization and is a host-browser smoke profile, not a Tauri-device benchmark. The 2,000-node view rendered without a failure; Tauri WebView frame pacing and sustained pan/zoom smoothness remain unmeasured.

Sigma.js plus Graphology offers GPU-backed rendering, gestures, and a graph data model, but adds WebGL lifecycle and accessibility integration work. Cytoscape.js offers a broader graph/layout and analysis toolkit with a canvas renderer. For the current first-party scope, a bounded Canvas renderer provides better control over stable placement, resource cleanup, and payload size; graphs remain ordinary data and can later be adapted to another renderer.

## Persistence and exports

RECON uses a versioned IndexedDB database distinct from `spectre-blackbox`. A record stores the target and explicit normalized scope, timestamps, source statuses, bounded normalized evidence, entities, relationships, notes, and up to 40 snapshots. One record and one native report are each limited to 12 MiB. Starting snapshot 41 prunes the oldest snapshot with a visible notice. Changes compare only observations from providers that completed in both snapshots; a provider failure or incomplete response prevents both positive and negative change claims. Old snapshots remain browsable offline.

JSON exports preserve the versioned investigation. HTML is generated from escaped text and local data only: no script, remote resource, or unsanitized provider markup is embedded. Native saving uses the existing create-new Downloads flow and never overwrites an existing file. Browser development can download a report locally.

## Security and privacy

- Renderer input is validated again in Rust. Targets are domain names, not arbitrary URLs. Input URL syntax is accepted only to extract an explicitly entered hostname; credentials, ports, paths beyond `/`, IP literals, malformed IDNA, and public-suffix-only values are rejected.
- Public-suffix data is used for registrable-domain context, while the requested hostname remains the collection scope. Entering a subdomain does not silently query sibling names.
- Only fixed provider hosts and IANA-discovered HTTPS RDAP hosts are contacted. Each host is resolved with the system resolver, the answer set is capped at 32 public addresses, HTTPS connections are pinned to those addresses, and environment proxies are disabled. Redirects are disabled. HTTP requests and DNS queries have nine-second deadlines, provider responses are capped at 2 MiB, each job has four request slots and a 60-second overall deadline, at most two jobs may run, and transient HTTP/connect failures are retried once.
- No secrets are required. Provider responses and notes are treated as untrusted text. No direct target probing is included in the passive workflow.
- The existing restrictive Tauri CSP remains unchanged. Native access stays behind named commands and channel data; no broad filesystem or browser network permission is added.

## Research references

- [Tauri commands, asynchronous commands, and channels](https://v2.tauri.app/develop/calling-rust/) and [managed state](https://v2.tauri.app/develop/state-management/).
- [Hickory DNS](https://hickory-dns.org/) and [Tokio resolver documentation](https://docs.rs/hickory-resolver/latest/hickory_resolver/type.TokioResolver.html).
- [RFC 9082](https://www.rfc-editor.org/rfc/rfc9082), [RFC 9083](https://www.rfc-editor.org/rfc/rfc9083), [RFC 9224](https://www.rfc-editor.org/rfc/rfc9224), and [IANA RDAP bootstrap data](https://data.iana.org/rdap/).
- [Certificate Transparency ecosystem documentation](https://github.com/google/certificate-transparency-community-site/blob/master/docs/google/fetch-logs.md); crt.sh is treated as a best-effort index.
- [RIPEstat Data API](https://stat.ripe.net/docs/data-api/ripestat-data-api), [network-info](https://stat.ripe.net/docs/data-api/api-endpoints/network-info), and [routing-status](https://stat.ripe.net/docs/data-api/api-endpoints/routing-status).
- [Sigma.js](https://www.sigmajs.org/), [Graphology](https://graphology.github.io/), and [Cytoscape.js](https://js.cytoscape.org/).
- [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).

