import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
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

type PresetWindow = '1h' | '3h' | '6h' | '12h' | '24h' | 'all';
type PlaybackSpeed = 0.5 | 1 | 2 | 4 | 8;

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
  source: state.source ?? 'opensky_live',
  staleness_status: 'RECORDED',
  data_quality: state.data_quality,
  history,
});

export const HistoricalPlaybackView: React.FC = () => {
  const [start, setStart] = useState(() => localDateTime(new Date(Date.now() - 6 * 60 * 60_000)));
  const [end, setEnd] = useState(() => localDateTime(new Date()));
  const [activePreset, setActivePreset] = useState<PresetWindow>('6h');
  const [records, setRecords] = useState<HistoricalState[]>([]);
  const [selectedTime, setSelectedTime] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);
  const [isLooping, setIsLooping] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const initialLoadDone = useRef(false);

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
      // Retain active position within a 35-minute observation envelope for historical playback
      if (frameTime - track[index].time > 35 * 60_000) continue;
      const pointStart = Math.max(0, index - 119);
      const trail = track.slice(pointStart, index + 1).map(({ lat, lng }) => ({ lat, lng }));
      snapshot.push(asFlight(track[index].record, trail));
    }
    return snapshot;
  }, [frameTime, tracksByAircraft]);

  const selectedFlight = useMemo(() => {
    return flights.find((flight) => flight.id === selectedId) ?? null;
  }, [flights, selectedId]);

  // Execute history fetch
  const fetchHistoricalData = useCallback(async (startTimeStr: string, endTimeStr: string) => {
    const from = new Date(startTimeStr);
    const to = new Date(endTimeStr);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
      setError('Choose a valid time range. The start must be earlier than the end.');
      return;
    }
    setIsLoading(true);
    setIsPlaying(false);
    setError(null);
    try {
      const query = new URLSearchParams({
        start: from.toISOString(),
        end: to.toISOString(),
        limit: '50000'
      });
      const response = await fetchWithAuth(`${API_BASE}/api/v1/aircraft/history?${query}`);
      if (!response.ok) {
        throw new Error(
          response.status === 401
            ? 'Your session has expired. Sign in again to load recorded aircraft history.'
            : `History request failed (${response.status}: ${response.statusText}).`
        );
      }
      const data = (await response.json()) as HistoricalState[];
      // Filter out simulated or synthetic noise — only real retained telemetry
      const real = data.filter(
        (record) => !record.is_synthetic && record.source !== 'regional_fallback' && record.source !== 'simulation'
      );
      
      setRecords(real);
      setTruncated(response.headers.get('X-Is-Truncated') === 'true');

      // Set initial playhead to the most recent frame (where all current aircraft are populated)
      if (real.length > 0) {
        const uniqueTimes = [...new Set(real.map((r) => Date.parse(r.received_at)).filter(Number.isFinite))];
        setSelectedTime(Math.max(0, uniqueTimes.length - 1));
      } else {
        setSelectedTime(0);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load recorded aircraft history.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Preset button handler
  const applyPreset = useCallback((preset: PresetWindow) => {
    setActivePreset(preset);
    const now = new Date();
    let pastMs = 6 * 60 * 60_000;
    if (preset === '1h') pastMs = 1 * 60 * 60_000;
    else if (preset === '3h') pastMs = 3 * 60 * 60_000;
    else if (preset === '6h') pastMs = 6 * 60 * 60_000;
    else if (preset === '12h') pastMs = 12 * 60 * 60_000;
    else if (preset === '24h') pastMs = 24 * 60 * 60_000;
    else if (preset === 'all') pastMs = 48 * 60 * 60_000;

    const newStart = localDateTime(new Date(now.getTime() - pastMs));
    const newEnd = localDateTime(now);
    setStart(newStart);
    setEnd(newEnd);
    void fetchHistoricalData(newStart, newEnd);
  }, [fetchHistoricalData]);

  // Auto-load on mount
  useEffect(() => {
    if (!initialLoadDone.current) {
      initialLoadDone.current = true;
      void fetchHistoricalData(start, end);
    }
  }, [fetchHistoricalData, start, end]);

  // Replay animation loop
  useEffect(() => {
    if (!isPlaying || timeline.length < 2) return;
    const intervalMs = Math.max(50, Math.round(600 / speed));
    const timer = window.setInterval(() => {
      setSelectedTime((index) => {
        if (index >= timeline.length - 1) {
          if (isLooping) return 0;
          setIsPlaying(false);
          return index;
        }
        return index + 1;
      });
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [isPlaying, timeline.length, speed, isLooping]);

  const handleFormSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void fetchHistoricalData(start, end);
  };

  const frameDate = frameTime !== undefined ? new Date(frameTime) : null;
  const frameLabelLocal = frameDate ? frameDate.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }) : 'No frame selected';
  const frameLabelUtc = frameDate ? frameDate.toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '';

  return (
    <section className="flex min-h-[650px] flex-1 flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#080d18] shadow-2xl" aria-label="Recorded aircraft playback">
      {/* Header with Preset Range & Custom Time Range Controls */}
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[.08] px-5 py-3.5 bg-[#0a101d]">
        <div className="min-w-[240px]">
          <div className="flex items-center gap-2">
            <span className="flex h-2 w-2 rounded-full bg-cyan-400 animate-pulse" />
            <p className="m-0 text-[10px] font-mono font-bold uppercase tracking-[.18em] text-cyan-300">
              HISTORICAL TELEMETRY REPLAY
            </p>
          </div>
          <h2 className="m-0 mt-0.5 text-base font-bold text-slate-100">Airspace Observation Playback</h2>
          <p className="m-0 text-xs text-slate-400">
            Replay actual past telemetry observations recorded from the live radar feed.
          </p>
        </div>

        {/* Quick Presets + Datetime Form */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Presets */}
          <div className="flex items-center rounded-lg border border-white/10 bg-[#060a12] p-0.5">
            {(['1h', '3h', '6h', '12h', '24h', 'all'] as const).map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => applyPreset(preset)}
                className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${
                  activePreset === preset
                    ? 'bg-cyan-500 text-slate-950 shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {preset === 'all' ? 'All (48h)' : `Past ${preset}`}
              </button>
            ))}
          </div>

          {/* Custom Date Form */}
          <form onSubmit={handleFormSubmit} className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-slate-400">
              <span className="text-[10px] uppercase font-mono font-semibold text-slate-500">From</span>
              <input
                aria-label="History start"
                type="datetime-local"
                value={start}
                onChange={(event) => setStart(event.target.value)}
                className="rounded-lg border border-white/10 bg-[#0b1422] px-2.5 py-1 text-xs text-slate-200 outline-none focus:border-cyan-500"
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-slate-400">
              <span className="text-[10px] uppercase font-mono font-semibold text-slate-500">To</span>
              <input
                aria-label="History end"
                type="datetime-local"
                value={end}
                onChange={(event) => setEnd(event.target.value)}
                className="rounded-lg border border-white/10 bg-[#0b1422] px-2.5 py-1 text-xs text-slate-200 outline-none focus:border-cyan-500"
              />
            </label>
            <button
              type="submit"
              disabled={isLoading}
              className="rounded-lg bg-cyan-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-wait disabled:opacity-60 cursor-pointer"
            >
              {isLoading ? 'Fetching…' : 'Load Slice'}
            </button>
          </form>
        </div>
      </header>

      {/* Status & Alerts */}
      {error && (
        <div role="alert" className="border-b border-rose-500/30 bg-rose-950/40 px-5 py-2.5 text-xs text-rose-200 flex items-center justify-between">
          <span>⚠ {error}</span>
          <button
            type="button"
            onClick={() => void fetchHistoricalData(start, end)}
            className="text-xs underline text-rose-300 hover:text-white"
          >
            Retry
          </button>
        </div>
      )}
      {truncated && (
        <div role="status" className="border-b border-amber-500/20 bg-amber-950/30 px-5 py-1.5 text-[11px] text-amber-200">
          Showing maximum 50,000 observations slice for this range.
        </div>
      )}

      {/* Main Map Playback Viewport */}
      <div className="relative min-h-[420px] flex-1">
        {records.length > 0 ? (
          <AirspaceMap
            flights={flights}
            selectedFlight={selectedFlight}
            onSelectFlight={(flight) => setSelectedId(flight?.id ?? null)}
            onOpenFlightDetails={(flight) => setSelectedId(flight.id)}
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center px-6 text-center">
            <div className="max-w-md rounded-2xl border border-white/[.08] bg-[#0b1422]/95 p-8 shadow-2xl backdrop-blur-md">
              <span className="mx-auto grid h-12 w-12 place-items-center rounded-xl border border-cyan-400/20 bg-cyan-400/[.08] text-2xl text-cyan-300 animate-pulse">
                ◷
              </span>
              <h3 className="mb-1 mt-4 text-base font-semibold text-slate-100">
                {isLoading ? 'Querying past flight telemetry…' : 'No observations found for this slice'}
              </h3>
              <p className="mb-4 text-xs leading-relaxed text-slate-400">
                {isLoading
                  ? 'Reconstructing past airframe positions and track vectors from the database.'
                  : 'Try selecting a different time window using the presets above.'}
              </p>
              {!isLoading && (
                <button
                  type="button"
                  onClick={() => applyPreset('6h')}
                  className="rounded-lg bg-cyan-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-300"
                >
                  Load Past 6 Hours
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Playback Control Bar & Scrubber */}
      <footer className="border-t border-white/[.08] bg-[#070b14] px-5 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          {/* Play/Pause, Jump & Speed Buttons */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={timeline.length < 2}
              onClick={() => {
                setIsPlaying(false);
                setSelectedTime(0);
              }}
              className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/10 disabled:opacity-40"
              title="Jump to first frame"
            >
              ⏮
            </button>

            <button
              type="button"
              disabled={timeline.length < 2}
              onClick={() => {
                setIsPlaying(false);
                setSelectedTime((v) => Math.max(0, v - 1));
              }}
              className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/10 disabled:opacity-40"
              title="Step backwards"
            >
              ◀
            </button>

            <button
              type="button"
              disabled={timeline.length < 2}
              onClick={() => setIsPlaying((v) => !v)}
              className="min-w-20 rounded-lg border border-cyan-400/40 bg-cyan-500/20 px-3 py-1.5 text-xs font-bold text-cyan-200 hover:bg-cyan-500/30 disabled:opacity-40 cursor-pointer shadow-[0_0_12px_rgba(6,182,212,0.2)]"
            >
              {isPlaying ? '⏸ Pause' : '▶ Play'}
            </button>

            <button
              type="button"
              disabled={timeline.length < 2}
              onClick={() => {
                setIsPlaying(false);
                setSelectedTime((v) => Math.min(timeline.length - 1, v + 1));
              }}
              className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/10 disabled:opacity-40"
              title="Step forward"
            >
              ▶
            </button>

            <button
              type="button"
              disabled={timeline.length < 2}
              onClick={() => {
                setIsPlaying(false);
                setSelectedTime(timeline.length - 1);
              }}
              className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/10 disabled:opacity-40"
              title="Jump to latest frame"
            >
              ⏭
            </button>

            {/* Speed Selector */}
            <div className="ml-2 flex items-center rounded-lg border border-white/10 bg-[#0c1322] p-0.5">
              {([0.5, 1, 2, 4, 8] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSpeed(s)}
                  className={`px-2 py-0.5 text-[11px] font-mono font-semibold rounded ${
                    speed === s ? 'bg-cyan-500/30 text-cyan-300' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {s}x
                </button>
              ))}
            </div>

            {/* Loop Toggle */}
            <button
              type="button"
              onClick={() => setIsLooping((v) => !v)}
              className={`px-2 py-1 text-xs font-semibold rounded-lg border ${
                isLooping
                  ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300'
                  : 'border-white/10 bg-white/5 text-slate-500'
              }`}
              title={isLooping ? 'Auto-loop replay ON' : 'Auto-loop replay OFF'}
            >
              🔁 Loop
            </button>
          </div>

          {/* Timeline Scrubber */}
          <div className="flex flex-1 items-center gap-3 min-w-[280px]">
            <input
              aria-label="Playback timeline scrubber"
              type="range"
              min={0}
              max={Math.max(0, timeline.length - 1)}
              value={Math.min(selectedTime, Math.max(0, timeline.length - 1))}
              onChange={(event) => {
                setIsPlaying(false);
                setSelectedTime(Number(event.target.value));
              }}
              disabled={timeline.length < 2}
              className="w-full accent-cyan-400 cursor-pointer disabled:opacity-40 h-2 bg-slate-800 rounded-lg appearance-none"
            />
          </div>
        </div>

        {/* HUD Info Row */}
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400 font-mono">
          <div className="flex items-center gap-2">
            <span className="text-cyan-300 font-bold">{frameLabelUtc}</span>
            <span className="text-slate-600">·</span>
            <span className="text-slate-400 text-[11px]">{frameLabelLocal}</span>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-emerald-400 font-semibold">
              ✈ {flights.length.toLocaleString()} aircraft in frame
            </span>
            <span className="text-slate-600">·</span>
            <span className="text-slate-400 text-[11px]">
              {records.length.toLocaleString()} total observations
            </span>
            {selectedFlight && (
              <>
                <span className="text-slate-600">·</span>
                <span className="text-sky-300 font-bold bg-sky-950/60 border border-sky-500/40 px-2 py-0.5 rounded">
                  Selected: {selectedFlight.callsign} ({selectedFlight.id})
                </span>
              </>
            )}
          </div>
        </div>
      </footer>
    </section>
  );
};
