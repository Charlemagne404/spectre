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

export function BootTerminal({ messages }: { messages: string[] }) {
  const viewport = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [messages.length]);

  return <main className="boot-terminal" aria-hidden="true">
    <div className="boot-log-window" ref={viewport}>
      <div className="boot-log-lines">
        {messages.map((message, index) =>
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
