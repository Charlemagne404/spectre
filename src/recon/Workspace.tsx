import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Ref } from 'react';
import { saveNativeReport } from '../tauri';
import { InfrastructureGraph } from './InfrastructureGraph';
import type { GraphSelection } from './InfrastructureGraph';
import { appendSnapshot, applyReconEvent, compareSnapshots, createInvestigation } from './model';
import type { ProviderReport, ReconInvestigation } from './model';
import { developmentFixture } from './fixture';
import { cancelNativeRecon, nativeReconAvailable, startNativeRecon } from './native';
import { listReconInvestigations, saveReconInvestigation } from './store';

export interface ReconWorkspaceProps {
  active: boolean;
  activating: boolean;
  back: () => void;
  titleRef: Ref<HTMLHeadingElement>;
}

type View = 'graph' | 'evidence' | 'timeline';

const providerNames: Record<string, string> = { dns: 'DNS', rdap: 'RDAP', ct: 'CERTIFICATE TRANSPARENCY', ripestat: 'RIPESTAT' };
const entityNames: Record<string, string> = { domain: 'DOMAIN', hostname: 'HOSTNAME', wildcard: 'WILDCARD', ip: 'IP ADDRESS', prefix: 'PREFIX', asn: 'ASN', nameserver: 'NAMESERVER', mailhost: 'MAIL HOST', registrar: 'REGISTRAR' };

function currentSnapshot(investigation: ReconInvestigation | null) {
  return investigation?.snapshots.at(-1) ?? null;
}

function plain(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  const formatted = JSON.stringify(value, null, 2);
  return formatted.length > 3_000 ? `${formatted.slice(0, 3_000)}…` : formatted;
}

function reportHtml(investigation: ReconInvestigation): string {
  const snapshot = currentSnapshot(investigation);
  const replacements: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (character) => replacements[character]);
  const rows = (snapshot?.evidence ?? []).map((item) => `<tr><td>${escape(item.provider)}</td><td>${escape(item.evidenceType)}</td><td>${escape(item.query)}</td><td>${escape(item.status)}</td><td>${escape(item.normalizedValue ?? item.originalValue ?? '')}</td><td>${escape(item.retrievedAt)}</td><td>${escape(item.sourceRef ?? 'System resolver')}</td><td><pre>${escape(JSON.stringify(item.details, null, 2))}</pre>${escape(item.limitations.join(' '))}</td></tr>`).join('');
  const providers = Object.values(snapshot?.providers ?? {}).map((item) => `<li><strong>${escape(item.provider)}</strong> — ${escape(item.status)}${item.message ? `: ${escape(item.message)}` : ''}</li>`).join('');
  const entityNotes = Object.entries(investigation.entityNotes).filter(([, note]) => note.trim()).map(([id, note]) => `<li><strong>${escape(id)}</strong><p class="note">${escape(note)}</p></li>`).join('');
  const notes = escape(investigation.notes).replace(/\n/g, '<br>');
  const fixtureBanner = investigation.fixture ? '<p><strong>DEVELOPMENT FIXTURE — these are not live observations.</strong></p>' : '';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Spectre RECON — ${escape(investigation.target)}</title><style>body{background:#0b0b0a;color:#e8e8e5;font:14px ui-monospace,monospace;line-height:1.6;margin:36px}h1,h2{color:#edba74;font-weight:500}small,td,th{font-size:12px}table{border-collapse:collapse;width:100%;word-break:break-word}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #383530;padding:8px}th{color:#edba74}code,pre{color:#d7d2c8}.note{white-space:pre-wrap;border-left:2px solid #d49a4a;padding:8px 14px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>SPECTRE / RECON</h1>${fixtureBanner}<p>Target scope: <code>${escape(investigation.target)}</code><br>Registrable domain context: <code>${escape(investigation.registrableDomain)}</code><br>Snapshot captured: ${escape(snapshot?.capturedAt)} · status: ${escape(snapshot?.status)}</p><h2>Source status</h2><ul>${providers}</ul><h2>Observed entities (${snapshot?.entities.length ?? 0})</h2><ul>${(snapshot?.entities ?? []).map((entity) => `<li><strong>${escape(entity.kind)}</strong> — ${escape(entity.label)}</li>`).join('')}</ul><h2>Relationships (${snapshot?.relationships.length ?? 0})</h2><ul>${(snapshot?.relationships ?? []).map((relationship) => `<li>${escape(relationship.from)} → ${escape(relationship.label)} → ${escape(relationship.to)} · evidence ${escape(relationship.evidenceIds.join(', '))}</li>`).join('')}</ul><h2>Evidence (${snapshot?.evidence.length ?? 0})</h2><table><thead><tr><th>Provider</th><th>Type</th><th>Query</th><th>Status</th><th>Value</th><th>Retrieved</th><th>Source</th><th>Details / limitations</th></tr></thead><tbody>${rows}</tbody></table><h2>Investigation notes</h2><p class="note">${notes || 'No notes.'}</p><h2>Selection notes</h2><ul>${entityNotes || '<li>No selection notes.</li>'}</ul><p><small>Passive public-data collection. Historical certificate names do not establish current resolution or ownership. RIPE routing relationships do not establish domain ownership.</small></p></html>`;
}

function safeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'investigation';
}

async function saveTextFile(name: string, contents: string, mime: string): Promise<string> {
  const native = await saveNativeReport(name, contents);
  if (native) return `Saved to ${native}`;
  const objectUrl = URL.createObjectURL(new Blob([contents], { type: mime }));
  const link = document.createElement('a');
  link.href = objectUrl; link.download = name; link.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  return `Downloaded ${name}`;
}

function ProviderLine({ report }: { report: ProviderReport }) {
  return <div className={`recon-provider-line status-${report.status}`} title={report.message ?? undefined}>
    <span className="recon-provider-dot" aria-hidden="true" />
    <span>{providerNames[report.provider] ?? report.provider.toUpperCase()}</span>
    <strong>{String(report.status).toUpperCase()}</strong>
  </div>;
}

export function ReconWorkspace({ active, activating, back, titleRef }: ReconWorkspaceProps) {
  const [nativeAvailable, setNativeAvailable] = useState(false);
  const [targetInput, setTargetInput] = useState('');
  const [investigation, setInvestigation] = useState<ReconInvestigation | null>(null);
  const [saved, setSaved] = useState<ReconInvestigation[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [view, setView] = useState<View>('graph');
  const [selection, setSelection] = useState<GraphSelection | null>(null);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [entityFilter, setEntityFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [fitVersion, setFitVersion] = useState(0);
  const [comparisonId, setComparisonId] = useState('');
  const investigationRef = useRef<ReconInvestigation | null>(null);
  const jobRef = useRef<string | null>(null);
  const lastSequence = useRef(0);
  const saveTimer = useRef<number | undefined>(undefined);

  const replaceInvestigation = useCallback((next: ReconInvestigation | null, persist = false) => {
    investigationRef.current = next;
    setInvestigation(next);
    if (!next || next.fixture || !persist) return;
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void saveReconInvestigation(next).then(() => listReconInvestigations()).then(setSaved)
        .catch((error: unknown) => setStatusMessage(error instanceof Error ? error.message : 'Could not save this investigation locally.'));
      saveTimer.current = undefined;
    }, 180);
  }, []);

  const refreshSaved = useCallback(() => {
    void listReconInvestigations().then(setSaved).catch((error: unknown) => setStatusMessage(error instanceof Error ? error.message : 'Could not read local investigations.'));
  }, []);

  useEffect(() => {
    setNativeAvailable(nativeReconAvailable());
    refreshSaved();
    return () => {
      if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
      const running = jobRef.current;
      if (running) void cancelNativeRecon(running).catch(() => undefined);
      const latest = investigationRef.current;
      if (latest && !latest.fixture) void saveReconInvestigation(latest).catch(() => undefined);
    };
  }, [refreshSaved]);

  useEffect(() => {
    if (active) return;
    const running = jobRef.current;
    if (!running) return;
    setStatusMessage('Leaving RECON. Active provider requests are being cancelled.');
    void cancelNativeRecon(running).catch((error: unknown) => setStatusMessage(error instanceof Error ? error.message : 'Could not cancel the active RECON job.'));
  }, [active]);

  useEffect(() => {
    if (investigation?.target && !targetInput) setTargetInput(investigation.target);
  }, [investigation, targetInput]);

  const snapshot = currentSnapshot(investigation);
  const evidenceById = useMemo(() => new Map((snapshot?.evidence ?? []).map((item) => [item.id, item])), [snapshot]);
  const relationshipById = useMemo(() => new Map((snapshot?.relationships ?? []).map((item) => [item.id, item])), [snapshot]);
  const entityById = useMemo(() => new Map((snapshot?.entities ?? []).map((item) => [item.id, item])), [snapshot]);
  const isRunning = Boolean(jobId);
  const selectedEntity = selection?.type === 'entity' ? entityById.get(selection.id) : undefined;
  const selectedRelationship = selection?.type === 'relationship' ? relationshipById.get(selection.id) : undefined;
  const selectedEvidence = selectedEvidenceId ? evidenceById.get(selectedEvidenceId) : undefined;

  const sourceEntityIds = useMemo(() => {
    if (sourceFilter === 'all' || !snapshot) return null;
    const ids = new Set<string>();
    for (const relation of snapshot.relationships) {
      const fromProvider = relation.evidenceIds.some((id) => evidenceById.get(id)?.provider === sourceFilter);
      if (fromProvider) { ids.add(relation.from); ids.add(relation.to); }
    }
    for (const evidence of snapshot.evidence) if (evidence.provider === sourceFilter) {
      const related = snapshot.relationships.find((relation) => relation.evidenceIds.includes(evidence.id));
      if (related) { ids.add(related.from); ids.add(related.to); }
    }
    return ids;
  }, [evidenceById, snapshot, sourceFilter]);

  const visibleEntities = useMemo(() => (snapshot?.entities ?? []).filter((entity) => {
    const matchesType = entityFilter === 'all' || entity.kind === entityFilter;
    const matchesSearch = !search.trim() || entity.label.toLowerCase().includes(search.trim().toLowerCase());
    const matchesSource = !sourceEntityIds || entity.kind === 'domain' || sourceEntityIds.has(entity.id);
    return matchesType && matchesSearch && matchesSource;
  }), [entityFilter, search, snapshot, sourceEntityIds]);
  const visibleIds = useMemo(() => new Set(visibleEntities.map((entity) => entity.id)), [visibleEntities]);
  const visibleRelationships = useMemo(() => (snapshot?.relationships ?? []).filter((item) => visibleIds.has(item.from) && visibleIds.has(item.to)), [snapshot, visibleIds]);
  const filteredEvidence = useMemo(() => (snapshot?.evidence ?? []).filter((item) => {
    const matchesSource = sourceFilter === 'all' || item.provider === sourceFilter;
    const query = search.trim().toLowerCase();
    const matchesSearch = !query || [item.query, item.originalValue, item.normalizedValue, item.evidenceType, item.provider].some((value) => value?.toLowerCase().includes(query));
    return matchesSource && matchesSearch;
  }), [search, snapshot, sourceFilter]);

  const handleEvent = useCallback((event: import('./model').ReconEvent) => {
    if (event.jobId !== jobRef.current || event.sequence <= lastSequence.current) return;
    lastSequence.current = event.sequence;
    const current = investigationRef.current;
    if (!current) return;
    const next = applyReconEvent(current, event);
    if (event.entities?.some((entity) => entity.kind === 'domain')) {
      const root = event.entities.find((entity) => entity.kind === 'domain');
      if (root) { next.target = root.label; setTargetInput(root.label); }
    }
    replaceInvestigation(next, true);
    if (event.kind === 'phase') setStatusMessage(event.message ?? `${event.phase.toUpperCase()} · ${event.status ?? 'running'}`);
    if (event.kind === 'provider' && event.message) setStatusMessage(`${providerNames[event.provider ?? ''] ?? event.provider?.toUpperCase()}: ${event.message}`);
    if (event.kind === 'complete') {
      jobRef.current = null;
      setJobId(null);
      setStatusMessage(event.message ?? 'Collection complete.');
      if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
      void saveReconInvestigation(next).then(() => listReconInvestigations()).then(setSaved)
        .catch((error: unknown) => setStatusMessage(error instanceof Error ? error.message : 'Could not save the final snapshot.'));
    }
  }, [replaceInvestigation]);

  const start = useCallback(async () => {
    const requested = targetInput.trim();
    if (!requested || !nativeAvailable || jobRef.current) return;
    const previous = investigationRef.current;
    const sameRecord = previous && !previous.fixture && previous.target.toLowerCase() === requested.toLowerCase();
    const appended = sameRecord && previous ? appendSnapshot(previous) : null;
    const next = appended?.investigation ?? createInvestigation(requested);
    jobRef.current = crypto.randomUUID();
    setJobId(jobRef.current);
    lastSequence.current = 0;
    setStatusMessage('Opening a passive investigation…');
    if (appended?.pruned) setStatusMessage('Starting a new snapshot. The oldest snapshot was removed to keep the 40-snapshot local history limit.');
    setSelection(null);
    setSelectedEvidenceId(null);
    setFitVersion((value) => value + 1);
    replaceInvestigation(next, true);
    try {
      const normalized = await startNativeRecon(jobRef.current, requested, handleEvent);
      const latest = investigationRef.current;
      if (latest?.id === next.id) replaceInvestigation({ ...latest, target: normalized.hostname, registrableDomain: normalized.registrableDomain }, true);
    } catch (error) {
      if (jobRef.current) {
        const latest = investigationRef.current;
        if (latest) {
          const snapshots = [...latest.snapshots];
          snapshots[snapshots.length - 1] = { ...snapshots.at(-1)!, status: 'error' };
          replaceInvestigation({ ...latest, snapshots }, true);
        }
        jobRef.current = null;
        setJobId(null);
      }
      setStatusMessage(error instanceof Error ? error.message : 'Could not start the native investigation.');
    }
  }, [handleEvent, nativeAvailable, replaceInvestigation, targetInput]);

  const cancel = useCallback(() => {
    const running = jobRef.current;
    if (!running) return;
    setStatusMessage('Cancellation requested…');
    void cancelNativeRecon(running).then((cancelled) => {
      if (!cancelled && jobRef.current === running) setStatusMessage('The provider job has already finished.');
    }).catch((error: unknown) => setStatusMessage(error instanceof Error ? error.message : 'Could not cancel the investigation.'));
  }, []);

  const openFixture = useCallback(() => {
    const fixture = developmentFixture();
    setTargetInput(fixture.target);
    setSelection(null);
    setSelectedEvidenceId(null);
    setFitVersion((value) => value + 1);
    replaceInvestigation(fixture, false);
    setStatusMessage('DEVELOPMENT FIXTURE · deterministic example data · not live observations.');
    setView('graph');
  }, [replaceInvestigation]);

  const selectSaved = (id: string) => {
    const record = saved.find((item) => item.id === id);
    if (!record) return;
    replaceInvestigation(record);
    setTargetInput(record.target);
    setSelection(null);
    setSelectedEvidenceId(null);
    setStatusMessage(`Loaded local snapshot from ${new Date(record.updatedAt).toLocaleString()}.`);
  };

  const saveNow = async () => {
    const current = investigationRef.current;
    if (!current || current.fixture) { setStatusMessage('Development fixtures are not saved as live investigations.'); return; }
    try { await saveReconInvestigation(current); refreshSaved(); setStatusMessage('Investigation saved locally on this device.'); }
    catch (error) { setStatusMessage(error instanceof Error ? error.message : 'Could not save the investigation.'); }
  };

  const exportRecord = async (format: 'json' | 'html') => {
    if (!investigation) return;
    try {
      const slug = safeSlug(investigation.target);
      const contents = format === 'json' ? JSON.stringify(investigation, null, 2) : reportHtml(investigation);
      const message = await saveTextFile(`spectre-recon-${slug}.${format}`, contents, format === 'json' ? 'application/json' : 'text/html');
      setStatusMessage(message);
    } catch (error) { setStatusMessage(error instanceof Error ? error.message : 'Report export failed.'); }
  };

  const noteTarget = selectedEvidence?.id ?? selectedRelationship?.id ?? selectedEntity?.id ?? null;
  const noteValue = noteTarget ? investigation?.entityNotes[noteTarget] ?? '' : investigation?.notes ?? '';
  const saveNote = (value: string) => {
    if (!investigation) return;
    const next = noteTarget
      ? { ...investigation, entityNotes: { ...investigation.entityNotes, [noteTarget]: value.slice(0, 12_000) } }
      : { ...investigation, notes: value.slice(0, 20_000) };
    replaceInvestigation(next, true);
  };

  const connectedEvidenceIds = useMemo(() => {
    if (selectedEvidence) return [selectedEvidence.id];
    if (selectedRelationship) return selectedRelationship.evidenceIds;
    if (selectedEntity && snapshot) {
      const relations = snapshot.relationships.filter((relation) => relation.from === selectedEntity.id || relation.to === selectedEntity.id);
      const ids = new Set(relations.flatMap((relation) => relation.evidenceIds));
      snapshot.evidence.filter((item) => item.query === selectedEntity.label).forEach((item) => ids.add(item.id));
      return [...ids];
    }
    return snapshot?.evidence.slice(-8).map((item) => item.id) ?? [];
  }, [selectedEntity, selectedEvidence, selectedRelationship, snapshot]);

  const comparison = investigation?.snapshots.find((item) => item.id === comparisonId)
    ?? investigation?.snapshots.at(-2) ?? null;
  const changes = comparison && snapshot ? compareSnapshots(comparison, snapshot) : [];
  const viewClass = activating ? ' recon-igniting' : '';

  return <main className={`recon-workspace${viewClass}`}>
    <header className="recon-header">
      <div className="recon-identity">
        <button className="recon-back" type="button" onClick={back} aria-label="Back to module launcher">← <span>MODULES</span></button>
        <span className="recon-divider" aria-hidden="true">/</span>
        <div><h1 ref={titleRef} tabIndex={-1}>RECON</h1><span className="recon-subtitle">INFRASTRUCTURE INTELLIGENCE</span></div>
      </div>
      <div className="recon-scope-label"><span className="recon-signal" aria-hidden="true" /> PASSIVE COLLECTION <span>·</span> NO TARGET PROBES</div>
    </header>

    <section className="recon-target-band" aria-label="Investigation controls">
      <label className="recon-target-field"><span>EXPLICIT TARGET SCOPE</span><input aria-label="Domain target" autoCapitalize="none" autoCorrect="off" spellCheck={false}
        placeholder="domain or subdomain" value={targetInput} onChange={(event) => setTargetInput(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void start(); } }} /></label>
      <label className="recon-history-field"><span>LOCAL HISTORY</span><select aria-label="Open saved investigation" value={investigation?.fixture ? 'fixture' : investigation?.id ?? ''} onChange={(event) => selectSaved(event.target.value)}>
        <option value="">Select investigation</option>
        {investigation?.fixture && <option value="fixture">Development fixture · example.com</option>}
        {saved.map((record) => <option key={record.id} value={record.id}>{record.target} · {new Date(record.updatedAt).toLocaleDateString()}</option>)}
      </select></label>
      <div className="recon-run-controls">
        {!isRunning ? <button className="recon-primary" type="button" disabled={!nativeAvailable || !targetInput.trim()} onClick={() => void start()}>
          <span aria-hidden="true">▶</span> {snapshot?.status === 'partial' || snapshot?.status === 'error' ? 'RETRY INVESTIGATION' : snapshot ? 'NEW SNAPSHOT' : 'START INVESTIGATION'}
        </button> : <button className="recon-cancel" type="button" onClick={cancel}>■ CANCEL</button>}
        <button className="recon-quiet" type="button" disabled={!investigation || investigation.fixture} onClick={() => void saveNow()}>SAVE</button>
      </div>
    </section>

    {!nativeAvailable && <div className="recon-mode-note" role="status"><span>PREVIEW MODE</span> Browser preview has no native network access. Start a real investigation in the Spectre desktop app, or load the clearly labeled deterministic fixture.</div>}
    {investigation?.fixture && <div className="recon-fixture-banner" role="status"><strong>DEVELOPMENT FIXTURE</strong><span>These deterministic example observations are not live network results.</span></div>}

    <div className="recon-provider-strip" aria-label="Provider status">
      {['dns', 'rdap', 'ct', 'ripestat'].map((provider) => <ProviderLine key={provider} report={snapshot?.providers[provider] ?? { provider, status: 'queued', message: null, updatedAt: '' }} />)}
      <span className="recon-provider-count">{snapshot?.entities.length ?? 0} ENTITIES <i>·</i> {snapshot?.relationships.length ?? 0} LINKS <i>·</i> {snapshot?.evidence.length ?? 0} EVIDENCE</span>
    </div>

    <div className="recon-layout">
      <section className="recon-main-panel" aria-label="Investigation workspace">
        <div className="recon-view-tabs" role="tablist" aria-label="Investigation view">
          {(['graph', 'evidence', 'timeline'] as const).map((item) => <button key={item} type="button" role="tab" aria-selected={view === item} className={view === item ? 'active' : ''} onClick={() => setView(item)}>{item.toUpperCase()}</button>)}
          <span className="recon-view-caption">{investigation?.target ? `SCOPE / ${investigation.target}` : 'NO TARGET SET'}</span>
        </div>

        {view === 'graph' && <div className="recon-map-view">
          <div className="recon-map-tools">
            <label className="recon-search"><span aria-hidden="true">⌕</span><input aria-label="Search graph entities" placeholder="Find entity" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
            <select aria-label="Filter entity type" value={entityFilter} onChange={(event) => setEntityFilter(event.target.value)}><option value="all">All entities</option>{Object.entries(entityNames).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select>
            <select aria-label="Filter evidence source" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}><option value="all">All sources</option>{Object.keys(providerNames).map((provider) => <option key={provider} value={provider}>{providerNames[provider]}</option>)}</select>
            <button className="recon-icon-control" type="button" onClick={() => setFitVersion((value) => value + 1)}>REFIT</button>
          </div>
          <div className="recon-graph-region">
            <InfrastructureGraph entities={visibleEntities} relationships={visibleRelationships} selection={selection} onSelect={(next) => { setSelection(next); setSelectedEvidenceId(null); }} fitVersion={fitVersion} focusEntityId={selection?.type === 'entity' ? selection.id : undefined} />
            <details className="recon-entity-index">
              <summary>ENTITY INDEX <span>{visibleEntities.length}</span></summary>
              <div className="recon-entity-index-list" role="listbox" aria-label="Graph entities">
                {visibleEntities.slice(0, 500).map((entity) => <button role="option" aria-selected={selection?.type === 'entity' && selection.id === entity.id} key={entity.id} type="button" onClick={() => { setSelection({ type: 'entity', id: entity.id }); setSelectedEvidenceId(null); }}><span>{entityNames[entity.kind] ?? entity.kind}</span><strong>{entity.label}</strong></button>)}
                {visibleEntities.length > 500 && <span className="recon-index-limit">Showing first 500 entities. Use search to narrow the list.</span>}
              </div>
              <div className="recon-index-subtitle">RELATIONSHIP INDEX <span>{visibleRelationships.length}</span></div>
              <div className="recon-entity-index-list" role="listbox" aria-label="Graph relationships">
                {visibleRelationships.slice(0, 500).map((relationship) => <button role="option" aria-selected={selection?.type === 'relationship' && selection.id === relationship.id} key={relationship.id} type="button" onClick={() => { setSelection({ type: 'relationship', id: relationship.id }); setSelectedEvidenceId(null); }}><span>{relationship.kind}</span><strong>{entityById.get(relationship.from)?.label ?? relationship.from} → {relationship.label} → {entityById.get(relationship.to)?.label ?? relationship.to}</strong></button>)}
                {visibleRelationships.length > 500 && <span className="recon-index-limit">Showing first 500 links. Use search to narrow the graph.</span>}
              </div>
            </details>
          </div>
          <div className="recon-activity-line"><span>RECENT EVIDENCE</span><div>{(snapshot?.evidence.slice(-3).reverse() ?? []).map((item) => <button key={item.id} type="button" onClick={() => { setSelectedEvidenceId(item.id); setSelection(null); }}><b>{item.provider.toUpperCase()}</b><span>{item.normalizedValue ?? item.originalValue ?? item.evidenceType}</span></button>)}{!snapshot?.evidence.length && <small>Awaiting provider observations</small>}</div></div>
        </div>}

        {view === 'evidence' && <div className="recon-evidence-view">
          <div className="recon-evidence-toolbar"><span>OBSERVATION LEDGER <b>{filteredEvidence.length}</b></span><label className="recon-evidence-search"><span aria-hidden="true">⌕</span><input aria-label="Search evidence" placeholder="Find value or query" value={search} onChange={(event) => setSearch(event.target.value)} /></label><select aria-label="Filter evidence source" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}><option value="all">All sources</option>{Object.keys(providerNames).map((provider) => <option key={provider} value={provider}>{providerNames[provider]}</option>)}</select><span>QUERY RESULTS KEEP THEIR SOURCE STATUS AND TIME</span></div>
          <div className="recon-evidence-table-wrap"><table className="recon-evidence-table"><thead><tr><th>PROVIDER</th><th>TYPE / QUERY</th><th>OBSERVED VALUE</th><th>STATUS</th><th>RETRIEVED</th></tr></thead><tbody>
            {filteredEvidence.map((item) => <tr key={item.id} className={selectedEvidenceId === item.id ? 'selected' : ''} onClick={() => { setSelectedEvidenceId(item.id); setSelection(null); }} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') { setSelectedEvidenceId(item.id); setSelection(null); } }}>
              <td><span className={`source-chip source-${item.provider}`}>{providerNames[item.provider] ?? item.provider.toUpperCase()}</span></td><td><strong>{item.evidenceType}</strong><small>{item.query}</small></td><td className="evidence-value">{item.normalizedValue ?? item.originalValue ?? plain(item.details)}</td><td><span className={`evidence-status status-${item.status}`}>{item.status}</span></td><td>{new Date(item.retrievedAt).toLocaleString()}</td>
            </tr>)}
            {!filteredEvidence.length && <tr><td colSpan={5} className="recon-empty-row">No observations match the current filters.</td></tr>}
          </tbody></table></div>
        </div>}

        {view === 'timeline' && <div className="recon-timeline-view">
          <div className="recon-snapshot-header"><div><span>SNAPSHOT HISTORY</span><strong>{investigation?.snapshots.length ?? 0} CAPTURE{investigation?.snapshots.length === 1 ? '' : 'S'}</strong></div>
            {investigation && investigation.snapshots.length > 1 && <label>COMPARE WITH <select value={comparison?.id ?? ''} onChange={(event) => setComparisonId(event.target.value)}>{investigation.snapshots.slice(0, -1).map((item) => <option key={item.id} value={item.id}>{new Date(item.capturedAt).toLocaleString()}</option>)}</select></label>}</div>
          {comparison && snapshot && <section className="recon-change-ledger"><h2>OBSERVATION CHANGES</h2><p>Missing results mean “not observed in the latest snapshot”; provider gaps are never treated as proof of removal.</p>
            {changes.length ? changes.slice(0, 300).map((change, index) => <div key={`${change.provider}-${change.label}-${index}`} className={`change-${change.kind}`}><span>{change.kind === 'new' ? 'NEW' : change.kind === 'changed' ? 'CHANGED' : 'NOT OBSERVED'}</span><strong>{change.label}</strong><small>{change.detail}</small></div>) : <div className="recon-no-changes">No comparable source changes were found.</div>}</section>}
          <section className="recon-certificate-timeline"><h2>CERTIFICATE VALIDITY &amp; RETRIEVAL</h2>{(snapshot?.evidence.filter((item) => item.provider === 'ct') ?? []).slice().reverse().map((item) => <div key={item.id} className="certificate-event"><time><span>VALID FROM</span>{String(item.details.validFrom ?? 'not reported')}</time><span className="timeline-marker" /><div><strong>{item.normalizedValue ?? item.originalValue}</strong><small>Valid to {String(item.details.validTo ?? 'not reported')} · {item.status}</small><small>{String(item.details.issuer ?? 'Issuer not reported')} · {item.sourceRef ?? 'Source reference unavailable'}</small><small>Retrieved {new Date(item.retrievedAt).toLocaleString()}; CT log submission time unavailable.</small></div></div>)}{!snapshot?.evidence.some((item) => item.provider === 'ct') && <p className="recon-empty-row">No certificate observations in this snapshot.</p>}</section>
          <div className="recon-snapshot-list">{investigation?.snapshots.slice().reverse().map((item, index) => <article key={item.id}><span className="snapshot-index">{String(investigation.snapshots.length - index).padStart(2, '0')}</span><div><strong>{new Date(item.capturedAt).toLocaleString()}</strong><small>{item.entities.length} entities · {item.evidence.length} observations · {item.status}</small></div><button type="button" onClick={() => setComparisonId(item.id)} disabled={index === 0}>COMPARE</button></article>)}</div>
        </div>}
      </section>

      <aside className="recon-inspector" aria-label="Evidence inspector">
        <div className="recon-inspector-head"><span>INSPECTOR</span><span>{selectedEvidence ? 'OBSERVATION' : selectedRelationship ? 'RELATIONSHIP' : selectedEntity ? entityNames[selectedEntity.kind] ?? 'ENTITY' : investigation ? 'INVESTIGATION' : 'STANDBY'}</span></div>
        {!investigation && <div className="recon-inspector-empty"><span>NO ACTIVE TARGET</span><p>Enter a domain or subdomain to begin a scoped passive investigation.</p></div>}
        {investigation && <>
          <div className="recon-selected-detail">
            {selectedEvidence ? <><small>{providerNames[selectedEvidence.provider] ?? selectedEvidence.provider.toUpperCase()} / {selectedEvidence.evidenceType}</small><h2>{selectedEvidence.normalizedValue ?? selectedEvidence.originalValue ?? selectedEvidence.query}</h2><dl><dt>QUERY</dt><dd>{selectedEvidence.query}</dd><dt>STATUS</dt><dd>{selectedEvidence.status}</dd><dt>RETRIEVED</dt><dd>{new Date(selectedEvidence.retrievedAt).toLocaleString()}</dd>{selectedEvidence.observedAt && <><dt>SOURCE TIME</dt><dd>{selectedEvidence.observedAt}</dd></>}<dt>SOURCE</dt><dd>{selectedEvidence.sourceRef ?? 'System resolver'}</dd><dt>DETAILS</dt><dd><pre>{plain(selectedEvidence.details)}</pre></dd><dt>LIMITATIONS</dt><dd>{selectedEvidence.limitations.join(' ') || 'None reported.'}</dd></dl></>
              : selectedRelationship ? <><small>OBSERVED RELATIONSHIP</small><h2>{selectedRelationship.label}</h2><div className="recon-relation-route"><button type="button" onClick={() => setSelection({ type: 'entity', id: selectedRelationship.from })}>{entityById.get(selectedRelationship.from)?.label ?? selectedRelationship.from}</button><b>→</b><button type="button" onClick={() => setSelection({ type: 'entity', id: selectedRelationship.to })}>{entityById.get(selectedRelationship.to)?.label ?? selectedRelationship.to}</button></div><p>Evidence references attached: {selectedRelationship.evidenceIds.length}.</p></>
                : selectedEntity ? <><small>{entityNames[selectedEntity.kind] ?? selectedEntity.kind.toUpperCase()}</small><h2>{selectedEntity.label}</h2><dl><dt>CANONICAL ID</dt><dd>{selectedEntity.id}</dd>{Object.entries(selectedEntity.attributes).slice(0, 16).map(([key, value]) => <div key={key}><dt>{key.replace(/[A-Z]/g, (letter) => ` ${letter}`).toUpperCase()}</dt><dd>{plain(value)}</dd></div>)}</dl></>
                  : <><small>EXPLICIT TARGET SCOPE</small><h2>{investigation.target}</h2><dl><dt>REGISTRABLE CONTEXT</dt><dd>{investigation.registrableDomain}</dd><dt>SNAPSHOT</dt><dd>{snapshot ? new Date(snapshot.capturedAt).toLocaleString() : '—'}</dd><dt>COLLECTION</dt><dd>{snapshot?.status ?? 'not started'}</dd><dt>ENTITIES</dt><dd>{snapshot?.entities.length ?? 0}</dd><dt>OBSERVATIONS</dt><dd>{snapshot?.evidence.length ?? 0}</dd></dl></>}
          </div>

          <section className="recon-supporting-evidence"><div className="recon-section-label">EVIDENCE / {connectedEvidenceIds.length}</div>
            {connectedEvidenceIds.slice(0, 12).map((id) => {
              const item = evidenceById.get(id); if (!item) return null;
              return <button className="recon-inspector-evidence" key={id} type="button" onClick={() => setSelectedEvidenceId(id)}><span>{item.provider.toUpperCase()} · {item.status}</span><strong>{item.normalizedValue ?? item.originalValue ?? item.evidenceType}</strong><small>{item.limitations[0]}</small></button>;
            })}
            {!connectedEvidenceIds.length && <p className="recon-inspector-muted">No evidence is attached to this selection yet.</p>}
          </section>

          <section className="recon-note-region"><label htmlFor="recon-note">{noteTarget ? 'SELECTION NOTE' : 'INVESTIGATION NOTE'}</label><textarea id="recon-note" aria-label={noteTarget ? 'Selected evidence note' : 'Investigation note'} value={noteValue} onChange={(event) => saveNote(event.target.value)} placeholder="Record a concise investigator note…" /></section>

          <div className="recon-inspector-actions"><button type="button" disabled={!investigation} onClick={() => void exportRecord('json')}>JSON</button><button type="button" disabled={!investigation} onClick={() => void exportRecord('html')}>HTML</button><button type="button" disabled={!investigation || investigation.fixture} onClick={() => void saveNow()}>SAVE LOCAL</button></div>
        </>}
      </aside>
    </div>

    <footer className="recon-footer" role="status"><span className={isRunning ? 'footer-running' : ''}>{isRunning && <i aria-hidden="true" />}{statusMessage || (nativeAvailable ? 'READY · passive providers contact the system resolver and public information services.' : 'READY · browser preview has no native network access.')}</span><button type="button" onClick={openFixture}>OPEN DETERMINISTIC FIXTURE</button><span className="recon-local-mark">LOCAL INVESTIGATION STORE</span></footer>
  </main>;
}

