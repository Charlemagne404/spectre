import { createInvestigation } from './model';
import type { ReconEvidence, ReconEntity, ReconRelationship } from './model';

/** Explicit deterministic UI fixture. It is never used by the live collection path. */
export function developmentFixture(): ReturnType<typeof createInvestigation> {
  const investigation = createInvestigation('example.com');
  investigation.fixture = true;
  const snapshot = investigation.snapshots[0];
  const domainId = 'domain:example.com';
  const dns = 'ns1.example.net';
  const ip = '93.184.216.34';
  const asn = 'AS15133';
  const now = new Date().toISOString();
  const entities: ReconEntity[] = [
    { id: domainId, kind: 'domain', label: 'example.com', attributes: { scope: 'explicitTarget' } },
    { id: `nameserver:${dns}`, kind: 'nameserver', label: dns, attributes: {} },
    { id: `ip:${ip}`, kind: 'ip', label: ip, attributes: { family: 'IPv4', public: true } },
    { id: `asn:${asn}`, kind: 'asn', label: asn, attributes: { number: asn, registry: 'fixture' } },
    { id: 'hostname:status.example.com', kind: 'hostname', label: 'status.example.com', attributes: { evidenceState: 'historicallyObserved', currentResolution: 'unverified' } },
  ];
  const evidence: ReconEvidence[] = [
    { id: 'ev:fixture:dns:ns', provider: 'dns', evidenceType: 'resourceRecord', query: 'example.com', retrievedAt: now, observedAt: null, status: 'observed', sourceRef: null, originalValue: 'ns1.example.net.', normalizedValue: 'ns1.example.net', details: { recordType: 'NS', ttlSeconds: 3600, resolver: 'development fixture' }, limitations: ['Deterministic development fixture; not a live observation.'] },
    { id: 'ev:fixture:dns:a', provider: 'dns', evidenceType: 'resourceRecord', query: 'example.com', retrievedAt: now, observedAt: null, status: 'observed', sourceRef: null, originalValue: ip, normalizedValue: ip, details: { recordType: 'A', ttlSeconds: 300, resolver: 'development fixture' }, limitations: ['Deterministic development fixture; not a live observation.'] },
    { id: 'ev:fixture:ripe', provider: 'ripestat', evidenceType: 'networkInfo', query: ip, retrievedAt: now, observedAt: null, status: 'observed', sourceRef: null, originalValue: ip, normalizedValue: '93.184.216.0/24', details: { prefix: '93.184.216.0/24', asns: [asn] }, limitations: ['Deterministic development fixture; routing relationship is not ownership.'] },
    { id: 'ev:fixture:ct', provider: 'ct', evidenceType: 'certificateName', query: 'example.com', retrievedAt: now, observedAt: null, status: 'historical', sourceRef: null, originalValue: 'status.example.com', normalizedValue: 'status.example.com', details: { certificateId: 'fixture-ct-0042', validFrom: '2024-04-12T00:00:00Z', validTo: '2025-04-12T23:59:59Z', issuer: 'Example Test CA', index: 'fixture' }, limitations: ['Deterministic development fixture; not a live observation.'] },
  ];
  const relationships: ReconRelationship[] = [
    { id: 'rel:fixture:ns', from: domainId, to: `nameserver:${dns}`, kind: 'delegatedTo', label: 'delegated to', evidenceIds: ['ev:fixture:dns:ns'] },
    { id: 'rel:fixture:a', from: domainId, to: `ip:${ip}`, kind: 'resolvesTo', label: 'resolves to', evidenceIds: ['ev:fixture:dns:a'] },
    { id: 'rel:fixture:asn', from: `ip:${ip}`, to: `asn:${asn}`, kind: 'announcedBy', label: 'announced by', evidenceIds: ['ev:fixture:ripe'] },
    { id: 'rel:fixture:ct', from: domainId, to: 'hostname:status.example.com', kind: 'certificateObserved', label: 'certificate observed', evidenceIds: ['ev:fixture:ct'] },
  ];
  snapshot.entities = entities;
  snapshot.relationships = relationships;
  snapshot.evidence = evidence;
  snapshot.status = 'complete';
  snapshot.providers = Object.fromEntries(['dns', 'rdap', 'ct', 'ripestat'].map((provider) => [provider, { provider, status: provider === 'rdap' ? 'unavailable' : 'complete', message: provider === 'rdap' ? 'Fixture contains no registration example.' : null, updatedAt: now }]));
  return investigation;
}

