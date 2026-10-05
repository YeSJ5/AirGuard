import { create } from 'zustand';
import type { Flight, AlertLog, IngestionPayload, User } from '../types';
import { aircraftMotionManager } from '../services/aircraftMotionManager';
import { isObservedField } from '../utils/dataQuality';
import { detectorStatusFromRisk, displayableRisk } from '../utils/detectorStatus';

export interface AirGuardState {
  flights: Flight[];
  selectedFlightId: string | null;
  alerts: AlertLog[];
  activeAlertCount: number;
  backendHealth: 'online' | 'degraded' | 'offline' | 'checking';
  websocketStatus: 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
  activeFilter: 'all' | 'suspicious' | 'critical';
  currentTier: 'tier1_overview' | 'tier2_investigation' | 'tier3_tools';
  tier3Tab: 'models' | 'threats' | 'playback' | 'config' | 'admin' | 'story' | 'analytics';
  showcaseMode: boolean;
  soundEnabled: boolean;
  currentUser: User | null;
  token: string | null;

  setFlights: (flights: Flight[]) => void;
  setAlerts: (alerts: AlertLog[], activeCount?: number) => void;
  updateFlightStatus: (icao24: string, score: number) => void;
  updateOrAddFlight: (payload: IngestionPayload) => void;
  updateOrAddFlights: (payloads: IngestionPayload[]) => void;
  setSelectedFlightId: (id: string | null) => void;
  setBackendHealth: (status: 'online' | 'degraded' | 'offline' | 'checking') => void;
  setWebsocketStatus: (status: 'connecting' | 'connected' | 'disconnected' | 'reconnecting') => void;
  setActiveFilter: (filter: 'all' | 'suspicious' | 'critical') => void;
  setCurrentTier: (tier: 'tier1_overview' | 'tier2_investigation' | 'tier3_tools') => void;
  setTier3Tab: (tab: 'models' | 'threats' | 'playback' | 'config' | 'admin' | 'story' | 'analytics') => void;
  setShowcaseMode: (enabled: boolean) => void;
  setSoundEnabled: (enabled: boolean) => void;
  addAlert: (alert: AlertLog) => void;
  acknowledgeAlert: (id: string) => void;
  setUser: (user: User | null) => void;
  setToken: (token: string | null) => void;
  logout: () => void;
}

function loadSavedUser(): User | null {
  if (typeof window === 'undefined') return null;
  try {
    return JSON.parse(localStorage.getItem('airguard_user') || 'null') as User | null;
  } catch {
    return null;
  }
}

// Reuse the lookup for an immutable flight snapshot. WebSocket batches replace
// the array after each update, so this keeps repeated batches from re-indexing
// every unchanged aircraft. Weak keys bound the cache to live snapshots.
const flightIndexes = new WeakMap<Flight[], Map<string, number>>();

function applyAircraftUpdates(flights: Flight[], payloads: IngestionPayload[]): Flight[] {
  if (payloads.length === 0) return flights;
  const next = [...flights];
  const indexById = flightIndexes.get(flights) ?? new Map(next.map((flight, index) => [flight.id, index]));

  for (const payload of payloads) {
    if (payload.is_synthetic || payload.source === 'regional_fallback' || payload.source === 'simulation') continue;
    const existingIndex = indexById.get(payload.icao24);
    const existing = existingIndex === undefined ? undefined : next[existingIndex];
    const incomingTime = payload.received_at ? Date.parse(payload.received_at) : Number.NaN;
    const existingTime = existing?.received_at ? Date.parse(existing.received_at) : Number.NaN;
    if (Number.isFinite(incomingTime) && Number.isFinite(existingTime) && incomingTime < existingTime) continue;
    const altitude = isObservedField(payload.data_quality, 'altitude') && Number.isFinite(payload.altitude_m)
      ? Math.round(payload.altitude_m * 3.28084) : Number.NaN;
    const speed = isObservedField(payload.data_quality, 'velocity') && Number.isFinite(payload.velocity_ms)
      ? Math.round(payload.velocity_ms * 1.94384) : Number.NaN;
    const heading = isObservedField(payload.data_quality, 'heading') && Number.isFinite(payload.heading_deg)
      ? Math.round(payload.heading_deg) : Number.NaN;
    const risk = displayableRisk(payload.combined_risk_score, payload.assessment_status);
    const status: Flight['status'] = payload.is_alert_triggered ? 'critical' : detectorStatusFromRisk(risk, payload.assessment_status);
    const receivedAtMs = payload.received_at ? Date.parse(payload.received_at) : Number.NaN;
    const observedAge = Number.isFinite(receivedAtMs)
      ? Math.max(0, (Date.now() - receivedAtMs) / 1000)
      : payload.last_seen_seconds_ago;
    const lastSeenSeconds = Number.isFinite(observedAge) ? observedAge! : (existing?.last_seen_seconds_ago ?? 0);

    aircraftMotionManager.updatePosition({
      icao24: payload.icao24,
      lat: payload.latitude,
      lng: payload.longitude,
      altitudeFt: Number.isFinite(altitude) ? altitude : 0,
      headingDeg: Number.isFinite(heading) ? heading : 0,
      speedKnots: Number.isFinite(speed) ? speed : 0,
      durationSec: 8
    });

    const calcTrust = payload.trust_score !== undefined && payload.trust_score !== null && Number.isFinite(payload.trust_score)
      ? Math.round(payload.trust_score)
      : (typeof risk === 'number' && Number.isFinite(risk) ? Math.round((1 - risk) * 100) : Number.NaN);

    const updated: Flight = {
      ...(existing || {} as Flight),
      id: payload.icao24,
      received_at: payload.received_at || existing?.received_at,
      callsign: payload.callsign || existing?.callsign || `AC-${payload.icao24.toUpperCase()}`,
      squawk: isObservedField(payload.data_quality, 'squawk') ? payload.squawk ?? null : null,
      altitude,
      speed,
      heading,
      verticalRate: isObservedField(payload.data_quality, 'vertical_rate') ? payload.vertical_rate_ms : undefined,
      trustScore: calcTrust,
      trust_score: Number.isFinite(calcTrust) ? calcTrust : null,
      combined_risk_score: risk,
      evidence_confidence: payload.evidence_confidence,
      assessment_status: payload.assessment_status,
      status,
      lat: payload.latitude,
      lng: payload.longitude,
      is_synthetic: false,
      source: payload.source || existing?.source || 'source_unavailable',
      route: payload.route || existing?.route || 'Route unknown',
      history: existing ? [...(existing.history || []).slice(-19), { lat: existing.lat, lng: existing.lng }] : [],
      last_seen_seconds_ago: lastSeenSeconds,
      staleness_status: payload.staleness_status || existing?.staleness_status || 'STALE',
      data_quality: payload.data_quality
    };

    if (existingIndex === undefined) {
      indexById.set(updated.id, next.length);
      next.push(updated);
    } else {
      next[existingIndex] = updated;
    }
  }
  flightIndexes.set(next, indexById);
  return next;
}

function loadSavedFlights(): Flight[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem('airguard_last_known_flights');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed as Flight[];
    }
  } catch (e) {
    console.warn("Could not load persisted flights snapshot:", e);
  }
  return [];
}

function saveFlightsSnapshot(flights: Flight[]): void {
  if (typeof window === 'undefined' || !flights || flights.length === 0) return;
  try {
    const lightweight = flights.slice(0, 15000).map(f => ({
      id: f.id,
      callsign: f.callsign,
      squawk: f.squawk,
      lat: f.lat,
      lng: f.lng,
      altitude: f.altitude,
      speed: f.speed,
      heading: f.heading,
      verticalRate: f.verticalRate,
      trustScore: f.trustScore,
      trust_score: f.trust_score,
      combined_risk_score: f.combined_risk_score,
      evidence_confidence: f.evidence_confidence,
      assessment_status: f.assessment_status,
      status: f.status,
      source: f.source,
      route: f.route,
      received_at: f.received_at,
      last_seen_seconds_ago: f.last_seen_seconds_ago,
      staleness_status: f.staleness_status,
      data_quality: f.data_quality,
    }));
    localStorage.setItem('airguard_last_known_flights', JSON.stringify(lightweight));
  } catch (e) {
    // Silent quota fallback
  }
}

export const useAirGuardStore = create<AirGuardState>((set) => ({
  flights: loadSavedFlights(),
  selectedFlightId: null,
  alerts: [],
  activeAlertCount: 0,
  backendHealth: 'checking',
  websocketStatus: 'connecting',
  activeFilter: 'all',
  currentTier: 'tier1_overview',
  tier3Tab: 'threats',
  showcaseMode: false,
  soundEnabled: false,
  currentUser: loadSavedUser(),
  token: typeof window !== 'undefined' ? localStorage.getItem('airguard_token') : null,

  setFlights: (flights) => {
    if (!flights || flights.length === 0) {
      // Preserve previously tracked flights if an empty batch arrives
      return;
    }
    const state = useAirGuardStore.getState();
    const currentById = new Map(state.flights.map(flight => [flight.id, flight]));
    const incomingById = new Map<string, Flight>();
    for (const flight of flights) {
      const current = currentById.get(flight.id);
      const candidateTime = flight.received_at ? Date.parse(flight.received_at) : Number.NaN;
      const currentTime = current?.received_at ? Date.parse(current.received_at) : Number.NaN;
      incomingById.set(flight.id, current && Number.isFinite(candidateTime) && Number.isFinite(currentTime) && currentTime > candidateTime ? current : flight);
    }
    const merged = [...incomingById.values()];
    const activeIcaos = new Set(merged.map(f => f.id));
    aircraftMotionManager.prune(activeIcaos);
    saveFlightsSnapshot(merged);
    set({ flights: merged });
  },

  setAlerts: (alerts, activeCount) => set((state) => {
    const mergedById = new Map<string, AlertLog>();
    for (const alert of [...alerts, ...state.alerts]) mergedById.set(alert.id, alert);
    const merged = [...mergedById.values()].sort((a, b) => Date.parse(b.detected_at || b.timestamp) - Date.parse(a.detected_at || a.timestamp)).slice(0, 3000);
    return { alerts: merged, ...(activeCount !== undefined ? { activeAlertCount: activeCount } : {}) };
  }),

  updateFlightStatus: (icao24, score) => set((state) => {
    const updated = state.flights.map((f: Flight) => {
      if (f.id.toLowerCase() === icao24.toLowerCase() || f.callsign.toLowerCase() === icao24.toLowerCase()) {
        const status: 'normal' | 'suspicious' | 'critical' = score >= 0.8 ? 'critical' : score >= 0.65 ? 'suspicious' : 'normal';
        const trust = typeof score === 'number' && Number.isFinite(score) ? Math.round((1.0 - score) * 100) : Number.NaN;
        return { ...f, trustScore: trust, trust_score: Number.isFinite(trust) ? trust : null, status, combined_risk_score: score };
      }
      return f;
    });
    return { flights: updated };
  }),

  updateOrAddFlight: (payload) => set((state) => {
    const updated = applyAircraftUpdates(state.flights, [payload]);
    saveFlightsSnapshot(updated);
    return { flights: updated };
  }),
  updateOrAddFlights: (payloads) => set((state) => {
    const updated = applyAircraftUpdates(state.flights, payloads);
    saveFlightsSnapshot(updated);
    return { flights: updated };
  }),

  setSelectedFlightId: (id) => set({ selectedFlightId: id }),
  setBackendHealth: (backendHealth) => set({ backendHealth }),
  setWebsocketStatus: (websocketStatus) => set({ websocketStatus }),
  setActiveFilter: (activeFilter) => set({ activeFilter }),
  setCurrentTier: (currentTier) => set({ currentTier }),
  setTier3Tab: (tier3Tab) => set({ tier3Tab }),
  setShowcaseMode: (showcaseMode) => set({ showcaseMode }),
  setSoundEnabled: (soundEnabled) => set({ soundEnabled }),

  addAlert: (alert) => set((state) => {
    if (state.alerts.some((a: AlertLog) => a.id === alert.id || (a.icao24 === alert.icao24 && a.timestamp === alert.timestamp))) {
      return state;
    }
    return { alerts: [alert, ...state.alerts.slice(0, 2999)], activeAlertCount: state.activeAlertCount + (alert.acknowledged ? 0 : 1) };
  }),

  acknowledgeAlert: (id) => set((state) => {
    const wasUnacknowledged = state.alerts.some((a) => a.id === id && !a.acknowledged);
    const updated = state.alerts.map((a: AlertLog) => a.id === id ? { ...a, acknowledged: true } : a);
    return { alerts: updated, activeAlertCount: Math.max(0, state.activeAlertCount - (wasUnacknowledged ? 1 : 0)) };
  }),

  setUser: (currentUser) => {
    if (typeof window !== 'undefined') {
      if (currentUser) {
        localStorage.setItem('airguard_user', JSON.stringify(currentUser));
      } else {
        localStorage.removeItem('airguard_user');
      }
    }
    set({ currentUser });
  },

  setToken: (token) => {
    if (typeof window !== 'undefined') {
      if (token) {
        localStorage.setItem('airguard_token', token);
      } else {
        localStorage.removeItem('airguard_token');
      }
    }
    set({ token });
  },

  logout: () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('airguard_token');
      localStorage.removeItem('airguard_user');
    }
    set({ currentUser: null, token: null, currentTier: 'tier1_overview' });
  }
}));
