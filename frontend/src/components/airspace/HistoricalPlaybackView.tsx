import React, { useEffect, useMemo, useState } from 'react';
import { AirspaceMap } from '../AirspaceMap';
import { API_BASE, fetchWithAuth } from '../../services/api';
import type { Flight } from '../../types';
import { detectorStatusFromRisk, displayableRisk } from '../../utils/detectorStatus';

interface HistoricalState {
  id: number;
  icao24: string;
  callsign?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  altitude_m?: number | null;
  velocity_ms?: number | null;
  heading_deg?: number | null;
  vertical_rate_ms?: number | null;
  received_at: string;
  source?: string | null;
  is_synthetic?: boolean;
  data_quality?: { observed_fields?: string[]; missing_fields?: string[] };
  combined_risk_score?: number | null;
  trust_score?: number | null;
  assessment_status?: string | null;
}

interface IndexedState {
  record: HistoricalState;
  time: number;
  lat: number;
  lng: number;
}

const localDateTime = (date: Date) => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};

const asFlight = (state: HistoricalState, history: Array<{ lat: number; lng: number }>): Flight => ({
  id: state.icao24,
  callsign: state.callsign?.trim() || state.icao24.toUpperCase(),
  lat: Number(state.latitude),
  lng: Number(state.longitude),
  altitude: Number.isFinite(state.altitude_m) ? Math.round((state.altitude_m as number) * 3.28084) : 0,
  speed: Number.isFinite(state.velocity_ms) ? Math.round((state.velocity_ms as number) * 1.94384) : 0,
  heading: Number.isFinite(state.heading_deg) ? (state.heading_deg as number) : 0,
  verticalRate: state.vertical_rate_ms ?? undefined,
  trustScore: Number.isFinite(state.trust_score) ? Math.round(state.trust_score as number) : Number.NaN,
  combined_risk_score: displayableRisk(state.combined_risk_score, state.assessment_status),
  status: detectorStatusFromRisk(state.combined_risk_score, state.assessment_status),
  is_synthetic: false,
  source: state.source ?? undefined,
  staleness_status: 'RECORDED',
  data_quality: state.data_quality,
  history,
});

export const HistoricalPlaybackView: React.FC = () => {
  const [start, setStart] = useState(() => localDateTime(new Date(Date.now() - 6 * 60 * 60_000)));
  const [end, setEnd] = useState(() => localDateTime(new Date()));
  const [records, setRecords] = useState<HistoricalState[]>([]);
  const [selectedTime, setSelectedTime] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  const timeline = useMemo(() => {
    const allTimes = [...new Set(records.map((record) => Date.parse(record.received_at)).filter(Number.isFinite))].sort((a, b) => a - b);
    if (allTimes.length <= 1600) return allTimes;
    const stride = Math.ceil(allTimes.length / 1600);
    const sampled = allTimes.filter((_, index) => index % stride === 0);
    if (sampled.at(-1) !== allTimes.at(-1)) sampled.push(allTimes.at(-1)!);
    return sampled;
  }, [records]);

  const tracksByAircraft = useMemo(() => {
    const tracks = new Map<string, IndexedState[]>();
    for (const record of records) {
      const time = Date.parse(record.received_at);
      const lat = Number(record.latitude);
      const lng = Number(record.longitude);
      if (!Number.isFinite(time) || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
      const track = tracks.get(record.icao24) ?? [];
      track.push({ record, time, lat, lng });
      tracks.set(record.icao24, track);
    }
    for (const track of tracks.values()) track.sort((a, b) => a.time - b.time);
    return tracks;
  }, [records]);

  const frameTime = timeline[Math.min(selectedTime, Math.max(0, timeline.length - 1))];
  const flights = useMemo(() => {
    if (frameTime === undefined) return [];
    const snapshot: Flight[] = [];
    for (const track of tracksByAircraft.values()) {
      let low = 0;
      let high = track.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (track[mid].time <= frameTime) low = mid + 1;
        else high = mid;
      }
      const index = low - 1;
      if (index < 0) continue;
      // A target leaves the frame once its last retained position is more than
      // 30 minutes old; replay must not imply it was still airborne afterward.
      if (frameTime - track[index].time > 30 * 60_000) continue;
      const pointStart = Math.max(0, index - 119);
      const trail = track.slice(pointStart, index + 1).map(({ lat, lng }) => ({ lat, lng }));
      snapshot.push(asFlight(track[index].record, trail));
    }
    return snapshot;
  }, [frameTime, tracksByAircraft]);

  const selectedFlight = flights.find((flight) => flight.id === selectedId) ?? null;

  useEffect(() => {
    if (!isPlaying || timeline.length < 2) return;
    const timer = window.setInterval(() => {
      setSelectedTime((index) => {
        if (index >= timeline.length - 1) {
          setIsPlaying(false);
          return index;
        }
        return index + 1;
      });
    }, 800);
    return () => window.clearInterval(timer);
  }, [isPlaying, timeline.length]);

  const loadHistory = async (event: React.FormEvent) => {
    event.preventDefault();
    const from = new Date(start);
    const to = new Date(end);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
      setError('Choose a valid time range. The start must be earlier than the end.');
      return;
    }
    setIsLoading(true);
    setIsPlaying(false);
    setError(null);
    setRecords([]);
    setSelectedTime(0);
    setSelectedId(null);
    try {
      const query = new URLSearchParams({ start: from.toISOString(), end: to.toISOString(), limit: '50000' });
      const response = await fetchWithAuth(`${API_BASE}/api/v1/aircraft/history?${query}`);
      if (!response.ok) throw new Error(response.status === 401 ? 'Your session has expired. Sign in again to load recorded aircraft history.' : `History request failed (${response.status}).`);
      const data = await response.json() as HistoricalState[];
      const real = data.filter((record) => !record.is_synthetic && record.source !== 'regional_fallback' && record.source !== 'simulation');
      setRecords(real);
      setTruncated(response.headers.get('X-Is-Truncated') === 'true');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load recorded aircraft history.');
    } finally {
      setIsLoading(false);
    }
  };

  const frameLabel = frameTime === undefined ? 'No time selected' : new Date(frameTime).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }) + ' local';

  return <section className="flex min-h-[600px] flex-1 flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#080d18] shadow-2xl" aria-label="Recorded aircraft playback">
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[.08] px-5 py-4">
      <div>
        <p className="m-0 text-[10px] font-semibold uppercase tracking-[.18em] text-cyan-300">Recorded telemetry</p>
        <h2 className="m-0 mt-1 text-lg font-semibold text-slate-100">Aircraft playback</h2>
        <p className="m-0 mt-1 text-xs text-slate-400">Scrub retained aircraft observations from the live feed. Playback does not generate or interpolate positions.</p>
      </div>
      <form onSubmit={loadHistory} className="flex flex-wrap items-end gap-2.5">
        <label className="grid gap-1 text-[10px] font-medium text-slate-400">From <input aria-label="History start" type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} className="rounded-lg border border-white/10 bg-[#0b1422] px-2.5 py-2 text-xs text-slate-200" /></label>
        <label className="grid gap-1 text-[10px] font-medium text-slate-400">To <input aria-label="History end" type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} className="rounded-lg border border-white/10 bg-[#0b1422] px-2.5 py-2 text-xs text-slate-200" /></label>
        <button type="submit" disabled={isLoading} className="rounded-lg bg-cyan-500 px-4 py-2 text-xs font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-wait disabled:opacity-60">{isLoading ? 'Loading…' : 'Load history'}</button>
      </form>
    </header>

    {error && <div role="alert" className="border-b border-rose-500/20 bg-rose-950/20 px-5 py-3 text-xs text-rose-200">{error}</div>}
    {truncated && <div role="status" className="border-b border-amber-500/20 bg-amber-950/15 px-5 py-2 text-[11px] text-amber-200">This range exceeds the 50,000-observation playback limit. Narrow the time range to inspect a complete slice.</div>}

    <div className="relative min-h-[380px] flex-1">
      {records.length > 0 ? <AirspaceMap flights={flights} selectedFlight={selectedFlight} onSelectFlight={(flight) => setSelectedId(flight?.id ?? null)} onOpenFlightDetails={(flight) => setSelectedId(flight.id)} /> :
        <div className="absolute inset-0 grid place-items-center px-6 text-center">
          <div className="max-w-lg rounded-2xl border border-white/[.08] bg-[#0b1422]/90 px-7 py-8 shadow-xl">
            <span className="mx-auto grid h-11 w-11 place-items-center rounded-xl border border-cyan-400/20 bg-cyan-400/[.07] text-xl text-cyan-200">◷</span>
            <h3 className="mb-0 mt-4 text-base font-semibold text-slate-100">{isLoading ? 'Loading stored observations' : 'Choose a time range to begin'}</h3>
            <p className="mb-0 mt-2 text-xs leading-relaxed text-slate-400">{isLoading ? 'Fetching real aircraft reports retained by this AirGuard deployment.' : 'History is available only for observations already collected and retained by the backend. A new or empty deployment may have no records yet.'}</p>
          </div>
        </div>}
    </div>

    <footer className="border-t border-white/[.08] bg-[#090f1a] px-5 py-4">
      <div className="flex flex-wrap items-center gap-4">
        <button type="button" disabled={timeline.length < 2} onClick={() => setIsPlaying((value) => !value)} className="min-w-24 rounded-lg border border-cyan-400/25 bg-cyan-400/[.08] px-3 py-2 text-xs font-semibold text-cyan-100 hover:bg-cyan-400/[.14] disabled:opacity-40">{isPlaying ? 'Pause' : 'Play'}</button>
        <button type="button" disabled={timeline.length < 2} onClick={() => { setIsPlaying(false); setSelectedTime((value) => Math.max(0, value - 1)); }} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-300 disabled:opacity-40" aria-label="Previous recorded time">Previous</button>
        <input aria-label="Playback time" type="range" min={0} max={Math.max(0, timeline.length - 1)} value={Math.min(selectedTime, Math.max(0, timeline.length - 1))} onChange={(event) => { setIsPlaying(false); setSelectedTime(Number(event.target.value)); }} disabled={timeline.length < 2} className="min-w-[180px] flex-1 accent-cyan-400 disabled:opacity-40" />
        <button type="button" disabled={timeline.length < 2} onClick={() => { setIsPlaying(false); setSelectedTime((value) => Math.min(timeline.length - 1, value + 1)); }} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-300 disabled:opacity-40" aria-label="Next recorded time">Next</button>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400"><span className="font-mono text-slate-200">{frameLabel}</span><span>{records.length.toLocaleString()} stored reports · {flights.length.toLocaleString()} aircraft at frame{selectedFlight ? ` · selected ${selectedFlight.callsign}` : ''}</span></div>
    </footer>
  </section>;
};
