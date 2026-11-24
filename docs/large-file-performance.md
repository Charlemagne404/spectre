# BLACKBOX large-file performance

## Ubuntu performance investigation — 2026-11-24

These are browser measurements from the same Ubuntu host and headless Chromium. They are not a controlled comparison with the historical Apple M2 results below.

- Ubuntu 24.04.5, Linux 7.0.0
- Intel Core i5-9400F at 2.90 GHz (6 cores), 15 GiB RAM
- Node.js 22.23.4, npm 10.9.9, Playwright 1.65.1, headless Chromium 159.0.8154.6
- Analysis chunk size: 512 KiB. The host showed about 4.9 GiB available memory and 4 GiB of swap in use during this session; treat all runs as observations rather than guarantees.
- `tests/large-files.perf.spec.ts` generated disk-backed deterministic fixtures. The expected SHA-256 was independently calculated in Node and checked against the app for every measured file.

### Fresh baseline and optimized browser runs

| Fixture | Baseline total | Optimized total | Change | Optimized worker time | Optimized statistics + strings |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10 MiB many strings | 0.914 s | 0.819 s | 10.4% faster | 0.286 s | 0.199 s |
| 128 MiB high entropy | 4.301 s | 2.709 s | 37.0% faster | 2.342 s | 1.211 s |
| 500 MiB repeated binary | 14.076 s | 7.421 s / 7.550 s / 7.527 s | 46.8% faster at 7.499 s mean | 6.998 s / 6.918 s / 7.100 s | 3.312 s / 3.262 s / 3.292 s |
| 1 GiB sparse text | 51.566 s | 19.789 s / 19.564 s / 19.925 s | 61.7% faster at 19.759 s mean | 19.323 s / 19.260 s / 19.690 s | 11.352 s / 11.266 s / 11.662 s |

The before/after figures came from one fresh baseline run and three optimized runs on the same machine. Host load and file-cache state can vary. The 500 MiB optimized range was 7.421–7.550 s (1.7%); the 1 GiB range was 19.564–19.925 s (1.8%). The final run in each case used the final code state.

### Measured phases and responsiveness

| Fixture | Total | File ranges | SHA-256 | Statistics + strings | Parser | RSS growth | Events/s | Max frame gap | Additional measurement |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 10 MiB many strings | 0.819 s | 33.3 ms | 50.9 ms | 198.9 ms | 0.3 ms | 139.3 MiB | 373.7 | 149.9 ms | Full-file string search: 27 ms |
| 128 MiB high entropy | 2.709 s | 546.7 ms | 577.9 ms | 1.211 s | 0.3 ms | 279.7 MiB | 70.9 | 133.4 ms | Digest verified |
| 500 MiB repeated binary | 7.527 s | 1.589 s | 2.204 s | 3.292 s | 0.3 ms | 284.5 MiB | 37.7 | 133.3 ms | Three-run optimized mean: 7.499 s |
| 1 GiB sparse text | 19.925 s | 3.495 s | 4.502 s | 11.662 s | 0.4 ms | 233.3 MiB | 38.6 | 116.7 ms | Hex jump: 170 ms; three-run mean: 19.759 s |

The final 1 GiB run's near-EOF jump was 170 ms; the earlier optimized repetitions measured 241 ms and 306 ms. This measurement includes browser input, React state update, and row-visibility checks, not just the underlying 1 KiB file read. All observations remain below the 1-second navigation target, though the spread shows end-to-end interaction timing is more variable than the bounded read itself.

Cancellation during a 128 MiB analysis completed in 11.5 ms in the final run (12.9 ms in an earlier run). The final 10 MiB full-file search for a marker beyond the initial string index took 27 ms. All measured browser analysis digests matched the independent fixture digests. The maximum animation-frame gap across the four final optimized fixtures was 149.9 ms. GNU `time` reported 29% average CPU for the final four-size performance command and no swap-in/out during that command; this invocation-level average includes fixture generation and is not a per-phase CPU reading.

### What changed and what the profiles show

- The main scan uses `Uint32Array` counters while counts fit the exact 32-bit range, with `Float64Array` fallback for files or entropy windows above that range. It reuses each histogram's prior count to detect first offsets and finalizes a partial entropy window after the last chunk instead of checking EOF on every byte.
- `StringScanner` skips a NUL only when its ASCII and UTF-16LE states are inactive. Active string candidates still pass through the original state machine.
- A temporary benchmark-only scan-disable switch was removed after use. Before optimization, a 1 GiB full scan measured 42.572 s in statistics/string work versus 33.206 s with string scanning disabled, an approximately 9.4 s scanner contribution. After the counter/EOF changes, a separate scan-disabled run measured 6.346 s for the statistics loop; the fast NUL path then reduced the full statistics/string phase from 16.133 s to 11.480 s in single runs. These comparisons are diagnostic estimates; the shipped phase metric continues to combine statistics and strings.
- The 1 GiB case now completes in about 19.7 s on this host, well under the 45-second target. The 500 MiB case is about 7.5 s, well under 20 seconds. Browser UI frame gaps, digest checks, cancellation, and bounded random-access inspection also passed in the benchmark suite.

The browser run does not verify a native Tauri build or a physical desktop WebView. Rustup is installed, but the project build stops at the missing `glib-2.0.pc` development package. The account lacks permission to install the required Linux development dependencies.

## Historical Apple M2 runs

### Measurement environment

- MacBook Air, Apple M2 (`T8112`), 8 GiB RAM
- macOS 26.5.1
- Node.js 24.14.1, Playwright 1.65.1, Chromium headless
- Disk-backed deterministic fixtures generated by `tests/large-files.perf.spec.ts`
- Analysis chunk size: 512 KiB

The browser performance suite was run on the host machine with one Playwright worker. Hashes were compared with Node's independent SHA-256 implementation. The 500 MiB before measurement used the earlier 1 MiB read chunk. The first streaming run used a 512 KiB read chunk; a later hard-cap change stopped the primary string pass at 50,000 entries. Results are single-run measurements, so treat them as engineering observations rather than statistical comparisons.

### Before and after

| Fixture | Earlier total time | Streaming total time | Worker time | Events/s | Frame gap max | RSS peak (growth over baseline) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 500 MiB repeated binary | 16.79 s | 13.03 s | 12.71 s | 31.5 | 100 ms | 598.8 MiB (282.2 MiB) |

The first 500 MiB streaming pass completed about 22% faster in that run. Its digest matched the independently generated expected SHA-256. This earlier result predates the string-index cap described below and is not the latest measurement.

The selected 512 KiB chunk was compared with 256 KiB, 1 MiB, and 2 MiB chunks on the 128 MiB high-entropy fixture. Worker times were 4.92 s, 3.85 s, 4.24 s, and 4.01 s respectively. The 512 KiB setting was fastest in these single trials and had a lower observed maximum frame gap than the 256 KiB and 1 MiB trials. The setting is configurable through `VITE_ANALYSIS_CHUNK_SIZE` (64 KiB–4 MiB).

### Streaming run results

| Fixture | Total time | Worker time | Events | Events/s | Max frame gap | RSS peak (growth) | Additional measurement |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 5 KiB repeated text | 2.44 s | 14.5 ms | 18 | 1,241 | 66.7 ms | 383.7 MiB (85.0 MiB) | Small-file reveal remains paced |
| 10 MiB many strings | 593 ms | 392.9 ms | 109 | 277.4 | 66.7 ms | 593.8 MiB (249.5 MiB) | Initial run; search past initial index: 38 ms |
| 10 MiB structured PNG | 956 ms | 402.5 ms | 54 | 134.2 | 50.1 ms | 508.1 MiB (161.1 MiB) | PNG fixture parsed and hashed |
| 128 MiB high entropy | 4.36 s | 4.07 s | 204 | 50.1 | 83.4 ms | 673.3 MiB (317.9 MiB) | SHA-256 verified |
| 500 MiB repeated binary | 13.03 s | 12.71 s | 400 | 31.5 | 100 ms | 598.8 MiB (282.2 MiB) | Initial streaming run; SHA-256 verified |
| 1 GiB sparse text | 32.04 s | 31.49 s | 1,167 | 37.1 | 100 ms | 454.0 MiB (137.0 MiB) | SHA-256 verified; hex jump near EOF: 132 ms |

The 5 KiB file retains the existing approximately 2.2-second progressive reveal even though its analysis completes in 14.5 ms. The 1 GiB case completed and supported a random-access hex jump at offset `0x3FFFFFFF` without scanning preceding bytes for the jump.

### Historical bounded-index run on Apple M2

After the primary string pass was changed to stop string-specific work at 50,000 indexed entries, a targeted Chromium run measured:

| Fixture | Total time | Worker time | Events | Events/s | Max frame gap | RSS peak (growth) | Additional measurement |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 10 MiB many strings | 1.94 s | 1.34 s | 121 | 90.3 | 216.6 ms | Not recorded (growth 212.7 MiB) | Full-file search for a marker beyond the index: 31 ms |
| 500 MiB repeated binary | 54.67 s | 50.74 s | 936 | 18.5 | 400 ms | 431.5 MiB (128.1 MiB) | SHA-256 verified |

Cancellation of a 128 MiB analysis completed in 876 ms in the same targeted run. At measurement time the host showed high system pressure: 7.53 GiB of 8 GiB in use, 2.51 GiB compressed, and a 14.61 one-minute load average. The latest 500 MiB trial missed the 20-second and 250 ms frame-gap targets; its process-tree RSS growth stayed below the 600 MiB target. The earlier 13.03-second run was faster but used the pre-cap scanner and ran under different load, so the two numbers are not a controlled before/after comparison. The 1 GiB result above is also from the earlier implementation and has not yet been rerun after the cap change.

### Working performance targets

These local engineering targets were initially calibrated on the documented 8 GiB MacBook Air and are also used to assess the current Ubuntu run. The historical bounded-index 500 MiB trial missed the time and frame-gap targets; its 1 GiB result predates that change:

- 500 MiB analysis completes within 20 seconds.
- 1 GiB analysis completes within 45 seconds.
- Peak process-tree RSS growth stays below 600 MiB for 500 MiB and 1 GiB cases.
- Maximum observed animation-frame gap stays below 250 ms during large-file analysis.
- Hex navigation within a 1 GiB file completes within 1 second.
- The user can cancel between bounded processing operations; cancellation latency is recorded by the opt-in performance test.

These are local engineering targets, not CI service-level guarantees. They should be recalibrated when hardware, OS, WebView, or fixture generation changes.

### Memory and measurement limits

The main analysis path retains at most one 512 KiB input slice at a time, 256 frequency counters, at most 512 entropy windows, and an index of at most 50,000 string entries with fixed-size previews. The source is a `File` handle and random-access panes read requested ranges. A separate full-file string query retains a 1 MiB slice and at most 50,000 matches for that query. The visible list renders at most 100 rows.

The reported RSS is a 250 ms sampled sum of the Playwright worker and descendant processes, including Chromium and Vite. It is not application-private memory, can miss short-lived peaks, and may count shared pages more than once. The browser's exposed JavaScript heap measurement also excludes the analysis worker and was not useful for comparing these runs. These measurements are therefore coarse process-tree evidence; they do not establish a precise native-app memory ceiling. The 1 GiB run's lower RSS growth than the 500 MiB run is consistent with bounded memory, but the variance reinforces that this is not a precise per-process allocation profile.

The native Tauri app uses macOS WKWebView. In an earlier macOS session the host desktop app was exercised on macOS 26.5.1 / Apple M2 with an actual 500 MiB file, but no reliable native-app timing or memory profile was captured. A 128 MiB WebKit run in that session took 29.3 seconds after increasing the hash-visibility timeout to 60 seconds. The application analyzes local bytes only, does not execute imported content, and does not extract archives.

At the time of that earlier macOS session, the full browser run passed 24 enabled tests across Chromium and WebKit; the 14 opt-in performance tests were skipped by the default suite. Native desktop recordings and generated fixture manifests from that session were retained locally under `output/` and are excluded from the source repository. The fixtures are generated test files; the 500 MiB binary fixture is also generated locally.

## Reproduction

```sh
SPECTRE_PERF=1 npx playwright test tests/large-files.perf.spec.ts --project=Chromium --workers=1
```

The suite writes deterministic fixtures to the system temporary directory and removes them after each case. It does not add large fixtures to the repository. Set `SPECTRE_PERF_SIZES` to a comma-separated subset such as `500MiB,1GiB` to rerun only those sizes.
