export const RECON_SCHEMA_VERSION = 1 as const;
export const MAX_SNAPSHOTS_PER_INVESTIGATION = 40;

export type EntityKind = 'domain' | 'hostname' | 'wildcard' | 'ip' | 'prefix' | 'asn' | 'nameserver' | 'mailhost' | 'registrar';
export type RelationshipKind = 'resolvesTo' | 'cname' | 'usesMailExchanger' | 'delegatedTo' | 'withinPrefix' | 'announcedBy' | 'registeredWith' | 'certificateObserved' | 'certificateWildcard';
export type EvidenceStatus = 'observed' | 'historical' | 'wildcard' | 'nxdomain' | 'nodata' | 'servfail' | 'timeout' | 'error' | 'unavailable';
export type ProviderStatus = 'queued' | 'running' | 'complete' | 'partial' | 'unavailable' | 'rateLimited' | 'offline' | 'timeout' | 'error' | 'cancelled';

export interface ReconEntity {
  id: string;
  kind: EntityKind;
  label: string;
  attributes: Record<string, unknown>;
}

export interface ReconRelationship {
  id: string;
  from: string;
  to: string;
  kind: RelationshipKind;
  label: string;
  evidenceIds: string[];
}

export interface ReconEvidence {
  id: string;
  provider: string;
  evidenceType: string;
  query: string;
  retrievedAt: string;
  observedAt: string | null;
  status: EvidenceStatus | string;
  sourceRef: string | null;
  originalValue: string | null;
  normalizedValue: string | null;
  details: Record<string, unknown>;
  limitations: string[];
  note?: string;
}

export interface ProviderReport {
  provider: string;
  status: ProviderStatus | string;
  message: string | null;
  updatedAt: string;
}

export interface ReconSnapshot {
  id: string;
  capturedAt: string;
  status: 'running' | 'complete' | 'partial' | 'cancelled' | 'error';
  providers: Record<string, ProviderReport>;
  entities: ReconEntity[];
  relationships: ReconRelationship[];
  evidence: ReconEvidence[];
}

export interface ReconInvestigation {
  schemaVersion: typeof RECON_SCHEMA_VERSION;
  id: string;
  target: string;
  registrableDomain: string;
  createdAt: string;
  updatedAt: string;
  notes: string;
  entityNotes: Record<string, string>;
  snapshots: ReconSnapshot[];
  fixture?: boolean;
}

export interface ReconEvent {
  jobId: string;
  sequence: number;
  timestamp: string;
  phase: string;
  provider: string | null;
  kind: 'phase' | 'provider' | 'finding' | 'complete';
  status: string | null;
  message: string | null;
  entities?: ReconEntity[];
  relationships?: ReconRelationship[];
  evidence?: ReconEvidence[];
}

export function createSnapshot(): ReconSnapshot {
  return { id: crypto.randomUUID(), capturedAt: new Date().toISOString(), status: 'running', providers: {}, entities: [], relationships: [], evidence: [] };
}

export function appendSnapshot(investigation: ReconInvestigation): { investigation: ReconInvestigation; pruned: boolean } {
  const all = [...investigation.snapshots, createSnapshot()];
  const snapshots = all.slice(-MAX_SNAPSHOTS_PER_INVESTIGATION);
  return { investigation: { ...investigation, updatedAt: new Date().toISOString(), snapshots }, pruned: all.length > snapshots.length };
}

export function createInvestigation(target: string, registrableDomain = target): ReconInvestigation {
  const now = new Date().toISOString();
  return {
    schemaVersion: RECON_SCHEMA_VERSION,
    id: crypto.randomUUID(),
    target,
    registrableDomain,
    createdAt: now,
    updatedAt: now,
    notes: '',
    entityNotes: {},
    snapshots: [createSnapshot()],
  };
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  if (!incoming.length) return current;
  const values = new Map(current.map((item) => [item.id, item]));
  incoming.forEach((item) => values.set(item.id, { ...values.get(item.id), ...item }));
  return [...values.values()];
}

export function applyReconEvent(investigation: ReconInvestigation, event: ReconEvent): ReconInvestigation {
  const snapshots = [...investigation.snapshots];
  const index = snapshots.length - 1;
  if (index < 0) return investigation;
  const current = snapshots[index];
  if (event.kind === 'provider' && event.provider) {
    current.providers = {
      ...current.providers,
      [event.provider]: { provider: event.provider, status: event.status ?? 'running', message: event.message, updatedAt: event.timestamp },
    };
  }
  current.entities = mergeById(current.entities, event.entities ?? []);
  const previousRelationships = current.relationships;
  current.relationships = mergeById(current.relationships, event.relationships ?? []).map((relationship) => {
    const prior = previousRelationships.find((item) => item.id === relationship.id);
    return { ...relationship, evidenceIds: [...new Set([...(prior?.evidenceIds ?? []), ...relationship.evidenceIds])] };
  });
  current.evidence = mergeById(current.evidence, event.evidence ?? []);
  if (event.kind === 'complete') current.status = event.status === 'cancelled' ? 'cancelled' : event.status === 'partial' ? 'partial' : event.status === 'error' ? 'error' : 'complete';
  snapshots[index] = current;
  return { ...investigation, updatedAt: event.timestamp, snapshots };
}

export interface SnapshotChange {
  kind: 'new' | 'notObserved' | 'changed';
  label: string;
  detail: string;
  provider: string;
}

export function compareSnapshots(previous: ReconSnapshot, current: ReconSnapshot): SnapshotChange[] {
  const completeSources = new Set(Object.values(current.providers).filter((provider) => provider.status === 'complete').map((provider) => provider.provider));
  const previousEvidence = new Map(previous.evidence.map((item) => [item.id, item]));
  const currentEvidence = new Map(current.evidence.map((item) => [item.id, item]));
  const changes: SnapshotChange[] = [];
  for (const item of current.evidence) {
    if (!previousEvidence.has(item.id) && completeSources.has(item.provider) && previous.providers[item.provider]?.status === 'complete') {
      changes.push({ kind: 'new', label: item.normalizedValue ?? item.evidenceType, detail: `Newly observed by ${item.provider}`, provider: item.provider });
    } else if (previousEvidence.has(item.id) && completeSources.has(item.provider) && previous.providers[item.provider]?.status === 'complete') {
      const prior = previousEvidence.get(item.id)!;
      if (JSON.stringify(prior.details) !== JSON.stringify(item.details)) {
        changes.push({ kind: 'changed', label: item.normalizedValue ?? item.evidenceType, detail: `Evidence details changed in ${item.provider}`, provider: item.provider });
      }
    }
  }
  for (const item of previous.evidence) {
    if (!currentEvidence.has(item.id) && completeSources.has(item.provider) && previous.providers[item.provider]?.status === 'complete') {
      changes.push({ kind: 'notObserved', label: item.normalizedValue ?? item.evidenceType, detail: `Not observed in this snapshot; this does not prove removal`, provider: item.provider });
    }
  }
  return changes.sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));
}

