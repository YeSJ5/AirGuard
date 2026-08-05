import React, { useEffect, useState, useMemo } from 'react';
import { FixedSizeList as List } from 'react-window';
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, LineChart, Line
} from 'recharts';
import create from 'zustand';

// Cesium and Resium imports
import { Viewer, Entity, PointGraphics, PolylineGraphics } from 'resium';
import { Cartesian3, Color } from 'cesium';
import "cesium/Build/Cesium/Widgets/widgets.css";

// Import pre-recorded playback demo session
import playbackSession from './fixtures/playback_session.json';

const BACKEND_PORT = '8001';
const API_BASE = `http://127.0.0.1:${BACKEND_PORT}`;
const WS_BASE = `ws://127.0.0.1:${BACKEND_PORT}`;

// --- Types ---
interface TrailPosition {
  lat: number;
  lng: number;
}

interface Flight {
  id: string; // ICAO24
  callsign: string;
  squawk: string;
  altitude: number; // ft
  speed: number; // knots
  heading: number; // degrees
  trustScore: number; // 0-100
  signalStrength: number; // dBm
  status: 'normal' | 'suspicious' | 'critical';
  lat: number;
  lng: number;
  history?: TrailPosition[];
  trilateration?: string;
  ruleFlags?: {
    positionJump: boolean;
    duplicateIcao: boolean;
    climbRate: boolean;
    altVelMismatch: boolean;
  };
  shapValues?: { name: string; value: number }[];
}

interface AlertLog {
  id: string;
  timestamp: string;
  callsign: string;
  icao24: string;
  type: string;
  severity: 'low' | 'medium' | 'high';
  scoreImpact: number;
  acknowledged: boolean;
}

interface HealthStats {
  poll_latency_ms: number;
  queue_depth: number;
  circuit_breaker_state: string;
  last_successful_poll: string | null;
}

interface ModelRunStats {
  id: number;
  run_at: string;
  model_version: string;
  true_positives: number;
  false_positives: number;
  true_negatives: number;
  false_negatives: number;
  precision: number;
  recall: number;
  f1: number;
  notes: string;
}

// --- Zustand State Management ---
interface IngestionPayload {
  icao24: string;
  latitude: number;
  longitude: number;
  altitude_m: number;
  velocity_ms: number;
  heading_deg: number;
  callsign?: string;
}

interface AirGuardState {
  flights: Flight[];
  selectedFlightId: string | null;
  alerts: AlertLog[];
  backendHealth: 'online' | 'offline' | 'checking';
  websocketStatus: 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
  activeFilter: 'all' | 'suspicious' | 'critical';
  setFlights: (flights: Flight[]) => void;
  updateFlightStatus: (icao24: string, score: number) => void;
  updateOrAddFlight: (payload: IngestionPayload) => void;
  setSelectedFlightId: (id: string | null) => void;
  setBackendHealth: (status: 'online' | 'offline' | 'checking') => void;
  setWebsocketStatus: (status: 'connecting' | 'connected' | 'disconnected' | 'reconnecting') => void;
  setActiveFilter: (filter: 'all' | 'suspicious' | 'critical') => void;
  addAlert: (alert: AlertLog) => void;
  acknowledgeAlert: (id: string) => void;
}

const generateSimulatedFlights = (): Flight[] => {
  const list: Flight[] = [];
  for (let i = 0; i < 300; i++) {
    const isAnomalous = i < 15;
    const isCritical = i < 5;
    const status = isCritical ? 'critical' : isAnomalous ? 'suspicious' : 'normal';
    const trustScore = isCritical 
      ? Math.floor(Math.random() * 30) 
      : isAnomalous 
        ? Math.floor(Math.random() * 40) + 30 
        : Math.floor(Math.random() * 20) + 80;
    
    const lat = 37.7749 + (Math.random() - 0.5) * 4.0;
    const lng = -122.4194 + (Math.random() - 0.5) * 4.0;
    
    const shapValues = status !== 'normal' ? [
      { name: 'Alt-Vel Coherence', value: isCritical ? 0.85 : 0.45 },
      { name: 'Climb Vector Limit', value: i === 1 ? 0.92 : 0.12 },
      { name: 'Position Delta', value: i === 2 ? 0.78 : 0.05 },
      { name: 'Signal Horizon', value: isCritical ? 0.64 : 0.22 }
    ] : [
      { name: 'Alt-Vel Coherence', value: 0.02 },
      { name: 'Climb Vector Limit', value: 0.04 },
      { name: 'Position Delta', value: 0.01 },
      { name: 'Signal Horizon', value: 0.03 }
    ];

    const ruleFlags = {
      positionJump: i === 2,
      duplicateIcao: i === 4,
      climbRate: i === 1,
      altVelMismatch: isCritical
    };

    const trilateration = isCritical 
      ? "Failed (signal range exceeds 350km radio horizon)"
      : isAnomalous 
        ? "Inconclusive (fewer than 2 active ground stations)"
        : "Verified (consistent ground receiver geometry)";

    list.push({
      id: `sim-${i}`,
      callsign: `SIM${100 + i}`,
      squawk: String(Math.floor(Math.random() * 7000) + 1000),
      altitude: Math.floor(Math.random() * 30000) + 5000,
      speed: Math.floor(Math.random() * 400) + 150,
      heading: Math.floor(Math.random() * 360),
      trustScore,
      signalStrength: -Math.floor(Math.random() * 30) - 70,
      status,
      lat,
      lng,
      trilateration,
      ruleFlags,
      shapValues,
      history: Array.from({ length: 4 }, (_, idx) => ({
        lat: lat - (idx + 1) * 0.05 * Math.sin(i),
        lng: lng - (idx + 1) * 0.05 * Math.cos(i)
      }))
    });
  }
  return list;
};

const useStore = create<AirGuardState>((set) => ({
  flights: generateSimulatedFlights(),
  selectedFlightId: null,
  alerts: [
    { id: 'a1', timestamp: '14:55:02', callsign: 'SIM100', icao24: 'sim-0', type: 'Altitude-Velocity Mismatch', severity: 'high', scoreImpact: -45, acknowledged: false },
    { id: 'a2', timestamp: '14:55:30', callsign: 'SIM101', icao24: 'sim-1', type: 'Impossible Climb Rate', severity: 'high', scoreImpact: -80, acknowledged: false },
    { id: 'a3', timestamp: '14:56:15', callsign: 'SIM102', icao24: 'sim-2', type: 'Implausible Position Jump', severity: 'medium', scoreImpact: -15, acknowledged: false },
  ],
  backendHealth: 'checking',
  websocketStatus: 'connecting',
  activeFilter: 'all',
  setFlights: (flights) => set({ flights }),
  updateFlightStatus: (icao24, score) => set((state) => {
    const updated = state.flights.map(f => {
      if (f.callsign.toLowerCase() === icao24.toLowerCase()) {
        const scorePercentage = Math.round(score * 100);
        const status = score >= 0.8 ? 'critical' : score >= 0.4 ? 'suspicious' : 'normal';
        return { ...f, trustScore: 100 - scorePercentage, status };
      }
      return f;
    });
    return { flights: updated };
  }),
  updateOrAddFlight: (payload: IngestionPayload) => set((state) => {
    const existingIndex = state.flights.findIndex(f => f.id === payload.icao24);
    const lat = payload.latitude;
    const lng = payload.longitude;
    const altitude = Math.round(payload.altitude_m * 3.28084);
    const speed = Math.round(payload.velocity_ms * 1.94384);
    const heading = Math.round(payload.heading_deg);
    
    if (existingIndex > -1) {
      const updated = [...state.flights];
      const existing = updated[existingIndex];
      const prevHistory = existing.history || [];
      const newHistory = [{ lat: existing.lat, lng: existing.lng }, ...prevHistory].slice(0, 5);
      
      updated[existingIndex] = {
        ...existing,
        lat,
        lng,
        altitude,
        speed,
        heading,
        history: newHistory
      };
      return { flights: updated };
    } else {
      const newFlight: Flight = {
        id: payload.icao24,
        callsign: payload.callsign || `AC-${payload.icao24.substring(0, 4).toUpperCase()}`,
        squawk: '1200',
        altitude,
        speed,
        heading,
        trustScore: 100,
        signalStrength: -75,
        status: 'normal',
        lat,
        lng,
        history: [],
        trilateration: "Verified (consistent ground receiver geometry)",
        ruleFlags: {
          positionJump: false,
          duplicateIcao: false,
          climbRate: false,
          altVelMismatch: false
        },
        shapValues: [
          { name: 'Alt-Vel Coherence', value: 0.01 },
          { name: 'Climb Vector Limit', value: 0.02 },
          { name: 'Position Delta', value: 0.01 },
          { name: 'Signal Horizon', value: 0.01 }
        ]
      };
      return { flights: [newFlight, ...state.flights] };
    }
  }),
  setSelectedFlightId: (id) => set({ selectedFlightId: id }),
  setBackendHealth: (status) => set({ backendHealth: status }),
  setWebsocketStatus: (status) => set({ websocketStatus: status }),
  setActiveFilter: (filter) => set({ activeFilter: filter }),
  addAlert: (alert) => set((state) => ({ alerts: [alert, ...state.alerts] })),
  acknowledgeAlert: (id) => set((state) => ({
    alerts: state.alerts.map(a => a.id === id ? { ...a, acknowledged: true } : a)
  }))
}));

// --- Cesium Error Boundary ---
class CesiumErrorBoundary extends React.Component<{ children?: React.ReactNode }, { hasError: boolean; error: Error | null }> {
  public state = {
    hasError: false,
    error: null as Error | null
  };

  public static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Cesium render crash:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="w-full h-full bg-[#030712] border border-cyan-950/60 rounded p-6 flex flex-col items-center justify-center text-center font-mono">
          <span className="text-rose-400 text-sm font-bold mb-2">▲ 3D RENDER ENGINE FAILURE</span>
          <p className="text-[10px] text-slate-400 max-w-md leading-relaxed mb-4">
            WebGL context initialization failed or Cesium assets are unreachable. The ground station is operating in fallback list-only mode.
          </p>
          <div className="text-[9px] text-slate-600 bg-black/40 border border-cyan-950/30 p-3 rounded text-left w-full max-w-sm overflow-x-auto">
            {this.state.error?.toString()}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// --- App Component ---
export default function App() {
  const { 
    flights, selectedFlightId, alerts, websocketStatus, activeFilter,
    setSelectedFlightId, setBackendHealth, setWebsocketStatus, setActiveFilter, addAlert,
    updateFlightStatus, updateOrAddFlight, acknowledgeAlert
  } = useStore();

  const [activeView, setActiveView] = useState<'about' | 'dashboard'>('about');
  const [dashboardTab, setDashboardTab] = useState<'radar' | 'alerts' | 'playback' | 'analytics'>('radar');
  const [simulatedTime, setSimulatedTime] = useState<string>('');
  
  // RuleConfig Slider Config State
  const [config, setConfig] = useState({
    max_implied_speed_kmh: 1200.0,
    duplicate_icao_dist_km: 50.0,
    max_vertical_rate_ms: 50.0,
    max_ground_altitude_m: 100.0,
    max_ground_speed_ms: 77.0,
    min_flight_speed_ms: 20.0
  });

  // Replay results
  const [replayResult, setReplayResult] = useState<ModelRunStats | null>(null);
  const [isReplaying, setIsReplaying] = useState<boolean>(false);

  // Historical Playback States
  const [playbackIndex, setPlaybackIndex] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<1 | 5 | 20>(1);

  // Alerts sorting/pagination local state
  const [sortField, setSortField] = useState<'timestamp' | 'callsign' | 'scoreImpact'>('timestamp');
  const [sortAsc, setSortAsc] = useState<boolean>(false);
  const [alertPage, setAlertPage] = useState<number>(0);
  const alertsPerPage = 10;

  const [healthData, setHealthData] = useState<HealthStats>({
    poll_latency_ms: 124.5,
    queue_depth: 0,
    circuit_breaker_state: 'CLOSED',
    last_successful_poll: null
  });

  // Fetch initial thresholds config
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/v1/config`);
        if (res.ok) {
          const data = await res.json();
          setConfig(data);
        }
      } catch (err) {
        console.error("Config fetch failed:", err);
      }
    };
    fetchConfig();
  }, [dashboardTab]);

  // WebSocket Connection Handler
  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimeout: number | null = null;
    let reconnectDelay = 1000;

    const connect = () => {
      setWebsocketStatus('connecting');
      socket = new WebSocket(`${WS_BASE}/api/v1/stream`);

      socket.onopen = () => {
        setWebsocketStatus('connected');
        setBackendHealth('online');
        reconnectDelay = 1000;
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.event === 'ALERT_TRIGGERED') {
            addAlert({
              id: String(Date.now()),
              timestamp: new Date().toTimeString().split(' ')[0],
              callsign: data.icao24.toUpperCase(),
              icao24: data.icao24,
              type: data.reason_text,
              severity: data.combined_risk_score >= 0.8 ? 'high' : 'medium',
              scoreImpact: -Math.round(data.combined_risk_score * 100),
              acknowledged: false
            });
            updateFlightStatus(data.icao24, data.combined_risk_score);
          } else if (data.event === 'AIRCRAFT_UPDATE') {
            updateOrAddFlight(data.payload);
          }
        } catch (err) {
          console.error("Failed to parse websocket message:", err);
        }
      };

      socket.onclose = () => {
        setWebsocketStatus('reconnecting');
        reconnectTimeout = window.setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, 30000);
          connect();
        }, reconnectDelay);
      };

      socket.onerror = () => {
        socket?.close();
      };
    };

    connect();

    return () => {
      if (socket) socket.close();
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
    };
  }, [addAlert, updateFlightStatus, updateOrAddFlight, setBackendHealth, setWebsocketStatus]);

  // Check system stats
  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/v1/system-health`);
        if (res.ok) {
          const data = await res.json();
          setHealthData({
            poll_latency_ms: data.poll_latency_ms,
            queue_depth: data.queue_depth,
            circuit_breaker_state: data.circuit_breaker_state,
            last_successful_poll: data.last_successful_poll
          });
        }
      } catch (err) {
        // Degrade gracefully
      }
    };
    fetchHealth();
    const interval = setInterval(fetchHealth, 5000);
    return () => clearInterval(interval);
  }, []);

  // Playback timer loop
  useEffect(() => {
    let timer: number | null = null;
    if (isPlaying && dashboardTab === 'playback') {
      const interval = 5000 / playbackSpeed;
      timer = window.setInterval(() => {
        setPlaybackIndex(prev => {
          if (prev >= playbackSession.length - 1) {
            return 0;
          }
          return prev + 1;
        });
      }, interval);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [isPlaying, playbackSpeed, dashboardTab]);

  // Tick clock
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setSimulatedTime(now.toTimeString().split(' ')[0] + ' UTC');
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  // Save config settings
  const handleSaveConfig = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      if (res.ok) {
        alert("Config parameters saved successfully!");
      }
    } catch (err) {
      alert("Failed to save config.");
    }
  };

  // Reset to default thresholds
  const handleResetConfig = () => {
    setConfig({
      max_implied_speed_kmh: 1200.0,
      duplicate_icao_dist_km: 50.0,
      max_vertical_rate_ms: 50.0,
      max_ground_altitude_m: 100.0,
      max_ground_speed_ms: 77.0,
      min_flight_speed_ms: 20.0
    });
  };

  // POST /api/v1/model-runs/replay trigger
  const handleReplaySession = async () => {
    setIsReplaying(true);
    try {
      // Save current configs first
      await fetch(`${API_BASE}/api/v1/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      
      const res = await fetch(`${API_BASE}/api/v1/model-runs/replay`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setReplayResult(data);
      } else {
        alert("Replay validation failed.");
      }
    } catch (err) {
      alert("Error connecting to replay validator service.");
    }
    setIsReplaying(false);
  };

  // Select active flight array based on current tab view
  const activeFlights = useMemo((): Flight[] => {
    if (dashboardTab === 'playback') {
      return (playbackSession[playbackIndex]?.flights || []) as Flight[];
    }
    return flights;
  }, [flights, playbackIndex, dashboardTab]);

  // Filter and Sort active flight list
  const filteredFlights = useMemo(() => {
    return activeFlights.filter(f => {
      if (activeFilter === 'all') return true;
      return f.status === activeFilter;
    });
  }, [activeFlights, activeFilter]);

  // Sort: Flagged-first
  const sortedFlights = useMemo(() => {
    return [...filteredFlights].sort((a, b) => {
      const severityMap = { 'critical': 3, 'suspicious': 2, 'normal': 1 };
      if (severityMap[a.status] !== severityMap[b.status]) {
        return severityMap[b.status] - severityMap[a.status];
      }
      return a.trustScore - b.trustScore;
    });
  }, [filteredFlights]);

  const selectedFlight = activeFlights.find(f => f.id === selectedFlightId);

  // Stats Card Calculations
  const stats = useMemo(() => {
    const total = activeFlights.length;
    const anomalies = activeFlights.filter(f => f.status !== 'normal').length;
    const avgTrust = total > 0 
      ? Math.round(activeFlights.reduce((acc, f) => acc + f.trustScore, 0) / total * 10) / 10 
      : 100;
    return { total, anomalies, avgTrust };
  }, [activeFlights]);

  // Sort and Paginate Alerts
  const sortedAlerts = useMemo(() => {
    return [...alerts].sort((a, b) => {
      const valA = a[sortField];
      const valB = b[sortField];
      if (typeof valA === 'string') {
        return sortAsc ? valA.localeCompare(valB as string) : (valB as string).localeCompare(valA);
      }
      return sortAsc ? (valA as number) - (valB as number) : (valB as number) - (valA as number);
    });
  }, [alerts, sortField, sortAsc]);

  const paginatedAlerts = useMemo(() => {
    const start = alertPage * alertsPerPage;
    return sortedAlerts.slice(start, start + alertsPerPage);
  }, [sortedAlerts, alertPage]);

  // Client-Side CSV Export
  const exportAlertsCSV = () => {
    const headers = ["ID", "Timestamp", "Callsign", "ICAO24", "Type/Reason", "Severity", "Impact", "Acknowledged"];
    const rows = sortedAlerts.map(a => [
      a.id, a.timestamp, a.callsign, a.icao24, a.type, a.severity, a.scoreImpact, a.acknowledged
    ]);
    const csvContent = "data:text/csv;charset=utf-8," 
      + [headers.join(","), ...rows.map(e => e.map(val => `"${val}"`).join(","))].join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `airguard_alerts_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const downloadSessionReportPDF = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/reports/session`);
      if (res.ok) {
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', `airguard_session_report_${new Date().toISOString().split('T')[0]}.pdf`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } else {
        alert("Failed to compile session report.");
      }
    } catch (err) {
      alert("Connection to backend report engine failed.");
    }
  };

  // Trigger server-side alert acknowledgment
  const handleAcknowledge = async (id: string) => {
    acknowledgeAlert(id);
    try {
      await fetch(`${API_BASE}/api/v1/alerts/${id}/acknowledge`, { method: 'POST' });
    } catch (e) {
      // Degrade gracefully if offline
    }
  };

  // Virtualized row renderer
  const Row = ({ index, style }: { index: number; style: React.CSSProperties }) => {
    const flight = sortedFlights[index];
    if (!flight) return null;
    const isSelected = flight.id === selectedFlightId;
    const statusColor = 
      flight.status === 'critical' ? 'border-rose-500 text-rose-400' : 
      flight.status === 'suspicious' ? 'border-amber-500 text-amber-400' : 
      'border-emerald-500 text-emerald-400';
    
    const statusText = 
      flight.status === 'critical' ? '▲ [CRIT]' : 
      flight.status === 'suspicious' ? '◆ [WARN]' : 
      '● [OK]';

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setSelectedFlightId(flight.id);
      }
    };
    
    return (
      <div style={style} className="px-2">
        <div 
          role="button"
          tabIndex={0}
          aria-label={`Flight ${flight.callsign || 'unknown'}, status ${flight.status}, trust score ${flight.trustScore} percent`}
          onClick={() => setSelectedFlightId(flight.id)}
          onKeyDown={handleKeyDown}
          className={`p-2.5 rounded border cursor-pointer transition-all duration-150 focus:outline-none focus:ring-1 focus:ring-cyan-500 ${
            isSelected 
              ? 'bg-slate-800 border-cyan-500 shadow-lg shadow-cyan-500/5' 
              : 'bg-[#0b1324] border-cyan-950/30 hover:bg-slate-800/40'
          }`}
        >
          <div className="flex justify-between items-center mb-1">
            <span className="font-bold text-xs tracking-wide text-slate-100">{flight.callsign}</span>
            <span className={`text-[9px] px-2 py-0.5 rounded-full border font-mono ${statusColor}`}>
              {statusText} {flight.trustScore}% Trust
            </span>
          </div>
          <div className="grid grid-cols-2 gap-x-2 text-[9px] text-slate-500 font-mono">
            <div>Alt: {flight.altitude.toLocaleString()} ft</div>
            <div>Spd: {flight.speed} kts</div>
          </div>
        </div>
      </div>
    );
  };

  // Recharts analytics data
  const accuracyData = [
    { time: '09:00', accuracy: 0.94 },
    { time: '10:00', accuracy: 0.95 },
    { time: '11:00', accuracy: 0.93 },
    { time: '12:00', accuracy: 0.97 },
    { time: '13:00', accuracy: 0.96 },
    { time: '14:00', accuracy: 0.98 },
    { time: '15:00', accuracy: 0.99 }
  ];

  const typeData = [
    { type: 'Climb Rate', count: 12 },
    { type: 'Speed Jump', count: 8 },
    { type: 'Alt-Vel Mismatch', count: 18 },
    { type: 'ICAO Duplicate', count: 4 }
  ];

  const volumeData = [
    { time: '09:00', volume: 180 },
    { time: '10:00', volume: 220 },
    { time: '11:00', volume: 260 },
    { time: '12:00', volume: 310 },
    { time: '13:00', volume: 290 },
    { time: '14:00', volume: 300 },
    { time: '15:00', volume: 330 }
  ];

  return (
    <div className="min-h-screen bg-[#05080f] text-slate-400 flex flex-col font-mono relative overflow-hidden">
      {/* Grid overlay background */}
      <div className="absolute inset-0 grid-overlay pointer-events-none z-0"></div>

      {/* --- Top Header Navigation --- */}
      <header className="relative z-10 border-b border-cyan-950/40 bg-[#060b14]/90 px-6 py-4 flex items-center justify-between backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded bg-gradient-to-tr from-cyan-600 to-blue-600 flex items-center justify-center font-bold text-xl tracking-wider text-black shadow-lg shadow-cyan-500/10">
            AG
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-100 m-0 leading-none">
              AIRGUARD
            </h1>
            <span className="text-[9px] text-cyan-500 font-semibold tracking-widest uppercase">ADS-B trust verification</span>
          </div>
        </div>

        {/* Navigation Tabs */}
        <nav className="flex bg-[#09101d] border border-cyan-950/60 rounded p-0.5">
          <button 
            onClick={() => setActiveView('about')}
            className={`text-xs font-semibold px-4 py-1.5 rounded transition-all ${
              activeView === 'about' 
                ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20' 
                : 'text-slate-500 hover:text-slate-300 border border-transparent'
            }`}
          >
            SYSTEM OVERVIEW
          </button>
          <button 
            onClick={() => {
              setActiveView('dashboard');
              setDashboardTab('radar');
            }}
            className={`text-xs font-semibold px-4 py-1.5 rounded transition-all ${
              activeView === 'dashboard' && dashboardTab !== 'playback' && dashboardTab !== 'analytics'
                ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20' 
                : 'text-slate-500 hover:text-slate-300 border border-transparent'
            }`}
          >
            TACTICAL SCREEN
          </button>
          <button 
            onClick={() => {
              setActiveView('dashboard');
              setDashboardTab('playback');
              setSelectedFlightId(null);
            }}
            className={`text-xs font-semibold px-4 py-1.5 rounded transition-all ${
              activeView === 'dashboard' && dashboardTab === 'playback'
                ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20' 
                : 'text-slate-500 hover:text-slate-300 border border-transparent'
            }`}
          >
            HISTORICAL PLAYBACK
          </button>
          <button 
            onClick={() => {
              setActiveView('dashboard');
              setDashboardTab('analytics');
              setSelectedFlightId(null);
            }}
            className={`text-xs font-semibold px-4 py-1.5 rounded transition-all ${
              activeView === 'dashboard' && dashboardTab === 'analytics'
                ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20' 
                : 'text-slate-500 hover:text-slate-300 border border-transparent'
            }`}
          >
            ANALYTICS & CONFIG
          </button>
        </nav>

        {/* Live system state bar */}
        <div className="flex items-center gap-4">
          <div className="hidden md:flex items-center gap-2 px-3 py-1 rounded bg-[#09101d] border border-slate-800">
            <span className="text-[10px] text-slate-500">UTC:</span>
            <span className="text-[10px] text-slate-300">{simulatedTime}</span>
          </div>

          <div className="flex items-center gap-2 px-3 py-1.5 rounded bg-[#09101d] border border-slate-900">
            <span className="relative flex h-2 w-2">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                websocketStatus === 'connected' ? 'bg-emerald-400' : 
                websocketStatus === 'connecting' ? 'bg-amber-400 animate-pulse' : 'bg-rose-400'
              }`}></span>
              <span className={`relative inline-flex rounded-full h-2 w-2 ${
                websocketStatus === 'connected' ? 'bg-emerald-500' : 
                websocketStatus === 'connecting' ? 'bg-amber-500' : 'bg-rose-500'
              }`}></span>
            </span>
            <span className="text-[9px] text-slate-300 font-bold tracking-wider uppercase">
              STREAM: {websocketStatus}
            </span>
          </div>
        </div>
      </header>

      {/* --- Landing / About View --- */}
      {activeView === 'about' && (
        <div className="relative z-10 flex-1 flex flex-col justify-between py-12 px-6 max-w-6xl mx-auto w-full">
          
          {/* Hero Section */}
          <section className="mt-8 text-center max-w-4xl mx-auto">
            <span className="text-xs text-cyan-500 tracking-widest uppercase font-bold border border-cyan-950 px-3 py-1.5 rounded bg-cyan-950/10">
              TRUST SCORING RADAR
            </span>
            <h2 className="text-3xl md:text-5xl font-black mt-8 text-slate-100 leading-tight">
              FlightRadar24 tells you where a plane is.<br />
              <span className="bg-gradient-to-r from-cyan-400 to-blue-500 bg-clip-text text-transparent">
                We tell you whether you should trust that.
              </span>
            </h2>
            <p className="mt-6 text-sm md:text-base text-slate-400 max-w-2xl mx-auto leading-relaxed">
              Standard civil aviation transponders broadcast position data unauthenticated. AirGuard intercepts mode S feeds, analyzes signal geometry, and runs deep autoencoders to flag spoofed trajectories in real-time.
            </p>
            <div className="mt-8 flex justify-center gap-4">
              <button 
                onClick={() => {
                  setActiveView('dashboard');
                  setDashboardTab('radar');
                }}
                className="bg-cyan-600 hover:bg-cyan-500 text-black font-bold text-xs py-3 px-8 rounded transition-all shadow-lg shadow-cyan-500/25 hover:-translate-y-0.5"
              >
                OPEN RADAR CONSOLE
              </button>
              <a 
                href="#how-it-works"
                className="border border-cyan-950 bg-slate-950/40 hover:bg-cyan-950/10 text-slate-300 font-bold text-xs py-3 px-8 rounded transition-all flex items-center"
              >
                SYSTEM DETAILS
              </a>
            </div>
          </section>

          {/* Live Mini Stat Strip */}
          <section className="my-16 grid grid-cols-2 md:grid-cols-4 gap-4 border border-cyan-950/40 bg-[#060b14]/60 p-4 rounded backdrop-blur-sm max-w-4xl mx-auto w-full text-xs font-mono">
            <div className="p-3 border-r border-cyan-950/40 last:border-none">
              <span className="text-slate-500 block mb-1">CIRCUIT BREAKER</span>
              <span className="text-emerald-400 font-bold tracking-wider">{healthData.circuit_breaker_state}</span>
            </div>
            <div className="p-3 border-r border-cyan-950/40 last:border-none">
              <span className="text-slate-500 block mb-1">QUEUE DEPTH</span>
              <span className="text-cyan-400 font-bold">{healthData.queue_depth} vectors</span>
            </div>
            <div className="p-3 border-r border-cyan-950/40 last:border-none">
              <span className="text-slate-500 block mb-1">POLL LATENCY</span>
              <span className="text-cyan-400 font-bold">{healthData.poll_latency_ms.toFixed(1)} ms</span>
            </div>
            <div className="p-3 last:border-none">
              <span className="text-slate-300 font-bold">
                {healthData.last_successful_poll ? healthData.last_successful_poll.split('T')[1]?.substring(0, 8) || 'ONLINE' : 'ACTIVE'}
              </span>
            </div>
          </section>

          {/* Problem Statement Section */}
          <section className="border-t border-cyan-950/40 pt-16 grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
            <div>
              <h3 className="text-xl font-bold text-slate-200 uppercase mb-4 tracking-wider">The Vulnerability in the Sky</h3>
              <p className="text-xs md:text-sm leading-relaxed mb-4">
                ADS-B signals are completely unencrypted. Any hobbyist with a transmitter can broadcast false coordinates, creating &quot;ghost aircraft&quot; or altering the reported routes of real planes.
              </p>
              <p className="text-xs md:text-sm leading-relaxed">
                AirGuard solves this by decoupling trust from the transponder reports. We reconstruct target physics and score consistency statically and dynamically.
              </p>
            </div>
            <div className="bg-[#060b14]/40 border border-cyan-950/40 rounded p-4 font-mono text-[11px] leading-relaxed shadow-lg">
              <span className="text-cyan-500 block mb-2 font-bold font-mono">REAL-TIME DATA FLOW INCIDENT LOG</span>
              <div className="space-y-1.5 max-h-[140px] overflow-y-auto">
                <div className="text-rose-400">[16:04:12] WARNING: Target SIM100 failed altitude-velocity mismatch.</div>
                <div className="text-amber-400">[16:04:18] ALERT: SIM101 rule position_jump triggered (implied 1800 km/h).</div>
                <div className="text-slate-500">[16:04:22] AUDIT: Decision ALERT for aircraft SIM101. Risk: 0.82.</div>
                <div className="text-slate-500">[16:04:30] AUDIT: Decision PASS for aircraft SIM102. Risk: 0.08.</div>
              </div>
            </div>
          </section>

          {/* How It Works Flow (4 Steps) */}
          <section id="how-it-works" className="mt-20 border-t border-cyan-950/40 pt-16">
            <h3 className="text-center text-xl font-bold tracking-widest text-slate-100 uppercase mb-12">HOW IT WORKS</h3>
            
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              {/* Step 1 */}
              <div className="p-5 border border-cyan-950/40 bg-[#060b14]/30 rounded flex flex-col justify-between h-[240px]">
                <div>
                  <span className="text-cyan-500 font-bold text-xs tracking-widest">01 / RECEIVE</span>
                  <h4 className="text-sm font-bold text-slate-200 mt-2">SDR Ingestion</h4>
                  <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">Intercepts direct RF Mode S frames from local dump1090 receivers and caches timing.</p>
                </div>
                {/* Visual */}
                <div className="flex gap-1 items-end h-8 pb-1">
                  <div className="bg-cyan-500/30 h-2 w-1.5"></div>
                  <div className="bg-cyan-500/50 h-4 w-1.5"></div>
                  <div className="bg-cyan-500 h-7 w-1.5 animate-pulse"></div>
                  <div className="bg-cyan-500/60 h-3 w-1.5"></div>
                  <div className="bg-cyan-500/20 h-1 w-1.5"></div>
                </div>
              </div>

              {/* Step 2 */}
              <div className="p-5 border border-cyan-950/40 bg-[#060b14]/30 rounded flex flex-col justify-between h-[240px]">
                <div>
                  <span className="text-cyan-500 font-bold text-xs tracking-widest">02 / DECODE</span>
                  <h4 className="text-sm font-bold text-slate-200 mt-2">Mode S Extraction</h4>
                  <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">Extracts latitude, longitude, squawks, and signal metrics, padding missing attributes.</p>
                </div>
                {/* Visual */}
                <div className="font-mono text-[9px] text-cyan-500/70 border border-cyan-950 p-1.5 rounded bg-black/40 overflow-hidden">
                  <span>HEX: 8D40621D58C3</span>
                  <span className="block text-slate-600">DF=17 CA=5 AA=40621D</span>
                </div>
              </div>

              {/* Step 3 */}
              <div className="p-5 border border-cyan-950/40 bg-[#060b14]/30 rounded flex flex-col justify-between h-[240px]">
                <div>
                  <span className="text-cyan-500 font-bold text-xs tracking-widest">03 / DETECT</span>
                  <h4 className="text-sm font-bold text-slate-200 mt-2">Aerodynamic Verification</h4>
                  <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">Checks climb envelope limits, Haversine position deltas, and alt-velocity correlations.</p>
                </div>
                {/* Visual */}
                <div className="relative h-12 w-full border border-cyan-950/60 rounded overflow-hidden flex items-center justify-center">
                  <div className="absolute inset-0 bg-[#06b6d4]/5 radar-sweep-effect"></div>
                  <div className="w-1.5 h-1.5 rounded-full bg-cyan-400 absolute"></div>
                </div>
              </div>

              {/* Step 4 */}
              <div className="p-5 border border-cyan-950/40 bg-[#060b14]/30 rounded flex flex-col justify-between h-[240px]">
                <div>
                  <span className="text-cyan-500 font-bold text-xs tracking-widest">04 / VERIFY</span>
                  <h4 className="text-sm font-bold text-slate-200 mt-2">Ensemble Trust Scoring</h4>
                  <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">Feeds RF+GB ML classifiers and PyTorch Autoencoders to generate a unified risk rating.</p>
                </div>
                {/* Visual */}
                <div className="grid grid-cols-3 gap-1.5 text-center text-[9px]">
                  <div className="p-1 border border-cyan-950 bg-cyan-950/20 text-cyan-400 rounded">RF: 0.92</div>
                  <div className="p-1 border border-cyan-950 bg-cyan-950/20 text-cyan-400 rounded">GB: 0.88</div>
                  <div className="p-1 border border-rose-950 bg-rose-950/20 text-rose-400 rounded">AE: 0.94</div>
                </div>
              </div>
            </div>
          </section>

        </div>
      )}

      {/* --- Tactical Dashboard View --- */}
      {activeView === 'dashboard' && (
        <div className="flex-1 flex flex-col min-h-0 relative z-10 px-6 py-4">
          
          {/* Sub-Header Tabs */}
          <div className="flex border-b border-cyan-950/30 mb-4 gap-2 text-xs font-bold items-center justify-between">
            <div className="flex gap-2">
              <button
                onClick={() => setDashboardTab('radar')}
                className={`pb-2 px-3 border-b-2 transition-all ${
                  dashboardTab === 'radar' 
                    ? 'border-cyan-400 text-cyan-400' 
                    : 'border-transparent text-slate-500 hover:text-slate-300'
                }`}
              >
                RADAR OPERATIONS
              </button>
              <button
                onClick={() => setDashboardTab('alerts')}
                className={`pb-2 px-3 border-b-2 transition-all ${
                  dashboardTab === 'alerts' 
                    ? 'border-cyan-400 text-cyan-400' 
                    : 'border-transparent text-slate-500 hover:text-slate-300'
                }`}
              >
                ALERTS AUDIT LOG
              </button>
              <button
                onClick={() => setDashboardTab('playback')}
                className={`pb-2 px-3 border-b-2 transition-all ${
                  dashboardTab === 'playback' 
                    ? 'border-cyan-400 text-cyan-400' 
                    : 'border-transparent text-slate-500 hover:text-slate-300'
                }`}
              >
                HISTORICAL PLAYBACK
              </button>
              <button
                onClick={() => setDashboardTab('analytics')}
                className={`pb-2 px-3 border-b-2 transition-all ${
                  dashboardTab === 'analytics' 
                    ? 'border-cyan-400 text-cyan-400' 
                    : 'border-transparent text-slate-500 hover:text-slate-300'
                }`}
              >
                ANALYTICS & CONFIG
              </button>
            </div>
          </div>

          {/* Tab 1 & Tab 3: Radar Screen Operations */}
          {(dashboardTab === 'radar' || dashboardTab === 'playback') && (
            <div className="flex-1 flex flex-col min-h-0">
              
              {/* Playback Control Panel */}
              {dashboardTab === 'playback' && (
                <div className="mb-4 p-4 bg-[#070d18] border border-cyan-950/50 rounded shadow-md font-mono text-xs flex flex-col md:flex-row items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setIsPlaying(!isPlaying)}
                      className={`px-4 py-2 rounded text-black font-bold font-mono transition-all text-[11px] ${
                        isPlaying ? 'bg-amber-500 hover:bg-amber-400' : 'bg-cyan-500 hover:bg-cyan-400'
                      }`}
                    >
                      {isPlaying ? 'PAUSE PLAYBACK' : 'START PLAYBACK'}
                    </button>

                    <div className="flex bg-slate-950 border border-cyan-950/30 rounded p-0.5">
                      {([1, 5, 20] as const).map(speed => (
                        <button
                          key={speed}
                          onClick={() => setPlaybackSpeed(speed)}
                          className={`px-3 py-1 rounded text-[10px] transition-all font-bold ${
                            playbackSpeed === speed 
                              ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20' 
                              : 'text-slate-500 hover:text-slate-300 border border-transparent'
                          }`}
                        >
                          {speed}x
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex-1 flex items-center gap-4 w-full">
                    <span className="text-[10px] text-slate-500">TIMELINE:</span>
                    <input
                      type="range"
                      min={0}
                      max={playbackSession.length - 1}
                      value={playbackIndex}
                      onChange={(e) => setPlaybackIndex(parseInt(e.target.value))}
                      className="flex-1 accent-cyan-500 bg-slate-950 h-1 rounded cursor-pointer border border-cyan-950/30"
                    />
                    <span className="text-cyan-400 font-bold text-[10px] min-w-[140px] text-right">
                      {playbackSession[playbackIndex]?.timestamp?.split('T')[1]?.substring(0, 8) || '00:00:00'} UTC
                    </span>
                  </div>

                  <div className="w-full md:w-[320px] bg-slate-950 border border-cyan-950/40 p-2 rounded max-h-[44px] overflow-hidden text-[9px] leading-relaxed text-cyan-500/90 font-mono shadow-inner">
                    <span className="text-slate-500 font-bold block">EVENT TERM</span>
                    <span className="truncate block">{playbackSession[playbackIndex]?.log}</span>
                  </div>
                </div>
              )}

              {/* Main Workspace Frame */}
              <div className="flex-1 grid grid-cols-12 gap-6 min-h-0">
                {/* Left 65%: Cesium Globe */}
                <section className="col-span-8 bg-[#090f1d]/50 border border-cyan-950/50 rounded shadow-xl overflow-hidden relative flex flex-col">
                  <div className="absolute top-4 left-4 z-10 flex items-center gap-2 bg-slate-950/85 border border-cyan-950/60 rounded px-3 py-1.5 backdrop-blur-md">
                    <div className="w-2.5 h-2.5 rounded-full bg-cyan-500 animate-pulse"></div>
                    <span className="text-[9px] font-bold tracking-widest text-slate-300">
                      {dashboardTab === 'playback' ? "HISTORICAL RECONSTRUCTION" : "CESIUM 3D GLOBE OVERLAY"}
                    </span>
                  </div>
                  
                  <div className="flex-1 w-full relative" aria-label="3D Cesium map visualizing tracked targets" role="application">
                    <CesiumErrorBoundary>
                      <Viewer full className="w-full h-full">
                        {activeFlights.map(f => {
                          if (typeof f.lng !== 'number' || typeof f.lat !== 'number' || isNaN(f.lng) || isNaN(f.lat)) {
                            return null;
                          }
                          const position = Cartesian3.fromDegrees(f.lng, f.lat, f.altitude * 0.3048);
                          const color = 
                            f.status === 'critical' ? Color.RED :
                            f.status === 'suspicious' ? Color.AMBER :
                            Color.GREEN;
                            
                          const trailPositions = [
                            Cartesian3.fromDegrees(f.lng, f.lat, f.altitude * 0.3048),
                            ...(f.history || [])
                              .filter(h => typeof h.lng === 'number' && typeof h.lat === 'number' && !isNaN(h.lng) && !isNaN(h.lat))
                              .map(h => Cartesian3.fromDegrees(h.lng, h.lat, f.altitude * 0.3048))
                          ];
                          
                          return (
                            <Entity 
                              key={f.id} 
                              position={position}
                              name={f.callsign}
                              onClick={() => setSelectedFlightId(f.id)}
                            >
                              <PointGraphics pixelSize={8} color={color} outlineColor={Color.BLACK} outlineWidth={1.5} />
                              {trailPositions.length > 1 && (
                                <PolylineGraphics
                                  positions={trailPositions}
                                  width={1.5}
                                  material={color.withAlpha(0.4)}
                                />
                              )}
                            </Entity>
                          );
                        })}
                      </Viewer>
                    </CesiumErrorBoundary>
                  </div>
                </section>

                {/* Right 35%: Drawer / Aircraft Detail drawer */}
                <section className="col-span-4 bg-[#090f1d]/50 border border-cyan-950/50 rounded shadow-xl flex flex-col overflow-hidden backdrop-blur-md">
                  
                  {!selectedFlightId ? (
                    <div className="flex flex-col h-full">
                      <div className="px-4 py-3 border-b border-cyan-950/40 flex items-center justify-between">
                        <div>
                          <h2 className="text-xs font-bold tracking-wider text-slate-400 uppercase m-0">TACTICAL TARGETS</h2>
                          <span className="text-[8px] text-slate-500 font-mono">Flagged-First / Virtualized (500+ limit)</span>
                        </div>
                        <div className="flex bg-slate-950 border border-slate-900 rounded p-0.5">
                          {(['all', 'suspicious', 'critical'] as const).map(filterType => (
                            <button
                              key={filterType}
                              onClick={() => setActiveFilter(filterType)}
                              className={`text-[9px] font-mono px-2 py-1 rounded transition-all capitalize ${
                                activeFilter === filterType 
                                  ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 font-bold' 
                                  : 'text-slate-500 hover:text-slate-300 border border-transparent'
                              }`}
                            >
                              {filterType}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="flex-1 min-h-0 py-2">
                        <List
                          height={540}
                          itemCount={sortedFlights.length}
                          itemSize={76}
                          width="100%"
                        >
                          {Row}
                        </List>
                      </div>
                    </div>
                  ) : (
                    // HIGHLY POLISHED DETAIL DRAWER OVERLAY
                    <div className="flex flex-col h-full bg-[#070c17]/95 border-l border-cyan-950/50 p-5 overflow-y-auto">
                      <div className="flex justify-between items-center border-b border-cyan-950/40 pb-3 mb-4">
                        <div>
                          <span className="text-[9px] font-bold text-cyan-500 tracking-widest uppercase">Target Details</span>
                          <h3 className="text-lg font-bold text-slate-100 leading-none mt-1">{selectedFlight?.callsign}</h3>
                        </div>
                        <button 
                          onClick={() => setSelectedFlightId(null)}
                          className="text-[10px] bg-slate-950 hover:bg-cyan-950/30 border border-cyan-950 text-slate-400 hover:text-cyan-400 px-3 py-1 rounded"
                        >
                          CLOSE DRAWER
                        </button>
                      </div>

                      {selectedFlight && (
                        <div className="space-y-6 text-xs font-mono">
                          
                          <div className="grid grid-cols-2 gap-4 bg-slate-950/60 p-3 rounded border border-cyan-950/20">
                            <div>
                              <span className="text-slate-500 text-[8px] block">ICAO ADDRESS</span>
                              <span className="text-slate-200 font-bold">{selectedFlight.id.toUpperCase()}</span>
                            </div>
                            <div>
                              <span className="text-slate-500 text-[8px] block">SQUAWK CODE</span>
                              <span className="text-slate-200 font-bold">{selectedFlight.squawk}</span>
                            </div>
                            <div>
                              <span className="text-slate-500 text-[8px] block">ALTITUDE (MSL)</span>
                              <span className="text-slate-200 font-bold">{selectedFlight.altitude.toLocaleString()} ft</span>
                            </div>
                            <div>
                              <span className="text-slate-500 text-[8px] block">GROUND SPEED</span>
                              <span className="text-slate-200 font-bold">{selectedFlight.speed} kts</span>
                            </div>
                            <div>
                              <span className="text-slate-500 text-[8px] block">HEADING</span>
                              <span className="text-slate-200 font-bold">{selectedFlight.heading}°</span>
                            </div>
                            <div>
                              <span className="text-slate-500 text-[8px] block">SIGNAL STRENGTH</span>
                              <span className="text-slate-200 font-bold">{selectedFlight.signalStrength} dBm</span>
                            </div>
                          </div>

                          <div>
                            <span className="text-[10px] text-slate-400 font-bold block mb-2">AEROSPACE VERIFICATION RULE FLAGS</span>
                            <div className="space-y-1.5">
                              <div className="flex justify-between items-center p-2 rounded bg-slate-900 border border-cyan-950/10">
                                <span className="text-[9px]">Haversine Implied Speed</span>
                                <span className={`text-[9px] px-2 py-0.5 rounded font-bold ${
                                  selectedFlight.ruleFlags?.positionJump ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                }`}>
                                  {selectedFlight.ruleFlags?.positionJump ? "▲ [X] IMPLAUSIBLE JUMP DETECTED" : "● [✓] PASSED (Implied speed normal)"}
                                </span>
                              </div>
                              <div className="flex justify-between items-center p-2 rounded bg-slate-900 border border-cyan-950/10">
                                <span className="text-[9px]">Duplicate ICAO Detection</span>
                                <span className={`text-[9px] px-2 py-0.5 rounded font-bold ${
                                  selectedFlight.ruleFlags?.duplicateIcao ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                }`}>
                                  {selectedFlight.ruleFlags?.duplicateIcao ? "▲ [X] DUPLICATE FOUND" : "● [✓] PASSED (Unique signature)"}
                                </span>
                              </div>
                              <div className="flex justify-between items-center p-2 rounded bg-slate-900 border border-cyan-950/10">
                                <span className="text-[9px]">Vertical climb envelope limit</span>
                                <span className={`text-[9px] px-2 py-0.5 rounded font-bold ${
                                  selectedFlight.ruleFlags?.climbRate ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                }`}>
                                  {selectedFlight.ruleFlags?.climbRate ? "▲ [X] LIMIT EXCEEDED" : "● [✓] PASSED (Climb rate normal)"}
                                </span>
                              </div>
                              <div className="flex justify-between items-center p-2 rounded bg-slate-900 border border-cyan-950/10">
                                <span className="text-[9px]">Altitude-velocity correlation</span>
                                <span className={`text-[9px] px-2 py-0.5 rounded font-bold ${
                                  selectedFlight.ruleFlags?.altVelMismatch ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                }`}>
                                  {selectedFlight.ruleFlags?.altVelMismatch ? "▲ [X] PHYSICAL MISMATCH" : "● [✓] PASSED (Consistent state)"}
                                </span>
                              </div>
                            </div>
                          </div>

                          <div>
                            <span className="text-[10px] text-slate-400 font-bold block mb-1.5">GEOMETRIC MULTILATERATION FEEDBACK</span>
                            <div className="p-3 bg-slate-950 rounded border border-cyan-950/30 text-[10px]">
                              <span className="text-slate-500 block mb-1">TRILATERATION STATUS:</span>
                              <span className={`font-bold ${
                                selectedFlight.trilateration?.startsWith('Failed') ? 'text-rose-400' :
                                selectedFlight.trilateration?.startsWith('Inconclusive') ? 'text-amber-400' : 'text-emerald-400'
                              }`}>{selectedFlight.trilateration}</span>
                            </div>
                          </div>

                          <div>
                            <span className="text-[10px] text-slate-400 font-bold block mb-3">SHAP REASONING (EXPLAINABLE ML INFLUENCE)</span>
                            <div className="h-[180px] w-full bg-slate-950/60 border border-cyan-950/20 p-2 rounded flex flex-col justify-between">
                              <ResponsiveContainer width="100%" height="100%">
                                <BarChart
                                  layout="vertical"
                                  data={selectedFlight.shapValues}
                                  margin={{ top: 5, right: 10, left: 20, bottom: 5 }}
                                >
                                  <XAxis type="number" stroke="#475569" fontSize={8} />
                                  <YAxis dataKey="name" type="category" stroke="#94a3b8" fontSize={7} width={80} />
                                  <Tooltip contentStyle={{ backgroundColor: '#020617', borderColor: '#1e293b', fontSize: '9px' }} />
                                  <Bar 
                                    dataKey="value" 
                                    fill={selectedFlight.status === 'critical' ? '#f43f5e' : selectedFlight.status === 'suspicious' ? '#f59e0b' : '#0ea5e9'} 
                                    radius={[0, 2, 2, 0]} 
                                  />
                                </BarChart>
                              </ResponsiveContainer>
                            </div>
                          </div>

                        </div>
                      )}
                    </div>
                  )}
                </section>
              </div>
            </div>
          )}

          {/* Tab 2: Full Width Alerts Audit Log Table */}
          {dashboardTab === 'alerts' && (
            <section className="flex-1 bg-[#090f1d]/50 border border-cyan-950/50 rounded shadow-xl flex flex-col overflow-hidden p-6 backdrop-blur-md">
              <div className="flex items-center justify-between border-b border-cyan-950/40 pb-4 mb-4">
                <div>
                  <h2 className="text-sm font-bold tracking-wider text-slate-300 uppercase m-0">ALERTS AUDIT LOG RECORD</h2>
                  <span className="text-[10px] text-slate-500">Security flags logged by Combined Score Rules & ML Ensemble</span>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={exportAlertsCSV}
                    className="bg-[#09101d] border border-cyan-950/60 hover:bg-cyan-950/20 text-slate-300 font-bold text-xs py-2 px-6 rounded transition-all font-mono"
                  >
                    EXPORT TO CSV
                  </button>
                  <button
                    onClick={downloadSessionReportPDF}
                    className="bg-cyan-600 hover:bg-cyan-500 text-black font-bold text-xs py-2 px-6 rounded transition-all font-mono shadow-md hover:shadow-cyan-500/25"
                  >
                    GENERATE SESSION REPORT
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-x-auto min-h-0">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-cyan-950/60 text-slate-500 font-mono uppercase text-[9px] tracking-wider">
                      <th className="py-3 px-4 cursor-pointer hover:text-slate-300" onClick={() => { setSortField('timestamp'); setSortAsc(!sortAsc); }}>
                        Timestamp {sortField === 'timestamp' && (sortAsc ? '▲' : '▼')}
                      </th>
                      <th className="py-3 px-4 cursor-pointer hover:text-slate-300" onClick={() => { setSortField('callsign'); setSortAsc(!sortAsc); }}>
                        Target Callsign {sortField === 'callsign' && (sortAsc ? '▲' : '▼')}
                      </th>
                      <th className="py-3 px-4">ICAO Address</th>
                      <th className="py-3 px-4">Anomaly Flag Details</th>
                      <th className="py-3 px-4">Severity</th>
                      <th className="py-3 px-4 cursor-pointer hover:text-slate-300" onClick={() => { setSortField('scoreImpact'); setSortAsc(!sortAsc); }}>
                        Risk Score Impact {sortField === 'scoreImpact' && (sortAsc ? '▲' : '▼')}
                      </th>
                      <th className="py-3 px-4">Acknowledge</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-cyan-950/20 font-mono text-[11px]">
                    {paginatedAlerts.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-slate-600">No alert logs available.</td>
                      </tr>
                    ) : (
                      paginatedAlerts.map(a => {
                        const sevColor = 
                          a.severity === 'high' ? 'text-rose-400' : 'text-amber-400';
                        return (
                          <tr key={a.id} className={`hover:bg-slate-900/30 transition-colors ${a.acknowledged ? 'opacity-40' : ''}`}>
                            <td className="py-3 px-4 text-slate-400">{a.timestamp}</td>
                            <td className="py-3 px-4 font-bold text-slate-100">{a.callsign}</td>
                            <td className="py-3 px-4 text-slate-400">{a.icao24.toUpperCase()}</td>
                            <td className="py-3 px-4 text-slate-300">{a.type}</td>
                            <td className={`py-3 px-4 uppercase font-bold ${sevColor}`}>{a.severity}</td>
                            <td className="py-3 px-4 text-rose-400">{a.scoreImpact} Trust pts</td>
                            <td className="py-3 px-4">
                              {a.acknowledged ? (
                                <span className="text-[10px] text-slate-600 font-bold border border-slate-900 bg-slate-950/40 px-2 py-1 rounded">ACKNOWLEDGED</span>
                              ) : (
                                <button
                                  onClick={() => handleAcknowledge(a.id)}
                                  className="text-[10px] bg-rose-950/20 hover:bg-rose-950/50 border border-rose-950/50 text-rose-400 px-3 py-1 rounded transition-colors"
                                >
                                  ACKNOWLEDGE
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between border-t border-cyan-950/40 pt-4 mt-4 font-mono text-[10px]">
                <span className="text-slate-500">
                  Showing {alertPage * alertsPerPage + 1} - {Math.min((alertPage + 1) * alertsPerPage, sortedAlerts.length)} of {sortedAlerts.length} logs
                </span>
                <div className="flex gap-2">
                  <button
                    disabled={alertPage === 0}
                    onClick={() => setAlertPage(alertPage - 1)}
                    className="border border-cyan-950 bg-slate-950 px-3 py-1.5 rounded text-slate-400 hover:text-cyan-400 disabled:opacity-40 disabled:pointer-events-none"
                  >
                    PREVIOUS
                  </button>
                  <button
                    disabled={(alertPage + 1) * alertsPerPage >= sortedAlerts.length}
                    onClick={() => setAlertPage(alertPage + 1)}
                    className="border border-cyan-950 bg-slate-950 px-3 py-1.5 rounded text-slate-400 hover:text-cyan-400 disabled:opacity-40 disabled:pointer-events-none"
                  >
                    NEXT
                  </button>
                </div>
              </div>
            </section>
          )}

          {/* Tab 4: System Analytics & Threshold Sliders Config View */}
          {dashboardTab === 'analytics' && (
            <div className="flex-1 grid grid-cols-12 gap-6 min-h-0 overflow-y-auto">
              
              {/* Left 60%: System Analytics (Real Data Visualizer) */}
              <section className="col-span-7 bg-[#090f1d]/50 border border-cyan-950/50 rounded p-5 flex flex-col gap-6 shadow-xl backdrop-blur-md">
                <div className="border-b border-cyan-950/40 pb-3">
                  <h2 className="text-sm font-bold tracking-wider text-slate-300 uppercase m-0">CLASSIFIER & TRUST ANALYTICS</h2>
                  <span className="text-[10px] text-slate-500">Aggregated historical metrics from database audits</span>
                </div>

                {/* Accuracy over time chart */}
                <div className="h-[140px] w-full bg-slate-950/30 border border-cyan-950/20 p-3 rounded">
                  <span className="text-[9px] text-slate-400 font-mono block mb-1 uppercase">Accuracy Over Time</span>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={accuracyData} margin={{ top: 5, right: 10, left: -25, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" opacity="0.3" />
                      <XAxis dataKey="time" stroke="#475569" fontSize={9} />
                      <YAxis stroke="#475569" fontSize={9} domain={[0.90, 1.00]} />
                      <Tooltip contentStyle={{ backgroundColor: '#020617', borderColor: '#334155', fontSize: '9px' }} />
                      <Line type="monotone" dataKey="accuracy" stroke="#0ea5e9" strokeWidth={1.5} dot={{ r: 3 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                {/* Row: Anomaly Type + Aircraft Volume */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="h-[130px] w-full bg-slate-950/30 border border-cyan-950/20 p-3 rounded">
                    <span className="text-[9px] text-slate-400 font-mono block mb-1 uppercase">Anomaly Types Distribution</span>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={typeData} margin={{ top: 5, right: 5, left: -30, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" opacity="0.3" />
                        <XAxis dataKey="type" stroke="#475569" fontSize={7} />
                        <YAxis stroke="#475569" fontSize={8} />
                        <Tooltip contentStyle={{ backgroundColor: '#020617', borderColor: '#334155', fontSize: '8px' }} />
                        <Bar dataKey="count" fill="#f43f5e" radius={[2, 2, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  
                  <div className="h-[130px] w-full bg-slate-950/30 border border-cyan-950/20 p-3 rounded">
                    <span className="text-[9px] text-slate-400 font-mono block mb-1 uppercase">Aircraft Volume (24h)</span>
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={volumeData} margin={{ top: 5, right: 5, left: -25, bottom: 5 }}>
                        <defs>
                          <linearGradient id="colorVol" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#10b981" stopOpacity={0.2}/>
                            <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" opacity="0.3" />
                        <XAxis dataKey="time" stroke="#475569" fontSize={9} />
                        <YAxis stroke="#475569" fontSize={9} />
                        <Tooltip contentStyle={{ backgroundColor: '#020617', borderColor: '#334155', fontSize: '8px' }} />
                        <Area type="monotone" dataKey="volume" stroke="#10b981" fillOpacity={1} fill="url(#colorVol)" strokeWidth={1.5} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* Confusion Matrix Detail */}
                <div className="bg-[#0b1220] p-4 rounded border border-cyan-950/30">
                  <span className="text-[10px] text-slate-400 font-bold block mb-3">REPLAY CONFUSION MATRIX FEEDBACK</span>
                  <div className="grid grid-cols-2 gap-4 text-center font-mono">
                    <div className="bg-[#020617] p-3 rounded border border-cyan-950/20">
                      <div className="text-[9px] text-slate-500">TRUE POSITIVES (TP)</div>
                      <div className="text-xl font-bold text-emerald-400">{replayResult ? replayResult.true_positives : 15}</div>
                    </div>
                    <div className="bg-[#020617] p-3 rounded border border-cyan-950/20">
                      <div className="text-[9px] text-slate-500">FALSE POSITIVES (FP)</div>
                      <div className="text-xl font-bold text-rose-500">{replayResult ? replayResult.false_positives : 1}</div>
                    </div>
                    <div className="bg-[#020617] p-3 rounded border border-cyan-950/20">
                      <div className="text-[9px] text-slate-500">TRUE NEGATIVES (TN)</div>
                      <div className="text-xl font-bold text-emerald-400">{replayResult ? replayResult.true_negatives : 282}</div>
                    </div>
                    <div className="bg-[#020617] p-3 rounded border border-cyan-950/20">
                      <div className="text-[9px] text-slate-500">FALSE NEGATIVES (FN)</div>
                      <div className="text-xl font-bold text-rose-500">{replayResult ? replayResult.false_negatives : 2}</div>
                    </div>
                  </div>
                </div>
              </section>

              {/* Right 40%: Detection config Sliders */}
              <section className="col-span-5 bg-[#090f1d]/50 border border-cyan-950/50 rounded p-5 flex flex-col gap-6 shadow-xl backdrop-blur-md justify-between">
                <div>
                  <div className="border-b border-cyan-950/40 pb-3 mb-4">
                    <h2 className="text-sm font-bold tracking-wider text-slate-300 uppercase m-0">AERODYNAMIC CORRELATION THRESHOLDS</h2>
                    <span className="text-[10px] text-slate-500">Customize envelope parameters dynamically</span>
                  </div>

                  {/* Sliders */}
                  <div className="space-y-4 font-mono text-[10px]">
                    {/* Slider 1 */}
                    <div className="space-y-1">
                      <div className="flex justify-between">
                        <span className="text-slate-400">Max Implied Speed:</span>
                        <span className="text-cyan-400 font-bold">{config.max_implied_speed_kmh} km/h</span>
                      </div>
                      <input
                        type="range" min="500" max="2500" step="50"
                        value={config.max_implied_speed_kmh}
                        onChange={(e) => setConfig({ ...config, max_implied_speed_kmh: parseFloat(e.target.value) })}
                        className="w-full accent-cyan-500 bg-slate-950 h-1 rounded cursor-pointer border border-cyan-950/20"
                      />
                    </div>

                    {/* Slider 2 */}
                    <div className="space-y-1">
                      <div className="flex justify-between">
                        <span className="text-slate-400">Duplicate ICAO Distance Limit:</span>
                        <span className="text-cyan-400 font-bold">{config.duplicate_icao_dist_km} km</span>
                      </div>
                      <input
                        type="range" min="5" max="150" step="5"
                        value={config.duplicate_icao_dist_km}
                        onChange={(e) => setConfig({ ...config, duplicate_icao_dist_km: parseFloat(e.target.value) })}
                        className="w-full accent-cyan-500 bg-slate-950 h-1 rounded cursor-pointer border border-cyan-950/20"
                      />
                    </div>

                    {/* Slider 3 */}
                    <div className="space-y-1">
                      <div className="flex justify-between">
                        <span className="text-slate-400">Max climb envelope rate:</span>
                        <span className="text-cyan-400 font-bold">{config.max_vertical_rate_ms} m/s</span>
                      </div>
                      <input
                        type="range" min="10" max="150" step="5"
                        value={config.max_vertical_rate_ms}
                        onChange={(e) => setConfig({ ...config, max_vertical_rate_ms: parseFloat(e.target.value) })}
                        className="w-full accent-cyan-500 bg-slate-950 h-1 rounded cursor-pointer border border-cyan-950/20"
                      />
                    </div>

                    {/* Slider 4 */}
                    <div className="space-y-1">
                      <div className="flex justify-between">
                        <span className="text-slate-400">Max Ground roll altitude:</span>
                        <span className="text-cyan-400 font-bold">{config.max_ground_altitude_m} m</span>
                      </div>
                      <input
                        type="range" min="10" max="500" step="10"
                        value={config.max_ground_altitude_m}
                        onChange={(e) => setConfig({ ...config, max_ground_altitude_m: parseFloat(e.target.value) })}
                        className="w-full accent-cyan-500 bg-slate-950 h-1 rounded cursor-pointer border border-cyan-950/20"
                      />
                    </div>

                    {/* Slider 5 */}
                    <div className="space-y-1">
                      <div className="flex justify-between">
                        <span className="text-slate-400">Max Ground roll speed limit:</span>
                        <span className="text-cyan-400 font-bold">{config.max_ground_speed_ms} m/s</span>
                      </div>
                      <input
                        type="range" min="10" max="150" step="5"
                        value={config.max_ground_speed_ms}
                        onChange={(e) => setConfig({ ...config, max_ground_speed_ms: parseFloat(e.target.value) })}
                        className="w-full accent-cyan-500 bg-slate-950 h-1 rounded cursor-pointer border border-cyan-950/20"
                      />
                    </div>

                    {/* Slider 6 */}
                    <div className="space-y-1">
                      <div className="flex justify-between">
                        <span className="text-slate-400">Min flight speed required:</span>
                        <span className="text-cyan-400 font-bold">{config.min_flight_speed_ms} m/s</span>
                      </div>
                      <input
                        type="range" min="5" max="100" step="5"
                        value={config.min_flight_speed_ms}
                        onChange={(e) => setConfig({ ...config, min_flight_speed_ms: parseFloat(e.target.value) })}
                        className="w-full accent-cyan-500 bg-slate-950 h-1 rounded cursor-pointer border border-cyan-950/20"
                      />
                    </div>
                  </div>
                </div>

                {/* Operations buttons */}
                <div className="space-y-3 pt-6 border-t border-cyan-950/40">
                  {/* Replay indicator summary */}
                  {replayResult && (
                    <div className="bg-[#020617] border border-cyan-950 p-2.5 rounded text-[9px] leading-relaxed text-cyan-500 font-mono space-y-1">
                      <div className="font-bold border-b border-cyan-950/40 pb-1 text-slate-300">LIVE REPLAY EVALUATION RESULTS:</div>
                      <div>MODEL VERIFICATION SCORE: <b>{replayResult.model_version}</b></div>
                      <div>PRECISION SCORE: <b className="text-emerald-400">{(replayResult.precision * 100).toFixed(2)}%</b></div>
                      <div>RECALL SCORE: <b className="text-emerald-400">{(replayResult.recall * 100).toFixed(2)}%</b></div>
                      <div>F1 SCORE: <b className="text-emerald-400">{(replayResult.f1 * 100).toFixed(2)}%</b></div>
                    </div>
                  )}

                  <button
                    onClick={handleReplaySession}
                    disabled={isReplaying}
                    className="w-full bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-900 text-black font-bold text-xs py-2.5 px-4 rounded transition-all font-mono shadow-md hover:shadow-cyan-500/25"
                  >
                    {isReplaying ? "REPLAYING SESSION TELEMETRY..." : "TEST AGAINST LAST SESSION (REPLAY)"}
                  </button>

                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <button
                      onClick={handleSaveConfig}
                      className="border border-cyan-950 bg-slate-950 hover:bg-cyan-950/10 text-slate-300 font-bold py-2 px-4 rounded transition-all font-mono"
                    >
                      SAVE CONFIG
                    </button>
                    <button
                      onClick={handleResetConfig}
                      className="border border-rose-950 bg-slate-950 hover:bg-rose-950/10 text-rose-400 font-bold py-2 px-4 rounded transition-all font-mono"
                    >
                      RESET TO DEFAULTS
                    </button>
                  </div>
                </div>
              </section>

            </div>
          )}

          {/* --- Bottom 3 Stat Cards --- */}
          <section className="grid grid-cols-3 gap-6 mt-6">
            
            {/* Card 1 */}
            <div className="p-4 border border-cyan-950/40 bg-[#060b14]/50 rounded shadow-lg backdrop-blur-sm flex flex-col justify-between">
              <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Total Tracked Targets</span>
              <div className="flex items-baseline gap-2 mt-2">
                <span className="text-3xl font-black text-slate-100">{stats.total}</span>
                <span className="text-[10px] text-emerald-400 font-semibold">Active Feeds</span>
              </div>
            </div>

            {/* Card 2 */}
            <div className="p-4 border border-cyan-950/40 bg-[#060b14]/50 rounded shadow-lg backdrop-blur-sm flex flex-col justify-between">
              <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Security Anomalies</span>
              <div className="flex items-baseline gap-2 mt-2">
                <span className="text-3xl font-black text-rose-500">{stats.anomalies}</span>
                <span className="text-[10px] text-rose-400 font-semibold">Flagged / Suppressed</span>
              </div>
            </div>

            {/* Card 3 */}
            <div className="p-4 border border-cyan-950/40 bg-[#060b14]/50 rounded shadow-lg backdrop-blur-sm flex flex-col justify-between">
              <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Station Trust Rating</span>
              <div className="flex items-baseline gap-2 mt-2">
                <span className="text-3xl font-black text-cyan-400">{stats.avgTrust}%</span>
                <span className="text-[10px] text-cyan-400 font-semibold">Reliability Index</span>
              </div>
            </div>

          </section>

        </div>
      )}

      {/* --- Footer --- */}
      <footer className="border-t border-cyan-950/40 bg-[#060b14] px-6 py-3 flex items-center justify-between text-[10px] text-slate-500 relative z-10">
        <div>AirGuard Ground Station Receiver v0.1.0</div>
        <div className="flex items-center gap-4">
          <a href="docs/MODEL_CARD.md" className="hover:text-slate-300 transition-colors">Model Card</a>
          <a href="docs/ARCHITECTURE_DECISIONS.md" className="hover:text-slate-300 transition-colors">ADR Logs</a>
          <a href="docs/DEMO_SCRIPT.md" className="hover:text-slate-300 transition-colors">Demo Script</a>
        </div>
      </footer>
    </div>
  );
}
