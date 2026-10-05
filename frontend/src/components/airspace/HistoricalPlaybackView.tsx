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
type SidebarTab = 'targets' | 'telemetry';

const localDateTime = (date: Date) => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};

// Haversine distance in km
const computeDistanceKm = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const getAirlineName = (callsign?: string | null): string => {
  if (!callsign) return 'Unknown Operator';
  const prefix = callsign.trim().slice(0, 3).toUpperCase();
  const airlines: Record<string, string> = {
    IGO: 'IndiGo (India)',
    AIC: 'Air India',
    SEJ: 'SpiceJet (India)',
    VTI: 'Vistara (India)',
    AKJ: 'Akasa Air (India)',
    AXB: 'Air India Express',
    GOW: 'Go First (India)',
    LLR: 'Alliance Air (India)',
    UAE: 'Emirates',
    ETD: 'Etihad Airways',
    QTR: 'Qatar Airways',
    SIA: 'Singapore Airlines',
    BAW: 'British Airways',
    DLH: 'Lufthansa',
    AFR: 'Air France',
    KLM: 'KLM Royal Dutch',
    THA: 'Thai Airways',
    MAS: 'Malaysia Airlines',
    CPA: 'Cathay Pacific',
    FDX: 'FedEx Express',
    UPS: 'UPS Airlines'
  };
  return airlines[prefix] || 'Commercial / General Aviation';
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
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('targets');
  const [searchFilter, setSearchFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'flagged' | 'nominal'>('all');
  const [isFollowing, setIsFollowing] = useState(true);
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

  // Compute flights for current frame time with full trajectory for the selected target
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

      const isThisSelected = track[0].record.icao24 === selectedId;

      // Retain active position within a 35-minute observation envelope for historical playback
      if (frameTime - track[index].time > 35 * 60_000 && !isThisSelected) continue;

      // Full continuous history for selected aircraft across the entire window
      const pointStart = isThisSelected ? 0 : Math.max(0, index - 119);
      const trail = track.slice(pointStart, index + 1).map(({ lat, lng }) => ({ lat, lng }));
      snapshot.push(asFlight(track[index].record, trail));
    }
    return snapshot;
  }, [frameTime, tracksByAircraft, selectedId]);

  const selectedFlight = useMemo(() => {
    return flights.find((flight) => flight.id === selectedId) ?? null;
  }, [flights, selectedId]);

  // All historical waypoints for the currently selected aircraft
  const selectedAircraftTrackPoints = useMemo(() => {
    if (!selectedId) return [];
    return tracksByAircraft.get(selectedId) || [];
  }, [selectedId, tracksByAircraft]);

  // Trajectory stats for selected aircraft
  const trajectoryStats = useMemo(() => {
    if (selectedAircraftTrackPoints.length === 0) return null;
    let totalDistKm = 0;
    let maxAltM = 0;
    let maxSpeedMs = 0;

    for (let i = 0; i < selectedAircraftTrackPoints.length; i++) {
      const p = selectedAircraftTrackPoints[i];
      if (p.record.altitude_m && p.record.altitude_m > maxAltM) maxAltM = p.record.altitude_m;
      if (p.record.velocity_ms && p.record.velocity_ms > maxSpeedMs) maxSpeedMs = p.record.velocity_ms;
      if (i > 0) {
        const prev = selectedAircraftTrackPoints[i - 1];
        totalDistKm += computeDistanceKm(prev.lat, prev.lng, p.lat, p.lng);
      }
    }

    const firstTime = new Date(selectedAircraftTrackPoints[0].time);
    const lastTime = new Date(selectedAircraftTrackPoints[selectedAircraftTrackPoints.length - 1].time);

    return {
      totalDistKm: Math.round(totalDistKm),
      totalDistNm: Math.round(totalDistKm * 0.539957),
      maxAltFt: Math.round(maxAltM * 3.28084),
      maxSpeedKt: Math.round(maxSpeedMs * 1.94384),
      pointsCount: selectedAircraftTrackPoints.length,
      firstTimeStr: firstTime.toISOString().slice(11, 19) + ' UTC',
      lastTimeStr: lastTime.toISOString().slice(11, 19) + ' UTC'
    };
  }, [selectedAircraftTrackPoints]);

  // Filtered aircraft list for sidebar
  const filteredAircraftList = useMemo(() => {
    const list = Array.from(tracksByAircraft.entries()).map(([icao24, track]) => {
      const latestPoint = track[track.length - 1];
      const flightObj = asFlight(latestPoint.record, []);
      return {
        icao24,
        callsign: flightObj.callsign,
        airline: getAirlineName(flightObj.callsign),
        status: flightObj.status,
        trustScore: flightObj.trustScore,
        altitude: flightObj.altitude,
        speed: flightObj.speed,
        lat: flightObj.lat,
        lng: flightObj.lng,
        pointsCount: track.length
      };
    });

    return list.filter((item) => {
      if (statusFilter === 'flagged' && item.status !== 'critical' && item.status !== 'suspicious') return false;
      if (statusFilter === 'nominal' && (item.status === 'critical' || item.status === 'suspicious')) return false;
      if (!searchFilter) return true;
      const q = searchFilter.toLowerCase().trim();
      return (
        item.callsign.toLowerCase().includes(q) ||
        item.icao24.toLowerCase().includes(q) ||
        item.airline.toLowerCase().includes(q)
      );
    });
  }, [tracksByAircraft, searchFilter, statusFilter]);

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
      const real = data.filter(
        (record) => !record.is_synthetic && record.source !== 'regional_fallback' && record.source !== 'simulation'
      );

      setRecords(real);
      setTruncated(response.headers.get('X-Is-Truncated') === 'true');

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

  const jumpToTrackPointTime = (targetTimestamp: number) => {
    if (timeline.length === 0) return;
    let bestIdx = 0;
    let minDiff = Infinity;
    for (let i = 0; i < timeline.length; i++) {
      const diff = Math.abs(timeline[i] - targetTimestamp);
      if (diff < minDiff) {
        minDiff = diff;
        bestIdx = i;
      }
    }
    setIsPlaying(false);
    setSelectedTime(bestIdx);
  };

  const handleSelectFlightFromList = (flightId: string) => {
    setSelectedId(flightId);
    setSidebarTab('telemetry');
    setIsSidebarOpen(true);
  };

  const frameDate = frameTime !== undefined ? new Date(frameTime) : null;
  const frameLabelLocal = frameDate ? frameDate.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }) : 'No frame selected';
  const frameLabelUtc = frameDate ? frameDate.toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '';

  return (
    <section className="flex h-full flex-1 flex-col min-h-0 overflow-hidden rounded-2xl border border-white/10 bg-[#080d18] shadow-2xl relative" aria-label="Recorded aircraft playback">
      {/* Top Playback Toolbar (Time Presets + Custom Datetime + Sidebar Toggle) */}
      <header className="flex flex-wrap items-center justify-between gap-2.5 border-b border-white/[.08] px-4 py-2.5 bg-[#0a101d] shrink-0 z-20">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="flex h-2.5 w-2.5 rounded-full bg-cyan-400 animate-pulse" />
            <span className="text-xs font-mono font-bold uppercase tracking-wider text-cyan-300">
              PLAYBACK ENGINE
            </span>
          </div>

          {/* Quick Presets */}
          <div className="flex items-center rounded-lg border border-white/10 bg-[#060a12] p-0.5">
            {(['1h', '3h', '6h', '12h', '24h', 'all'] as const).map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => applyPreset(preset)}
                className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                  activePreset === preset
                    ? 'bg-cyan-500 text-slate-950 shadow-sm font-bold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {preset === 'all' ? 'All (48h)' : `Past ${preset}`}
              </button>
            ))}
          </div>
        </div>

        {/* Datetime Form & Sidebar Trigger */}
        <div className="flex items-center gap-2">
          <form onSubmit={handleFormSubmit} className="hidden lg:flex items-center gap-2">
            <label className="flex items-center gap-1 text-xs text-slate-400">
              <span className="text-[10px] uppercase font-mono font-semibold text-slate-500">From</span>
              <input
                aria-label="History start"
                type="datetime-local"
                value={start}
                onChange={(event) => setStart(event.target.value)}
                className="rounded-lg border border-white/10 bg-[#0b1422] px-2 py-1 text-xs text-slate-200 outline-none focus:border-cyan-500"
              />
            </label>
            <label className="flex items-center gap-1 text-xs text-slate-400">
              <span className="text-[10px] uppercase font-mono font-semibold text-slate-500">To</span>
              <input
                aria-label="History end"
                type="datetime-local"
                value={end}
                onChange={(event) => setEnd(event.target.value)}
                className="rounded-lg border border-white/10 bg-[#0b1422] px-2 py-1 text-xs text-slate-200 outline-none focus:border-cyan-500"
              />
            </label>
            <button
              type="submit"
              disabled={isLoading}
              className="rounded-lg bg-cyan-500 px-3 py-1 text-xs font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-wait disabled:opacity-60 cursor-pointer"
            >
              {isLoading ? 'Fetching…' : 'Load Slice'}
            </button>
          </form>

          {/* Toggle Sidebar Button */}
          <button
            type="button"
            onClick={() => setIsSidebarOpen((v) => !v)}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all flex items-center gap-1.5 cursor-pointer ${
              isSidebarOpen
                ? 'bg-cyan-500/20 border-cyan-400/50 text-cyan-200'
                : 'bg-white/5 hover:bg-white/10 border-white/10 text-slate-300'
            }`}
            title={isSidebarOpen ? 'Hide Replay Sidebar' : 'Show Replay Sidebar'}
          >
            <span>☰</span>
            <span className="hidden sm:inline">Playback Sidebar</span>
            <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-black/40 text-cyan-300">
              {filteredAircraftList.length}
            </span>
          </button>
        </div>
      </header>

      {/* Error & Status Banners */}
      {error && (
        <div role="alert" className="border-b border-rose-500/30 bg-rose-950/40 px-4 py-2 text-xs text-rose-200 flex items-center justify-between shrink-0 z-20">
          <span>⚠ {error}</span>
          <button
            type="button"
            onClick={() => void fetchHistoricalData(start, end)}
            className="text-xs underline text-rose-300 hover:text-white cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}
      {truncated && (
        <div role="status" className="border-b border-amber-500/20 bg-amber-950/30 px-4 py-1 text-[11px] text-amber-200 shrink-0 z-20">
          Showing maximum 50,000 observations slice for this range.
        </div>
      )}

      {/* Main Workspace (Map + Collapsible Playback Sidebar) */}
      <div className="relative flex-1 min-h-0 w-full overflow-hidden flex">
        {/* Airspace Map Canvas */}
        <div className="flex-1 h-full min-h-0 relative">
          {records.length > 0 ? (
            <AirspaceMap
              flights={flights}
              selectedFlight={selectedFlight}
              onSelectFlight={(flight) => {
                setSelectedId(flight?.id ?? null);
                if (flight) {
                  setSidebarTab('telemetry');
                  setIsSidebarOpen(true);
                }
              }}
              onOpenFlightDetails={(flight) => {
                setSelectedId(flight.id);
                setSidebarTab('telemetry');
                setIsSidebarOpen(true);
              }}
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
                    className="rounded-lg bg-cyan-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-300 cursor-pointer"
                  >
                    Load Past 6 Hours
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Dedicated Playback Sidebar */}
        {isSidebarOpen && (
          <aside className="w-80 sm:w-[380px] bg-[#080d18]/95 backdrop-blur-xl border-l border-white/10 flex flex-col h-full z-[400] shadow-2xl animate-in slide-in-from-right duration-200 overflow-hidden shrink-0">
            {/* Sidebar Navigation Tabs */}
            <div className="flex items-center justify-between border-b border-white/10 bg-[#0b1424] px-3 py-2 shrink-0">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setSidebarTab('targets')}
                  className={`px-3 py-1 text-xs font-semibold rounded-lg transition-colors cursor-pointer ${
                    sidebarTab === 'targets'
                      ? 'bg-cyan-500 text-slate-950 font-bold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Aircraft ({filteredAircraftList.length})
                </button>
                <button
                  type="button"
                  onClick={() => setSidebarTab('telemetry')}
                  disabled={!selectedFlight}
                  className={`px-3 py-1 text-xs font-semibold rounded-lg transition-colors cursor-pointer disabled:opacity-40 ${
                    sidebarTab === 'telemetry'
                      ? 'bg-cyan-500 text-slate-950 font-bold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Target Details
                </button>
              </div>

              <button
                type="button"
                onClick={() => setIsSidebarOpen(false)}
                className="p-1 text-slate-400 hover:text-white rounded hover:bg-white/10 transition cursor-pointer"
                title="Collapse sidebar"
              >
                ✕
              </button>
            </div>

            {/* TAB 1: ALL REPLAY AIRCRAFT LIST */}
            {sidebarTab === 'targets' && (
              <div className="flex flex-col flex-1 min-h-0">
                {/* Search & Filter Controls */}
                <div className="p-3 border-b border-white/[0.08] space-y-2 bg-[#060a12]/80 shrink-0">
                  <div className="relative">
                    <input
                      type="search"
                      value={searchFilter}
                      onChange={(e) => setSearchFilter(e.target.value)}
                      placeholder="Search callsign, ICAO, or airline…"
                      className="w-full rounded-lg border border-white/10 bg-[#0b1422] px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 outline-none focus:border-cyan-500"
                    />
                    {searchFilter && (
                      <button
                        type="button"
                        onClick={() => setSearchFilter('')}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white text-xs"
                      >
                        ✕
                      </button>
                    )}
                  </div>

                  {/* Threat filter pills */}
                  <div className="flex items-center gap-1 text-[10px] font-mono">
                    {(['all', 'flagged', 'nominal'] as const).map((filter) => (
                      <button
                        key={filter}
                        type="button"
                        onClick={() => setStatusFilter(filter)}
                        className={`px-2 py-0.5 rounded capitalize transition cursor-pointer ${
                          statusFilter === filter
                            ? 'bg-slate-700 text-white font-bold'
                            : 'bg-white/5 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {filter}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Scrollable Aircraft List */}
                <div className="flex-1 overflow-y-auto p-2 space-y-1.5 text-xs">
                  {filteredAircraftList.length === 0 ? (
                    <div className="p-6 text-center text-slate-500 text-xs">
                      No matching aircraft in this playback slice.
                    </div>
                  ) : (
                    filteredAircraftList.map((ac) => {
                      const isSelected = ac.icao24 === selectedId;
                      const isFlagged = ac.status === 'critical' || ac.status === 'suspicious';

                      return (
                        <button
                          key={ac.icao24}
                          type="button"
                          onClick={() => handleSelectFlightFromList(ac.icao24)}
                          className={`w-full text-left p-2.5 rounded-xl border transition-all flex items-center justify-between gap-2 cursor-pointer ${
                            isSelected
                              ? 'bg-cyan-950/70 border-cyan-400 shadow-md ring-1 ring-cyan-500/50'
                              : isFlagged
                              ? 'bg-rose-950/30 hover:bg-rose-950/50 border-rose-500/40'
                              : 'bg-[#0b1424]/80 hover:bg-white/5 border-white/[0.08]'
                          }`}
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span
                                className={`w-2 h-2 rounded-full shrink-0 ${
                                  ac.status === 'critical'
                                    ? 'bg-rose-400 animate-pulse'
                                    : ac.status === 'suspicious'
                                    ? 'bg-amber-400'
                                    : 'bg-emerald-400'
                                }`}
                              />
                              <span className="font-bold text-slate-100 truncate text-xs">
                                {ac.callsign}
                              </span>
                              <span className="text-[10px] font-mono text-slate-500">
                                ({ac.icao24})
                              </span>
                            </div>
                            <span className="text-[11px] text-slate-400 truncate block mt-0.5">
                              {ac.airline}
                            </span>
                          </div>

                          <div className="text-right font-mono shrink-0">
                            <span className="text-xs text-slate-200 block font-semibold">
                              {ac.altitude.toLocaleString()} ft
                            </span>
                            <span className="text-[10px] text-cyan-300/80 block">
                              {ac.pointsCount} fixes
                            </span>
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}

            {/* TAB 2: SELECTED AIRCRAFT TELEMETRY & TRAJECTORY */}
            {sidebarTab === 'telemetry' && selectedFlight && (
              <div className="flex flex-col flex-1 min-h-0 overflow-y-auto p-3.5 space-y-3 text-xs">
                {/* Header Card */}
                <div className="bg-[#0b1424] border border-cyan-500/30 p-3 rounded-xl shadow-lg">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-ping inline-block" />
                        <span className="text-[10px] font-mono text-cyan-300 font-bold uppercase tracking-widest">
                          TRACKED TARGET
                        </span>
                      </div>
                      <h3 className="text-base font-bold text-white mt-0.5">
                        {selectedFlight.callsign}{' '}
                        <span className="text-xs font-mono font-normal text-slate-400">({selectedFlight.id})</span>
                      </h3>
                      <span className="text-xs text-cyan-300 block">
                        {getAirlineName(selectedFlight.callsign)}
                      </span>
                    </div>

                    <span
                      className={`text-[9px] font-mono font-bold px-2 py-0.5 rounded border ${
                        selectedFlight.status === 'critical'
                          ? 'bg-rose-950 text-rose-300 border-rose-500'
                          : selectedFlight.status === 'suspicious'
                          ? 'bg-amber-950 text-amber-300 border-amber-500'
                          : 'bg-emerald-950 text-emerald-300 border-emerald-500'
                      }`}
                    >
                      {selectedFlight.status.toUpperCase()}
                    </span>
                  </div>

                  {/* Follow Mode Toggle */}
                  <div className="mt-3 pt-2.5 border-t border-white/10 flex items-center justify-between">
                    <span className="text-[11px] text-slate-300 font-medium">Auto-Follow Camera:</span>
                    <button
                      type="button"
                      onClick={() => setIsFollowing((v) => !v)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
                        isFollowing
                          ? 'bg-cyan-500 text-slate-950'
                          : 'bg-white/10 text-slate-400 hover:text-white'
                      }`}
                    >
                      {isFollowing ? '◉ Following Active' : '○ Follow OFF'}
                    </button>
                  </div>
                </div>

                {/* Exact High-Precision GPS Coordinates */}
                <div className="bg-[#0b1424] border border-white/[0.08] p-3 rounded-xl">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[10px] text-slate-400 font-mono uppercase font-bold">
                      Exact Geographic Position
                    </span>
                    <span className="text-[9px] font-mono bg-cyan-950 text-cyan-300 px-1.5 py-0.5 rounded border border-cyan-800">
                      5-DECIMAL GPS
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 font-mono">
                    <div className="bg-black/40 p-2 rounded-lg border border-white/5">
                      <span className="text-[10px] text-slate-500 block">LATITUDE</span>
                      <span className="text-xs font-bold text-slate-100">
                        {selectedFlight.lat.toFixed(5)}° {selectedFlight.lat >= 0 ? 'N' : 'S'}
                      </span>
                    </div>
                    <div className="bg-black/40 p-2 rounded-lg border border-white/5">
                      <span className="text-[10px] text-slate-500 block">LONGITUDE</span>
                      <span className="text-xs font-bold text-slate-100">
                        {selectedFlight.lng.toFixed(5)}° {selectedFlight.lng >= 0 ? 'E' : 'W'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Physical Flight Vectors */}
                <div className="grid grid-cols-2 gap-2 font-mono">
                  <div className="bg-[#0b1424] border border-white/[0.08] p-2.5 rounded-xl">
                    <span className="text-[10px] text-slate-400 uppercase block">Altitude</span>
                    <span className="text-sm font-bold text-slate-100 mt-0.5 block">
                      {selectedFlight.altitude.toLocaleString()} FT
                    </span>
                    <span className="text-[9px] text-slate-500 block">
                      ({Math.round(selectedFlight.altitude * 0.3048).toLocaleString()} m)
                    </span>
                  </div>

                  <div className="bg-[#0b1424] border border-white/[0.08] p-2.5 rounded-xl">
                    <span className="text-[10px] text-slate-400 uppercase block">Ground Speed</span>
                    <span className="text-sm font-bold text-slate-100 mt-0.5 block">
                      {selectedFlight.speed} KT
                    </span>
                    <span className="text-[9px] text-slate-500 block">
                      ({Math.round(selectedFlight.speed * 1.852)} km/h)
                    </span>
                  </div>

                  <div className="bg-[#0b1424] border border-white/[0.08] p-2.5 rounded-xl">
                    <span className="text-[10px] text-slate-400 uppercase block">True Heading</span>
                    <span className="text-sm font-bold text-slate-100 mt-0.5 block">
                      {Math.round(selectedFlight.heading)}°{' '}
                      <span className="text-cyan-400 text-xs font-bold">
                        {selectedFlight.heading >= 337.5 || selectedFlight.heading < 22.5 ? 'N' :
                         selectedFlight.heading < 67.5 ? 'NE' :
                         selectedFlight.heading < 112.5 ? 'E' :
                         selectedFlight.heading < 157.5 ? 'SE' :
                         selectedFlight.heading < 202.5 ? 'S' :
                         selectedFlight.heading < 247.5 ? 'SW' :
                         selectedFlight.heading < 292.5 ? 'W' : 'NW'}
                      </span>
                    </span>
                  </div>

                  <div className="bg-[#0b1424] border border-white/[0.08] p-2.5 rounded-xl">
                    <span className="text-[10px] text-slate-400 uppercase block">Vertical Rate</span>
                    <span className="text-sm font-bold text-slate-100 mt-0.5 block">
                      {selectedFlight.verticalRate !== undefined
                        ? `${selectedFlight.verticalRate > 0 ? '+' : ''}${Math.round(selectedFlight.verticalRate * 196.85)} FPM`
                        : '0 FPM'}
                    </span>
                  </div>
                </div>

                {/* Trajectory Analytics Summary (Past 1h/3h/6h) */}
                {trajectoryStats && (
                  <div className="bg-[#0b1424] border border-white/[0.08] p-3 rounded-xl space-y-2">
                    <span className="text-[10px] text-slate-400 font-mono uppercase font-bold block">
                      Trajectory Analysis ({activePreset.toUpperCase()} Window)
                    </span>
                    <div className="grid grid-cols-3 gap-2 font-mono text-center">
                      <div className="bg-black/30 p-2 rounded-lg">
                        <span className="text-[9px] text-slate-500 block">DISTANCE</span>
                        <span className="text-xs font-bold text-emerald-400">{trajectoryStats.totalDistNm} NM</span>
                        <span className="text-[9px] text-slate-500">({trajectoryStats.totalDistKm} km)</span>
                      </div>
                      <div className="bg-black/30 p-2 rounded-lg">
                        <span className="text-[9px] text-slate-500 block">MAX ALT</span>
                        <span className="text-xs font-bold text-sky-400">{trajectoryStats.maxAltFt.toLocaleString()} ft</span>
                      </div>
                      <div className="bg-black/30 p-2 rounded-lg">
                        <span className="text-[9px] text-slate-500 block">MAX SPEED</span>
                        <span className="text-xs font-bold text-amber-400">{trajectoryStats.maxSpeedKt} KT</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Interactive Waypoints Log (Click to Jump Scrubber) */}
                <div className="bg-[#0b1424] border border-white/[0.08] p-3 rounded-xl space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-slate-400 font-mono uppercase font-bold">
                      Recorded Waypoints ({selectedAircraftTrackPoints.length})
                    </span>
                    <span className="text-[9px] text-cyan-300 font-mono">
                      Click to scrub playhead
                    </span>
                  </div>

                  <div className="max-h-48 overflow-y-auto space-y-1 pr-1 font-mono text-[10px]">
                    {selectedAircraftTrackPoints.map((pt, idx) => {
                      const ptDate = new Date(pt.time);
                      const timeStr = ptDate.toISOString().slice(11, 19) + ' UTC';
                      const isCurrent = Math.abs(pt.time - (frameTime || 0)) < 15_000;

                      return (
                        <button
                          key={idx}
                          type="button"
                          onClick={() => jumpToTrackPointTime(pt.time)}
                          className={`w-full text-left p-1.5 rounded flex items-center justify-between transition cursor-pointer ${
                            isCurrent
                              ? 'bg-cyan-500/20 border border-cyan-400/50 text-cyan-200 shadow-sm'
                              : 'bg-black/30 hover:bg-white/5 border border-transparent text-slate-300'
                          }`}
                        >
                          <span className="font-bold">{timeStr}</span>
                          <span>{pt.lat.toFixed(3)}°, {pt.lng.toFixed(3)}°</span>
                          <span className="text-slate-400">{Math.round((pt.record.altitude_m || 0) * 3.28084)} ft</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Action: Return to Target List */}
                <button
                  type="button"
                  onClick={() => setSidebarTab('targets')}
                  className="w-full py-2 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 text-xs font-semibold rounded-xl transition cursor-pointer"
                >
                  ← Back to All Aircraft List
                </button>
              </div>
            )}
          </aside>
        )}
      </div>

      {/* Bottom Playback HUD & Scrubber Controls */}
      <footer className="border-t border-white/[.08] bg-[#070b14] px-4 py-2.5 shrink-0 z-20">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Controls: Play/Pause, Steps, Jump, Speed, Loop */}
          <div className="flex items-center gap-1.5 sm:gap-2">
            <button
              type="button"
              disabled={timeline.length < 2}
              onClick={() => {
                setIsPlaying(false);
                setSelectedTime(0);
              }}
              className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-slate-300 hover:bg-white/10 disabled:opacity-40 cursor-pointer"
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
              className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-slate-300 hover:bg-white/10 disabled:opacity-40 cursor-pointer"
              title="Step backwards"
            >
              ◀
            </button>

            <button
              type="button"
              disabled={timeline.length < 2}
              onClick={() => setIsPlaying((v) => !v)}
              className="min-w-20 rounded-lg border border-cyan-400/40 bg-cyan-500/20 px-3 py-1 text-xs font-bold text-cyan-200 hover:bg-cyan-500/30 disabled:opacity-40 cursor-pointer shadow-[0_0_12px_rgba(6,182,212,0.2)]"
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
              className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-slate-300 hover:bg-white/10 disabled:opacity-40 cursor-pointer"
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
              className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-slate-300 hover:bg-white/10 disabled:opacity-40 cursor-pointer"
              title="Jump to latest frame"
            >
              ⏭
            </button>

            {/* Speed Multiplier */}
            <div className="ml-1 flex items-center rounded-lg border border-white/10 bg-[#0c1322] p-0.5">
              {([0.5, 1, 2, 4, 8] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSpeed(s)}
                  className={`px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded cursor-pointer ${
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
              className={`px-2 py-1 text-[11px] font-semibold rounded-lg border cursor-pointer ${
                isLooping
                  ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300'
                  : 'border-white/10 bg-white/5 text-slate-500'
              }`}
              title={isLooping ? 'Auto-loop replay ON' : 'Auto-loop replay OFF'}
            >
              🔁 Loop
            </button>
          </div>

          {/* Timeline Scrubber Slider */}
          <div className="flex flex-1 items-center gap-2 min-w-[240px]">
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
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400 font-mono">
          <div className="flex items-center gap-2">
            <span className="text-cyan-300 font-bold">{frameLabelUtc}</span>
            <span className="text-slate-600">·</span>
            <span className="text-slate-400 text-[11px]">{frameLabelLocal}</span>
          </div>

          <div className="flex items-center gap-2.5">
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
                  {selectedFlight.callsign} ({selectedFlight.lat.toFixed(4)}°, {selectedFlight.lng.toFixed(4)}°)
                </span>
              </>
            )}
          </div>
        </div>
      </footer>
    </section>
  );
};
