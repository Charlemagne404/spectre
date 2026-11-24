import { useCallback, useEffect, useRef, useState } from 'react';
import type { Analysis, AnalysisEvent, AnalysisRun } from './model';
import { applyAnalysisEvent, applyAnalysisEvents, createAnalysisRun } from './analysisEvents';
import {
  completesPresentationPhase,
  expandForPresentation,
  minimumPresentationDuration,
  presentationPhase,
  presentationPhases,
  SMALL_FILE_PRESENTATION_LIMIT,
} from './analysisPresentation';
import type { PresentationPhase } from './analysisPresentation';

export interface Inspection {
  id: number;
  file: File;
  data: Analysis;
  sample: boolean;
}

type PresentationEvents = Record<PresentationPhase, AnalysisEvent[]>;

function emptyPresentationEvents(): PresentationEvents {
  return {
    identification: [], fingerprint: [], structure: [], entropy: [], strings: [], frequency: [], inspection: [],
  };
}

class SmallFilePresentation {
  private readonly events = emptyPresentationEvents();
  private readonly ready = new Set<PresentationPhase>();
  private readonly due = new Set<PresentationPhase>();
  private readonly started = new Set<PresentationPhase>();
  private readonly timers: number[] = [];
  private readonly phaseSpan: number;
  private disposed = false;

  constructor(
    private readonly startedAt: number,
    private readonly publish: (events: AnalysisEvent[]) => void,
    private readonly onComplete: () => void,
  ) {
    const duration = minimumPresentationDuration(presentationPhases.length);
    this.phaseSpan = duration / presentationPhases.length;
    presentationPhases.forEach((phase, index) => {
      this.scheduleAt(index * this.phaseSpan, () => {
        this.due.add(phase);
        this.tryReveal(phase);
      });
    });
  }

  push(event: AnalysisEvent) {
    const phase = presentationPhase(event);
    if (!phase || this.disposed) return;
    this.events[phase].push(event);
    if (completesPresentationPhase(event)) {
      this.ready.add(phase);
      this.tryReveal(phase);
    }
  }

  dispose() {
    this.disposed = true;
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.length = 0;
  }

  private scheduleAt(offset: number, action: () => void) {
    const delay = Math.max(0, this.startedAt + offset - performance.now());
    this.timers.push(window.setTimeout(() => {
      if (!this.disposed) action();
    }, delay));
  }

  private scheduleIn(offset: number, action: () => void) {
    this.timers.push(window.setTimeout(() => {
      if (!this.disposed) action();
    }, Math.max(0, offset)));
  }

  private tryReveal(phase: PresentationPhase) {
    if (this.disposed || !this.due.has(phase) || !this.ready.has(phase) || this.started.has(phase)) return;
    this.started.add(phase);
    const grouped = this.events[phase];
    const slot = this.phaseSpan;
    const at = (offset: number, events: AnalysisEvent[]) => {
      if (events.length) this.scheduleIn(offset, () => this.publish(events));
    };

    switch (phase) {
      case 'identification': {
        at(0, grouped.filter((event) => event.type !== 'FILE_IDENTIFIED'));
        at(slot * 0.72, grouped.filter((event) => event.type === 'FILE_IDENTIFIED'));
        break;
      }
      case 'fingerprint': {
        at(0, grouped.filter((event) => event.type === 'HASHING_STARTED'));
        const progress = grouped.filter((event) => event.type === 'HASHING_PROGRESS');
        progress.forEach((event, index) => at(slot * (0.18 + 0.52 * (index + 1) / (progress.length + 1)), [event]));
        at(slot * 0.86, grouped.filter((event) => event.type === 'HASHING_COMPLETED'));
        break;
      }
      case 'structure': {
        at(0, grouped.filter((event) => event.type === 'STRUCTURE_PARSING_STARTED'));
        const regions = grouped.filter((event) => event.type === 'STRUCTURE_REGION_DISCOVERED' || event.type === 'STRUCTURE_REGION_BATCH_DISCOVERED');
        const batchSize = Math.max(1, Math.ceil(regions.length / 12));
        const batches: AnalysisEvent[][] = [];
        for (let index = 0; index < regions.length; index += batchSize) batches.push(regions.slice(index, index + batchSize));
        batches.forEach((batch, index) => at(slot * (0.08 + 0.76 * (index + 1) / (batches.length + 1)), batch));
        at(slot * 0.92, grouped.filter((event) => event.type === 'STRUCTURE_PARSING_COMPLETED'));
        break;
      }
      case 'entropy': {
        at(0, grouped.filter((event) => event.type === 'ENTROPY_ANALYSIS_STARTED'));
        const bins = grouped.flatMap((event) => expandForPresentation(event))
          .filter((event) => event.type === 'ENTROPY_REGION_ANALYZED');
        bins.forEach((event, index) => at(slot * (0.1 + 0.72 * (index + 1) / (bins.length + 1)), [event]));
        at(slot * 0.92, grouped.filter((event) => event.type === 'ENTROPY_ANALYSIS_COMPLETED'));
        break;
      }
      case 'strings': {
        const batches = grouped.filter((event) => event.type === 'STRING_BATCH_DISCOVERED');
        batches.forEach((event, index) => at(slot * (0.16 + 0.62 * (index + 1) / (batches.length + 1)), [event]));
        at(slot * 0.92, grouped.filter((event) => event.type === 'STRING_EXTRACTION_COMPLETED'));
        break;
      }
      case 'frequency': {
        const updates = grouped.filter((event) => event.type === 'BYTE_FREQUENCY_UPDATED');
        updates.forEach((event, index) => at(slot * (0.08 + 0.7 * (index + 1) / (updates.length + 1)), [event]));
        at(slot * 0.92, grouped.filter((event) => event.type === 'BYTE_FREQUENCY_COMPLETED'));
        break;
      }
      case 'inspection': {
        at(0, grouped.filter((event) => event.type === 'HEX_DATA_AVAILABLE'));
        at(slot * 0.82, grouped.filter((event) => event.type === 'ANALYSIS_COMPLETED'));
        break;
      }
    }

    if (this.started.size === presentationPhases.length) {
      this.scheduleIn(slot, () => {
        if (this.disposed) return;
        this.dispose();
        this.onComplete();
      });
    }
  }
}

export function useInspection() {
  const sequence = useRef(0);
  const worker = useRef<Worker | null>(null);
  const actualRun = useRef<AnalysisRun | null>(null);
  const visibleRun = useRef<AnalysisRun | null>(null);
  const presentation = useRef<SmallFilePresentation | null>(null);
  const processingEvents = useRef<AnalysisEvent[]>([]);
  const processingFrame = useRef<number | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [run, setRun] = useState<AnalysisRun | null>(null);
  const [processingRun, setProcessingRun] = useState<AnalysisRun | null>(null);
  const [error, setError] = useState('');

  const publishVisible = useCallback((next: AnalysisRun) => {
    visibleRun.current = next;
    setRun(next);
  }, []);

  const flushProcessingEvents = useCallback(() => {
    if (processingFrame.current !== null) cancelAnimationFrame(processingFrame.current);
    processingFrame.current = null;
    const events = processingEvents.current.splice(0);
    const current = actualRun.current;
    if (!current || !events.length) return;
    const next = applyAnalysisEvents(current, events);
    actualRun.current = next;
    setProcessingRun(next);
    if (!presentation.current) {
      const visible = visibleRun.current;
      if (visible) publishVisible(applyAnalysisEvents(visible, events));
    }
  }, [publishVisible]);

  const queueProcessingEvent = useCallback((event: AnalysisEvent, flushNow = false) => {
    processingEvents.current.push(event);
    if (flushNow) {
      flushProcessingEvents();
      return;
    }
    if (processingFrame.current === null) processingFrame.current = requestAnimationFrame(flushProcessingEvents);
  }, [flushProcessingEvents]);

  const publishEvents = useCallback((events: AnalysisEvent[]) => {
    const current = visibleRun.current;
    if (!current) return;
    const expanded = events.flatMap((event) => expandForPresentation(event));
    publishVisible(applyAnalysisEvents(current, expanded));
  }, [publishVisible]);

  const stopPresentation = useCallback(() => {
    presentation.current?.dispose();
    presentation.current = null;
  }, []);

  const cancel = useCallback(() => {
    const activeWorker = worker.current;
    if (!activeWorker) return;
    worker.current = null;
    activeWorker.terminate();
    stopPresentation();
    flushProcessingEvents();
    const current = actualRun.current;
    if (!current || current.status !== 'running') return;
    const cancelled = applyAnalysisEvent(current, { jobId: current.jobId, type: 'ANALYSIS_CANCELLED' });
    actualRun.current = cancelled;
    setProcessingRun(cancelled);
    publishVisible(cancelled);
  }, [flushProcessingEvents, publishVisible, stopPresentation]);

  const load = useCallback((file: File, sample = false) => {
    stopPresentation();
    cancel();
    const jobId = ++sequence.current;
    const initial = createAnalysisRun(jobId, file, sample);
    actualRun.current = initial;
    visibleRun.current = initial;
    setInspection(null);
    setError('');
    setRun(initial);
    setProcessingRun(initial);

    const reduceMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const paced = file.size <= SMALL_FILE_PRESENTATION_LIMIT && !reduceMotion;
    if (paced) {
      let controller: SmallFilePresentation;
      controller = new SmallFilePresentation(performance.now(), (events) => {
        if (presentation.current === controller && actualRun.current?.jobId === jobId) publishEvents(events);
      }, () => {
        if (presentation.current === controller) presentation.current = null;
      });
      presentation.current = controller;
    }

    const fail = (message: string) => {
      if (worker.current) worker.current.terminate();
      worker.current = null;
      stopPresentation();
      flushProcessingEvents();
      setError(message);
      const current = actualRun.current;
      if (current && current.jobId === jobId && current.status === 'running') {
        const failed = applyAnalysisEvent(current, { jobId, type: 'ANALYSIS_FAILED', message });
        actualRun.current = failed;
        setProcessingRun(failed);
        publishVisible(failed);
      }
    };

    try {
      const job = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
      worker.current = job;
      job.onmessage = ({ data }: MessageEvent<AnalysisEvent>) => {
        if (worker.current !== job || data.jobId !== jobId) return;
        const current = actualRun.current;
        if (!current || current.jobId !== jobId) return;
        const immediate = data.type === 'ANALYSIS_FAILED' || data.type === 'ANALYSIS_CANCELLED' || data.type === 'ANALYSIS_COMPLETED';
        queueProcessingEvent(data, immediate);

        if (data.type === 'ANALYSIS_FAILED') {
          setError(data.message);
          stopPresentation();
          const failed = actualRun.current;
          if (failed) publishVisible(failed);
          worker.current = null;
          job.terminate();
          return;
        }
        if (data.type === 'ANALYSIS_COMPLETED') {
          setInspection({ id: jobId, data: data.analysis, file, sample });
          worker.current = null;
          job.terminate();
        }

        const controller = presentation.current;
        if (controller) controller.push(data);
      };
      job.onerror = () => {
        if (worker.current === job) fail('The analysis worker could not start.');
      };
      job.postMessage({ jobId, file });
    } catch {
      fail('The analysis worker could not start.');
    }
  }, [cancel, flushProcessingEvents, publishEvents, publishVisible, queueProcessingEvent, stopPresentation]);

  useEffect(() => () => {
    worker.current?.terminate();
    presentation.current?.dispose();
    if (processingFrame.current !== null) cancelAnimationFrame(processingFrame.current);
    processingEvents.current.length = 0;
  }, []);

  return { inspection, run, processingRun, pending: processingRun?.status === 'running', error, load, cancel };
}
