# SPECTRE overnight research and architecture decisions

## Existing implementation and decision

BLACKBOX already has the core instrument model this mission calls for: one incremental worker pass calculates the digest, entropy, byte counts, first offsets, and bounded ASCII/UTF-16LE strings. Parsers consume bounded random-access reads through a typed registry. The UI applies typed events, flushes updates per animation frame, and shares byte ranges across views. Hex navigation reads a 1 KiB page; full-file byte and string searches use bounded slices and cancellable workers.

This is a sound local-first baseline. Keep it, improve the visible experience around it, and use current-host measurements before considering a native analysis rewrite. Do not add an analysis dependency for this mission.

## Project study

| Reference | Useful design lesson | Existing coverage | Decision |
| --- | --- | --- | --- |
| [ImHex](https://github.com/WerWolv/ImHex) and its [Pattern Language](https://github.com/WerWolv/PatternLanguage) | A binary tool becomes more useful when structures, selected bytes, and visual representations point to the same ranges. Its declarative patterns also illustrate a route for extensible format definitions. | BLACKBOX already links structure, entropy, strings, histogram, and hex through one byte-range selection. Its parser registry is a safer, simpler extension point for the current scope. | Retain cross-pane selection. Do not add a user-supplied executable pattern language during this release pass; it adds a language/runtime and untrusted-input surface that would need its own sandbox and limits. |
| [Hex Fiend](https://github.com/HexFiend/HexFiend) and its [framework documentation](https://hexfiend.github.io/HexFiend/docs/) | Large files need range-based access and a clear model/view boundary; the editor explicitly avoids loading an entire file into memory. | Browser `File.slice()` feeds bounded worker chunks and on-demand hex/search reads. | Keep range reads and bounded rendering. A native data-source rewrite would add duplicate code and file-handle lifecycle work without a demonstrated bottleneck. |
| [Binwalk](https://github.com/ReFirmLabs/binwalk) | Signature scans and entropy are useful triage signals, but findings should stay distinct from proof of encryption or extraction. | BLACKBOX has content-based signatures and measured regional/whole-file entropy. It does not execute or extract detected content. | Keep signatures and entropy as observations. Do not add a broad signature database or automatic extraction dependency; neither is required by the current workflow, and extraction would increase security and maintenance scope. |
| [Kaitai Struct](https://doc.kaitai.io/user_guide.html) | Declarative format descriptions can improve consistency and generate parsers across languages. | The current typed registry and bounded parser helpers are hand-written TypeScript and covered by malformed-input tests. | Use Kaitai as a future authoring/reference option for complex formats. Do not add a compiler/runtime or generated parser bundle until there is a concrete format need and a validation/limitation model for generated parsers. |

## Platform and library research

- [Tauri 2 configuration and capabilities](https://v2.tauri.app/reference/config/) support the current restrictive posture: the webview receives no IPC capability unless explicitly granted. This project has no Tauri plugins or capability grants; its CSP disallows external connections. Preserve that boundary and do not add filesystem or shell privileges merely to move code into Rust.
- [React `useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore) is intended for external mutable stores and requires immutable/cached snapshots. BLACKBOX state is already owned by React and delivered in typed worker batches, so introducing a separate store is not justified.
- [TypeScript strict mode](https://www.typescriptlang.org/tsconfig/strict.html) is enabled. Keep strict type checks and avoid weakening compiler settings to accommodate changes.
- [Web Worker `Blob.slice()`](https://developer.mozilla.org/en-US/docs/Web/API/Blob/slice) is available in workers and supports the existing bounded file-read design. The browser worker path preserves parity for browser development and tests.
- Rust's [file API](https://doc.rust-lang.org/std/fs/struct.File.html) supports random-access reads/seeks, while the [Rust book's concurrency guide](https://doc.rust-lang.org/stable/book/ch16-01-threads.html) describes the ordering and race considerations that accompany multithreaded work. The official stable toolchain is now installed, but the native build stops before the project crate can compile because `glib-2.0.pc` and other GTK/WebKit development headers are unavailable and this account cannot install system packages. The optimized TypeScript worker now completes 500 MiB and 1 GiB fixtures in about 7.5 s and 19.7 s respectively on the measured host, with correct independent hashes, so a Rust analysis rewrite has no demonstrated user-facing benefit that justifies duplicate logic, native file-access permissions, event transport, cancellation, browser parity, and parser parity. Reassess only after native prerequisites are available and comparative native profiling shows a concrete bottleneck.
- SQLite has no concrete use in the current product: imports are analyzed in the current session, and there is no persistent file catalog, case database, or multi-file project. Do not add a database dependency.
- [Playwright](https://playwright.dev/docs/accessibility-testing) provides repeatable browser interaction/layout checks; [Vitest](https://vitest.dev/guide/features.html) shares the Vite/TypeScript toolchain for fast unit checks. Existing test suites cover the applicable workflows, so no testing dependency is needed.

## Dependencies, licensing, and scope

No dependency or major architecture change is proposed. Existing dependencies are sufficient for the current UI, hashing, worker, unit-test, browser-test, and Tauri-shell requirements. Avoiding integration also avoids a new runtime compatibility, maintenance, package-size, and license review surface. The application has no sound feature. Adding a sound preference and synthesized effects would expand the interface without improving the essential inspection workflow, so this release remains silent.

## Research limits

This was a targeted design and architecture review, not a full audit of the referenced projects' complete source trees or a formal performance comparison against them. Current-host measurements are recorded separately from prior Apple M2 measurements. No native Rust build or physical desktop/WebView verification can be claimed on this host.
