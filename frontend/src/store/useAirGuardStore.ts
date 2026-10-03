import { create } from 'zustand';
import type { Flight, AlertLog, IngestionPayload, User } from '../types';
import { aircraftMotionManager } from '../services/aircraftMotionManager';

export interface AirGuardState {
  flights: Flight[];
  selectedFlightId: string | null;
  alerts: AlertLog[];
  backendHealth: 'online' | 'offline' | 'checking';
  websocketStatus: 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
  activeFilter: 'all' | 'suspicious' | 'critical';
  currentTier: 'tier1_overview' | 'tier2_investigation' | 'tier3_tools';
  tier3Tab: 'models' | 'threats' | 'playback' | 'config' | 'admin' | 'story' | 'analytics';
  showcaseMode: boolean;
  soundEnabled: boolean;
  currentUser: User | null;
  token: string | null;

  setFlights: (flights: Flight[]) => void;
  updateFlightStatus: (icao24: string, score: number) => void;
  updateOrAddFlight: (payload: IngestionPayload) => void;
  setSelectedFlightId: (id: string | null) => void;
  setBackendHealth: (status: 'online' | 'offline' | 'checking') => void;
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

export const useAirGuardStore = create<AirGuardState>((set) => ({
  flights: [],
  selectedFlightId: null,
  alerts: [],
  backendHealth: 'checking',
  websocketStatus: 'connecting',
  activeFilter: 'all',
  currentTier: 'tier1_overview',
  tier3Tab: 'threats',
  showcaseMode: true,
  soundEnabled: false,
  currentUser: typeof window !== 'undefined' && localStorage.getItem('airguard_user') 
    ? JSON.parse(localStorage.getItem('airguard_user') || 'null') 
    : null,
  token: typeof window !== 'undefined' ? localStorage.getItem('airguard_token') : null,

  setFlights: (flights) => {
    const activeIcaos = new Set(flights.map(f => f.id));
    aircraftMotionManager.prune(activeIcaos);
    set({ flights });
  },

  updateFlightStatus: (icao24, score) => set((state) => {
    const updated = state.flights.map((f: Flight) => {
      if (f.id.toLowerCase() === icao24.toLowerCase() || f.callsign.toLowerCase() === icao24.toLowerCase()) {
        const scorePercentage = Math.round(score * 100);
        const status: 'normal' | 'suspicious' | 'critical' = score >= 0.65 ? 'critical' : score >= 0.35 ? 'suspicious' : 'normal';
        return { ...f, trustScore: Math.max(5, 100 - scorePercentage), status, combined_risk_score: score };
      }
      return f;
    });
    return { flights: updated };
  }),

  updateOrAddFlight: (payload: IngestionPayload) => set((state) => {
    const isSynthetic = payload.is_synthetic ?? false;
    if (isSynthetic || payload.source === 'regional_fallback' || payload.source === 'simulation') return state;
    const existingIndex = state.flights.findIndex((f: Flight) => f.id === payload.icao24);
    const altitudeFt = Math.round(payload.altitude_m * 3.28084);
    const speedKnots = Math.round(payload.velocity_ms * 1.94384);
    const trustScore = payload.trust_score != null
      ? payload.trust_score 
      : payload.combined_risk_score != null
        ? Math.max(5, Math.min(100, Math.round((1.0 - payload.combined_risk_score) * 100))) 
        : Number.NaN;

    const status: 'normal' | 'suspicious' | 'critical' = payload.is_alert_triggered 
      ? 'critical' 
      : Number.isFinite(trustScore) && trustScore < 40 ? 'critical' : Number.isFinite(trustScore) && trustScore < 70 ? 'suspicious' : 'normal';

    if (existingIndex >= 0) {
      const existing = state.flights[existingIndex];
      const updatedHistory = [
        ...(existing.history || []).slice(-19),
        { lat: payload.latitude, lng: payload.longitude }
      ];

      const updatedFlight: Flight = {
        ...existing,
        lat: payload.latitude,
        lng: payload.longitude,
        altitude: altitudeFt,
        speed: speedKnots,
        heading: payload.heading_deg,
        verticalRate: payload.vertical_rate_ms,
        trustScore,
        status,
        route: payload.route || existing.route,
        is_synthetic: isSynthetic,
        source: payload.source || existing.source,
        history: updatedHistory,
        combined_risk_score: payload.combined_risk_score
      };

      const newFlights = [...state.flights];
      newFlights[existingIndex] = updatedFlight;
      return { flights: newFlights };
    } else {
      const newFlight: Flight = {
        id: payload.icao24,
        callsign: payload.callsign || `AC-${payload.icao24.toUpperCase()}`,
        altitude: altitudeFt,
        speed: speedKnots,
        heading: payload.heading_deg,
        verticalRate: payload.vertical_rate_ms,
        trustScore,
        status,
        lat: payload.latitude,
        lng: payload.longitude,
        is_synthetic: isSynthetic,
        source: payload.source || 'opensky',
        route: payload.route || 'Route unknown',
        history: [{ lat: payload.latitude, lng: payload.longitude }],
        combined_risk_score: payload.combined_risk_score
      };
      return { flights: [newFlight, ...state.flights] };
    }
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
    // Avoid duplicates
    if (state.alerts.some((a: AlertLog) => a.id === alert.id || (a.icao24 === alert.icao24 && a.timestamp === alert.timestamp))) {
      return state;
    }
    return { alerts: [alert, ...state.alerts.slice(0, 99)] };
  }),

  acknowledgeAlert: (id) => set((state) => {
    const updated = state.alerts.map((a: AlertLog) => a.id === id ? { ...a, acknowledged: true } : a);
    return { alerts: updated };
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
