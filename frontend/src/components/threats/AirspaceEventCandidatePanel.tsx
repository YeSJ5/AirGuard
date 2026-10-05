import React, { useCallback, useEffect, useState } from 'react';
import {
  createAirspaceEventCase,
  fetchAirspaceEventCandidates,
  fetchAirspaceEventCases,
  updateAirspaceEventCase,
  type AirspaceEventCandidate,
  type AirspaceEventCase,
} from '../../services/api';
import { useAirGuardStore } from '../../store/useAirGuardStore';

interface AirspaceEventCandidatePanelProps {
  onInvestigate: (icao24: string) => void;
}

const dispositionLabel: Record<Exclude<AirspaceEventCase['disposition'], null>, string> = {
  CORRELATED: 'Related behavior supported',
  NOT_CORRELATED: 'No relationship found',
  INSUFFICIENT_EVIDENCE: 'Insufficient evidence',
};

export const AirspaceEventCandidatePanel: React.FC<AirspaceEventCandidatePanelProps> = ({ onInvestigate }) => {
  const currentUser = useAirGuardStore(state => state.currentUser);
  const canReview = currentUser?.role === 'analyst' || currentUser?.role === 'admin';
  const [candidates, setCandidates] = useState<AirspaceEventCandidate[]>([]);
  const [cases, setCases] = useState<AirspaceEventCase[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const visibleCandidates = candidates.slice(0, 20);

  const load = useCallback(async () => {
    try {
      const [newCandidates, savedCases] = await Promise.all([
        fetchAirspaceEventCandidates(),
        fetchAirspaceEventCases(),
      ]);
      setCandidates(newCandidates);
      setCases(savedCases);
      setLoadError(null);
    } catch (error) {
      console.error('Failed to load airspace event review data:', error);
      setLoadError(error instanceof Error ? error.message : 'Event review data is unavailable.');
    }
  }, []);

  useEffect(() => {
    let active = true;
    const run = async () => { if (active) await load(); };
    void run();
    const interval = window.setInterval(run, 60_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [load]);

  const runAction = async (key: string, action: () => Promise<unknown>) => {
    setActionError(null);
    setBusyKey(key);
    try {
      await action();
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The case update was not confirmed by the server.');
    } finally {
      setBusyKey(null);
    }
  };

  const openCase = (candidate: AirspaceEventCandidate) => runAction(candidate.candidate_id, async () => {
    await createAirspaceEventCase(candidate, `Airspace review ${candidate.candidate_id.replace('derived-', 'AG-')}`);
  });

  const updateCase = (eventCase: AirspaceEventCase, change: Parameters<typeof updateAirspaceEventCase>[1]) =>
    runAction(`case-${eventCase.id}`, () => updateAirspaceEventCase(eventCase.id, change));

  return (
    <section className="mb-4 rounded-xl border border-cyan-900/50 bg-slate-950/50 p-4" aria-labelledby="airspace-candidates-heading">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id="airspace-candidates-heading" className="text-xs font-bold uppercase tracking-wider text-cyan-200">Airspace event review</h3>
          <p className="mt-1 text-[10px] text-slate-400">Candidates link real stored alerts by position and time. Proximity does not establish a common cause.</p>
        </div>
        <span className="text-[9px] font-mono text-slate-500">30 min · 50 km · review required</span>
      </div>

      {loadError && <p className="mt-3 text-[10px] text-amber-300" role="status">Review data unavailable: {loadError}</p>}
      {actionError && <p className="mt-3 rounded-lg border border-amber-800/60 bg-amber-950/30 p-2 text-[10px] text-amber-200" role="alert">{actionError}</p>}

      <div className="mt-3">
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-300">Derived candidates ({candidates.length})</h4>
        {candidates.length === 0 ? (
          <p className="mt-2 rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-[10px] text-slate-500">No multi-aircraft alert cluster meets this space-time window in the available observations.</p>
        ) : (
          <div className="mt-2 grid max-h-80 gap-2 overflow-y-auto xl:grid-cols-2">
            {visibleCandidates.map(candidate => {
              const existingCase = cases.find(item => item.candidate_id === candidate.candidate_id && item.status !== 'CLOSED');
              const isBusy = busyKey === candidate.candidate_id;
              return (
                <article key={candidate.candidate_id} className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[10px] font-semibold text-slate-200">Candidate {candidate.candidate_id.replace('derived-', 'AG-')}</span>
                    <span className="rounded border border-amber-800/70 px-1.5 py-0.5 text-[8px] font-mono text-amber-300">REVIEW REQUIRED</span>
                  </div>
                  <p className="mt-1.5 text-[10px] text-slate-300">{candidate.aircraft_icao24.length} aircraft · {candidate.alert_ids.length} alerts · {candidate.linked_alert_pairs} proximity links</p>
                  <p className="mt-1 text-[9px] text-slate-500">{new Date(candidate.start_time).toLocaleString()} — {new Date(candidate.end_time).toLocaleTimeString()} · {candidate.center_latitude.toFixed(2)}, {candidate.center_longitude.toFixed(2)}</p>
                  <p className="mt-1 text-[9px] text-slate-400">Evidence types: {candidate.anomaly_types.length ? candidate.anomaly_types.join(', ') : 'not supplied'}</p>
                  <details className="mt-2 text-[9px] text-slate-400">
                    <summary className="cursor-pointer hover:text-cyan-200">Inspect {candidate.evidence.length} source observations</summary>
                    <ul className="mt-1 space-y-1">
                      {candidate.evidence.slice(0, 50).map(item => <li key={item.alert_id}>Alert {item.alert_id} · {item.icao24.toUpperCase()} · {new Date(item.observed_at).toLocaleString()} · {item.source}</li>)}
                      {candidate.evidence.length > 50 && <li>+ {candidate.evidence.length - 50} more records in the evidence snapshot</li>}
                    </ul>
                  </details>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {candidate.aircraft_icao24.map(icao => (
                      <button key={icao} type="button" onClick={() => onInvestigate(icao)} className="rounded border border-slate-700 px-2 py-1 font-mono text-[9px] text-cyan-200 hover:border-cyan-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400">Investigate {icao.toUpperCase()}</button>
                    ))}
                    {canReview && (existingCase ? (
                      <span className="self-center px-2 py-1 text-[9px] text-emerald-300">Case #{existingCase.id} · {existingCase.status.replace('_', ' ')}</span>
                    ) : (
                      <button type="button" disabled={isBusy} onClick={() => void openCase(candidate)} className="rounded border border-cyan-700 bg-cyan-950/50 px-2 py-1 text-[9px] font-semibold text-cyan-200 hover:border-cyan-400 disabled:opacity-50">{isBusy ? 'Opening…' : 'Open investigation case'}</button>
                    ))}
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {!canReview && <p className="mt-2 text-[9px] text-slate-500">An analyst role is required to open or update investigation cases.</p>}
      </div>

      <div className="mt-4 border-t border-slate-800 pt-3">
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-300">Saved investigation cases ({cases.length})</h4>
        {cases.length === 0 ? (
          <p className="mt-2 text-[10px] text-slate-500">No investigation cases have been opened.</p>
        ) : (
          <div className="mt-2 max-h-96 space-y-2 overflow-y-auto">
            {cases.map(eventCase => {
              const isBusy = busyKey === `case-${eventCase.id}`;
              return (
                <article key={eventCase.id} className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h5 className="text-[10px] font-semibold text-slate-200">Case #{eventCase.id} · {eventCase.title}</h5>
                      <p className="mt-1 text-[9px] text-slate-500">{eventCase.evidence_snapshot.aircraft_icao24.length} aircraft · {eventCase.evidence_snapshot.alert_ids.length} alerts · opened {new Date(eventCase.created_at).toLocaleString()}</p>
                    </div>
                    <span className={`rounded border px-2 py-1 text-[9px] font-mono ${eventCase.status === 'CLOSED' ? 'border-slate-700 text-slate-400' : 'border-cyan-800 text-cyan-200'}`}>{eventCase.status.replace('_', ' ')}{eventCase.disposition ? ` · ${eventCase.disposition.replaceAll('_', ' ')}` : ''}</span>
                  </div>
                  <details className="mt-2 text-[9px] text-slate-400">
                    <summary className="cursor-pointer hover:text-cyan-200">Evidence and review history ({eventCase.reviews.length} entries)</summary>
                    <div className="mt-2 space-y-1">
                      <p>Method: {eventCase.evidence_snapshot.correlation_method}; link window {eventCase.evidence_snapshot.time_window_minutes} min / {eventCase.evidence_snapshot.radius_km} km.</p>
                      {eventCase.evidence_snapshot.evidence.slice(0, 50).map(item => <p key={item.alert_id}>Alert {item.alert_id} · {item.icao24.toUpperCase()} · {item.rule_flags.join(', ') || 'rule flags unavailable'} · {item.reason_text}</p>)}
                      {eventCase.evidence_snapshot.evidence.length > 50 && <p>+ {eventCase.evidence_snapshot.evidence.length - 50} more records in the stored snapshot</p>}
                      {eventCase.reviews.map(review => <p key={review.id} className="border-l border-slate-700 pl-2">{new Date(review.created_at).toLocaleString()} · {review.action} · {review.notes || 'No note recorded'}</p>)}
                    </div>
                  </details>
                  {canReview && eventCase.status !== 'CLOSED' && (
                    <div className="mt-3 space-y-2">
                      <textarea value={notes[eventCase.id] || ''} onChange={e => setNotes(previous => ({ ...previous, [eventCase.id]: e.target.value }))} maxLength={4000} placeholder="Record the reasoning for a final disposition (at least 8 characters)." className="w-full rounded-lg border border-slate-700 bg-slate-950 p-2 text-[10px] text-slate-200 placeholder:text-slate-600 focus:border-cyan-600 focus:outline-none" rows={2} />
                      <div className="flex flex-wrap gap-1.5">
                        {eventCase.status === 'OPEN' && <button type="button" disabled={isBusy} onClick={() => void updateCase(eventCase, { status: 'IN_REVIEW', notes: 'Analyst review started.' })} className="rounded border border-slate-700 px-2 py-1 text-[9px] text-slate-300 hover:border-cyan-700 disabled:opacity-50">Start review</button>}
                        {(['CORRELATED', 'NOT_CORRELATED', 'INSUFFICIENT_EVIDENCE'] as const).map(disposition => (
                          <button key={disposition} type="button" disabled={isBusy || (notes[eventCase.id] || '').trim().length < 8} onClick={() => void updateCase(eventCase, { status: 'CLOSED', disposition, notes: notes[eventCase.id]?.trim() })} className="rounded border border-amber-800/70 px-2 py-1 text-[9px] text-amber-200 hover:border-amber-500 disabled:opacity-40">Close: {dispositionLabel[disposition]}</button>
                        ))}
                      </div>
                    </div>
                  )}
                  {canReview && eventCase.status === 'CLOSED' && <button type="button" disabled={isBusy} onClick={() => void updateCase(eventCase, { status: 'OPEN', disposition: null, notes: 'Reopened for further investigation.' })} className="mt-2 rounded border border-slate-700 px-2 py-1 text-[9px] text-slate-300 hover:border-cyan-700 disabled:opacity-50">Reopen case</button>}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
};
