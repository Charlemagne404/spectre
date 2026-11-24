import { useLayoutEffect, useRef } from 'react';
import type { Ref } from 'react';

const glyphs = [
  [' .----.', '/ ,---\'', '\\ `--. ', ' `--- \\', '.---\' /', '\'----\' '],
  ['.----. ', '| .-. \\', '| `-\' /', '| .--\' ', '| |    ', '\'-\'    '],
  ['.------', '| .----', '| `---.', '| .---\'', '| `----', '\'------'],
  [' .----.', '/ ,---\'', '| |    ', '| |    ', '\\ `---.', ' `----\''],
  ['.------', '\'--. .-', '   | | ', '   | | ', '   | | ', '   \'-\' '],
  ['.----. ', '| .-. \\', '| `-\' /', '| .-. \\', '| | \\ \\', '\'-\'  \'-\''],
  ['.------', '| .----', '| `---.', '| .---\'', '| `----', '\'------'],
];

const letters = glyphs.map((glyph) => glyph.map((row) => row.padEnd(8)).join('\n'));

export const BOOT_MESSAGES = [
  '[    0.084] Spectre runtime initializing',
  '[    0.112] Reading application manifest',
  '[    0.148] Loading local interface assets',
  '[    0.193] Preparing renderer entry point',
  '[    0.227] Creating application shell',
  '[    0.281] Loading JetBrains Mono variable face',
  '[    0.314] Resolving interface font metrics',
  '[    0.376] Registering application components',
  '[    0.421] Binding keyboard input handlers',
  '[    0.493] Reading reduced-motion preference',
  '[    0.527] Preparing launcher surface',
  '[    0.561] Registering local file input',
  '[    0.608] Attaching file drop handlers',
  '[    0.644] Loading BLACKBOX module definition',
  '[    0.701] Preparing workspace layout',
  '[    0.735] Initializing inspection state',
  '[    0.772] Registering analysis cancellation path',
  '[    0.809] Loading file signature matcher',
  '[    0.846] Preparing RIFF chunk reader',
  '[    0.882] Registering WAVE metadata parser',
  '[    0.924] Preparing generic byte inspection',
  '[    0.957] Configuring bounded input segments',
  '[    0.993] Preparing SHA-256 digest view',
  '[    1.031] Initializing entropy data model',
  '[    1.064] Allocating byte-frequency bins',
  '[    1.108] Preparing printable-string index',
  '[    1.146] Loading shared byte-range model',
  '[    1.181] Registering region selection events',
  '[    1.224] Preparing structure map renderer',
  '[    1.261] Calibrating entropy plot scales',
  '[    1.298] Loading hexadecimal row formatter',
  '[    1.337] Preparing byte-frequency display',
  '[    1.374] Configuring bounded hex page window',
  '[    1.411] Binding cross-pane selection updates',
  '[    1.448] Registering digest copy action',
  '[    1.487] Registering string filter control',
  '[    1.525] Preparing keyboard navigation',
  '[    1.562] Resolving workspace panel geometry',
  '[    1.604] Applying local display settings',
  '[    1.641] Checking viewport measurements',
  '[    1.679] Preparing on-demand analysis worker',
  '[    1.718] Connecting worker progress updates',
  '[    1.754] Initializing file replacement flow',
  '[    1.792] Registering focus restoration',
  '[    1.829] Measuring panel text baselines',
  '[    1.866] Preparing launcher module selector',
  '[    1.904] Checking interface readiness',
  '[    1.942] BLACKBOX views prepared',
  '[    1.981] Registering analysis progress channel',
  '[    2.019] Preparing replacement input flow',
  '[    2.056] Configuring panel focus targets',
  '[    2.093] Applying file-navigation defaults',
  '[    2.130] Binding entropy range selection',
  '[    2.167] Binding structure-region selection',
  '[    2.204] Binding string row selection',
  '[    2.241] Binding hexadecimal byte selection',
  '[    2.278] Connecting histogram navigation',
  '[    2.315] Preparing digest copy fallback',
  '[    2.352] Checking narrow-screen layout rules',
  '[    2.389] Reading current viewport dimensions',
  '[    2.426] Applying responsive workspace tracks',
  '[    2.463] Registering processing progress view',
  '[    2.500] Preparing analysis error surface',
  '[    2.537] Restoring workspace title focus',
  '[    2.574] Resolving selector keyboard target',
  '[    2.611] Finalizing input focus order',
  '[    2.648] Checking linked visualization controls',
  '[    2.685] Preparing stable workspace frame',
  '[    2.722] Settling interface font rendering',
  '[    2.759] Spectre initialization complete',
];

export interface BootReadiness {
  renderer: 'pending' | 'ready';
  fileInput: 'pending' | 'ready' | 'unavailable';
  worker: 'pending' | 'available on demand' | 'unavailable';
  frame: 'pending' | 'delivered';
  fonts: 'pending' | 'settled';
}

export function BootTerminal({ messageCount, readiness }: { messageCount: number; readiness: BootReadiness }) {
  const viewport = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [messageCount]);

  const liveStatus = `Live readiness · renderer ${readiness.renderer} · file input ${readiness.fileInput}`
    + ` · analysis worker ${readiness.worker} · first frame ${readiness.frame} · fonts ${readiness.fonts}`;

  return <main className="boot-terminal">
    <div className="boot-meta">
      <span className="boot-sequence-label">Visual startup trace · display only</span>
      <span className="boot-live-status" role="status" aria-live="polite">{liveStatus}</span>
    </div>
    <div className="boot-log-window" ref={viewport} aria-hidden="true">
      <div className="boot-log-lines">
        {BOOT_MESSAGES.slice(0, messageCount).map((message, index) =>
          <div key={message} className="boot-log-line" style={{ '--line-order': index } as React.CSSProperties}>{message}</div>)}
      </div>
    </div>
  </main>;
}

export type LauncherMode = 'wordmark' | 'resolving' | 'ready' | 'shutting';

export function Launcher({ mode, version, open, buttonRef }: {
  mode: LauncherMode;
  version: string;
  open: () => void;
  buttonRef: Ref<HTMLButtonElement>;
}) {
  const wordmarkOnly = mode === 'wordmark';
  const className = 'launcher' + (wordmarkOnly ? ' launcher-wordmark-only' : '')
    + (mode === 'resolving' ? ' launcher-resolving' : '')
    + (mode === 'shutting' ? ' launcher-shutting' : '');

  return <main className={className}>
    <div className="launcher-core">
      <h1 className="wordmark" aria-label="Spectre"><span aria-hidden="true">
        {letters.map((letter, index) => <span key={index} className="wordmark-letter"
          style={{ '--letter-index': index } as React.CSSProperties}>{letter}</span>)}
      </span></h1>
      {!wordmarkOnly && <button className="launcher-module" ref={buttonRef} onClick={open} disabled={mode !== 'ready'}>
        <span className="launcher-indicator" aria-hidden="true" /><span className="launcher-key">[1]</span> BLACKBOX
      </button>}
    </div>
    {mode === 'ready' && <div className="version">v{version}</div>}
  </main>;
}
