import { describe, expect, it } from 'vitest';
import { AVAILABLE_MODULES, MODULES, getModule, moduleFromKey } from '../src/modules/registry';
import { appendSnapshot, applyReconEvent, compareSnapshots, createInvestigation, MAX_SNAPSHOTS_PER_INVESTIGATION } from '../src/recon/model';
import type { ReconEvidence, ReconEvent, ReconRelationship } from '../src/recon/model';
import { developmentFixture } from '../src/recon/fixture';

const evidence = (id: string, provider = 'dns'): ReconEvidence => ({
  id, provider, evidenceType: 'resourceRecord', query: 'example.com', retrievedAt: '2026-11-24T12:00:00Z',
  observedAt: null, status: 'observed', sourceRef: null, originalValue: '203.0.113.8', normalizedValue: '203.0.113.8',
  details: { recordType: 'A', ttlSeconds: 300 }, limitations: [],
});

describe('first-party module registry', () => {
  it('exposes BLACKBOX and RECON while keeping future modules unavailable', () => {
    expect(AVAILABLE_MODULES.map((item) => item.id)).toEqual(['blackbox', 'recon']);
    expect(MODULES.filter((item) => !item.available).map((item) => item.id)).toEqual(['atlas', 'ghost']);
    expect(getModule('recon').name).toBe('RECON');
    expect(moduleFromKey('2')).toBe('recon');
    expect(moduleFromKey('3')).toBeUndefined();
  });
});

describe('RECON event and history model', () => {
  it('progressively merges entities, source statuses, and relationship provenance', () => {
    let investigation = createInvestigation('example.com');
    const relation: ReconRelationship = { id: 'edge', from: 'domain:example.com', to: 'ip:203.0.113.8', kind: 'resolvesTo', label: 'resolves to', evidenceIds: ['ev:a'] };
    const first: ReconEvent = { jobId: 'job', sequence: 1, timestamp: '2026-11-24T12:00:00Z', phase: 'dns', provider: 'dns', kind: 'finding', status: null, message: null,
      entities: [{ id: 'ip:203.0.113.8', kind: 'ip', label: '203.0.113.8', attributes: { family: 'IPv4' } }], relationships: [relation], evidence: [evidence('ev:a')] };
    const second: ReconEvent = { ...first, sequence: 2, evidence: [evidence('ev:b')], relationships: [{ ...relation, evidenceIds: ['ev:b'] }] };
    investigation = applyReconEvent(investigation, first);
    investigation = applyReconEvent(investigation, second);
    expect(investigation.snapshots[0].entities).toHaveLength(1);
    expect(investigation.snapshots[0].relationships[0].evidenceIds).toEqual(['ev:a', 'ev:b']);
    expect(investigation.snapshots[0].evidence).toHaveLength(2);
  });

  it('never calls a missing result removed when the latest source is incomplete', () => {
    const previous = {
      id: 'before', capturedAt: 'a', status: 'complete' as const,
      providers: { dns: { provider: 'dns', status: 'complete', message: null, updatedAt: 'a' } },
      entities: [], relationships: [], evidence: [evidence('ev:a')],
    };
    const current = {
      id: 'after', capturedAt: 'b', status: 'partial' as const,
      providers: { dns: { provider: 'dns', status: 'offline', message: 'No connection', updatedAt: 'b' } },
      entities: [], relationships: [], evidence: [],
    };
    expect(compareSnapshots(previous, current)).toEqual([]);
  });

  it('reports newly observed values and qualifies values absent from a completed source', () => {
    const previous = {
      id: 'before', capturedAt: 'a', status: 'complete' as const,
      providers: { dns: { provider: 'dns', status: 'complete', message: null, updatedAt: 'a' } },
      entities: [], relationships: [], evidence: [evidence('ev:old')],
    };
    const current = {
      id: 'after', capturedAt: 'b', status: 'complete' as const,
      providers: { dns: { provider: 'dns', status: 'complete', message: null, updatedAt: 'b' } },
      entities: [], relationships: [], evidence: [evidence('ev:new')],
    };
    expect(compareSnapshots(previous, current).map((change) => change.kind)).toEqual(['new', 'notObserved']);
    expect(compareSnapshots(previous, current).find((change) => change.kind === 'notObserved')?.detail).toContain('does not prove removal');
  });

  it('keeps incomplete current sources from creating positive change claims', () => {
    const previous = {
      id: 'before', capturedAt: 'a', status: 'complete' as const,
      providers: { dns: { provider: 'dns', status: 'complete', message: null, updatedAt: 'a' } },
      entities: [], relationships: [], evidence: [],
    };
    const current = {
      id: 'after', capturedAt: 'b', status: 'partial' as const,
      providers: { dns: { provider: 'dns', status: 'offline', message: 'Offline', updatedAt: 'b' } },
      entities: [], relationships: [], evidence: [evidence('ev:new')],
    };
    expect(compareSnapshots(previous, current)).toEqual([]);
  });

  it('retains no more than 40 snapshots and reports when old history is pruned', () => {
    const investigation = createInvestigation('example.com');
    investigation.snapshots = Array.from({ length: MAX_SNAPSHOTS_PER_INVESTIGATION }, (_, index) => ({
      id: `snapshot-${index}`, capturedAt: String(index), status: 'complete' as const,
      providers: {}, entities: [], relationships: [], evidence: [],
    }));
    const result = appendSnapshot(investigation);
    expect(result.investigation.snapshots).toHaveLength(40);
    expect(result.investigation.snapshots[0].id).toBe('snapshot-1');
    expect(result.pruned).toBe(true);
  });

  it('marks the UI fixture explicitly and keeps it out of persisted-live flow', () => {
    const fixture = developmentFixture();
    expect(fixture.fixture).toBe(true);
    expect(fixture.snapshots[0].evidence.every((item) => item.limitations.some((text) => text.toLowerCase().includes('development fixture')))).toBe(true);
    expect(fixture.snapshots[0].entities.length).toBeGreaterThan(0);
  });
});

