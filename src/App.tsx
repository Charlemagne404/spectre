import { useCallback, useEffect, useRef, useState } from 'react';
import { BootTerminal, BOOT_MESSAGES, Launcher } from './Launcher';
import type { BootReadiness } from './Launcher';
import { ModuleHost } from './modules/ModuleHost';
import type { ModuleId } from './modules/registry';
import { demonstrationFile } from './blackbox/fixture';
import { useInspection } from './blackbox/useInspection';
import manifest from '../package.json';

type Screen =
  | 'boot-log' | 'boot-clear' | 'boot-wordmark' | 'boot-launcher' | 'launcher'
  | 'opening-cut' | 'opening-black' | 'workspace-start' | 'workspace'
  | 'closing-cut' | 'closing-black';

const motionPreference = '(prefers-reduced-motion: reduce)';
const bootLineDelay = (index: number) => 16 + ((index * 13) % 25) + (index % 9 === 6 ? 60 : 0);
const isBootScreen = (screen: Screen) => screen === 'boot-log' || screen.startsWith('boot-');

export function App() {
  const [reduced, setReduced] = useState(() => matchMedia(motionPreference).matches);
  const [screen, setScreen] = useState<Screen>(() => matchMedia(motionPreference).matches ? 'launcher' : 'boot-log');
  const [activeModule, setActiveModule] = useState<ModuleId>('blackbox');
  const [bootMessageCount, setBootMessageCount] = useState(0);
  const [bootReadiness, setBootReadiness] = useState<BootReadiness>({
    renderer: 'pending', fileInput: 'pending', worker: 'pending', frame: 'pending', fonts: 'pending',
  });
  const [dragging, setDragging] = useState(false);
  const [draggedName, setDraggedName] = useState('');
  const [intakeAck, setIntakeAck] = useState<{ name: string; id: number } | null>(null);
  const dragDepth = useRef(0);
  const intakeTimer = useRef<number | undefined>(undefined);
  const intakeSequence = useRef(0);
  const launcherButton = useRef<HTMLButtonElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const { inspection, run, processingRun, pending, error, load, cancel } = useInspection();

  useEffect(() => {
    const preference = matchMedia(motionPreference);
    const change = () => setReduced(preference.matches);
    preference.addEventListener('change', change);
    return () => preference.removeEventListener('change', change);
  }, []);

  useEffect(() => () => {
    if (intakeTimer.current !== undefined) window.clearTimeout(intakeTimer.current);
  }, []);

  useEffect(() => {
    if (reduced) {
      if (isBootScreen(screen)) setScreen('launcher');
      else if (screen === 'opening-cut' || screen === 'opening-black' || screen === 'workspace-start') setScreen('workspace');
      else if (screen === 'closing-cut' || screen === 'closing-black') setScreen('launcher');
      return;
    }

    let timer: number | undefined;
    if (screen === 'boot-log') {
      let active = true;
      setBootMessageCount(1);
      setBootReadiness({
        renderer: 'ready',
        fileInput: input.current ? 'ready' : 'unavailable',
        worker: typeof Worker === 'function' ? 'available on demand' : 'unavailable',
        frame: 'pending',
        fonts: 'pending',
      });
      let index = 1;
      const appendNext = () => {
        if (!active) return;
        if (index < BOOT_MESSAGES.length) {
          timer = window.setTimeout(() => {
            index += 1;
            setBootMessageCount(index);
            appendNext();
          }, bootLineDelay(index));
        } else {
          timer = window.setTimeout(() => setScreen('boot-clear'), 170);
        }
      };
      appendNext();
      const frame = window.requestAnimationFrame(() => {
        if (active) setBootReadiness((current) => ({ ...current, frame: 'delivered' }));
      });
      void document.fonts.ready.then(() => {
        if (active) setBootReadiness((current) => ({ ...current, fonts: 'settled' }));
      });
      return () => {
        active = false;
        window.cancelAnimationFrame(frame);
        if (timer !== undefined) window.clearTimeout(timer);
      };
    } else {
      const next: Partial<Record<Screen, { screen: Screen; delay: number }>> = {
        'boot-clear': { screen: 'boot-wordmark', delay: 190 },
        'boot-wordmark': { screen: 'boot-launcher', delay: 620 },
        'boot-launcher': { screen: 'launcher', delay: 340 },
        'opening-cut': { screen: 'opening-black', delay: 190 },
        'opening-black': { screen: 'workspace-start', delay: 140 },
        'workspace-start': { screen: 'workspace', delay: 1420 },
        'closing-cut': { screen: 'closing-black', delay: 180 },
        'closing-black': { screen: 'launcher', delay: 140 },
      };
      const step = next[screen];
      if (step) timer = window.setTimeout(() => setScreen(step.screen), step.delay);
    }
    return () => { if (timer !== undefined) window.clearTimeout(timer); };
  }, [screen, reduced]);

  useEffect(() => {
    if (screen === 'launcher') launcherButton.current?.focus({ preventScroll: true });
    if ((screen === 'workspace-start' || screen === 'workspace') &&
      (document.activeElement === document.body || document.activeElement === launcherButton.current)) {
      title.current?.focus({ preventScroll: true });
    }
  }, [screen]);

  const launch = useCallback((moduleId: ModuleId = activeModule) => {
    setActiveModule(moduleId);
    setScreen(reduced ? 'workspace' : 'opening-cut');
  }, [activeModule, reduced]);

  const open = useCallback(() => input.current?.click(), []);
  const restoreFile = useCallback((_file: import('./blackbox/investigations').InvestigationFile) => input.current?.click(), []);
  const back = useCallback(() => setScreen(reduced ? 'launcher' : 'closing-cut'), [reduced]);
  const importFile = (file: File) => {
    load(file);
    if (screen !== 'opening-cut' && screen !== 'opening-black' && screen !== 'workspace-start' && screen !== 'workspace') {
      setScreen(reduced ? 'workspace' : 'opening-cut');
    }
  };

  const openSample = useCallback(() => {
    load(demonstrationFile(), true);
  }, [load]);

  const reanalyze = useCallback(() => {
    const file = run?.file ?? inspection?.file;
    if (file) load(file, run?.sample ?? inspection?.sample ?? false);
  }, [inspection, load, run]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (isBootScreen(screen)) {
        if (!event.repeat) setScreen('launcher');
        return;
      }

      const shortcut = event.metaKey || event.ctrlKey;
      const value = event.key.toLowerCase();
      if (shortcut && !event.altKey && value === 'o') {
        event.preventDefault();
        open();
      } else if (shortcut && !event.altKey && value === 'f' && search.current && screen !== 'closing-cut' && screen !== 'closing-black') {
        event.preventDefault();
        search.current.focus();
        search.current.select();
      } else if (event.key === 'Escape') {
        const activeElement = document.activeElement;
        const isTextEditor = activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement ||
          (activeElement instanceof HTMLElement && activeElement.isContentEditable);
        if ((screen === 'workspace' || screen === 'workspace-start') && isTextEditor) {
          activeElement.blur();
          title.current?.focus();
        } else if (screen === 'workspace' || screen === 'workspace-start') back();
        else if (screen === 'opening-cut' || screen === 'opening-black') setScreen('workspace');
        else if (screen === 'closing-cut' || screen === 'closing-black') setScreen('launcher');
      } else if (!shortcut && !event.altKey && !event.repeat && screen === 'launcher' && (event.key === '1' || event.key === '2')) {
        event.preventDefault();
        launch(event.key === '1' ? 'blackbox' : 'recon');
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [screen, open, back, launch]);

  const booting = isBootScreen(screen);
  const blackPhase = screen === 'boot-clear' || screen === 'opening-black' || screen === 'closing-black';
  const showLauncher = screen === 'boot-wordmark' || screen === 'boot-launcher' || screen === 'launcher' || screen === 'opening-cut';
  const launcherMode = screen === 'boot-wordmark' ? 'wordmark'
    : screen === 'boot-launcher' ? 'resolving'
      : screen === 'opening-cut' ? 'shutting' : 'ready';
  const showWorkspace = screen === 'workspace-start' || screen === 'workspace' || screen === 'closing-cut';

  return <div className={'application' + (booting ? ' boot-surface' : '') + (blackPhase ? ' black-phase' : '') + (dragging ? ' is-dragging' : '')} onDragEnter={(event) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragDepth.current++;
    const incoming = [...event.dataTransfer.items].find((item) => item.kind === 'file')?.getAsFile()?.name;
    if (incoming) setDraggedName(incoming);
    setDragging(true);
  }} onDragOver={(event) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }} onDragLeave={(event) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) { setDragging(false); setDraggedName(''); }
  }} onDrop={(event) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const file = event.dataTransfer.files[0];
    setDraggedName('');
    if (file) {
      importFile(file);
      setIntakeAck({ name: file.name || 'Unnamed file', id: ++intakeSequence.current });
      if (intakeTimer.current !== undefined) window.clearTimeout(intakeTimer.current);
      intakeTimer.current = window.setTimeout(() => setIntakeAck(null), 700);
    }
  }}>
    <input type="file" ref={input} hidden aria-label="Choose a local file" onChange={(event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) importFile(file);
    }} />
    {screen === 'boot-log' && <BootTerminal messageCount={bootMessageCount} readiness={bootReadiness} />}
    {showLauncher && <Launcher mode={launcherMode} version={manifest.version} open={launch} buttonRef={launcherButton} />}
    {showWorkspace && <ModuleHost moduleId={activeModule}
      blackbox={{ inspection, pending, error, run, processingRun, reanalyze, openSample,
        activating: screen === 'workspace-start', shuttingDown: screen === 'closing-cut',
        open, back, cancel, restoreFile, titleRef: title, searchRef: search }}
      recon={{ active: screen !== 'closing-cut', activating: screen === 'workspace-start', back, titleRef: title }} />}
    {dragging && <div className="drop-overlay" aria-hidden="true"><div><span>FILE INCOMING</span><strong>{draggedName || 'Drop to begin analysis'}</strong></div></div>}
    {intakeAck && <div key={intakeAck.id} className="intake-ack" role="status"><span>RECEIVED</span><strong>{intakeAck.name}</strong></div>}
  </div>;
}
