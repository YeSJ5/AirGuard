import React, { Suspense, lazy, useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { FixedSizeList as List } from 'react-window';
import {
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, LineChart, Line
} from 'recharts';
import { useAirGuardStore as useStore } from './store/useAirGuardStore';
import { API_BASE, WS_BASE } from './services/api';
import type { AircraftApiState, AircraftDetailResponse, AlertApiResponse, Flight, AlertLog, User, AuditLog, HealthStats } from './types';

// Cesium and Resium imports
import { Viewer, Entity, PolylineGraphics, LabelGraphics, BillboardGraphics, RectangleGraphics } from 'resium';
import {
  Cartesian3, Color, Cartesian2, LabelStyle, CallbackProperty,
  Math as CesiumMath, EasingFunction, Viewer as CesiumViewer,
  BoundingSphere, HeadingPitchRange,
  Rectangle, DistanceDisplayCondition, ClockStep, Ion, UrlTemplateImageryProvider
} from 'cesium';
import "cesium/Build/Cesium/Widgets/widgets.css";
const CesiumViewerComponent: typeof Viewer = Viewer;
import { aircraftMotionManager } from './services/aircraftMotionManager';
import { AirspaceMap } from './components/AirspaceMap';
const AirspaceEventCandidatePanel = lazy(() => import('./components/threats/AirspaceEventCandidatePanel').then(module => ({ default: module.AirspaceEventCandidatePanel })));
const HistoricalPlaybackView = lazy(() => import('./components/airspace/HistoricalPlaybackView').then(module => ({ default: module.HistoricalPlaybackView })));
import { formatObservedNumber, isObservedField } from './utils/dataQuality';
import { detectorStatusFromRisk, displayableRisk } from './utils/detectorStatus';

// Use a deployment-provided token when an Ion asset requires it; never embed account credentials in the client bundle.
const cesiumIonToken = import.meta.env.VITE_CESIUM_ION_TOKEN || '';
if (cesiumIonToken) Ion.defaultAccessToken = cesiumIonToken;

// Global high-resolution Satellite & World Boundaries imagery provider
const createSatelliteImageryProvider = () => new UrlTemplateImageryProvider({
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  maximumLevel: 19,
  credit: 'Esri World Imagery'
});

const createReferenceBoundariesProvider = () => new UrlTemplateImageryProvider({
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  maximumLevel: 19,
  credit: 'Esri Reference'
});


// --- Cesium Error Boundary with Self-Healing Recovery ---
class CesiumErrorBoundary extends React.Component<{ children?: React.ReactNode; resetKey?: unknown }, { hasError: boolean; error: Error | null }> {
  public state = {
    hasError: false,
    error: null as Error | null
  };

  public static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Cesium render crash caught by boundary:", error, errorInfo);
  }

  public componentDidUpdate(prevProps: { children?: React.ReactNode; resetKey?: unknown }) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null });
    }
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="w-full h-full bg-[#080d18] border border-slate-800 rounded p-6 flex flex-col items-center justify-center text-center">
          <div className="w-8 h-8 rounded-full bg-rose-500/20 border border-rose-500/40 flex items-center justify-center text-rose-400 mb-3 text-sm">
            ⚠
          </div>
          <span className="text-rose-400 text-xs font-bold mb-1">3D RENDER ENGINE RECOVERY ACTIVE</span>
          <p className="text-[10px] text-slate-400 max-w-md leading-relaxed mb-3 font-normal">
            Cesium 3D canvas encountered a WebGL state interruption. The telemetry ingestion pipeline is unaffected.
          </p>
          <div className="text-[10px] text-slate-500 bg-slate-900 border border-slate-800 p-2.5 rounded text-left w-full max-w-sm overflow-x-auto font-mono mb-4">
            {this.state.error?.toString() || "WebGL context lost or entity geometry error."}
          </div>
          <button
            onClick={this.handleReset}
            className="px-4 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded text-xs font-mono font-semibold transition-all shadow-[0_0_15px_rgba(6,182,212,0.3)] flex items-center gap-2"
          >
            <span>REINITIALIZE 3D ENGINE</span>
            <span className="text-[10px] opacity-75">↻</span>
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

// --- Airport Coordinates and Metadata for Route Line Projection and Flight Panels ---
const AIRPORT_COORDINATES: Record<string, { lat: number; lng: number; name: string; city: string; iata: string }> = {
  VIDP: { lat: 28.5562, lng: 77.1000, name: "Indira Gandhi Intl", city: "Delhi", iata: "DEL" },
  VABB: { lat: 19.0896, lng: 72.8656, name: "Chhatrapati Shivaji Intl", city: "Mumbai", iata: "BOM" },
  VOBL: { lat: 13.1986, lng: 77.7066, name: "Kempegowda Intl", city: "Bengaluru", iata: "BLR" },
  VOMM: { lat: 12.9941, lng: 80.1709, name: "Chennai Intl", city: "Chennai", iata: "MAA" },
  VECC: { lat: 22.6547, lng: 88.4467, name: "Netaji Subhash Chandra Bose Intl", city: "Kolkata", iata: "CCU" },
  VOHS: { lat: 17.2403, lng: 78.4294, name: "Rajiv Gandhi Intl", city: "Hyderabad", iata: "HYD" },
  VOCI: { lat: 10.1518, lng: 76.3929, name: "Cochin Intl", city: "Kochi", iata: "COK" },
  VAGO: { lat: 15.3808, lng: 73.8314, name: "Dabolim", city: "Goa", iata: "GOI" },
  VOGA: { lat: 15.7428, lng: 73.8661, name: "Manohar Intl Mopa", city: "Goa", iata: "GOX" },
  VAID: { lat: 22.7217, lng: 75.8011, name: "Devi Ahilya Bai Holkar", city: "Indore", iata: "IDR" },
  VIJP: { lat: 26.8242, lng: 75.8122, name: "Jaipur Intl", city: "Jaipur", iata: "JAI" },
  VILK: { lat: 26.7606, lng: 80.8893, name: "Chaudhary Charan Singh Intl", city: "Lucknow", iata: "LKO" },
  VEBD: { lat: 26.6812, lng: 88.3286, name: "Bagdogra", city: "Siliguri", iata: "IXB" },
  VEGT: { lat: 26.1061, lng: 91.5859, name: "Lokpriya Gopinath Bordoloi Intl", city: "Guwahati", iata: "GAU" },
  VAAH: { lat: 23.0772, lng: 72.6347, name: "Sardar Vallabhbhai Patel Intl", city: "Ahmedabad", iata: "AMD" },
  VOPB: { lat: 11.6414, lng: 92.7297, name: "Veer Savarkar Intl", city: "Port Blair", iata: "IXZ" },
  VOCL: { lat: 11.1368, lng: 75.9553, name: "Calicut Intl", city: "Kozhikode", iata: "CCJ" },
  VOTV: { lat: 8.4821, lng: 76.9200, name: "Trivandrum Intl", city: "Thiruvananthapuram", iata: "TRV" },
  VOCB: { lat: 11.0299, lng: 77.0434, name: "Coimbatore Intl", city: "Coimbatore", iata: "CJB" },
  VAPO: { lat: 18.5821, lng: 73.9197, name: "Pune Intl", city: "Pune", iata: "PNQ" },
  VANP: { lat: 21.0922, lng: 79.0594, name: "Dr. Babasaheb Ambedkar Intl", city: "Nagpur", iata: "NAG" },
  VEBS: { lat: 20.2444, lng: 85.8178, name: "Biju Patnaik Intl", city: "Bhubaneswar", iata: "BBI" },
  VEPT: { lat: 25.5913, lng: 85.0880, name: "Jay Prakash Narayan Intl", city: "Patna", iata: "PAT" },
  VIAR: { lat: 31.7096, lng: 74.7973, name: "Sri Guru Ram Dass Jee Intl", city: "Amritsar", iata: "ATQ" },
  VISR: { lat: 33.9871, lng: 74.7741, name: "Sheikh ul-Alam Intl", city: "Srinagar", iata: "SXR" },
  OMDB: { lat: 25.2532, lng: 55.3657, name: "Dubai Intl", city: "Dubai", iata: "DXB" },
  OMAA: { lat: 24.4330, lng: 54.6511, name: "Abu Dhabi Intl", city: "Abu Dhabi", iata: "AUH" },
  OTHH: { lat: 25.2731, lng: 51.6081, name: "Hamad Intl", city: "Doha", iata: "DOH" },
  WSSS: { lat: 1.3644, lng: 103.9915, name: "Singapore Changi", city: "Singapore", iata: "SIN" },
  VTBS: { lat: 13.6900, lng: 100.7501, name: "Suvarnabhumi", city: "Bangkok", iata: "BKK" },
  OOMS: { lat: 23.5933, lng: 58.2844, name: "Muscat Intl", city: "Muscat", iata: "MCT" },
  OBBI: { lat: 26.2708, lng: 50.6336, name: "Bahrain Intl", city: "Manama", iata: "BAH" },
  OKBK: { lat: 29.2268, lng: 47.9689, name: "Kuwait Intl", city: "Kuwait City", iata: "KWI" },
  OERK: { lat: 24.9576, lng: 46.6988, name: "King Khalid Intl", city: "Riyadh", iata: "RUH" },
  OEJN: { lat: 21.6796, lng: 39.1565, name: "King Abdulaziz Intl", city: "Jeddah", iata: "JED" },
  VCBI: { lat: 7.1808, lng: 79.8841, name: "Bandaranaike Intl", city: "Colombo", iata: "CMB" },
  VRMM: { lat: 4.1918, lng: 73.5290, name: "Velana Intl", city: "Male", iata: "MLE" },
  VNKT: { lat: 27.6966, lng: 85.3591, name: "Tribhuvan Intl", city: "Kathmandu", iata: "KTM" },
  VGHS: { lat: 23.8433, lng: 90.3978, name: "Hazrat Shahjalal Intl", city: "Dhaka", iata: "DAC" },
};

// Airline enrichment interface & comprehensive ICAO designator directory
export { type AirlineInfo, AIRLINE_DIRECTORY, getAirlineInfo, getAirlineDisplayName } from './utils/airlineDirectory';
import { getAirlineInfo } from './utils/airlineDirectory';

// Match airport string/code to geographic coordinate metadata
const resolveAirportCoords = (airportStr?: string | null): { lat: number; lng: number; label: string; name: string; city: string; iata: string } | null => {
  if (!airportStr) return null;
  const clean = airportStr.toUpperCase().trim();
  if (clean === "ROUTE UNKNOWN" || clean === "UNKNOWN" || clean === "NULL") return null;

  // Direct 4-letter ICAO match
  if (AIRPORT_COORDINATES[clean]) {
    const a = AIRPORT_COORDINATES[clean];
    return { lat: a.lat, lng: a.lng, label: `${a.iata}/${clean}`, name: a.name, city: a.city, iata: a.iata };
  }

  // Check if string contains ICAO or IATA code
  for (const [icao, info] of Object.entries(AIRPORT_COORDINATES)) {
    if (clean === info.iata || clean.includes(info.iata) || clean.includes(icao)) {
      return { lat: info.lat, lng: info.lng, label: `${info.iata}/${icao}`, name: info.name, city: info.city, iata: info.iata };
    }
  }
  return null;
};

// Compute 3D parabolic great-circle trajectory arc for Cesium route projection
const computeRouteArcPositions = (
  startLat: number,
  startLng: number,
  startAltM: number,
  endLat: number,
  endLng: number,
  endAltM: number,
  steps = 14
): Cartesian3[] => {
  const points: Cartesian3[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const lat = startLat + t * (endLat - startLat);
    const lng = startLng + t * (endLng - startLng);
    // Smooth parabolic altitude curve
    const arcHeight = Math.sin(t * Math.PI) * 1500;
    const alt = startAltM + t * (endAltM - startAltM) + arcHeight;
    points.push(Cartesian3.fromDegrees(lng, lat, Math.max(50, alt)));
  }
  return points;
};

// Helper for plain-English explanation of why an aircraft was flagged
function getPlainEnglishExplanation(
  flight: Flight,
  detail?: Pick<AircraftDetailResponse, 'trust_status'>
): { headline: string; summary: string; reasons: string[] } {
  const trustStatus = detail?.trust_status;
  const backendReasons = Array.isArray(trustStatus?.reasons) ? trustStatus.reasons.filter((reason: unknown): reason is string => typeof reason === 'string') : [];
  if (!trustStatus) {
    return { headline: 'Evaluation details unavailable', summary: 'The backend did not return an explanation for this aircraft.', reasons: [] };
  }
  const headline = trustStatus.is_flagged
    ? flight.status === 'critical' ? 'Critical telemetry anomaly' : 'Suspicious telemetry pattern'
    : 'No threat reported by the detector';
  return {
    headline,
    summary: typeof trustStatus.explanation === 'string' && trustStatus.explanation.length > 0 ? trustStatus.explanation : 'Explanation unavailable.',
    reasons: backendReasons
  };
}
// Global runtime flags synced from App state to bypass interpolation during defense mode or reduced motion
export const setShowcaseModeGlobal = (val: boolean) => {
  aircraftMotionManager.setShowcaseMode(val);
};

export const setReduceMotionGlobal = (val: boolean) => {
  aircraftMotionManager.setReduceMotion(val);
};

// Shared GPU animation callbacks for pulsing rings (zero React re-render overhead)
const pulseScaleProperty = new CallbackProperty(() => {
  return 0.9 + 0.3 * Math.sin(performance.now() / 350);
}, false);

const pulseColorProperty = new CallbackProperty(() => {
  const alpha = 0.35 + 0.35 * Math.sin(performance.now() / 350);
  return Color.WHITE.withAlpha(Math.max(0.1, alpha));
}, false);

// Subtle pulsing radar rings for flagged aircraft
const createPulseRingSvg = (color: string) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><circle cx="32" cy="32" r="25" fill="none" stroke="${color}" stroke-width="2.5" stroke-dasharray="6 3"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
};

const PULSE_RING_CRITICAL_SVG = createPulseRingSvg('#f43f5e');
const PULSE_RING_SUSPICIOUS_SVG = createPulseRingSvg('#f59e0b');

const aircraftBillboardCache = new Map<string, string>();
const createAircraftBillboard = (color: string) => {
  const cached = aircraftBillboardCache.get(color);
  if (cached) return cached;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32"><path d="M16 2c-1.2 0-2 1.1-2 2.7v7.7L4 18v3l10-3.7v7.3l-3 2.1v2L16 27l5 1.7v-2l-3-2.1v-7.3L28 21v-3l-10-5.6V4.7C18 3.1 17.2 2 16 2Z" fill="${color}" stroke="#082f49" stroke-width="1.1" stroke-linejoin="round"/></svg>`;
  const uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  aircraftBillboardCache.set(color, uri);
  return uri;
};

// Register / update smooth motion target for continuous interpolation
const registerFlightMotion = (
  id: string,
  newLat: number,
  newLng: number,
  newAlt: number,
  newHeading: number,
  newSpeed: number,
  durationMs: number = 8000
) => {
  aircraftMotionManager.updatePosition({
    icao24: id,
    lat: newLat,
    lng: newLng,
    altitudeFt: newAlt,
    headingDeg: newHeading,
    speedKnots: newSpeed,
    durationSec: durationMs / 1000
  });
};

const getFlightMotionProperties = (flight: Flight) => {
  return aircraftMotionManager.getProperties(
    flight.id,
    flight.lat,
    flight.lng,
    flight.altitude,
    flight.heading,
    flight.speed
  );
};

// --- Auditory Feedback Layer (Web Audio API Synthesizer) ---
// Low-volume, pleasant, and strictly silenced during data-reading contexts
let audioCtx: AudioContext | null = null;
let ambientGain: GainNode | null = null;
let ambientOsc1: OscillatorNode | null = null;
let ambientOsc2: OscillatorNode | null = null;
let ambientNoiseSource: AudioBufferSourceNode | null = null;
let ambientLfo: OscillatorNode | null = null;
let lastAnomalyChimeTime = 0;

// Soft, pleasant acoustic chime for live anomaly detection (F#5, A#5, C#6 major triad, < 1.4s, low volume 0.07)
const playSoftAnomalyChime = () => {
  const now = performance.now();
  if (now - lastAnomalyChimeTime < 1800) return; // rate-limit to under 2s
  lastAnomalyChimeTime = now;

  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    if (!audioCtx) {
      audioCtx = new AudioContextClass();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    const t = audioCtx.currentTime;

    // Master Chime Gain - gentle, low-volume (0.07 max), soft exponential decay
    const masterChimeGain = audioCtx.createGain();
    masterChimeGain.gain.setValueAtTime(0.001, t);
    masterChimeGain.gain.linearRampToValueAtTime(0.07, t + 0.02);
    masterChimeGain.gain.exponentialRampToValueAtTime(0.0001, t + 1.35);
    masterChimeGain.connect(audioCtx.destination);

    // Warm Butterworth low-pass filter (silky acoustic response, never screechy or siren-like)
    const chimeFilter = audioCtx.createBiquadFilter();
    chimeFilter.type = 'lowpass';
    chimeFilter.frequency.setValueAtTime(2200, t);
    chimeFilter.Q.setValueAtTime(1.0, t);
    chimeFilter.connect(masterChimeGain);

    // Harmonious marimba / glass chime notes: F#5 (740Hz), A#5 (932Hz), C#6 (1109Hz)
    const notes = [
      { freq: 739.99, delay: 0.000, gain: 0.65 },
      { freq: 932.33, delay: 0.045, gain: 0.45 },
      { freq: 1108.73, delay: 0.090, gain: 0.30 }
    ];

    notes.forEach(({ freq, delay, gain }) => {
      if (!audioCtx) return;
      const osc = audioCtx.createOscillator();
      const noteGain = audioCtx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t + delay);

      noteGain.gain.setValueAtTime(0.001, t + delay);
      noteGain.gain.linearRampToValueAtTime(gain, t + delay + 0.015);
      noteGain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 1.15);

      osc.connect(noteGain);
      noteGain.connect(chimeFilter);

      osc.start(t + delay);
      osc.stop(t + delay + 1.25);
    });
  } catch (err) {
    console.warn("Soft anomaly chime playback bypassed:", err);
  }
};

// Subtle low ambient turbofan & wind hum in close-orbit fly-to state (volume 0.06, seamless loop)
const startAmbientAtmosphere = () => {
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    if (!audioCtx) {
      audioCtx = new AudioContextClass();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    if (ambientGain) {
      // If already playing, smoothly ensure proper target volume
      const t = audioCtx.currentTime;
      ambientGain.gain.cancelScheduledValues(t);
      ambientGain.gain.setValueAtTime(ambientGain.gain.value, t);
      ambientGain.gain.linearRampToValueAtTime(0.06, t + 0.6);
      return;
    }

    // Master gain node with smooth fade-in
    ambientGain = audioCtx.createGain();
    ambientGain.gain.setValueAtTime(0.001, audioCtx.currentTime);
    ambientGain.gain.linearRampToValueAtTime(0.06, audioCtx.currentTime + 0.6);
    ambientGain.connect(audioCtx.destination);

    // Ethereal lowpass filter for atmospheric wind rush & engine hum
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(120, audioCtx.currentTime);
    filter.Q.setValueAtTime(1.8, audioCtx.currentTime);
    filter.connect(ambientGain);

    // Low-frequency detuned sub-bass sine waves for cosmic / turbine core resonance
    ambientOsc1 = audioCtx.createOscillator();
    ambientOsc1.type = 'sine';
    ambientOsc1.frequency.setValueAtTime(55.0, audioCtx.currentTime);

    ambientOsc2 = audioCtx.createOscillator();
    ambientOsc2.type = 'sine';
    ambientOsc2.frequency.setValueAtTime(55.6, audioCtx.currentTime); // gentle ~0.6Hz beating

    // Organic pink noise buffer for soft wind rush
    const bufferSize = audioCtx.sampleRate * 2;
    const noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99 * b0 + white * 0.05;
      b1 = 0.95 * b1 + white * 0.05;
      b2 = 0.85 * b2 + white * 0.05;
      data[i] = (b0 + b1 + b2) * 0.22;
    }
    ambientNoiseSource = audioCtx.createBufferSource();
    ambientNoiseSource.buffer = noiseBuffer;
    ambientNoiseSource.loop = true;

    // Slow LFO for breathing wind swells
    ambientLfo = audioCtx.createOscillator();
    const lfoGain = audioCtx.createGain();
    ambientLfo.frequency.setValueAtTime(0.16, audioCtx.currentTime); // ~6.2s wind breath cycle
    lfoGain.gain.setValueAtTime(35, audioCtx.currentTime);
    ambientLfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);

    ambientOsc1.connect(filter);
    ambientOsc2.connect(filter);
    ambientNoiseSource.connect(filter);

    ambientOsc1.start();
    ambientOsc2.start();
    ambientNoiseSource.start();
    ambientLfo.start();
  } catch (err) {
    console.warn("Ambient audio initialization bypassed:", err);
  }
};

const stopAmbientAtmosphere = (immediate: boolean = false) => {
  if (ambientGain && audioCtx) {
    try {
      const t = audioCtx.currentTime;
      ambientGain.gain.cancelScheduledValues(t);
      ambientGain.gain.setValueAtTime(ambientGain.gain.value, t);
      if (immediate) {
        ambientGain.gain.setValueAtTime(0.0001, t);
      } else {
        ambientGain.gain.linearRampToValueAtTime(0.0001, t + 0.6);
      }
      setTimeout(() => {
        if (ambientOsc1) { ambientOsc1.stop(); ambientOsc1.disconnect(); ambientOsc1 = null; }
        if (ambientOsc2) { ambientOsc2.stop(); ambientOsc2.disconnect(); ambientOsc2 = null; }
        if (ambientNoiseSource) { ambientNoiseSource.stop(); ambientNoiseSource.disconnect(); ambientNoiseSource = null; }
        if (ambientLfo) { ambientLfo.stop(); ambientLfo.disconnect(); ambientLfo = null; }
        if (ambientGain) { ambientGain.disconnect(); ambientGain = null; }
      }, immediate ? 50 : 700);
    } catch (e) {
      // Ignore cleanup error
    }
  }
};

// --- App Component ---
export default function App() {
  const {
    flights, selectedFlightId, alerts, activeAlertCount, websocketStatus, backendHealth, activeFilter, token, currentUser,
    setSelectedFlightId, setBackendHealth, setWebsocketStatus, setActiveFilter, addAlert, setAlerts,
    updateFlightStatus, updateOrAddFlight, updateOrAddFlights, acknowledgeAlert,
    setToken, setUser, logout
  } = useStore();

  // Single application-shell navigation state.
  const [currentTier, setCurrentTier] = useState<'tier1_overview' | 'tier2_radar' | 'tier3_tools'>('tier1_overview');
  const [tier3Tab, setTier3Tab] = useState<'details' | 'alerts' | 'analytics' | 'config' | 'playback' | 'admin' | 'about'>('alerts');
  const [aircraftSearch, setAircraftSearch] = useState('');
  const [showTier2Telemetry, setShowTier2Telemetry] = useState(false);

  // Technical Detail Toggles (off by default for low cognitive load)
  const [showShapTechnical, setShowShapTechnical] = useState(false);
  const [hoveredFlightId, setHoveredFlightId] = useState<string | null>(null);

  // Camera and motion effects are opt-in; operational telemetry is shown without staged presentation effects.
  const [showcaseMode] = useState(false);

  // Reduce Motion Setting (Honoring prefers-reduced-motion media query, toggleable in UI & persisted)
  const [reduceMotion, setReduceMotion] = useState<boolean>(() => {
    const saved = localStorage.getItem('airguard_reduce_motion');
    if (saved !== null) return saved === 'true';
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
    return false;
  });

  // Sync runtime flags for zero-overhead Cesium GPU property evaluation
  useEffect(() => {
    setShowcaseModeGlobal(showcaseMode);
  }, [showcaseMode]);

  useEffect(() => {
    setReduceMotionGlobal(reduceMotion);
  }, [reduceMotion]);

  // Listener for system prefers-reduced-motion changes
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = (e: MediaQueryListEvent) => {
      if (localStorage.getItem('airguard_reduce_motion') === null) {
        setReduceMotion(e.matches);
      }
    };
    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, []);

  // Real-Time Frame Rate Profiler (measures live rendering performance)
  const [fps, setFps] = useState<number>(0);
  const [mapViewMode, setMapViewMode] = useState<'2d' | '3d'>('2d');
  const fpsFrameCountRef = useRef(0);
  const fpsLastTimeRef = useRef(performance.now());

  useEffect(() => {
    if (mapViewMode !== '3d') {
      setFps(0);
      return;
    }
    let animId: number;
    const measureFps = (now: number) => {
      fpsFrameCountRef.current++;
      const elapsed = now - fpsLastTimeRef.current;
      if (elapsed >= 1000) {
        const calculatedFps = Math.round((fpsFrameCountRef.current * 1000) / elapsed);
        setFps(calculatedFps);
        fpsFrameCountRef.current = 0;
        fpsLastTimeRef.current = now;
      }
      animId = requestAnimationFrame(measureFps);
    };
    animId = requestAnimationFrame(measureFps);
    return () => cancelAnimationFrame(animId);
  }, [mapViewMode]);

  const [isCinematicActive, setIsCinematicActive] = useState<boolean>(false);
  const [cinematicStage, setCinematicStage] = useState<1 | 2 | 3>(1);
  const [cinematicProgress, setCinematicProgress] = useState<number>(0);

  // Global Sound Layer State (Off by default, persisted in localStorage)
  const [isSoundEnabled, setIsSoundEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem('airguard_sound_enabled');
    return saved !== null ? saved === 'true' : false; // OFF by default
  });

  const viewerRef = useRef<CesiumViewer | null>(null);
  const cinematicTimerRef = useRef<number[]>([]);

  // Chase Cam Fly-To State (< 3s smooth fly-to swooping into chase cam distance before drawer slides in)
  const [isChaseFlying, setIsChaseFlying] = useState<boolean>(false);
  const [chaseTargetCallsign, setChaseTargetCallsign] = useState<string | null>(null);
  const activeChaseFlightRef = useRef<string | null>(null);

  // Detector Risk Overlay State (only uses scored observations; persisted in localStorage)
  const [showConfidenceOverlay, setShowConfidenceOverlay] = useState<boolean>(() => {
    const saved = localStorage.getItem('airguard_confidence_overlay');
    return saved === 'true';
  });
  const [isConfidenceLegendCollapsed, setIsConfidenceLegendCollapsed] = useState<boolean>(true);

  const handleToggleConfidenceOverlay = useCallback((val: boolean) => {
    setShowConfidenceOverlay(val);
    localStorage.setItem('airguard_confidence_overlay', String(val));
  }, []);

  // Global toggle handler - instantly mutable, saves to localStorage, halts audio immediately when muted
  const handleToggleSound = useCallback(() => {
    setIsSoundEnabled(prev => {
      const next = !prev;
      localStorage.setItem('airguard_sound_enabled', String(next));
      if (!next) {
        stopAmbientAtmosphere(true);
      } else {
        if (showcaseMode && (isCinematicActive || isChaseFlying)) {
          startAmbientAtmosphere();
        }
      }
      return next;
    });
  }, [showcaseMode, isCinematicActive, isChaseFlying]);

  // Trigger live anomaly chime: strictly guarded to exploratory globe only (no sound during Detail drawer or technical screens)
  const triggerLiveAnomalyChime = useCallback(() => {
    if (!isSoundEnabled) return;
    if (currentTier !== 'tier2_radar') return;
    if (selectedFlightId !== null) return;

    playSoftAnomalyChime();
  }, [isSoundEnabled, currentTier, selectedFlightId]);

  // Watch alerts array for newly detected live anomalies
  const prevAlertCountRef = useRef<number>(alerts.length);
  useEffect(() => {
    if (alerts.length > prevAlertCountRef.current) {
      const latest = alerts[0];
      if (latest && !latest.acknowledged) {
        triggerLiveAnomalyChime();
      }
    }
    prevAlertCountRef.current = alerts.length;
  }, [alerts, triggerLiveAnomalyChime]);

  // Silence ambient audio in technical data-reading contexts (Detail drawer, Analytics, Config, Admin, Playback, Tier 1)
  useEffect(() => {
    if (!isSoundEnabled || currentTier !== 'tier2_radar' || selectedFlightId !== null || !showcaseMode) {
      stopAmbientAtmosphere();
    }
  }, [isSoundEnabled, currentTier, selectedFlightId, showcaseMode]);

  const handleSelectFlightWithChaseCam = useCallback((flight: Flight) => {
    const viewer = viewerRef.current;

    // Fast-path: If Showcase Mode is OFF, Reduce Motion is ON, or viewer camera unavailable, select immediately with zero animation delay
    if (!showcaseMode || reduceMotion || !viewer || !viewer.camera) {
      setSelectedFlightId(flight.id);
      setIsDetailDrawerOpen(true);
      return;
    }

    // If already inspecting this flight and no camera flight is pending, no-op
    if (selectedFlightId === flight.id && !isChaseFlying) {
      setIsDetailDrawerOpen(true);
      return;
    }

    // Cancel any active camera flight immediately (handles rapid multiple clicks without lag or queuing)
    viewer.camera.cancelFlight();

    // Start subtle ambient hum if sound & showcase mode are active
    if (showcaseMode && isSoundEnabled) {
      startAmbientAtmosphere();
    }

    // Momentarily close drawer during swooping flight to give full cinematic visibility
    setSelectedFlightId(null);
    activeChaseFlightRef.current = flight.id;
    setIsChaseFlying(true);
    setChaseTargetCallsign(flight.callsign || flight.id);

    // Aircraft position & target bounding sphere (targets live interpolated coordinates)
    const displayedAltFt = Number.isFinite(flight.altitude) ? flight.altitude : 0;
    const pos = aircraftMotionManager.getInterpolatedPosition(flight.id) || Cartesian3.fromDegrees(flight.lng, flight.lat, displayedAltFt * 0.3048);
    const targetSphere = new BoundingSphere(pos, 35);

    // Chase cam offset: viewpoint behind and slightly to the quarter of the aircraft, angled downward
    const flightHeadingDeg = aircraftMotionManager.getInterpolatedHeading(flight.id) || flight.heading || 0;
    const chaseHeading = CesiumMath.toRadians((flightHeadingDeg + 12) % 360);
    const chasePitch = CesiumMath.toRadians(-18); // looking down towards aircraft
    const chaseRange = 360; // meters - close cinematic chase distance

    const hpr = new HeadingPitchRange(chaseHeading, chasePitch, chaseRange);

    viewer.camera.flyToBoundingSphere(targetSphere, {
      offset: hpr,
      duration: 1.6, // Fast & snappy (< 3.0s threshold)
      easingFunction: EasingFunction.CUBIC_OUT,
      complete: () => {
        // Only open drawer if this aircraft is still the active target (safe from rapid click races)
        if (activeChaseFlightRef.current === flight.id) {
          setSelectedFlightId(flight.id);
          setIsDetailDrawerOpen(true);
          setIsChaseFlying(false);
          setChaseTargetCallsign(null);
          stopAmbientAtmosphere();
        }
      },
      cancel: () => {
        if (activeChaseFlightRef.current === flight.id) {
          setIsChaseFlying(false);
          setChaseTargetCallsign(null);
          stopAmbientAtmosphere();
        }
      }
    });
  }, [showcaseMode, reduceMotion, selectedFlightId, isChaseFlying, isSoundEnabled, setSelectedFlightId]);

  const handleMapSelectFlight = useCallback((flight: Flight | null) => {
    setSelectedFlightId(flight ? flight.id : null);
  }, [setSelectedFlightId]);

  const handleMapOpenDetails = useCallback((flight: Flight) => {
    setSelectedFlightId(flight.id);
    setIsDetailDrawerOpen(true);
  }, [setSelectedFlightId]);

  // Login form state
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);

  useEffect(() => {
    let active = true;
    const checkBackend = async () => {
      try {
        const response = await fetch(`${API_BASE}/health`, { cache: 'no-store' });
        const health = await response.json().catch(() => null) as { database?: string; redis?: string } | null;
        if (!active) return;
        if (response.ok) setBackendHealth('online');
        else if (health?.database === 'connected' && health.redis !== 'connected') setBackendHealth('degraded');
        else setBackendHealth('offline');
      } catch {
        if (active) setBackendHealth('offline');
      }
    };
    void checkBackend();
    const interval = window.setInterval(checkBackend, 10000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [setBackendHealth]);

  // Admin page state
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [adminUsers, setAdminUsers] = useState<User[]>([]);
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserRole, setNewUserRole] = useState("viewer");
  const [adminError, setAdminError] = useState<string | null>(null);
  const [adminSuccess, setAdminSuccess] = useState<string | null>(null);
  const [logFilterAction, setLogFilterAction] = useState("");

  const fetchWithAuth = useCallback(async (url: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers || {});
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
      setToken(null);
      setUser(null);
      throw new Error("Session expired. Please log in again.");
    }
    return res;
  }, [token, setToken, setUser]);

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    setIsLoggingIn(true);
    try {
      const formData = new URLSearchParams();
      formData.append("username", loginEmail);
      formData.append("password", loginPassword);

      if (isRegistering) {
        const registrationRes = await fetch(`${API_BASE}/api/v1/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: loginEmail, password: loginPassword })
        });
        if (!registrationRes.ok) {
          const registrationError = await registrationRes.json().catch(() => ({}));
          throw new Error(registrationError.detail || "Account registration failed.");
        }
      }

      const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
        method: "POST",
        body: formData,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        }
      });

      if (!res.ok) {
        throw new Error("Invalid clearance credentials.");
      }

      const tokenData = await res.json();
      const tempToken = tokenData.access_token;

      const profileRes = await fetch(`${API_BASE}/api/v1/auth/me`, {
        headers: {
          "Authorization": `Bearer ${tempToken}`
        }
      });

      if (!profileRes.ok) {
        throw new Error("Failed to fetch clearance profile.");
      }

      const profileData = await profileRes.json();
      setToken(tempToken);
      setUser(profileData);
      setLoginPassword("");
      setCurrentTier('tier2_radar');
    } catch (err: unknown) {
      setLoginError(err instanceof Error ? err.message : "Authentication link offline.");
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = () => {
    logout();
    setCurrentTier('tier1_overview');
  };

  const fetchAdminData = async () => {
    if (!token) return;
    try {
      const logsRes = await fetchWithAuth(`${API_BASE}/api/v1/admin/audit-logs${logFilterAction ? `?action=${logFilterAction}` : ''}`);
      if (logsRes.ok) {
        const logsData = await logsRes.json();
        setAuditLogs(logsData);
      }

      const usersRes = await fetchWithAuth(`${API_BASE}/api/v1/admin/users`);
      if (usersRes.ok) {
        const usersData = await usersRes.json();
        setAdminUsers(usersData);
      }
    } catch (err) {
      console.error("Failed to load admin data:", err);
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdminError(null);
    setAdminSuccess(null);
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/users`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email: newUserEmail,
          password: newUserPassword,
          role: newUserRole
        })
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.detail || "Failed to create user");
      }
      setAdminSuccess(`User ${newUserEmail} registered successfully.`);
      setNewUserEmail("");
      setNewUserPassword("");
      setNewUserRole("viewer");
      fetchAdminData();
    } catch (err: unknown) {
      setAdminError(err instanceof Error ? err.message : "Failed to submit operator data.");
    }
  };

  const handleDeleteUser = async (id: number) => {
    setAdminError(null);
    setAdminSuccess(null);
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/users/${id}`, {
        method: "DELETE"
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.detail || "Failed to delete user");
      }
      setAdminSuccess("User account deleted.");
      fetchAdminData();
    } catch (err: unknown) {
      setAdminError(err instanceof Error ? err.message : "Failed to execute delete sequence.");
    }
  };

  useEffect(() => {
    if (tier3Tab === 'admin' && token && currentUser?.role === 'admin') {
      fetchAdminData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier3Tab, token, currentUser, logFilterAction]);

  // RuleConfig Slider Config State
  const [config, setConfig] = useState({
    max_implied_speed_kmh: 1200.0,
    duplicate_icao_dist_km: 50.0,
    max_vertical_rate_ms: 50.0,
    max_ground_altitude_m: 100.0,
    max_ground_speed_ms: 77.0,
    min_flight_speed_ms: 20.0
  });

  // Historical Playback States
  const [currentUtcTime, setCurrentUtcTime] = useState<string>('');

  // Alerts sorting/filtering/pagination local state
  const [sortField, setSortField] = useState<'timestamp' | 'callsign' | 'scoreImpact'>('timestamp');
  const [sortAsc, setSortAsc] = useState<boolean>(false);
  const [alertPage, setAlertPage] = useState<number>(0);
  const [alertSearch, setAlertSearch] = useState<string>('');
  const [alertSeverityFilter, setAlertSeverityFilter] = useState<'all' | 'high' | 'medium' | 'unacked'>('all');
  const [alertActionError, setAlertActionError] = useState<string | null>(null);
  const [alertsPerPage, setAlertPerPage] = useState<number>(25);

  const [healthData, setHealthData] = useState<HealthStats>({
    poll_latency_ms: null,
    queue_depth: null,
    circuit_breaker_state: 'UNKNOWN',
    database_status: 'UNKNOWN',
    redis_status: 'UNKNOWN',
    last_successful_poll: null,
    last_poll_records: 0,
    rate_limit_remaining: null,
    total_real_states: 0,
    total_synthetic_states: 0,
    upstream_status: 'UNKNOWN',
    feed_mode: 'UNKNOWN',
    feed_source: 'none',
    max_allowed_poll_gap_seconds: 1800,
    fallback_reason: null,
    upstream_message: 'Waiting for the first response from the configured aircraft feed.',
    source_status: 'AWAITING_TELEMETRY',
    last_successful_update: null,
    next_attempt_at: null,
    retry_after: null,
    snapshot_age_seconds: null,
    snapshot_count: 0,
    consecutive_failures: 0,
    last_error: null,
    refresh_in_progress: false,
    manual_refresh_pending: false,
    refresh_interval_seconds: 0
  });
  const [refreshNowPending, setRefreshNowPending] = useState(false);
  const [refreshNowMessage, setRefreshNowMessage] = useState<string | null>(null);
  const [snapshotRevision, setSnapshotRevision] = useState(0);

  const [showDebugIndicator, setShowDebugIndicator] = useState<boolean>(false);
  const [, setIsDetailDrawerOpen] = useState<boolean>(false);

  const realFlightsCount = useMemo(() => {
    return flights.filter((flight) => !flight.is_synthetic && flight.source !== 'regional_fallback' && flight.staleness_status !== 'STALE').length;
  }, [flights]);

  const formatPollTime = (isoString?: string | null) => {
    if (!isoString) return 'Awaiting first poll...';
    try {
      const d = new Date(isoString);
      const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
      return `${d.toISOString().slice(11, 19)} UTC (${diffSec}s ago)`;
    } catch {
      return String(isoString);
    }
  };

  // Fetch initial thresholds config
  useEffect(() => {
    if (!token) return;
    const fetchConfig = async () => {
      try {
        const res = await fetchWithAuth(`${API_BASE}/api/v1/config`);
        if (res.ok) {
          const data = await res.json();
          setConfig(data);
        }
      } catch (err) {
        console.error("Config fetch failed:", err);
      }
    };
    fetchConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier3Tab, token]);

  // Synchronize token ref so reconnects dynamically read current valid clearance token
  const tokenRef = useRef<string | null>(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  // WebSocket Connection Handler
  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimeout: number | null = null;
    let reconnectDelay = 1000;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      // Dynamic auth token resolution: reconnects always use the current real session.
      const activeToken = localStorage.getItem('airguard_token') || tokenRef.current;
      if (!activeToken) {
        setWebsocketStatus('disconnected');
        return;
      }
      setWebsocketStatus('connecting');
      socket = new WebSocket(`${WS_BASE}/api/v1/stream?token=${encodeURIComponent(activeToken)}`);

      socket.onopen = () => {
        setWebsocketStatus('connected');
        setBackendHealth('online');
        reconnectDelay = 1000;
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.event === 'ALERT_TRIGGERED') {
            const rawCallsign = data.callsign?.trim() ? data.callsign : data.icao24;
            const opInfo = getAirlineInfo(rawCallsign, data.icao24);
            addAlert({
              id: String(data.id ?? `${data.icao24}-${data.detected_at ?? Date.now()}`),
              timestamp: new Date(data.detected_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
              detected_at: data.detected_at,
              callsign: rawCallsign.toUpperCase(),
              icao24: data.icao24,
              airline: opInfo.name,
              type: data.reason_text || "Signal Inconsistency",
              severity: data.combined_risk_score >= 0.8 ? 'high' : 'medium',
              scoreImpact: -Math.round(data.combined_risk_score * 100),
              acknowledged: false,
              is_synthetic: data.is_synthetic ?? false
            });
            updateFlightStatus(data.icao24, data.combined_risk_score);
          } else if (data.event === 'AIRCRAFT_UPDATE') {
            updateOrAddFlight(data.payload);
          } else if (data.event === 'AIRCRAFT_BATCH_UPDATE' && Array.isArray(data.payload?.items)) {
            updateOrAddFlights(data.payload.items);
          } else if (data.event === 'SOURCE_REFRESH_STATE') {
            const source = data.payload || data;
            setHealthData(previous => ({
              ...previous,
              source_status: source.source_status ?? previous.source_status,
              last_successful_update: source.last_successful_update ?? previous.last_successful_update,
              next_attempt_at: source.next_attempt_at ?? previous.next_attempt_at,
              retry_after: source.retry_after ?? previous.retry_after,
              snapshot_age_seconds: source.snapshot_age_seconds ?? previous.snapshot_age_seconds,
              snapshot_count: source.snapshot_count ?? previous.snapshot_count,
              consecutive_failures: source.consecutive_failures ?? previous.consecutive_failures,
              last_error: source.last_error ?? null,
              refresh_in_progress: Boolean(source.refresh_in_progress),
              manual_refresh_pending: Boolean(source.manual_refresh_pending),
              upstream_status: source.source_status === 'FRESH' ? 'LIVE' : source.source_status === 'STALE' ? 'STALE' : source.source_status === 'RATE_LIMITED' ? 'RATE_LIMITED' : source.source_status === 'UNAVAILABLE' || source.source_status === 'INVALID_RESPONSE' ? 'UNAVAILABLE' : previous.upstream_status
            }));
            if (source.snapshot_replaced) setSnapshotRevision(value => value + 1);
          }
        } catch (err) {
          console.error("Failed to parse websocket message:", err);
        }
      };

      socket.onclose = () => {
        if (disposed) return;
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
      disposed = true;
      if (socket) socket.close();
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
    };
  }, [addAlert, updateFlightStatus, updateOrAddFlight, updateOrAddFlights, setBackendHealth, setWebsocketStatus, token]);

  // Check system stats
  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const res = await fetchWithAuth(`${API_BASE}/api/v1/system-health`);
        if (res.ok) {
          const data = await res.json();
          setHealthData({
            poll_latency_ms: data.poll_latency_ms,
            queue_depth: data.queue_depth,
            circuit_breaker_state: data.circuit_breaker_state,
            database_status: data.database_status || 'UNKNOWN',
            redis_status: data.redis_status || 'UNKNOWN',
            last_successful_poll: data.last_successful_poll,
            last_poll_records: data.last_poll_records,
            last_normalized_records: data.last_normalized_records,
            last_poll_http_status: data.last_poll_http_status,
            rate_limit_remaining: data.rate_limit_remaining,
            total_real_states: data.total_real_states,
            total_synthetic_states: data.total_synthetic_states,
            upstream_status: data.upstream_status,
            feed_mode: data.feed_mode,
            max_allowed_poll_gap_seconds: data.max_allowed_poll_gap_seconds,
            feed_source: data.feed_source,
            fallback_reason: data.fallback_reason,
            upstream_message: data.upstream_message,
            source_status: data.source_status,
            source_name: data.source_name,
            last_successful_update: data.last_successful_update,
            next_attempt_at: data.next_attempt_at,
            retry_after: data.retry_after,
            snapshot_age_seconds: data.snapshot_age_seconds,
            snapshot_count: data.snapshot_count,
            consecutive_failures: data.consecutive_failures,
            last_error: data.last_error,
            refresh_in_progress: data.refresh_in_progress,
            manual_refresh_pending: data.manual_refresh_pending,
            refresh_interval_seconds: data.refresh_interval_seconds
          });
        }
      } catch (err) {
        // Degrade gracefully
      }
    };
    fetchHealth();
    const interval = setInterval(fetchHealth, 4000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Tick clock
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setCurrentUtcTime(now.toTimeString().split(' ')[0] + ' UTC');
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  // Fetch initial real aircraft and alerts from backend on mount (Zero mock data in live path)
  useEffect(() => {
    const fetchInitialAirspace = async () => {
      try {
        const alertsLoad = fetchWithAuth(`${API_BASE}/api/v1/alerts?limit=1000`).then(async (alertsRes) => {
          if (!alertsRes.ok) return;
          const alertsData = await alertsRes.json() as AlertApiResponse[];
          if (Array.isArray(alertsData)) {
            const mappedAlerts: AlertLog[] = alertsData.filter((a) => !a.is_synthetic).map((a) => {
              const rawCallsign = a.callsign?.trim() ? a.callsign : a.icao24;
              const opInfo = getAirlineInfo(rawCallsign, a.icao24);
              return {
                id: String(a.id),
                timestamp: new Date(a.detected_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                detected_at: a.detected_at,
                callsign: rawCallsign.toUpperCase(),
                icao24: a.icao24,
                airline: opInfo.name,
                type: a.reason_text || "Signal Inconsistency",
                severity: a.combined_risk_score >= 0.8 ? 'high' : 'medium',
                scoreImpact: -Math.round(a.combined_risk_score * 100),
                acknowledged: a.acknowledged ?? false,
                is_synthetic: a.is_synthetic ?? false
              };
            });
            const activeCountHeader = alertsRes.headers.get('X-Active-Alert-Count');
            setAlerts(mappedAlerts, activeCountHeader === null ? undefined : Number(activeCountHeader));
          }
        }).catch((error) => {
          console.warn("Initial alert fetch failed:", error);
        });
        const acRes = await fetchWithAuth(`${API_BASE}/api/v1/aircraft`);

        if (acRes.ok) {
        const states = await acRes.json() as AircraftApiState[];
        if (Array.isArray(states)) {
          const mapped: Flight[] = states.filter((s) => !s.is_synthetic && s.source !== 'regional_fallback').map((s) => {
              const calcTrust = s.trust_score !== undefined && s.trust_score !== null ? Math.round(s.trust_score) : Number.NaN;
              const visibleRisk = displayableRisk(s.combined_risk_score, s.assessment_status);
              const calcStatus = detectorStatusFromRisk(visibleRisk, s.assessment_status);

              return {
                id: s.icao24,
                received_at: s.received_at,
                callsign: s.callsign || `AC-${s.icao24.slice(0, 4).toUpperCase()}`,
                squawk: s.squawk ?? null,
                altitude: isObservedField(s.data_quality, 'altitude') ? Math.round(s.altitude_m * 3.28084) : Number.NaN,
                speed: isObservedField(s.data_quality, 'velocity') ? Math.round(s.velocity_ms * 1.94384) : Number.NaN,
                heading: isObservedField(s.data_quality, 'heading') ? Math.round(s.heading_deg) : Number.NaN,
                trustScore: calcTrust,
                combined_risk_score: visibleRisk,
                assessment_status: s.assessment_status,
                signalStrength: undefined,
                status: calcStatus,
                lat: s.latitude,
                lng: s.longitude,
                is_synthetic: Boolean(s.is_synthetic || s.source === 'regional_fallback'),
                data_quality: s.data_quality,
                source: s.source || 'source_unavailable',
                route: 'Route unknown',
                history: [],
                last_seen_seconds_ago: s.last_seen_seconds_ago ?? 0,
                staleness_status: s.staleness_status || 'LIVE',
                trilateration: undefined,
                ruleFlags: undefined,
                shapValues: []
              };
            });
            mapped.forEach(f => {
              aircraftMotionManager.updatePosition({
                icao24: f.id,
                lat: f.lat,
                lng: f.lng,
                altitudeFt: Number.isFinite(f.altitude) ? f.altitude : 0,
                headingDeg: Number.isFinite(f.heading) ? f.heading : 0,
                speedKnots: Number.isFinite(f.speed) ? f.speed : 0,
                durationSec: 8
              });
            });
            useStore.getState().setFlights(mapped);
          }
        }

        await alertsLoad;
      } catch (e) {
        console.error("Initial airspace fetch error:", e);
      }
    };
    fetchInitialAirspace();
  }, [fetchWithAuth, setAlerts]);

  // Keep the global alerts and authoritative active count updated periodically.
  useEffect(() => {
    if (!token) return;
    const refreshAlerts = async () => {
      try {
        const response = await fetchWithAuth(`${API_BASE}/api/v1/alerts?limit=1000`);
        if (!response.ok) return;
        const count = response.headers.get('X-Active-Alert-Count');
        const activeNum = count !== null && Number.isFinite(Number(count)) ? Number(count) : undefined;
        const alertsData = await response.json() as AlertApiResponse[];
        if (Array.isArray(alertsData)) {
          const mappedAlerts: AlertLog[] = alertsData.filter((a) => !a.is_synthetic).map((a) => {
            const rawCallsign = a.callsign?.trim() ? a.callsign : a.icao24;
            const opInfo = getAirlineInfo(rawCallsign, a.icao24);
            return {
              id: String(a.id),
              timestamp: new Date(a.detected_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
              detected_at: a.detected_at,
              callsign: rawCallsign.toUpperCase(),
              icao24: a.icao24,
              airline: opInfo.name,
              type: a.reason_text || "Signal Inconsistency",
              severity: a.combined_risk_score >= 0.8 ? 'high' : 'medium',
              scoreImpact: -Math.round(a.combined_risk_score * 100),
              acknowledged: a.acknowledged ?? false,
              is_synthetic: a.is_synthetic ?? false
            };
          });
          useStore.getState().setAlerts(mappedAlerts, activeNum);
        } else if (activeNum !== undefined) {
          useStore.getState().setAlerts([], activeNum);
        }
      } catch {
        // Retain the last known count during a transient API outage.
      }
    };
    const interval = window.setInterval(refreshAlerts, 20000);
    return () => window.clearInterval(interval);
  }, [fetchWithAuth, token]);

  // Continuous tracking integrity: Staleness increment ticker and timeout pruner
  // Thresholds follow the provider polling cadence so slower global queries remain visible as stale.
  const staleAfterSeconds = Math.max(20, (healthData.max_allowed_poll_gap_seconds || 1800) * 0.75);
  const removalAfterSeconds = Math.max(120, (healthData.max_allowed_poll_gap_seconds || 1800) * 1.5);
  useEffect(() => {
    const stalenessInterval = setInterval(() => {
      const currentFlights = useStore.getState().flights;
      if (currentFlights.length === 0) return;

      const updated = currentFlights.flatMap(f => {
          if (f.is_synthetic || f.source === 'regional_fallback') return [];
          const currentAge = (f.last_seen_seconds_ago ?? 0) + 2;
          const isStale = currentAge > staleAfterSeconds;
          return [{
            ...f,
            last_seen_seconds_ago: currentAge,
            staleness_status: isStale ? 'STALE' : 'LIVE'
          }];
        });

      useStore.getState().setFlights(updated);
    }, 2000);

    return () => clearInterval(stalenessInterval);
  }, [staleAfterSeconds, removalAfterSeconds]);

  // Reconcile the full aircraft snapshot periodically; websocket updates handle live movement between snapshots.
  // Ensures full snapshot integrity, zero gaps, and self-healing across connection interruptions
  useEffect(() => {
    const reconcileAirspace = async () => {
      try {
        const res = await fetchWithAuth(`${API_BASE}/api/v1/aircraft`);
        if (!res.ok) return;
        const liveStates = await res.json() as AircraftApiState[];
        if (!Array.isArray(liveStates)) return;

        const currentFlights = useStore.getState().flights;

        const currentById = new Map(currentFlights.map(f => [f.id, f]));
        const seenIcaos = new Set<string>();
        const merged: Flight[] = [];

        liveStates.forEach((s) => {
          if (s.is_synthetic || s.source === 'regional_fallback') return;
          seenIcaos.add(s.icao24);
          const existing = currentById.get(s.icao24);
          const altitude = isObservedField(s.data_quality, 'altitude') ? Math.round(s.altitude_m * 3.28084) : (existing?.altitude ?? Number.NaN);
          const speed = isObservedField(s.data_quality, 'velocity') ? Math.round(s.velocity_ms * 1.94384) : (existing?.speed ?? Number.NaN);
          const heading = isObservedField(s.data_quality, 'heading') ? Math.round(s.heading_deg) : (existing?.heading ?? Number.NaN);

          aircraftMotionManager.updatePosition({
            icao24: s.icao24,
            lat: s.latitude,
            lng: s.longitude,
            altitudeFt: Number.isFinite(altitude) ? altitude : 0,
            headingDeg: Number.isFinite(heading) ? heading : 0,
            speedKnots: Number.isFinite(speed) ? speed : 0,
            durationSec: 8
          });

          if (existing) {
            merged.push({
              ...existing,
              received_at: s.received_at,
              lat: s.latitude,
              lng: s.longitude,
              altitude,
              speed,
              heading,
              verticalRate: isObservedField(s.data_quality, 'vertical_rate') ? s.vertical_rate_ms : existing.verticalRate,
              last_seen_seconds_ago: s.last_seen_seconds_ago ?? 0,
              staleness_status: s.staleness_status || 'LIVE',
              route: s.route || existing.route || 'Route unknown',
              source: s.source || existing.source || 'source_unavailable',
              combined_risk_score: displayableRisk(s.combined_risk_score, s.assessment_status),
              assessment_status: s.assessment_status,
              status: detectorStatusFromRisk(displayableRisk(s.combined_risk_score, s.assessment_status), s.assessment_status),
              is_synthetic: Boolean(s.is_synthetic || s.source === 'regional_fallback'),
              data_quality: s.data_quality,
              squawk: s.squawk ?? existing.squawk
            });
          } else {
            const calcTrust = s.trust_score !== undefined && s.trust_score !== null ? Math.round(s.trust_score) : Number.NaN;
            const visibleRisk = displayableRisk(s.combined_risk_score, s.assessment_status);
            const calcStatus = detectorStatusFromRisk(visibleRisk, s.assessment_status);

            merged.push({
              id: s.icao24,
              received_at: s.received_at,
              callsign: s.callsign || `AC-${s.icao24.slice(0, 4).toUpperCase()}`,
              squawk: s.squawk ?? null,
              altitude,
              speed,
              heading,
              verticalRate: isObservedField(s.data_quality, 'vertical_rate') ? s.vertical_rate_ms : undefined,
              trustScore: calcTrust,
              combined_risk_score: visibleRisk,
              assessment_status: s.assessment_status,
              signalStrength: undefined,
              status: calcStatus,
              lat: s.latitude,
              lng: s.longitude,
              is_synthetic: Boolean(s.is_synthetic || s.source === 'regional_fallback'),
              data_quality: s.data_quality,
              source: s.source || 'source_unavailable',
              route: s.route || 'Route unknown',
              history: [],
              last_seen_seconds_ago: s.last_seen_seconds_ago ?? 0,
              staleness_status: s.staleness_status || 'LIVE',
              trilateration: undefined,
              ruleFlags: undefined,
              shapValues: []
            });
          }
        });

        // Retain existing flights that are still within 120s timeout
        currentFlights.forEach(f => {
          if (!seenIcaos.has(f.id) && !f.is_synthetic && f.source !== 'regional_fallback') {
            const age = f.last_seen_seconds_ago ?? 0;
            if (age <= removalAfterSeconds) {
              merged.push({
                ...f,
                staleness_status: age > staleAfterSeconds ? 'STALE' : f.staleness_status
              });
            }
          }
        });

        useStore.getState().setFlights(merged);
      } catch (err) {
        console.warn("Airspace periodic reconciliation failed:", err);
      }
    };

    void reconcileAirspace();
    const interval = setInterval(reconcileAirspace, 30000);
    return () => clearInterval(interval);
  }, [fetchWithAuth, staleAfterSeconds, removalAfterSeconds, snapshotRevision]);

  // --- Trust History State for Selected Target ---
  interface TrustHistoryItem {
    timestamp: string;
    time: string;
    risk_score: number;
    smoothed_risk_score: number;
    is_alert: boolean;
    reported_nic: number | null;
  }

  const [trustHistory, setTrustHistory] = useState<TrustHistoryItem[]>([]);
  const [trustPattern, setTrustPattern] = useState<string>("UNASSESSED");
  const [isTrustLoading, setIsTrustLoading] = useState(false);

  useEffect(() => {
    if (!selectedFlightId) {
      setTrustHistory([]);
      return;
    }

    let isMounted = true;
    setIsTrustLoading(true);

    const loadTrustHistory = async () => {
      try {
        const res = await fetchWithAuth(`${API_BASE}/api/v1/aircraft/${selectedFlightId}/trust-history`);
        if (res.ok) {
          const data = await res.json();
          if (isMounted && data.history && data.history.length > 0) {
            const formatted: TrustHistoryItem[] = data.history.map((pt: { timestamp: string | number; [key: string]: unknown }) => ({
              ...(pt as unknown as TrustHistoryItem),
              time: new Date(pt.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
            }));
            setTrustHistory(formatted);
            setTrustPattern(data.pattern || "UNASSESSED");
            setIsTrustLoading(false);
            return;
          }
        }
      } catch (e) {
        // Do not create local substitute readings when the API is unavailable.
      }

      if (!isMounted) return;

      setTrustHistory([]);
      setTrustPattern('UNAVAILABLE');
      setIsTrustLoading(false);
    };

    loadTrustHistory();

    return () => {
      isMounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFlightId, flights]);

  // --- Consolidated Detail Data for Selected Target (Endpoint: /api/v1/aircraft/{icao24}/detail) ---
  const [selectedFlightDetail, setSelectedFlightDetail] = useState<AircraftDetailResponse | null>(null);
  const [selectedFlightRoute, setSelectedFlightRoute] = useState<AircraftDetailResponse['route'] | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const isRouteLoading = isDetailLoading;

  useEffect(() => {
    if (!selectedFlightId) {
      setSelectedFlightDetail(null);
      setSelectedFlightRoute(null);
      setIsDetailLoading(false);
      return;
    }

    let isMounted = true;
    setIsDetailLoading(true);
    const fetchDetail = async () => {
      try {
        const res = await fetchWithAuth(`${API_BASE}/api/v1/aircraft/${selectedFlightId}/detail`);
        if (!res.ok) throw new Error(`Aircraft detail request failed: ${res.status}`);
        const data: AircraftDetailResponse = await res.json();
        if (!isMounted) return;
        setSelectedFlightDetail(data);
        setSelectedFlightRoute(data.route);
      } catch (err) {
        console.warn('[AirGuard] Aircraft detail is unavailable:', err);
        if (!isMounted) return;
        const currentFlight = useStore.getState().flights.find(f => f.id === selectedFlightId);
        setSelectedFlightDetail(null);
        setSelectedFlightRoute({
          icao24: selectedFlightId,
          callsign: currentFlight?.callsign,
          route_text: currentFlight?.route || 'Route unavailable',
          est_departure_airport: currentFlight?.estDepartureAirport,
          est_arrival_airport: currentFlight?.estArrivalAirport,
        });
      } finally {
        if (isMounted) setIsDetailLoading(false);
      }
    };

    fetchDetail();
    return () => { isMounted = false; };
  }, [fetchWithAuth, selectedFlightId]);
  // --- Camera motion and cinematic intro handlers ---
  const handleToggleReduceMotion = (val: boolean) => {
    setReduceMotion(val);
    localStorage.setItem('airguard_reduce_motion', String(val));
    if (val && isCinematicActive) {
      handleSkipCinematic();
    }
  };

  const handleSkipCinematic = () => {
    cinematicTimerRef.current.forEach(t => {
      clearTimeout(t);
      clearInterval(t);
    });
    cinematicTimerRef.current = [];
    if (viewerRef.current && !viewerRef.current.isDestroyed()) {
      viewerRef.current.camera.cancelFlight();
      viewerRef.current.camera.setView({
        destination: Cartesian3.fromDegrees(0, 18, 18000000)
      });
    }
    setIsCinematicActive(false);
    setCinematicProgress(1.0);
    sessionStorage.setItem('airguard_cinematic_dismissed', 'true');
    stopAmbientAtmosphere(true);
  };

  const launchCinematicFlight = (viewer: CesiumViewer) => {
    if (!viewer || viewer.isDestroyed()) return;
    cinematicTimerRef.current.forEach(t => {
      clearTimeout(t);
      clearInterval(t);
    });
    cinematicTimerRef.current = [];

    // If Showcase Mode is OFF or Reduce Motion is ON, jump directly to tactical position with zero delay
    if (!showcaseMode || reduceMotion) {
      viewer.camera.setView({
        destination: Cartesian3.fromDegrees(0, 18, 18000000)
      });
      setIsCinematicActive(false);
      setCinematicProgress(1.0);
      sessionStorage.setItem('airguard_cinematic_dismissed', 'true');
      return;
    }

    // Set initial high orbital camera view (26,000 km in deep space)
    viewer.camera.setView({
      destination: Cartesian3.fromDegrees(0, 18, 26000000),
      orientation: {
        heading: CesiumMath.toRadians(0),
        pitch: CesiumMath.toRadians(-90),
        roll: 0
      }
    });

    setIsCinematicActive(true);
    setCinematicStage(1);
    setCinematicProgress(0);

    // If sound layer is active, fade in subtle atmospheric wind ambience
    if (showcaseMode && isSoundEnabled) {
      startAmbientAtmosphere();
    }

    const t1 = window.setTimeout(() => setCinematicStage(2), 2200);
    const t2 = window.setTimeout(() => setCinematicStage(3), 4600);

    const startTime = performance.now();
    const durationMs = 7000;

    const animInterval = window.setInterval(() => {
      const elapsed = performance.now() - startTime;
      const p = Math.min(1.0, elapsed / durationMs);
      setCinematicProgress(p);
      if (p >= 1.0) {
        clearInterval(animInterval);
      }
    }, 40);

    cinematicTimerRef.current.push(t1, t2, animInterval);

    viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(0, 18, 18000000),
      duration: 7.0,
      easingFunction: EasingFunction.CUBIC_IN_OUT,
      complete: () => {
        clearInterval(animInterval);
        setIsCinematicActive(false);
        setCinematicProgress(1.0);
        sessionStorage.setItem('airguard_cinematic_dismissed', 'true');
        stopAmbientAtmosphere();
      },
      cancel: () => {
        clearInterval(animInterval);
        setIsCinematicActive(false);
        setCinematicProgress(1.0);
        stopAmbientAtmosphere();
      }
    });
  };

  const getAircraftOpacity = useCallback((idx: number) => {
    if (!isCinematicActive) return 1.0;
    // Aircraft fade into view one by one as camera descends through clouds toward tracked region
    const startThreshold = 0.35 + ((idx * 13) % 25) * 0.018;
    if (cinematicProgress < startThreshold) return 0.0;
    const p = (cinematicProgress - startThreshold) / 0.18;
    return Math.min(1.0, Math.max(0.0, p));
  }, [isCinematicActive, cinematicProgress]);

  // Keyboard listener for Escape to skip cinematic intro
  useEffect(() => {
    if (!isCinematicActive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleSkipCinematic();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isCinematicActive]);

  // Trigger cinematic intro when switching to Tier 2 Radar if showcaseMode is ON and reduceMotion is OFF
  useEffect(() => {
    if (currentTier !== 'tier2_radar') {
      if (isCinematicActive) {
        handleSkipCinematic();
      }
      return;
    }

    const isDismissed = sessionStorage.getItem('airguard_cinematic_dismissed') === 'true';

    const timer = setTimeout(() => {
      if (!viewerRef.current || viewerRef.current.isDestroyed()) return;

      if (showcaseMode && !reduceMotion && !isDismissed) {
        launchCinematicFlight(viewerRef.current);
      } else {
        viewerRef.current.camera.setView({
          destination: Cartesian3.fromDegrees(0, 18, 18000000)
        });
        setIsCinematicActive(false);
        setCinematicProgress(1.0);
      }
    }, 200);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTier, showcaseMode, reduceMotion]);

  // Save config settings
  const handleSaveConfig = async () => {
    if (!token) {
      alert("Sign in to save configuration changes.");
      return;
    }
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/v1/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      if (res.ok) {
        alert("Config parameters saved successfully.");
      } else {
        const errorData = await res.json();
        alert(`Failed to save config: ${errorData.detail || "Unauthorized access."}`);
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

  // Active flights selection
  const activeFlights = useMemo((): Flight[] => {
    return flights;
  }, [flights]);

  // --- Detector Risk Overlay (only sectors with persisted detector scores) ---
  const CELL_SIZE_DEG = 2.5;

  interface DetectorRiskSector {
    id: string;
    name: string;
    west: number;
    south: number;
    east: number;
    north: number;
    centerLng: number;
    centerLat: number;
    avgRisk: number;
    flightCount: number;
    flights: Flight[];
    hasAnomaly: boolean;
    minRisk: number;
    tier: 'high' | 'moderate' | 'low';
    rect: Rectangle;
    fillColor: Color;
    outlineColor: Color;
    labelColor: Color;
  }

  const confidenceSectors = useMemo((): DetectorRiskSector[] => {
    if (!activeFlights || activeFlights.length === 0) return [];

    const cellMap = new Map<string, {
      cellLat: number;
      cellLng: number;
      flights: Flight[];
    }>();

    for (const f of activeFlights) {
      if (f.is_synthetic || f.source === 'regional_fallback' || typeof f.lat !== 'number' || typeof f.lng !== 'number' || isNaN(f.lat) || isNaN(f.lng) || !Number.isFinite(f.combined_risk_score)) {
        continue;
      }
      const cellLat = Math.floor(f.lat / CELL_SIZE_DEG) * CELL_SIZE_DEG;
      const cellLng = Math.floor(f.lng / CELL_SIZE_DEG) * CELL_SIZE_DEG;
      const key = `${cellLat.toFixed(1)}_${cellLng.toFixed(1)}`;

      const existing = cellMap.get(key);
      if (existing) {
        existing.flights.push(f);
      } else {
        cellMap.set(key, { cellLat, cellLng, flights: [f] });
      }
    }

    const sectors: DetectorRiskSector[] = [];

    cellMap.forEach((entry) => {
      const { cellLat, cellLng, flights } = entry;
      const count = flights.length;
      if (count === 0) return;

      const risks = flights.map(f => (f.combined_risk_score as number) * 100);
      const avgRisk = risks.reduce((sum, value) => sum + value, 0) / count;
      const minRisk = Math.min(...risks);
      const hasAnomaly = flights.some(f => f.status === 'critical' || f.status === 'suspicious');

      const west = cellLng;
      const south = cellLat;
      const east = cellLng + CELL_SIZE_DEG;
      const north = cellLat + CELL_SIZE_DEG;
      const centerLng = cellLng + CELL_SIZE_DEG / 2;
      const centerLat = cellLat + CELL_SIZE_DEG / 2;

      // Scores are heuristic detector-risk outputs, not probability or signal confidence.
      let tier: 'high' | 'moderate' | 'low';
      let fillColor: Color;
      let outlineColor: Color;
      let labelColor: Color;

      if (avgRisk >= 65) {
        tier = 'high';
        fillColor = Color.fromCssColorString('#e11d48').withAlpha(0.40);
        outlineColor = Color.fromCssColorString('#f43f5e').withAlpha(0.92);
        labelColor = Color.fromCssColorString('#fda4af');
      } else if (avgRisk >= 35) {
        tier = 'moderate';
        fillColor = Color.fromCssColorString('#d97706').withAlpha(0.32);
        outlineColor = Color.fromCssColorString('#f59e0b').withAlpha(0.75);
        labelColor = Color.fromCssColorString('#fcd34d');
      } else {
        tier = 'low';
        fillColor = Color.fromCssColorString('#0284c7').withAlpha(0.24);
        outlineColor = Color.fromCssColorString('#38bdf8').withAlpha(0.60);
        labelColor = Color.fromCssColorString('#7dd3fc');
      }

      const id = `${Math.abs(cellLat).toFixed(0)}${cellLat >= 0 ? 'N' : 'S'}-${Math.abs(cellLng).toFixed(0)}${cellLng >= 0 ? 'E' : 'W'}`;
      const name = `Sector ${id} (mean detector risk: ${avgRisk.toFixed(1)}%)`;

      sectors.push({
        id,
        name,
        west,
        south,
        east,
        north,
        centerLng,
        centerLat,
        avgRisk,
        flightCount: count,
        flights,
        hasAnomaly,
        minRisk,
        tier,
        rect: Rectangle.fromDegrees(west, south, east, north),
        fillColor,
        outlineColor,
        labelColor
      });
    });

    return sectors;
  }, [activeFlights]);

  const overallDetectorRisk = useMemo(() => {
    if (confidenceSectors.length === 0) return Number.NaN;
    const totalFlights = confidenceSectors.reduce((acc, s) => acc + s.flightCount, 0);
    if (totalFlights === 0) return Number.NaN;
    const weightedSum = confidenceSectors.reduce((acc, s) => acc + s.avgRisk * s.flightCount, 0);
    return Math.round(weightedSum / totalFlights);
  }, [confidenceSectors]);

  const flaggedSectorsCount = useMemo(() => {
    return confidenceSectors.filter(s => s.tier === 'high' || s.hasAnomaly).length;
  }, [confidenceSectors]);

  const visibleAircraftCount = useMemo(() => {
    if (!isCinematicActive) return activeFlights.length;
    return activeFlights.filter((_, idx) => getAircraftOpacity(idx) > 0.05).length;
  }, [isCinematicActive, activeFlights, getAircraftOpacity]);

  // Filter and Sort active flight list
  const filteredFlights = useMemo(() => {
    return activeFlights.filter(f => {
      const matchesStatus = activeFilter === 'all' || f.status === activeFilter;
      const query = aircraftSearch.trim().toLowerCase();
      const matchesSearch = !query || [f.callsign, f.id, f.route, f.estDepartureAirport, f.estArrivalAirport]
        .some(value => value?.toLowerCase().includes(query));
      return matchesStatus && matchesSearch;
    });
  }, [activeFlights, activeFilter, aircraftSearch]);

  // Sort: Flagged-first
  const sortedFlights = useMemo(() => {
    return [...filteredFlights].sort((a, b) => {
      const severityMap = { 'critical': 3, 'suspicious': 2, 'normal': 1, 'unassessed': 0 };
      if (severityMap[a.status] !== severityMap[b.status]) {
        return severityMap[b.status] - severityMap[a.status];
      }
      const riskA = Number.isFinite(a.combined_risk_score) ? a.combined_risk_score as number : -1;
      const riskB = Number.isFinite(b.combined_risk_score) ? b.combined_risk_score as number : -1;
      return riskB - riskA;
    });
  }, [filteredFlights]);

  const selectedFlight = activeFlights.find(f => f.id === selectedFlightId);

  // 3D Route Line Arc Entities for Selected Aircraft
  const selectedRouteEntities = useMemo(() => {
    if (!selectedFlight) return null;

    const depStr = selectedFlightRoute?.est_departure_airport || selectedFlight.estDepartureAirport;
    const arrStr = selectedFlightRoute?.est_arrival_airport || selectedFlight.estArrivalAirport;

    const originResolved = resolveAirportCoords(depStr);
    const origin = originResolved || (
      selectedFlightRoute?.dep_lat != null && selectedFlightRoute?.dep_lng != null && depStr
        ? {
            lat: selectedFlightRoute.dep_lat,
            lng: selectedFlightRoute.dep_lng,
            label: depStr,
            name: depStr,
            city: depStr,
            iata: depStr
          }
        : null
    );

    const destinationResolved = resolveAirportCoords(arrStr);
    const destination = destinationResolved || (
      selectedFlightRoute?.arr_lat != null && selectedFlightRoute?.arr_lng != null && arrStr
        ? {
            lat: selectedFlightRoute.arr_lat,
            lng: selectedFlightRoute.arr_lng,
            label: arrStr,
            name: arrStr,
            city: arrStr,
            iata: arrStr
          }
        : null
    );

    const planeLat = selectedFlight.lat;
    const planeLng = selectedFlight.lng;
    const planeAltM = Number.isFinite(selectedFlight.altitude) ? Math.max(100, selectedFlight.altitude * 0.3048) : 100;

    let flownPositions: Cartesian3[] = [];
    if (origin) {
      flownPositions = computeRouteArcPositions(origin.lat, origin.lng, 100, planeLat, planeLng, planeAltM, 14);
    } else if (selectedFlight.history && selectedFlight.history.length > 1) {
      flownPositions = selectedFlight.history.map(h => Cartesian3.fromDegrees(h.lng, h.lat, planeAltM));
      flownPositions.push(Cartesian3.fromDegrees(planeLng, planeLat, planeAltM));
    } else {
      // Route unknown without recorded crumbs: no phantom lines
      flownPositions = [];
    }

    let remainingPositions: Cartesian3[] = [];
    if (destination) {
      remainingPositions = computeRouteArcPositions(planeLat, planeLng, planeAltM, destination.lat, destination.lng, 100, 14);
    }

    return {
      origin: origin ? {
        position: Cartesian3.fromDegrees(origin.lng, origin.lat, 100),
        lat: origin.lat,
        lng: origin.lng,
        label: origin.label,
        name: origin.name,
        city: origin.city,
        iata: origin.iata
      } : null,
      destination: destination ? {
        position: Cartesian3.fromDegrees(destination.lng, destination.lat, 100),
        lat: destination.lat,
        lng: destination.lng,
        label: destination.label,
        name: destination.name,
        city: destination.city,
        iata: destination.iata
      } : null,
      flownPositions,
      remainingPositions
    };
  }, [selectedFlight, selectedFlightRoute]);
  const selectedRouteForMap = useMemo(() => selectedRouteEntities ? ({
    origin: selectedRouteEntities.origin ? { lat: selectedRouteEntities.origin.lat, lng: selectedRouteEntities.origin.lng, label: selectedRouteEntities.origin.label } : null,
    destination: selectedRouteEntities.destination ? { lat: selectedRouteEntities.destination.lat, lng: selectedRouteEntities.destination.lng, label: selectedRouteEntities.destination.label } : null,
  }) : null, [selectedRouteEntities]);
  const hasActiveAlerts = activeAlertCount > 0;

  // Stats Card Calculations
  const stats = useMemo(() => {
    const total = activeFlights.length;
    const anomalies = activeFlights.filter(f => f.status === 'critical' || f.status === 'suspicious').length;
    const scoredLiveFlights = activeFlights.filter(f => !f.is_synthetic && f.source !== 'regional_fallback' && Number.isFinite(f.combined_risk_score));
    const avgRisk = scoredLiveFlights.length > 0
      ? Math.round(scoredLiveFlights.reduce((acc, f) => acc + (f.combined_risk_score as number), 0) / scoredLiveFlights.length * 1000) / 10
      : Number.NaN;
    return { total, anomalies, avgRisk, scoredCount: scoredLiveFlights.length };
  }, [activeFlights]);
  const liveAircraftCount = useMemo(() => activeFlights.filter(f => !f.is_synthetic && f.source !== 'regional_fallback' && !f.id.startsWith('sim-') && f.staleness_status !== 'STALE').length, [activeFlights]);
  const upstreamStatus = healthData.upstream_status || (healthData.last_poll_http_status === 429 ? 'RATE_LIMITED' : healthData.last_poll_http_status === 200 ? 'LIVE' : 'UNKNOWN');

  // Filter, Sort and Paginate Alerts
  const filteredAlerts = useMemo(() => {
    let list = alerts;
    if (alertSeverityFilter === 'high') {
      list = list.filter(a => a.severity === 'high');
    } else if (alertSeverityFilter === 'medium') {
      list = list.filter(a => a.severity === 'medium');
    } else if (alertSeverityFilter === 'unacked') {
      list = list.filter(a => !a.acknowledged);
    }
    if (alertSearch.trim()) {
      const q = alertSearch.trim().toLowerCase();
      list = list.filter(a =>
        a.callsign.toLowerCase().includes(q) ||
        a.icao24.toLowerCase().includes(q) ||
        (a.airline && a.airline.toLowerCase().includes(q)) ||
        (a.type && a.type.toLowerCase().includes(q))
      );
    }
    return list;
  }, [alerts, alertSeverityFilter, alertSearch]);

  const sortedAlerts = useMemo(() => {
    return [...filteredAlerts].sort((a, b) => {
      const valA = a[sortField];
      const valB = b[sortField];
      if (typeof valA === 'string') {
        return sortAsc ? valA.localeCompare(valB as string) : (valB as string).localeCompare(valA);
      }
      return sortAsc ? (valA as number) - (valB as number) : (valB as number) - (valA as number);
    });
  }, [filteredAlerts, sortField, sortAsc]);

  const paginatedAlerts = useMemo(() => {
    const start = alertPage * alertsPerPage;
    return sortedAlerts.slice(start, start + alertsPerPage);
  }, [sortedAlerts, alertPage, alertsPerPage]);

  // Client-Side CSV Export
  const exportAlertsCSV = () => {
    const headers = ["ID", "Timestamp", "Callsign", "Airline", "ICAO24", "Type/Reason", "Severity", "Impact", "Acknowledged"];
    const rows = sortedAlerts.map(a => [
      a.id, a.timestamp, a.callsign, a.airline || "Unknown", a.icao24, a.type, a.severity, a.scoreImpact, a.acknowledged
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

  const refreshLiveSnapshot = async () => {
    if (refreshNowPending || healthData.refresh_in_progress || healthData.manual_refresh_pending) return;
    setRefreshNowPending(true);
    setRefreshNowMessage(null);
    try {
      const response = await fetchWithAuth(`${API_BASE}/api/v1/system/refresh`, { method: 'POST' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || 'Refresh request could not be queued.');
      setRefreshNowMessage(body.queued ? 'Refresh queued; provider timing and rate limits are being respected.' : 'Refresh started.');
      setHealthData(previous => ({ ...previous, manual_refresh_pending: Boolean(body.queued), refresh_in_progress: !body.queued }));
    } catch (error) {
      setRefreshNowMessage(error instanceof Error ? error.message : 'Refresh request failed.');
    } finally {
      setRefreshNowPending(false);
    }
  };

  const downloadSessionReportPDF = async () => {
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/v1/reports/session`);
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
    setAlertActionError(null);
    if (!token) {
      setAlertActionError('Sign in again before acknowledging this alert.');
      return;
    }
    try {
      const response = await fetchWithAuth(`${API_BASE}/api/v1/alerts/${id}/acknowledge`, { method: 'POST' });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      acknowledgeAlert(id);
    } catch (error) {
      console.error('Failed to persist alert acknowledgement:', error);
      setAlertActionError('The server did not confirm this acknowledgement. The alert remains active.');
    }
  };

  // Virtualized row renderer
  const Row = ({ index, style }: { index: number; style: React.CSSProperties }) => {
    const flight = sortedFlights[index];
    if (!flight) return null;
    const isSelected = flight.id === selectedFlightId;
    const isStale = flight.staleness_status === 'STALE' || (flight.last_seen_seconds_ago !== undefined && flight.last_seen_seconds_ago > staleAfterSeconds);
    const airline = getAirlineInfo(flight.callsign);

    // Risk flags use the detector's configured thresholds; no trust rating is implied.
    const statusTextClass = flight.status === 'critical' ? 'text-rose-400 border-rose-500/50' : flight.status === 'suspicious' ? 'text-amber-400 border-amber-500/50' : 'text-slate-400 border-slate-600';

    const statusSymbol = flight.status === 'critical' ? '▲' : flight.status === 'suspicious' ? '◆' : flight.status === 'unassessed' ? '·' : '●';

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleSelectFlightWithChaseCam(flight);
      }
    };

    return (
      <div style={style} className="px-2">
        <div
          role="button"
          tabIndex={0}
          aria-label={`Flight ${flight.callsign || 'unknown'} (${airline.name}), detector status ${flight.status}, risk score ${flight.combined_risk_score ?? 'unassessed'}`}
          onClick={() => handleSelectFlightWithChaseCam(flight)}
          onKeyDown={handleKeyDown}
          className={`p-2.5 rounded-xl border cursor-pointer transition-colors focus:outline-none focus:border-sky-400 ${
            isSelected
              ? 'bg-sky-400/[0.08] border-sky-400/50 ring-1 ring-sky-400/15'
              : isStale
              ? 'bg-[#0a1220] border-slate-800/80 opacity-75 hover:opacity-100 hover:bg-slate-800/50'
              : 'bg-[#0c1524] border-slate-800/90 hover:bg-slate-800/50 hover:border-slate-700'
          }`}
        >
          <div className="flex justify-between items-center mb-1 gap-2">
            <div className="flex items-center gap-2 truncate">
              {/* Airline Color Accent Tag */}
              <span
                className="w-1.5 h-3.5 rounded-sm shrink-0 shadow-sm"
                style={{ backgroundColor: airline.color || '#38bdf8' }}
                title={`${airline.name} (${airline.code})`}
              />
              <div className="truncate">
                <div className="flex items-baseline gap-1.5 truncate">
                  <span className={`font-semibold text-[13px] ${isStale ? 'text-slate-300' : 'text-slate-100'}`}>
                    {flight.callsign}
                  </span>
                  <span className="text-[11px] text-sky-300/90 font-medium truncate">
                    {airline.name}
                  </span>
                </div>
              </div>
              {isStale && (
                <span className="text-[9px] px-1 py-0.2 rounded font-mono bg-amber-950/60 border border-amber-500/40 text-amber-300 font-bold shrink-0">
                  STALE ({Math.round(flight.last_seen_seconds_ago || 25)}s)
                </span>
              )}
            </div>
            <span className={`text-[10px] px-1.5 py-0.5 rounded border font-normal shrink-0 ${statusTextClass}`}>
              {statusSymbol} {Number.isFinite(flight.combined_risk_score) ? `${Math.round((flight.combined_risk_score as number) * 100)}% RISK` : 'UNASSESSED'}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-x-1 text-[10px] text-slate-500 font-normal pl-3.5">
            <div>Alt: {formatObservedNumber(flight.data_quality, 'altitude', flight.altitude)} ft</div>
            <div>Spd: {formatObservedNumber(flight.data_quality, 'velocity', flight.speed)} kts</div>
            <div className="text-right font-mono text-slate-400 truncate">ICAO: {flight.id.toUpperCase()}</div>
          </div>
        </div>
      </div>
    );
  };

  // Ground Station Access / Login Screen
  if (!token || !currentUser) {
    return (
      <div className="min-h-screen bg-[#060913] flex items-center justify-center p-4 select-none">
        <div className="w-full max-w-sm bg-[#0a0f1d] border border-slate-800 p-6 rounded">
          <div className="text-center mb-6 flex flex-col items-center">
            <div className="w-12 h-12 rounded-xl bg-[#0a1224] border border-sky-500/30 flex items-center justify-center mb-3 shadow-[0_0_20px_rgba(14,165,233,0.25)]">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" className="w-8 h-8" fill="none">
                <defs>
                  <linearGradient id="loginRadarSweep" x1="16" y1="4" x2="28" y2="16" gradientUnits="userSpaceOnUse">
                    <stop offset="0%" stopColor="#38bdf8" />
                    <stop offset="100%" stopColor="#10b981" />
                  </linearGradient>
                  <linearGradient id="loginPlaneGrad" x1="16" y1="8" x2="16" y2="24" gradientUnits="userSpaceOnUse">
                    <stop offset="0%" stopColor="#ffffff" />
                    <stop offset="100%" stopColor="#bae6fd" />
                  </linearGradient>
                </defs>
                <circle cx="16" cy="16" r="11.5" stroke="#0284c7" strokeWidth="1.2" opacity="0.4" />
                <path d="M 16 5 A 11 11 0 0 1 27 16" stroke="url(#loginRadarSweep)" strokeWidth="2" strokeLinecap="round" />
                <path d="M 16 8 L 18 13 L 24.5 16.5 L 24.5 18 L 18 16.5 L 18 21.5 L 20 23 L 20 24 L 16 23.2 L 12 24 L 12 23 L 14 21.5 L 14 16.5 L 7.5 18 L 7.5 16.5 L 14 13 Z"
                      fill="url(#loginPlaneGrad)"
                      stroke="#0284c7"
                      strokeWidth="0.5"
                      strokeLinejoin="round" />
                <circle cx="16" cy="8" r="1.2" fill="#10b981" />
              </svg>
            </div>
            <h1 className="text-xl font-bold tracking-tight text-white">AirGuard</h1>
            <span className="text-xs text-sky-400 font-medium tracking-normal mt-0.5">AIRSPACE TRUST & THREAT INTELLIGENCE</span>
            <p className="text-[11px] text-slate-400 mt-2 font-normal leading-relaxed max-w-xs">
              Airplanes broadcast unencrypted radio signals without authentication. AirGuard checks incoming telemetry for kinematic inconsistencies. These heuristic flags are leads for review, not proof of spoofing.
            </p>
          </div>

          <div role="status" aria-live="polite" className={`mb-4 flex items-center gap-2 rounded border px-3 py-2 text-[11px] ${backendHealth === 'online' ? 'border-emerald-800 bg-emerald-950/30 text-emerald-300' : backendHealth === 'checking' ? 'border-slate-700 bg-slate-900/70 text-slate-400' : backendHealth === 'degraded' ? 'border-amber-800 bg-amber-950/30 text-amber-200' : 'border-rose-900 bg-rose-950/30 text-rose-300'}`}>
            <span className={`h-2 w-2 rounded-full ${backendHealth === 'online' ? 'bg-emerald-400' : backendHealth === 'checking' ? 'bg-slate-500' : backendHealth === 'degraded' ? 'bg-amber-400' : 'bg-rose-400'}`} />
            {backendHealth === 'online' ? 'Backend, database, and Redis connected' : backendHealth === 'checking' ? 'Checking backend services…' : backendHealth === 'degraded' ? 'Backend and PostgreSQL connected; Redis unavailable — live streaming is degraded' : 'Backend or database unavailable — check the API and PostgreSQL services'}
          </div>

          {loginError && (
            <div className="mb-4 bg-rose-950/40 border border-rose-500/40 text-rose-400 text-[10px] p-2.5 rounded font-normal">
              ▲ ERROR: {loginError}
            </div>
          )}

          <form onSubmit={handleLoginSubmit} className="space-y-4">
            <div>
              <label className="text-[10px] text-slate-400 block mb-1 uppercase font-bold">Operator Email</label>
              <input
                type="email"
                required
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                placeholder="operator@airguard.sec"
                className="w-full bg-[#060913] border border-slate-800 rounded px-3 py-2 text-xs text-slate-100 placeholder-slate-600 focus:outline-none focus:border-cyan-500 font-normal"
              />
            </div>

            <div>
              <label className="text-[10px] text-slate-400 block mb-1 uppercase font-bold">Password</label>
              <input
                type="password"
                required
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                placeholder="••••••••••••"
                className="w-full bg-[#060913] border border-slate-800 rounded px-3 py-2 text-xs text-slate-100 placeholder-slate-600 focus:outline-none focus:border-cyan-500 font-normal"
              />
            </div>

            <button
              type="submit"
              disabled={isLoggingIn}
              className="w-full bg-cyan-500 hover:bg-cyan-400 disabled:bg-slate-800 disabled:text-slate-500 text-black font-bold text-xs py-2.5 rounded transition-colors mt-2"
            >
              {isLoggingIn ? (isRegistering ? "CREATING ACCOUNT..." : "SIGNING IN...") : (isRegistering ? "CREATE VIEWER ACCOUNT" : "SIGN IN")}
            </button>
          </form>

          <button
            type="button"
            onClick={() => { setIsRegistering((value) => !value); setLoginError(null); }}
            className="mt-4 w-full text-xs text-sky-300 hover:text-white transition-colors"
          >
            {isRegistering ? "Already registered? Sign in" : "New to AirGuard? Create a viewer account"}
          </button>

          <div className="mt-4 border-t border-slate-800/60 pt-3 text-center">
            <span className="text-[10px] text-slate-600 uppercase font-normal">
              SECURE LINK // SIGNED SESSION TOKEN
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`h-screen min-h-[640px] overflow-hidden bg-[#080f1b] text-slate-300 flex flex-col relative select-none ${reduceMotion ? 'reduce-motion' : ''}`}>
      {/* Subtle grid background */}
      <div className="absolute inset-0 grid-overlay pointer-events-none z-0"></div>

      {/* ========================================================================= */}
      {/* APPLICATION STATUS STRIP */}
      {/* "Is everything OK right now?" — Connected, Aircraft count, Active alerts. */}
      {/* Nothing else. Green means fine, red means look here.                      */}
      {/* ========================================================================= */}
      <header className="relative z-30 border-b border-slate-800 bg-[#0b1220]/95 px-4 md:px-6 py-2 flex flex-wrap items-center justify-between gap-3">

        {/* Brand */}
        <div className="flex items-center gap-3 cursor-pointer select-none" onClick={() => setCurrentTier('tier1_overview')}>
          <div className="w-8 h-8 rounded-lg bg-[#0a1224] border border-sky-500/30 flex items-center justify-center shadow-[0_0_12px_rgba(14,165,233,0.2)]">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" className="w-6 h-6" fill="none">
              <defs>
                <linearGradient id="headerRadarSweep" x1="16" y1="4" x2="28" y2="16" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stopColor="#38bdf8" />
                  <stop offset="100%" stopColor="#10b981" />
                </linearGradient>
                <linearGradient id="headerPlaneGrad" x1="16" y1="8" x2="16" y2="24" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stopColor="#ffffff" />
                  <stop offset="100%" stopColor="#bae6fd" />
                </linearGradient>
              </defs>
              <circle cx="16" cy="16" r="11.5" stroke="#0284c7" strokeWidth="1.2" opacity="0.4" />
              <path d="M 16 5 A 11 11 0 0 1 27 16" stroke="url(#headerRadarSweep)" strokeWidth="2" strokeLinecap="round" />
              <path d="M 16 8 L 18 13 L 24.5 16.5 L 24.5 18 L 18 16.5 L 18 21.5 L 20 23 L 20 24 L 16 23.2 L 12 24 L 12 23 L 14 21.5 L 14 16.5 L 7.5 18 L 7.5 16.5 L 14 13 Z"
                    fill="url(#headerPlaneGrad)"
                    stroke="#0284c7"
                    strokeWidth="0.5"
                    strokeLinejoin="round" />
              <circle cx="16" cy="8" r="1.2" fill="#10b981" />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-base font-bold tracking-tight text-white leading-none">AirGuard</span>
            </div>
            <span className="text-[11px] text-sky-400 font-medium tracking-normal block mt-0.5">AIRSPACE TRUST & THREAT INTELLIGENCE</span>
          </div>
        </div>

        {/* ----------------------------------------------------------------------- */}
        {/* Shared system and feed status */}
        {/* ----------------------------------------------------------------------- */}
        <div
          role="region"
          aria-label="AirGuard system status"
          className="flex items-center gap-3 bg-[#03060d] border border-slate-800 px-3.5 py-1.5 rounded"
        >
          {/* Item 1: Connected / Disconnected (Green / Red) */}
          <div className="flex items-center gap-2 pr-3 border-r border-slate-800">
            <span className="text-[10px] text-slate-500 font-bold uppercase hidden sm:inline">BACKEND STREAM:</span>
            <div className={`flex items-center gap-1.5 text-xs font-bold ${
              websocketStatus === 'connected' ? 'text-emerald-400' :
              websocketStatus === 'connecting' ? 'text-amber-400' : 'text-rose-400'
            }`}>
              <span className={`w-2 h-2 rounded-full ${
                websocketStatus === 'connected' ? 'bg-emerald-500' :
                websocketStatus === 'connecting' ? 'bg-amber-500' : 'bg-rose-500'
              }`} />
              <span>
                {websocketStatus === 'connected' ? 'CONNECTED' :
                 websocketStatus === 'connecting' ? 'CONNECTING...' : 'DISCONNECTED'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 pr-3 border-r border-slate-800">
            <span className="text-[10px] text-slate-500 font-bold uppercase hidden sm:inline">AIRCRAFT SOURCE:</span>
            <span className={`text-[10px] font-bold ${upstreamStatus === 'LIVE' ? 'text-emerald-300' : 'text-amber-300'}`}>
              {upstreamStatus === 'LIVE' ? 'LIVE FEED' : upstreamStatus}
            </span>
          </div>

          {/* Item 2: Aircraft Count */}
          <div className="flex items-center gap-2 pr-3 border-r border-slate-800">
            <span className="text-[10px] text-slate-500 font-bold uppercase hidden sm:inline">AIRSPACE:</span>
            <span className="text-xs font-bold text-slate-100">
              {liveAircraftCount} LIVE AIRCRAFT
            </span>
          </div>

          {/* Item 3: Active Alerts Count (GREEN = FINE, RED = LOOK HERE) */}
          <div
            onClick={() => {
              setCurrentTier('tier3_tools');
              setTier3Tab('alerts');
            }}
            role="button"
            tabIndex={0}
            title={hasActiveAlerts ? "Click to review active alerts" : "No active alerts are currently recorded"}
            className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded cursor-pointer transition-colors border ${
              hasActiveAlerts
                ? 'bg-rose-950/40 border-rose-500/60 text-rose-300'
                : 'bg-slate-900 border-slate-700 text-slate-300'
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${hasActiveAlerts ? 'bg-rose-500' : 'bg-slate-500'}`} />
            {hasActiveAlerts ? (
              <span className="text-xs font-bold text-rose-300">
                ▲ {activeAlertCount} ALERTS — LOOK HERE
              </span>
            ) : (
              <span className="text-xs font-bold text-emerald-400">
                ● NO ACTIVE ALERTS
              </span>
            )}
          </div>
        </div>

        {/* Primary workspace actions */}
        <div className={`items-center gap-2 ${currentTier === 'tier2_radar' ? 'hidden' : 'flex'}`}>

          {/* Primary action opens the live airspace workspace */}
          <button
            onClick={() => setCurrentTier('tier2_radar')}
            className={`text-xs font-bold px-3 py-1.5 rounded transition-colors flex items-center gap-1.5 ${
              currentTier === 'tier2_radar'
                ? 'bg-cyan-500 text-black'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700'
            }`}
          >
            <span>OPEN AIRSPACE</span>
            <span className="text-[10px]">→</span>
          </button>

          {/* Reduce Motion Setting (Honoring prefers-reduced-motion) */}
          <button
            onClick={() => handleToggleReduceMotion(!reduceMotion)}
            className={`text-xs font-mono font-bold px-2.5 py-1.5 rounded transition-all border flex items-center gap-1.5 ${
              reduceMotion
                ? 'bg-amber-950/70 border-amber-500 text-amber-300 shadow-[0_0_8px_rgba(245,158,11,0.25)]'
                : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
            }`}
            title={reduceMotion ? "Reduce Motion ON: Camera fly-to animations and transitions disabled (honoring prefers-reduced-motion)." : "Reduce Motion OFF: Normal animations enabled. Click to disable animations."}
          >
            <span>{reduceMotion ? '⚡' : '🎬'}</span>
            <span>MOTION: {reduceMotion ? 'REDUCED' : 'NORMAL'}</span>
          </button>

          {/* Global Sound Layer Toggle in Header (Persisted in localStorage, off by default) */}
          <button
            onClick={handleToggleSound}
            className={`text-xs font-mono font-bold px-2.5 py-1.5 rounded transition-all border flex items-center gap-1.5 ${
              isSoundEnabled
                ? 'bg-cyan-950/70 border-cyan-500 text-cyan-300 shadow-[0_0_8px_rgba(6,182,212,0.25)]'
                : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
            }`}
            title={isSoundEnabled ? "Sound Layer Enabled: Click to mute all audio" : "Sound Layer Muted (Default): Click to enable soft anomaly chimes and ambient flight hum"}
          >
            <span>{isSoundEnabled ? '🔊' : '🔇'}</span>
            <span>SOUND: {isSoundEnabled ? 'ON' : 'MUTED'}</span>
          </button>

          {/* Detector Risk Overlay Toggle in Header */}
          <button
            onClick={() => handleToggleConfidenceOverlay(!showConfidenceOverlay)}
            className={`text-xs font-mono font-bold px-2.5 py-1.5 rounded transition-all border flex items-center gap-1.5 ${
              showConfidenceOverlay
                ? 'bg-sky-950/70 border-sky-500 text-sky-300 shadow-[0_0_8px_rgba(56,189,248,0.25)]'
                : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
            }`}
            title="Shows only sectors with persisted heuristic detector-risk scores."
          >
            <span className={`w-1.5 h-1.5 rounded-full ${showConfidenceOverlay ? 'bg-sky-400 animate-pulse' : 'bg-slate-600'}`} />
            <span>RISK OVERLAY: {showConfidenceOverlay ? 'ON' : 'OFF'}</span>
          </button>

          {/* Additional workspaces */}
          <div className="flex bg-[#04070e] border border-slate-800 rounded p-0.5">
            <button
              onClick={() => setCurrentTier('tier1_overview')}
              className={`text-[10px] font-bold px-2 py-1 rounded transition-colors ${
                currentTier === 'tier1_overview'
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              STATUS
            </button>
            <button
              onClick={() => {
                setCurrentTier('tier3_tools');
                setTier3Tab('analytics');
              }}
              className={`text-[10px] font-bold px-2 py-1 rounded transition-colors ${
                currentTier === 'tier3_tools'
                  ? 'bg-slate-800 text-cyan-400'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              WORKSPACE
            </button>
          </div>

          {/* Clearance & Logout */}
          <div className="hidden lg:flex items-center gap-2 text-[10px] border-l border-slate-800 pl-3">
            <span className="text-slate-500 font-normal">{currentUser?.email}</span>
            <button
              onClick={handleLogout}
              className="bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-slate-200 px-2 py-0.5 rounded text-[10px] font-normal"
            >
              LOGOUT
            </button>
          </div>
        </div>

      </header>
      <nav aria-label="Primary navigation" className="relative z-20 flex flex-wrap items-center gap-1.5 px-4 md:px-6 py-1.5 border-b border-slate-800 bg-[#0b1220]">
        <button
          onClick={() => setCurrentTier('tier2_radar')}
          className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer ${
            currentTier === 'tier2_radar'
              ? 'bg-sky-500/20 text-sky-200 border border-sky-400/40 shadow-[0_0_10px_rgba(56,189,248,0.2)]'
              : 'text-slate-400 hover:bg-white/5 hover:text-slate-100'
          }`}
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 2a10 10 0 0 1 10 10" />
            <path d="M12 12 19 5" />
            <circle cx="12" cy="12" r="2" />
          </svg>
          <span>Airspace</span>
        </button>

        <button
          onClick={() => {
            setCurrentTier('tier3_tools');
            setTier3Tab('alerts');
          }}
          className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer ${
            currentTier === 'tier3_tools' && tier3Tab === 'alerts'
              ? 'bg-rose-500/20 text-rose-200 border border-rose-400/40 shadow-[0_0_10px_rgba(244,63,94,0.2)]'
              : 'text-slate-400 hover:bg-white/5 hover:text-slate-100'
          }`}
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>Threats</span>
          {activeAlertCount > 0 && (
            <span className="ml-1 px-1.5 py-0.2 rounded-full bg-rose-500/30 border border-rose-500/50 text-[10px] text-rose-300 font-bold font-mono">
              {activeAlertCount}
            </span>
          )}
        </button>

        <button
          onClick={() => {
            if (!selectedFlightId && flights[0]) setSelectedFlightId(flights[0].id);
            setCurrentTier('tier2_radar');
            setIsDetailDrawerOpen(true);
          }}
          className="px-3 py-1.5 text-xs font-semibold rounded-lg text-slate-400 hover:bg-white/5 hover:text-slate-100 transition-colors flex items-center gap-1.5 cursor-pointer"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
          <span>Investigate</span>
        </button>

        <button
          onClick={() => {
            setCurrentTier('tier3_tools');
            setTier3Tab('analytics');
          }}
          className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer ${
            currentTier === 'tier3_tools' && tier3Tab === 'analytics'
              ? 'bg-sky-500/20 text-sky-200 border border-sky-400/40 shadow-[0_0_10px_rgba(56,189,248,0.2)]'
              : 'text-slate-400 hover:bg-white/5 hover:text-slate-100'
          }`}
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="20" x2="18" y2="10" />
            <line x1="12" y1="20" x2="12" y2="4" />
            <line x1="6" y1="20" x2="6" y2="14" />
          </svg>
          <span>Analytics</span>
        </button>

        <span className="mx-1 h-5 border-l border-slate-800" />

        <button
          onClick={() => {
            setCurrentTier('tier3_tools');
            setTier3Tab('playback');
          }}
          className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer ${
            currentTier === 'tier3_tools' && tier3Tab === 'playback'
              ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-400/40'
              : 'text-slate-400 hover:bg-white/5 hover:text-slate-100'
          }`}
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polygon points="10 8 16 12 10 16 10 8" fill="currentColor" />
          </svg>
          <span>Replay</span>
        </button>

        <button
          onClick={() => {
            setCurrentTier('tier3_tools');
            setTier3Tab('config');
          }}
          className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer ${
            currentTier === 'tier3_tools' && tier3Tab === 'config'
              ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-400/40'
              : 'text-slate-400 hover:bg-white/5 hover:text-slate-100'
          }`}
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span>System</span>
        </button>
      </nav>

      {/* ========================================================================= */}
      {/* 4-STAGE PIPELINE DIAGNOSTIC HUD BANNER (DEV MODE & REAL-TIME CONTINUITY)  */}
      {/* Shows: (1) Poll Status/Time, (2) Raw OpenSky Count, (3) Detection Count,  */}
      {/*        (4) Count Reaching Frontend Store & 3D Globe                       */}
      {/* ========================================================================= */}
      <div className={`bg-[#0b1220] border-b border-slate-800 px-4 py-1 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono select-text z-20 ${currentTier === 'tier2_radar' ? 'hidden' : 'flex'}`}>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse"></span>
          <span className="font-bold text-cyan-400 tracking-wider">PIPELINE HUD:</span>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs">
          {/* Stage 1: Last Successful Poll Timestamp + HTTP Status */}
          <div className="flex items-center gap-1.5 bg-slate-900/90 px-2.5 py-0.5 rounded border border-slate-800">
            <span className="text-slate-500 font-bold">1. INGESTION:</span>
            <span className={healthData.last_poll_http_status === 200 ? "text-emerald-400 font-bold" : "text-amber-400 font-bold"}>
              {healthData.last_poll_http_status === 200 ? "HTTP 200 OK" : `HTTP ${healthData.last_poll_http_status || 'POLLING'}`}
            </span>
            <span className="text-slate-400 text-[10px]">
              ({healthData.last_successful_poll ? `${Math.max(0, Math.round((Date.now() - new Date(healthData.last_successful_poll).getTime()) / 1000))}s ago` : 'active'})
            </span>
          </div>

          {/* Stage 2: Raw OpenSky / Regional Count */}
          <div className="flex items-center gap-1.5 bg-slate-900/90 px-2.5 py-0.5 rounded border border-slate-800">
            <span className="text-slate-500 font-bold">2. UPSTREAM RAW:</span>
            <span className="text-cyan-300 font-bold">
              {healthData.last_poll_records} RECORDS
            </span>
            <span className="text-[10px] text-slate-500">
              [{healthData.feed_source || healthData.circuit_breaker_state || 'WAITING'}]
            </span>
          </div>

          {/* Stage 3: Verified input normalization */}
          <div className="flex items-center gap-1.5 bg-slate-900/90 px-2.5 py-0.5 rounded border border-slate-800">
            <span className="text-slate-500 font-bold">3. NORMALIZED INPUTS:</span>
            <span className="text-emerald-400 font-bold">
              {healthData.last_normalized_records ?? 0} RECORDS
            </span>
          </div>

          {/* Stage 4: Reaching Frontend Store & Globe */}
          <div className="flex items-center gap-1.5 bg-slate-900/90 px-2.5 py-0.5 rounded border border-slate-800">
            <span className="text-slate-500 font-bold">4. DISPLAYED:</span>
            <span className="text-sky-300 font-bold">
              {liveAircraftCount} LIVE AIRCRAFT
            </span>
          </div>
        </div>

        <div className="text-[10px] text-slate-500 hidden xl:flex items-center gap-2">
          <span>REGION: <strong className="text-slate-300">IND-FIR</strong></span>
          <span>•</span>
          <span>FEED: <strong className={websocketStatus === 'connected' ? "text-emerald-400" : "text-amber-400"}>{websocketStatus.toUpperCase()}</strong></span>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* Overview workspace */}
      {/* One clear focal point: The primary action button and 3 calm status metrics */}
      {/* ========================================================================= */}
      {currentTier === 'tier1_overview' && (
        <main className="relative z-10 flex-1 flex flex-col justify-between py-8 px-6 max-w-5xl mx-auto w-full overflow-y-auto">

          {/* Executive Hero - Quiet and Focused */}
          <div className="text-center max-w-2xl mx-auto mt-2">
            <h1 className="text-2xl font-bold text-slate-100">
              Can I trust this aircraft?
            </h1>
            <p className="text-xs text-slate-400 mt-2 font-normal">
              Review aircraft trust, active threats, and the evidence behind each detection.
            </p>
          </div>

          {/* ------------------------------------------------------------------- */}
          {/* Current system status */}
          {/* Status colors reserved strictly for status meaning                  */}
          {/* ------------------------------------------------------------------- */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 my-6 max-w-4xl mx-auto w-full">

            {/* Tile 1: Connection Health */}
            <div className="p-5 rounded border border-slate-800 bg-[#0a0f1d] flex flex-col justify-between">
              <div>
                <span className="text-[10px] text-slate-500 font-bold uppercase block mb-1">
                  1. Ingestion Stream Link
                </span>
                <div className="flex items-center gap-2 mt-2">
                  <span className={`w-3 h-3 rounded-full ${
                    websocketStatus === 'connected' ? 'bg-emerald-500' :
                    websocketStatus === 'connecting' ? 'bg-amber-500' : 'bg-rose-500'
                  }`} />
                  <span className={`text-base font-bold ${
                    websocketStatus === 'connected' ? 'text-emerald-400' :
                    websocketStatus === 'connecting' ? 'text-amber-400' : 'text-rose-400'
                  }`}>
                    {websocketStatus === 'connected' ? 'FEED CONNECTED' :
                     websocketStatus === 'connecting' ? 'CONNECTING...' : 'FEED OFFLINE'}
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-2 leading-relaxed font-normal">
                  {upstreamStatus === 'LIVE'
                    ? 'Current aircraft reports are arriving from the configured feed. Check System for source and ingestion details.'
                    : upstreamStatus === 'STALE'
                      ? 'No recent aircraft reports are available. Check System for source freshness and ingestion details.'
                      : upstreamStatus === 'RATE_LIMITED'
                        ? 'The configured source is rate-limiting requests. Check System for ingestion status and retry timing.'
                        : 'No current aircraft reports are available from the configured feed. Check System for source and ingestion details.'}
                </p>
              </div>
              <div className="mt-4 pt-3 border-t border-slate-800 text-[10px] text-slate-500 font-normal flex justify-between">
                <span>CIRCUIT BREAKER:</span>
                <span className="text-slate-300 font-bold">{healthData.circuit_breaker_state}</span>
              </div>
            </div>

            {/* Tile 2: Tracked Aircraft Count */}
            <div className="p-5 rounded border border-slate-800 bg-[#0a0f1d] flex flex-col justify-between">
              <div>
                <span className="text-[10px] text-slate-500 font-bold uppercase block mb-1">
                  2. Airspace Airframes Tracked
                </span>
                <div className="flex items-baseline gap-2 mt-2">
                  <span className="text-3xl font-bold text-slate-100">{stats.total}</span>
                  <span className="text-xs text-slate-400 font-normal">ACTIVE TARGETS</span>
                </div>
                <p className="text-xs text-slate-400 mt-2 leading-relaxed font-normal">
                  Aircraft reports currently visible from the configured feed.
                </p>
              </div>
              <div className="mt-4 pt-3 border-t border-slate-800 text-[10px] text-slate-500 font-normal flex justify-between">
                <span>MEAN DETECTOR TRIAGE RISK:</span>
                <span className="text-slate-300 font-bold">{Number.isFinite(stats.avgRisk) ? `${stats.avgRisk}%` : '—'}</span>
              </div>
            </div>

            {/* Tile 3: Active Alerts (GREEN = FINE, RED = LOOK HERE) */}
            <div className={`p-5 rounded border flex flex-col justify-between ${
              hasActiveAlerts
                ? 'bg-rose-950/20 border-rose-500/50'
                : 'bg-[#0a0f1d] border-slate-800'
            }`}>
              <div>
                <span className="text-[10px] text-slate-500 font-bold uppercase block mb-1">
                  3. Active Security Alerts
                </span>
                <div className="flex items-baseline gap-2 mt-2">
                  <span className={`text-3xl font-bold ${hasActiveAlerts ? 'text-rose-400' : 'text-emerald-400'}`}>
                    {activeAlertCount}
                  </span>
                  <span className={`text-xs font-bold ${hasActiveAlerts ? 'text-rose-400' : 'text-emerald-400'}`}>
                    {hasActiveAlerts ? 'ANOMALIES FLAGGED' : 'NO ACTIVE ALERTS'}
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-2 leading-relaxed font-normal">
                  {hasActiveAlerts ? (
                    <span className="text-rose-300">
                      Physical mismatch detected in telemetry signals. Review required.
                    </span>
                  ) : (
                    <span>
                      No active alerts are currently returned by the detection service.
                    </span>
                  )}
                </p>
              </div>
              <div className="mt-4 pt-3 border-t border-slate-800">
                {hasActiveAlerts ? (
                  <button
                    onClick={() => {
                      setCurrentTier('tier3_tools');
                      setTier3Tab('alerts');
                    }}
                    className="w-full bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs py-1.5 rounded transition-colors"
                  >
                    INSPECT {activeAlertCount} ALERTS →
                  </button>
                ) : (
                  <span className="text-[10px] text-emerald-400 font-normal block text-center">
                    NO ACTIVE ALERTS REPORTED
                  </span>
                )}
              </div>
            </div>

          </div>

          {/* Primary Action Buttons: ONE CLEAR FOCAL POINT */}
          <div className="text-center my-3">
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                onClick={() => setCurrentTier('tier2_radar')}
                className="bg-cyan-500 hover:bg-cyan-400 text-black font-bold text-xs py-3 px-7 rounded transition-colors"
              >
              OPEN AIRSPACE →
              </button>
            </div>
            <span className="block text-[10px] text-slate-500 mt-2 font-normal">
              Explore live aircraft reports and tracking details
            </span>
          </div>

          {/* Additional workspaces */}
          <div className="border-t border-slate-800/80 pt-5 mt-4 max-w-3xl mx-auto w-full">
            <span className="text-[10px] text-slate-500 font-bold uppercase block mb-3 text-center">
              MORE AIRGUARD WORKSPACES
            </span>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-center text-xs">
              <button
                onClick={() => {
                  setCurrentTier('tier3_tools');
                  setTier3Tab('alerts');
                }}
                className="p-2.5 rounded bg-[#080d18] border border-slate-800 hover:border-slate-700 text-slate-300 hover:text-slate-100 transition-colors"
              >
                <span className="block font-bold">Alerts Log</span>
                <span className="text-[10px] text-slate-500 font-normal">CSV & PDF reports</span>
              </button>
              <button
                onClick={() => {
                  setCurrentTier('tier3_tools');
                  setTier3Tab('analytics');
                }}
                className="p-2.5 rounded bg-[#080d18] border border-slate-800 hover:border-slate-700 text-slate-300 hover:text-slate-100 transition-colors"
              >
                <span className="block font-bold">Analytics</span>
                <span className="text-[10px] text-slate-500 font-normal">Live detector overview</span>
              </button>
              <button
                onClick={() => {
                  setCurrentTier('tier3_tools');
                  setTier3Tab('config');
                }}
                className="p-2.5 rounded bg-[#080d18] border border-slate-800 hover:border-slate-700 text-slate-300 hover:text-slate-100 transition-colors"
              >
                <span className="block font-bold">Thresholds</span>
                <span className="text-[10px] text-slate-500 font-normal">Envelope sliders</span>
              </button>
              <button
                onClick={() => {
                  setCurrentTier('tier3_tools');
                  setTier3Tab('playback');
                }}
                className="p-2.5 rounded bg-[#080d18] border border-slate-800 hover:border-slate-700 text-slate-300 hover:text-slate-100 transition-colors"
              >
                <span className="block font-bold">Playback</span>
                <span className="text-[10px] text-slate-500 font-normal">Timeline replay</span>
              </button>
            </div>
          </div>

        </main>
      )}

      {/* ========================================================================= */}
      {/* Live airspace workspace */}
      {/* One clear focal point: The Cesium 3D Globe overlay.                       */}
      {/* Full height, calm borders, zero decorative hover-bounces or glows.        */}
      {/* ========================================================================= */}
      {currentTier === 'tier2_radar' && (
        <div className="flex-1 flex flex-col min-h-0 overflow-y-auto lg:overflow-hidden relative z-10 px-4 xl:px-8 pt-2 pb-4">

          {/* Airspace workspace navigation */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-slate-800 pb-2 mb-3 text-xs gap-2">
            <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2">
              <span className="text-slate-100 font-semibold text-sm tracking-tight">
                Live airspace
              </span>
              <span className="text-[11px] text-slate-400 font-normal">
                {liveAircraftCount} live aircraft <span className="text-slate-600">·</span> <span className={activeAlertCount ? 'text-rose-300' : 'text-emerald-300'}>{activeAlertCount} active alerts across airspace</span>
              </span>
            </div>

            {/* Other AirGuard workspaces */}
            <div className="hidden items-center gap-1.5 text-[10px]">
              <span className="text-slate-500 uppercase font-bold mr-1 hidden md:inline">More:</span>
              <button
                onClick={() => {
                  setCurrentTier('tier3_tools');
                  setTier3Tab('alerts');
                }}
                className={`px-2 py-0.5 rounded border font-normal ${
                  hasActiveAlerts ? 'bg-rose-950/30 border-rose-500/40 text-rose-300' : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                Alerts ({alerts.length})
              </button>
              <button
                onClick={() => {
                  setCurrentTier('tier3_tools');
                  setTier3Tab('analytics');
                }}
                className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 font-normal"
              >
                Analytics
              </button>
              <button
                onClick={() => {
                  setCurrentTier('tier3_tools');
                  setTier3Tab('config');
                }}
                className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 font-normal"
              >
                Config
              </button>
              <button
                onClick={() => {
                  setCurrentTier('tier3_tools');
                  setTier3Tab('playback');
                }}
                className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 font-normal"
              >
                Playback
              </button>
              {currentUser?.role === 'admin' && (
                <button
                  onClick={() => {
                    setCurrentTier('tier3_tools');
                    setTier3Tab('admin');
                  }}
                  className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 font-normal"
                >
                  Admin
                </button>
              )}
              <button
                onClick={() => handleToggleReduceMotion(!reduceMotion)}
                className={`px-2 py-0.5 rounded border text-[11px] font-mono transition-colors ${
                  reduceMotion
                    ? 'bg-amber-950/60 border-amber-500/50 text-amber-300'
                    : 'bg-slate-900 border-slate-800 text-slate-500 hover:text-slate-400'
                }`}
                title="Toggle Reduce Motion setting (honoring prefers-reduced-motion)"
              >
                MOTION [{reduceMotion ? 'REDUCED' : 'NORMAL'}]
              </button>
              <button
                onClick={() => setShowDebugIndicator(prev => !prev)}
                className={`px-2 py-0.5 rounded border text-[11px] font-mono transition-colors ${
                  showDebugIndicator
                    ? 'bg-cyan-950/60 border-cyan-500/50 text-cyan-300'
                    : 'bg-slate-900 border-slate-800 text-slate-500 hover:text-slate-400'
                }`}
                title="Toggle OpenSky live ingestion debug indicator"
              >
                DEBUG [{showDebugIndicator ? 'ON' : 'OFF'}]
              </button>
              <button
                onClick={() => handleToggleConfidenceOverlay(!showConfidenceOverlay)}
                className={`px-2 py-0.5 rounded border text-[11px] font-mono transition-colors flex items-center gap-1.5 ${
                  showConfidenceOverlay
                    ? 'bg-sky-950/60 border-sky-500/50 text-sky-300 shadow-[0_0_10px_rgba(56,189,248,0.25)]'
                    : 'bg-slate-900 border-slate-800 text-slate-500 hover:text-slate-400'
                }`}
                title="Shows only sectors with persisted heuristic detector-risk scores."
              >
                <span className={`w-1.5 h-1.5 rounded-full ${showConfidenceOverlay ? 'bg-sky-400 animate-pulse' : 'bg-slate-600'}`} />
                <span>SIGNAL OVERLAY [{showConfidenceOverlay ? 'ON' : 'OFF'}]</span>
              </button>

              {/* Map Mode Toggle: 2D Light Map (Default) vs 3D Globe */}
              <div className="flex bg-slate-900 border border-slate-800 rounded p-0.5 text-[11px] font-mono">
                <button
                  onClick={() => setMapViewMode('2d')}
                  className={`px-2.5 py-0.5 rounded transition-all font-semibold flex items-center gap-1.5 ${
                    mapViewMode === '2d'
                      ? 'bg-sky-400/15 text-sky-200 border border-sky-300/30'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="Switch to clean 2D Light Map view"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-sky-300" />
                  <span>2D MAP</span>
                </button>
                <button
                  onClick={() => setMapViewMode('3d')}
                  className={`px-2.5 py-0.5 rounded transition-all font-semibold flex items-center gap-1.5 ${
                    mapViewMode === '3d'
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-[0_0_10px_rgba(6,182,212,0.2)]'
                    : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="Switch to Cesium 3D Globe view"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
                  <span>3D GLOBE</span>
                </button>
              </div>

            </div>
          </div>

          {(() => {
            const updateAgeSeconds = healthData.last_successful_update ? Math.max(0, Math.floor((Date.now() - Date.parse(healthData.last_successful_update)) / 1000)) : null;
            const isFresh = updateAgeSeconds !== null && updateAgeSeconds <= 35 && healthData.source_status === 'FRESH';
            const isAging = updateAgeSeconds !== null && updateAgeSeconds > 35 && updateAgeSeconds <= 90;
            const isStaleSnapshot = updateAgeSeconds !== null && updateAgeSeconds > 90;

            const freshnessText = healthData.refresh_in_progress
              ? 'Refreshing live feed'
              : isStaleSnapshot
              ? 'Last confirmed snapshot · stale'
              : isAging
              ? 'Snapshot aging · polling active'
              : isFresh
              ? 'Live snapshot current'
              : healthData.source_status === 'RATE_LIMITED'
              ? 'Provider rate limited · retaining last snapshot'
              : healthData.source_status === 'UNAVAILABLE' || healthData.source_status === 'INVALID_RESPONSE'
              ? 'Feed unavailable · retaining last snapshot'
              : 'Awaiting first valid live snapshot';

            const formattedAge = updateAgeSeconds !== null
              ? (updateAgeSeconds < 60 ? `${updateAgeSeconds}s ago` : `${Math.floor(updateAgeSeconds / 60)}m ${updateAgeSeconds % 60}s ago`)
              : '—';

            return (
              <section aria-label="Live source freshness" className="mb-3 flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2">
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${healthData.refresh_in_progress ? 'animate-pulse bg-sky-400' : isFresh ? 'bg-emerald-400' : isAging ? 'bg-cyan-400' : isStaleSnapshot || healthData.source_status === 'RATE_LIMITED' ? 'bg-amber-400' : 'bg-slate-500'}`} />
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-200">
                      {freshnessText}
                    </span>
                  </div>
                  <span className="text-[11px] text-slate-400">{healthData.snapshot_count ?? flights.length} aircraft in last valid snapshot</span>
                  <span className="text-[11px] text-slate-400">Updated {formattedAge}</span>
                  <span className="text-[11px] text-slate-400">Next attempt {healthData.next_attempt_at ? (Date.parse(healthData.next_attempt_at) <= Date.now() ? 'due' : `in ${Math.ceil((Date.parse(healthData.next_attempt_at) - Date.now()) / 1000)}s`) : 'pending'}</span>
                  {healthData.last_error && <span title={healthData.last_error} className="max-w-[280px] truncate text-[11px] text-amber-300">{healthData.last_error}</span>}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {refreshNowMessage && <span role="status" className="max-w-[280px] text-[11px] text-slate-400">{refreshNowMessage}</span>}
                  <button type="button" onClick={() => void refreshLiveSnapshot()} disabled={refreshNowPending || healthData.refresh_in_progress || healthData.manual_refresh_pending} className="rounded-lg border border-sky-700/70 bg-sky-950/40 px-3 py-2 text-[11px] font-semibold text-sky-200 transition hover:border-sky-500 hover:bg-sky-900/50 disabled:cursor-not-allowed disabled:opacity-50">
                    {refreshNowPending || healthData.refresh_in_progress ? 'Refreshing…' : healthData.manual_refresh_pending ? 'Refresh queued' : 'Refresh now'}
                  </button>
                </div>
              </section>
            );
          })()}

          {flights.length === 0 && (
            <div role="status" className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3 text-sm text-slate-300">
              <span className="font-semibold text-amber-200">No current aircraft reports.</span>{' '}
              {healthData.upstream_message || 'Waiting for the global live feed.'}
            </div>
          )}

          {/* Main Tactical Workspace: 65% Globe + 35% List/Drawer */}
          <div className="flex-1 grid grid-cols-12 gap-3 min-h-0">

            {/* Left 65%: The Globe is the clear focal point */}
            <section className="col-span-12 h-[52vh] min-h-[360px] lg:h-auto lg:min-h-0 lg:col-span-9 bg-[#0b1220] border border-slate-700/70 rounded-xl overflow-hidden relative flex flex-col shadow-2xl shadow-black/20">
              <div className="absolute top-3 left-3 z-10 flex items-center gap-2 bg-[#0b1220]/90 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs font-mono backdrop-blur-xl shadow-lg">
                <span className={`w-2 h-2 rounded-full ${mapViewMode === '3d' ? 'bg-sky-300' : 'bg-emerald-400'}`}></span>
                <span className="text-[10px] font-semibold tracking-wide text-slate-200">
                  {mapViewMode === '3d' ? '3D GLOBE' : '2D AIRSPACE MAP'}
                </span>
                <span className="text-slate-700">|</span>
                <span className="text-[10px] text-slate-400">{liveAircraftCount} live aircraft</span>
                {mapViewMode === '3d' && <>
                  <span className="text-slate-700">|</span>
                  <span className={`text-[10px] font-semibold ${fps >= 50 ? 'text-emerald-400' : fps >= 30 ? 'text-amber-400' : 'text-rose-400'}`}>{fps} FPS</span>
                </>}
                {reduceMotion && (
                  <span className="text-[9px] text-amber-400 bg-amber-950/60 px-1 py-0.2 rounded border border-amber-800/60">
                    REDUCED MOTION
                  </span>
                )}
              </div>

              {/* Detector Risk Overlay: sector legend and persisted score coverage */}
              {showConfidenceOverlay && (
              <div className="absolute top-12 left-3 z-20 max-w-xs sm:max-w-sm bg-[#101a2b]/95 border border-slate-700 rounded-xl shadow-xl p-3 backdrop-blur-md text-xs font-mono select-none animate-fadeIn">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-1.5 mb-2">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-sky-400 animate-pulse" />
                      <span className="text-[11px] font-bold tracking-wider text-sky-300 uppercase">
                        Detector Risk Overlay
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setIsConfidenceLegendCollapsed(prev => !prev)}
                        className="text-slate-500 hover:text-slate-300 text-[10px] px-1 py-0.5 rounded hover:bg-slate-800"
                        title={isConfidenceLegendCollapsed ? "Expand legend" : "Collapse legend"}
                      >
                        {isConfidenceLegendCollapsed ? '▼' : '▲'}
                      </button>
                      <button
                        onClick={() => handleToggleConfidenceOverlay(false)}
                        className="text-slate-500 hover:text-rose-400 text-[10px] px-1 py-0.5 rounded hover:bg-slate-800"
                        title="Turn off Detector Risk Overlay"
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  {/* One-Line Required Caption */}
                  <p className="text-[10px] text-slate-300 leading-snug mb-2 italic">
                    &ldquo;Shows sectors with persisted detector scores and their mean heuristic risk. Unscored aircraft are omitted.&rdquo;
                  </p>

                  {!isConfidenceLegendCollapsed && (
                    <>
                      {/* Detector risk scale */}
                      <div className="space-y-1 mb-2.5">
                        <div className="flex items-center justify-between text-[9px] text-slate-400 uppercase tracking-wider font-semibold">
                          <span>Mean detector risk</span>
                          <span className="text-slate-400">Heuristic, not probability</span>
                        </div>
                        <div className="h-2 w-full rounded-sm bg-gradient-to-r from-rose-500 via-amber-400 to-sky-400 shadow-inner" />
                        <div className="flex items-center justify-between text-[9px] text-slate-400 font-mono">
                          <span className="text-sky-300 font-semibold">&lt;35% Lower</span>
                          <span className="text-amber-400 font-semibold">35–64% Elevated</span>
                          <span className="text-rose-400 font-semibold">≥65% Review threshold</span>
                        </div>
                      </div>

                      {/* Real-Time Airspace Integrity Metrics */}
                      <div className="pt-1.5 border-t border-slate-800/80 grid grid-cols-3 gap-1.5 text-center text-[10px]">
                        <div className="bg-slate-900/80 border border-slate-800 rounded p-1">
                          <div className="text-slate-500 text-[9px]">Sectors</div>
                          <div className="text-slate-200 font-bold">{confidenceSectors.length} Active</div>
                        </div>
                        <div className="bg-slate-900/80 border border-slate-800 rounded p-1">
                          <div className="text-slate-500 text-[9px]">Mean triage risk</div>
                          <div className={`font-bold ${overallDetectorRisk >= 65 ? 'text-rose-400' : overallDetectorRisk >= 35 ? 'text-amber-400' : 'text-sky-300'}`}>
                            {Number.isFinite(overallDetectorRisk) ? `${overallDetectorRisk}%` : 'No scored observations'}
                          </div>
                        </div>
                        <div className="bg-slate-900/80 border border-slate-800 rounded p-1">
                          <div className="text-slate-500 text-[9px]">Alert Sectors</div>
                          <div className={`font-bold ${flaggedSectorsCount > 0 ? 'text-rose-400 animate-pulse' : 'text-emerald-400'}`}>
                            {flaggedSectorsCount > 0 ? `${flaggedSectorsCount} Review` : 'No review flags'}
                          </div>
                        </div>
                      </div>

                      {/* Explicit Differentiation Badge */}
                      <div className="mt-2 pt-1.5 border-t border-slate-800/60 flex items-center justify-between text-[9px] text-slate-500">
                        <span>Persisted scored aircraft only</span>
                        <span className="text-sky-400 font-semibold">NOT A PROBABILITY</span>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Minimized Pill when Overlay is OFF */}
              {!showConfidenceOverlay && (
                <button
                  onClick={() => handleToggleConfidenceOverlay(true)}
                  className="absolute top-12 left-3 z-20 bg-slate-950/90 border border-sky-500/40 text-sky-300 hover:text-sky-200 text-[10px] font-mono px-2 py-1 rounded shadow-lg flex items-center gap-1.5"
                  title="Shows only sectors with persisted heuristic detector-risk scores."
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-sky-400" />
                  <span>DETECTOR RISK OVERLAY [OFF]</span>
                </button>
              )}

              {/* Dev-Mode 4-Stage Ingestion & Telemetry Diagnostic HUD */}
              {showDebugIndicator && (
                <div className="absolute top-3 right-3 z-30 max-w-sm sm:max-w-md bg-slate-950/95 border-2 border-cyan-500/70 rounded-lg shadow-[0_0_30px_rgba(6,182,212,0.35)] p-3 backdrop-blur-md text-xs font-mono select-none">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-1.5 mb-2.5">
                    <div className="flex items-center gap-2">
                      <span className={`w-2.5 h-2.5 rounded-full ${
                        healthData?.last_successful_poll
                          ? 'bg-emerald-400 animate-pulse'
                          : healthData?.circuit_breaker_state?.includes('RATE_LIMITED')
                          ? 'bg-amber-400 animate-ping'
                          : 'bg-rose-400'
                      }`} />
                      <span className="text-[12px] font-extrabold tracking-wider text-cyan-300">
                        PIPELINE TELEMETRY DIAGNOSTIC
                      </span>
                      <span className="text-[9px] px-1.5 py-0.5 bg-cyan-950 text-cyan-400 border border-cyan-600/60 rounded font-bold">
                        DEV-HUD
                      </span>
                    </div>
                    <button
                      onClick={() => setShowDebugIndicator(false)}
                      className="text-slate-400 hover:text-white text-[11px] ml-2 px-1.5 py-0.5 bg-slate-900 border border-slate-700 rounded"
                      title="Minimize debug indicator"
                    >
                      ✕
                    </button>
                  </div>

                  {/* 4 Pipeline Stages Breakdown */}
                  <div className="space-y-2 text-[11px]">
                    {/* Stage 1: OpenSky Raw Poll */}
                    <div className="p-2 bg-slate-900/80 rounded border border-slate-800/90 flex items-center justify-between">
                      <div className="flex flex-col">
                        <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">1. OPENSKY RAW FEED</span>
                        <span className="text-[9px] text-slate-500">{formatPollTime(healthData?.last_successful_poll)}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`text-[12px] font-extrabold ${healthData?.last_poll_records ? 'text-emerald-400' : 'text-amber-400'}`}>
                          {healthData?.last_poll_records ?? 0} raw acft
                        </span>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold border ${
                          healthData?.last_poll_http_status === 200
                            ? 'bg-emerald-950/90 text-emerald-300 border-emerald-700'
                            : 'bg-amber-950/90 text-amber-300 border-amber-700'
                        }`}>
                          HTTP {healthData?.last_poll_http_status ?? '—'}
                        </span>
                      </div>
                    </div>

                    {/* Stage 2: Detection & ML Scoring Engine */}
                    <div className="p-2 bg-slate-900/80 rounded border border-slate-800/90 flex items-center justify-between">
                      <div className="flex flex-col">
                        <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">2. INPUT NORMALIZATION</span>
                        <span className="text-[9px] text-slate-500">Valid source records handed to the stream or local processor</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[12px] font-extrabold text-sky-300">
                          {healthData?.last_normalized_records ?? 0} normalized
                        </span>
                        <span className="text-[9px] px-1.5 py-0.5 bg-sky-950/90 text-sky-300 border border-sky-700 rounded font-bold">
                          ACTIVE
                        </span>
                      </div>
                    </div>

                    {/* Stage 3: WebSocket Transport */}
                    <div className="p-2 bg-slate-900/80 rounded border border-slate-800/90 flex items-center justify-between">
                      <div className="flex flex-col">
                        <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">3. WS STREAM & DB WRITE</span>
                        <span className="text-[9px] text-slate-500">DB {healthData?.database_status ?? 'UNKNOWN'} · Redis {healthData?.redis_status ?? 'UNKNOWN'}</span>
                      </div>
                      <div className="flex flex-wrap justify-end gap-1">
                        {[['DB', healthData?.database_status], ['REDIS', healthData?.redis_status], ['WS', websocketStatus.toUpperCase()]].map(([label, value]) => (
                          <span key={label} className={`text-[9px] px-1.5 py-0.5 rounded font-bold border ${
                            value === 'CONNECTED' || value === 'connected'
                              ? 'bg-emerald-950/90 text-emerald-300 border-emerald-700'
                              : 'bg-amber-950/90 text-amber-300 border-amber-700'
                          }`}>
                            {label} {value || 'UNKNOWN'}
                          </span>
                        ))}
                      </div>
                    </div>

                    {/* Stage 4: Frontend Globe Rendering */}
                    <div className="p-2 bg-slate-900/90 rounded border border-cyan-500/40 flex items-center justify-between">
                      <div className="flex flex-col">
                        <span className="text-[10px] text-cyan-300 font-bold uppercase tracking-wider">4. AIRSPACE VIEW</span>
                        <span className="text-[9px] text-slate-400">Rendering on {mapViewMode === '3d' ? '3D globe' : '2D map'}</span>
                      </div>
                      <span className="text-[13px] font-extrabold text-emerald-300 bg-emerald-950/90 border border-emerald-500/50 px-2.5 py-0.5 rounded">
                        {flights.length} AIRFRAMES
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Minimized Pill if closed */}
              {!showDebugIndicator && (
                <button
                  onClick={() => setShowDebugIndicator(true)}
                  className="absolute top-3 right-3 z-20 bg-slate-950/90 border border-cyan-500/40 text-cyan-300 hover:text-cyan-200 text-[10px] font-mono px-2 py-1 rounded shadow-lg flex items-center gap-1.5"
                  title="Show OpenSky ingestion debug indicator"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                  <span>LIVE AIRCRAFT [{realFlightsCount}]</span>
                </button>
              )}

              <div className="flex-1 w-full relative" aria-label={`Live ${mapViewMode === '3d' ? '3D globe' : '2D map'} visualizing tracked aircraft`} role="application">
                {/* One-Time Cinematic Intro HUD Overlay */}
                {isCinematicActive && (
                  <div className="absolute inset-0 z-30 pointer-events-none flex flex-col justify-between p-6 bg-gradient-to-b from-black/75 via-transparent to-black/85 animate-fadeIn">

                    {/* Atmospheric Cloud Deck Penetration Effect */}
                    {cinematicProgress >= 0.18 && cinematicProgress <= 0.78 && (
                      <div
                        className="absolute inset-0 pointer-events-none overflow-hidden transition-opacity duration-500 z-10"
                        style={{
                          opacity: cinematicProgress < 0.32
                            ? (cinematicProgress - 0.18) / 0.14
                            : cinematicProgress > 0.62
                            ? (0.78 - cinematicProgress) / 0.16
                            : 0.82
                        }}
                      >
                        {/* Upper stratospheric cloud wisps drifting slowly */}
                        <div className="absolute -inset-16 animate-cloud-slow opacity-65 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-sky-200/20 via-slate-300/10 to-transparent blur-xl"></div>
                        {/* Mid-altitude denser cloud deck passing */}
                        <div className="absolute -inset-16 animate-cloud-fast opacity-50 bg-[radial-gradient(circle_at_45%_45%,_var(--tw-gradient-stops))] from-white/25 via-cyan-100/10 to-transparent blur-2xl"></div>
                        {/* Passing cloud deck condensation badge */}
                        <div className="absolute inset-x-0 top-24 flex items-center justify-center">
                          <div className="text-[10px] font-mono tracking-widest text-cyan-200/90 bg-slate-950/85 px-3 py-1 rounded border border-cyan-500/35 backdrop-blur-md shadow-[0_0_15px_rgba(6,182,212,0.25)] flex items-center gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping"></span>
                            <span>☁ PENETRATING STRATOSPHERIC CLOUD DECK • FL600+</span>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Top status bar */}
                    <div className="flex items-center justify-between relative z-20">
                      <div className="flex items-center gap-3">
                        <div className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-ping"></div>
                        <div>
                          <div className="text-[11px] font-mono font-bold tracking-widest text-cyan-400 uppercase">
                            ORBITAL DESCENT RECONNAISSANCE // STAGE 0{cinematicStage}
                          </div>
                          <div className="text-[9px] font-mono text-slate-400">
                            {cinematicStage === 1 && "HIGH ORBITAL GEOSTATIONARY SCAN (26,000 KM) • DEEP SPACE PERSPECTIVE"}
                            {cinematicStage === 2 && "ATMOSPHERIC INSERTION // PASSING CLOUD DECK (14,000 KM) • SYNCHRONIZING REAL DATA"}
                            {cinematicStage === 3 && "AIRSPACE COVERAGE (4,200 KM) • LIVE REPORTS RECEIVED"}
                          </div>
                        </div>
                      </div>

                      {/* Controls: Audio Toggle & Skip Intro */}
                      <div className="flex items-center gap-2 pointer-events-auto">
                        <button
                          onClick={handleToggleSound}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono border backdrop-blur-md transition-all ${
                            isSoundEnabled
                              ? 'bg-cyan-950/90 border-cyan-500 text-cyan-300 shadow-[0_0_12px_rgba(6,182,212,0.3)]'
                              : 'bg-slate-900/90 border-slate-700 text-slate-300 hover:text-white hover:border-cyan-500/50'
                          }`}
                          title={isSoundEnabled ? "Mute atmospheric audio" : "Unmute subtle atmospheric wind ambience (opt-in)"}
                        >
                          <span className="text-sm">{isSoundEnabled ? '🔊' : '🔇'}</span>
                          <span>{isSoundEnabled ? 'AMBIENCE LIVE' : 'UNMUTE AMBIENCE'}</span>
                        </button>

                        <button
                          onClick={handleSkipCinematic}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono bg-slate-900/90 border border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white transition-all backdrop-blur-md shadow-lg"
                          title="Skip cinematic intro (or press ESC)"
                        >
                          <span>SKIP INTRO</span>
                          <kbd className="px-1.5 py-0.2 rounded bg-slate-800 text-[10px] text-slate-400 border border-slate-600">ESC</kbd>
                        </button>
                      </div>
                    </div>

                    {/* Center subtle crosshair / targeting reticle */}
                    <div className="self-center flex flex-col items-center justify-center opacity-45 relative z-20">
                      <div className="w-24 h-24 border border-cyan-500/40 rounded-full flex items-center justify-center relative">
                        <div className="w-16 h-16 border border-dashed border-cyan-400/50 rounded-full animate-spin"></div>
                        <div className="w-2 h-2 rounded-full bg-cyan-400"></div>
                      </div>
                      <div className="text-[10px] font-mono text-cyan-400 tracking-wider mt-2 bg-slate-950/60 px-2 py-0.5 rounded border border-cyan-500/20">
                        ACQUIRING AIRSPACE GRID • [78.96°E, 20.59°N]
                      </div>
                    </div>

                    {/* Bottom descent progress indicator */}
                    <div className="max-w-md w-full self-center bg-slate-950/90 border border-slate-800 rounded p-3 backdrop-blur-md relative z-20 shadow-2xl">
                      <div className="flex justify-between items-center text-[10px] font-mono text-slate-400 mb-1.5">
                        <span className="text-cyan-400 font-bold">ALTITUDE DESCENT</span>
                        <span className="text-slate-200 font-bold">{Math.round(26000 - cinematicProgress * 21800).toLocaleString()} KM</span>
                      </div>
                      <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-cyan-500 via-sky-400 to-emerald-400 transition-all duration-100 ease-out"
                          style={{ width: `${Math.round(cinematicProgress * 100)}%` }}
                        ></div>
                      </div>
                      <div className="flex justify-between items-center text-[9px] font-mono text-slate-400 mt-1.5">
                        <span>ORBIT (26K KM)</span>
                        <span className="text-cyan-300 font-bold">
                          {cinematicProgress < 0.35
                            ? "SCANNING FREQUENCIES..."
                            : `ACQUIRED ${visibleAircraftCount} / ${activeFlights.length} REAL AIRFRAMES`}
                        </span>
                        <span>COVERAGE (4.2K KM)</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Chase Cam Tactical Intercept HUD Banner */}
                {isChaseFlying && (
                  <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 pointer-events-none flex items-center gap-2.5 bg-[#060913]/90 border border-cyan-500/50 backdrop-blur-md px-4 py-1.5 rounded-full shadow-[0_0_20px_rgba(6,182,212,0.3)] text-cyan-300 font-mono text-[11px] animate-pulse">
                    <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping inline-block" />
                    <span className="font-bold tracking-wider uppercase">INTERCEPT CAMERA LOCK: {chaseTargetCallsign}</span>
                    <span className="text-[9px] text-slate-400 border-l border-slate-700 pl-2">CHASE CAM (360M)</span>
                  </div>
                )}

                {mapViewMode === '2d' ? (
                  <AirspaceMap
                    flights={activeFlights}
                    selectedFlight={selectedFlight || null}
                    route={selectedRouteForMap}
                    onSelectFlight={handleMapSelectFlight}
                    onOpenFlightDetails={handleMapOpenDetails}
                  />
                ) : (
                  <CesiumErrorBoundary resetKey="cesium-viewport">
                    <CesiumViewerComponent
                    full
                    className="w-full h-full"
                    shouldAnimate={true}
                    baseLayer={false}
                    baseLayerPicker={false}
                    geocoder={false}
                    homeButton={false}
                    sceneModePicker={false}
                    navigationHelpButton={false}
                    animation={false}
                    timeline={false}
                    fullscreenButton={false}
                    ref={(e: { cesiumElement?: CesiumViewer } | null) => {
                      if (e?.cesiumElement && viewerRef.current !== e.cesiumElement) {
                        viewerRef.current = e.cesiumElement;
                        const viewer = e.cesiumElement;
                        viewer.clock.shouldAnimate = true;
                        viewer.clock.clockStep = ClockStep.SYSTEM_CLOCK_MULTIPLIER;
                        viewer.clock.multiplier = 1.0;

                        // Configure Globe Rendering
                        viewer.scene.globe.show = true;
                        viewer.scene.globe.baseColor = Color.fromCssColorString('#060913');
                        viewer.scene.globe.showGroundAtmosphere = true;
                        viewer.scene.globe.enableLighting = false; // Keep globe illuminated with satellite imagery

                        // Ensure Satellite + World Boundaries layers are mounted
                        if (viewer.imageryLayers.length === 0) {
                          viewer.imageryLayers.addImageryProvider(createSatelliteImageryProvider());
                        }
                        if (viewer.imageryLayers.length <= 1) {
                          try {
                            viewer.imageryLayers.addImageryProvider(createReferenceBoundariesProvider());
                          } catch (err) {
                            console.warn('Boundaries overlay warning:', err);
                          }
                        }

                        aircraftMotionManager.setViewerClockSupplier(() => viewer.clock?.currentTime);
                        const isDismissed = sessionStorage.getItem('airguard_cinematic_dismissed') === 'true';
                        if (showcaseMode && !isDismissed) {
                          launchCinematicFlight(viewer);
                        } else {
                          viewer.camera.setView({
                            destination: Cartesian3.fromDegrees(0, 18, 18000000)
                          });
                          setIsCinematicActive(false);
                          setCinematicProgress(1.0);
                        }
                      }
                    }}
                  >
                    {activeFlights.map((f, idx) => {
                      if (typeof f.lng !== 'number' || typeof f.lat !== 'number' || isNaN(f.lng) || isNaN(f.lat)) {
                        return null;
                      }

                      // Dynamic visibility opacity (maintains mounted entity without rendering gap)
                      const aircraftOpacity = isCinematicActive ? Math.max(0.35, getAircraftOpacity(idx)) : 1.0;

                      // Register/update smooth motion target for continuous interpolation
                      registerFlightMotion(f.id, f.lat, f.lng, Number.isFinite(f.altitude) ? f.altitude : 0, Number.isFinite(f.heading) ? f.heading : 0, Number.isFinite(f.speed) ? f.speed : 0, 8000);
                      const motion = getFlightMotionProperties(f);

                      const isSelected = f.id === selectedFlightId;
                      const isHovered = f.id === hoveredFlightId;
                      const isCritical = f.status === 'critical';
                      const isSuspicious = f.status === 'suspicious';
                      const isFlagged = isCritical || isSuspicious;
                      const isStale = f.staleness_status === 'STALE' || (f.last_seen_seconds_ago !== undefined && f.last_seen_seconds_ago > staleAfterSeconds);
                      const effectiveOpacity = isStale ? Math.min(aircraftOpacity, 0.45) : aircraftOpacity;

                      // Speed-dependent dynamic fading trail (longer and more vivid for fast aircraft)

                      // Lightweight inline label (callsign + altitude) shown on hover, tap/selection, or critical alerts
                      const showLabel = (isHovered || isSelected || isCritical || isStale) && effectiveOpacity > 0.3;

                      return (
                        <React.Fragment key={f.id}>
                          {/* Pulsing ring billboard behind flagged aircraft */}
                          {isFlagged && effectiveOpacity > 0.5 && (
                            <Entity
                              position={motion.positionProp}
                            >
                              <BillboardGraphics
                                image={isCritical ? PULSE_RING_CRITICAL_SVG : PULSE_RING_SUSPICIOUS_SVG}
                                width={38}
                                height={38}
                                scale={pulseScaleProperty}
                                color={pulseColorProperty}
                              />
                            </Entity>
                          )}

                          {/* Lightweight heading-oriented glyph keeps global aircraft counts practical on the globe. */}
                          <Entity
                            position={motion.positionProp}
                            name={f.callsign}
                            onClick={() => handleSelectFlightWithChaseCam(f)}
                            onMouseEnter={() => setHoveredFlightId(f.id)}
                            onMouseLeave={() => setHoveredFlightId(prev => prev === f.id ? null : prev)}
                          >
                            <BillboardGraphics
                              image={createAircraftBillboard(
                                isSelected ? '#22d3ee' :
                                isCritical ? '#f43f5e' :
                                isSuspicious ? '#f97316' :
                                isStale ? '#94a3b8' : '#38bdf8'
                              )}
                              width={isSelected ? 34 : 26}
                              height={isSelected ? 34 : 26}
                              rotation={-CesiumMath.toRadians(Number.isFinite(f.heading) ? f.heading : 0)}
                              color={Color.WHITE.withAlpha(effectiveOpacity)}
                            />

                            {showLabel && (
                              <LabelGraphics
                                text={
                                  isHovered || isSelected
                                    ? `${f.callsign}${isStale ? ' [STALE ' + Math.round(f.last_seen_seconds_ago || 25) + 's]' : ''}\n${formatObservedNumber(f.data_quality, 'altitude', f.altitude)} FT • ${formatObservedNumber(f.data_quality, 'velocity', f.speed)} KT`
                                    : isStale ? `${f.callsign} [STALE]` : f.callsign
                                }
                                font={isSelected || isHovered ? "bold 11px monospace" : "10px monospace"}
                                fillColor={
                                  isSelected ? Color.CYAN :
                                  isCritical ? Color.fromCssColorString('#f43f5e') :
                                  isSuspicious ? Color.fromCssColorString('#f59e0b') :
                                  isStale ? Color.fromCssColorString('#94a3b8') :
                                  Color.WHITE
                                }
                                showBackground={isHovered || isSelected || isStale}
                                backgroundColor={Color.fromCssColorString('rgba(6, 9, 19, 0.90)')}
                                backgroundPadding={new Cartesian2(6, 4)}
                                outlineColor={Color.BLACK}
                                outlineWidth={2}
                                style={LabelStyle.FILL_AND_OUTLINE}
                                pixelOffset={new Cartesian2(0, -22)}
                              />
                            )}


                          </Entity>
                        </React.Fragment>
                      );
                    })}

                    {/* 3D Route Line Trajectory for Selected Aircraft */}
                    {selectedFlight && selectedRouteEntities && (
                      <>
                        {/* Flown Route Arc (Solid Glowing Cyan Polyline from Origin to Current Position) */}
                        {selectedRouteEntities.flownPositions && selectedRouteEntities.flownPositions.length >= 2 && (
                          <Entity name={`${selectedFlight.callsign}-flown-route`}>
                            <PolylineGraphics
                              positions={selectedRouteEntities.flownPositions}
                              width={2.5}
                              material={Color.fromCssColorString('#38bdf8').withAlpha(0.85)}
                            />
                          </Entity>
                        )}

                        {/* Remaining Route Arc (Dashed/Muted Blue Polyline from Current Position to Destination) */}
                        {selectedRouteEntities.remainingPositions && selectedRouteEntities.remainingPositions.length >= 2 && (
                          <Entity name={`${selectedFlight.callsign}-remaining-route`}>
                            <PolylineGraphics
                              positions={selectedRouteEntities.remainingPositions}
                              width={2.0}
                              material={Color.fromCssColorString('#0284c7').withAlpha(0.65)}
                            />
                          </Entity>
                        )}

                        {/* Origin Airport Waypoint Label */}
                        {selectedRouteEntities.origin && (
                          <Entity
                            position={selectedRouteEntities.origin.position}
                            name={`origin-${selectedRouteEntities.origin.label}`}
                          >
                            <LabelGraphics
                              text={`DEP: ${selectedRouteEntities.origin.label}`}
                              font="bold 10px monospace"
                              fillColor={Color.fromCssColorString('#38bdf8')}
                              showBackground={true}
                              backgroundColor={Color.fromCssColorString('rgba(6, 9, 19, 0.90)')}
                              backgroundPadding={new Cartesian2(5, 3)}
                              pixelOffset={new Cartesian2(0, -14)}
                              style={LabelStyle.FILL_AND_OUTLINE}
                              outlineColor={Color.BLACK}
                              outlineWidth={2}
                            />
                          </Entity>
                        )}

                        {/* Destination Airport Waypoint Label */}
                        {selectedRouteEntities.destination && (
                          <Entity
                            position={selectedRouteEntities.destination.position}
                            name={`dest-${selectedRouteEntities.destination.label}`}
                          >
                            <LabelGraphics
                              text={`ARR: ${selectedRouteEntities.destination.label}`}
                              font="bold 10px monospace"
                              fillColor={Color.fromCssColorString('#38bdf8')}
                              showBackground={true}
                              backgroundColor={Color.fromCssColorString('rgba(6, 9, 19, 0.90)')}
                              backgroundPadding={new Cartesian2(5, 3)}
                              pixelOffset={new Cartesian2(0, -14)}
                              style={LabelStyle.FILL_AND_OUTLINE}
                              outlineColor={Color.BLACK}
                              outlineWidth={2}
                            />
                          </Entity>
                        )}
                      </>
                    )}

                    {/* Detector risk overlay; unscored aircraft are intentionally not colored */}
                    {showConfidenceOverlay && (isCinematicActive ? (cinematicProgress - 0.35) / 0.65 > 0.05 : true) && (
                      (() => {
                        const overlayAlpha = isCinematicActive ? Math.max(0, Math.min(1.0, (cinematicProgress - 0.35) / 0.65)) : 1.0;
                        return confidenceSectors.map(sec => {
                          const fill = sec.fillColor.withAlpha(sec.fillColor.alpha * overlayAlpha);
                          const outline = sec.outlineColor.withAlpha(sec.outlineColor.alpha * overlayAlpha);
                          const labelClr = sec.labelColor.withAlpha(sec.labelColor.alpha * overlayAlpha);
                          const bgClr = Color.fromCssColorString('rgba(6, 9, 19, 0.82)').withAlpha(0.82 * overlayAlpha);

                          return (
                            <Entity
                              key={`conf-sec-${sec.id}`}
                              name={sec.name}
                              position={Cartesian3.fromDegrees(sec.centerLng, sec.centerLat, 100)}
                            >
                              <RectangleGraphics
                                coordinates={sec.rect}
                                material={fill}
                                outline={true}
                                outlineColor={outline}
                                outlineWidth={1.5}
                                height={80}
                              />
                              <LabelGraphics
                                text={`SEC ${sec.id}\n${Math.round(sec.avgRisk)}% RISK • ${sec.flightCount} ACFT${sec.hasAnomaly ? ' ⚠' : ''}`}
                                font="bold 9px monospace"
                                fillColor={labelClr}
                                showBackground={true}
                                backgroundColor={bgClr}
                                backgroundPadding={new Cartesian2(5, 3)}
                                outlineColor={Color.BLACK}
                                outlineWidth={2}
                                style={LabelStyle.FILL_AND_OUTLINE}
                                pixelOffset={new Cartesian2(0, 0)}
                                distanceDisplayCondition={new DistanceDisplayCondition(0, 4500000)}
                              />
                            </Entity>
                          );
                        });
                      })()
                    )}
                  </CesiumViewerComponent>
                </CesiumErrorBoundary>
              )}
            </div>
          </section>

            {/* Right 35%: Target List OR Detail Drawer */}
              <section className="col-span-12 min-h-[420px] lg:min-h-0 lg:col-span-3 bg-[#0b1220] border border-slate-700/70 rounded-xl flex flex-col overflow-hidden shadow-xl shadow-black/20">

              {!selectedFlightId ? (
                // Target List
                <div className="flex flex-col h-full">
                  <div className="px-4 py-3 border-b border-white/[0.07] flex items-center justify-between gap-2">
                    <div>
                      <h2 className="text-sm font-semibold text-slate-100 m-0">Aircraft</h2>
                      <span className="text-[11px] text-slate-500 font-normal">Highest risk first <span className="text-slate-700">·</span> {sortedFlights.length} tracked</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="flex bg-[#04070e] border border-slate-800 rounded p-0.5">
                        {(['all', 'suspicious', 'critical'] as const).map(filterType => (
                          <button
                            key={filterType}
                            onClick={() => setActiveFilter(filterType)}
                            className={`text-[10px] px-2 py-0.5 rounded transition-colors capitalize ${
                              activeFilter === filterType
                                ? 'bg-slate-800 text-slate-100 font-bold'
                                : 'text-slate-500 hover:text-slate-300 font-normal'
                            }`}
                          >
                            {filterType}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="px-3 pt-3">
                    <label className="sr-only" htmlFor="aircraft-search">Search aircraft</label>
                    <div className="relative">
                      <input id="aircraft-search" type="search" value={aircraftSearch} onChange={e => setAircraftSearch(e.target.value)}
                        placeholder="Search callsign, ICAO, or route" className="w-full rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2 pr-8 text-xs text-slate-100 placeholder:text-slate-500 outline-none focus:border-cyan-500" />
                      {aircraftSearch && <button type="button" onClick={() => setAircraftSearch('')} aria-label="Clear aircraft search" className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white">×</button>}
                    </div>
                  </div>

                  <div className="flex-1 min-h-0 py-2">
                    {sortedFlights.length === 0 ? (
                      <div className="flex flex-col items-center justify-center h-52 text-center p-4 border border-dashed border-slate-800 rounded-lg m-2">
                        <svg className="w-7 h-7 text-cyan-500/50 mb-2 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                        <span className="text-xs font-mono text-slate-300 font-semibold tracking-wider">
                          {aircraftSearch ? 'NO MATCHING AIRCRAFT' : 'LIVE AIRSPACE STANDBY'}
                        </span>
                        <span className="text-[11px] font-mono text-slate-500 mt-1 max-w-[240px]">
                          {aircraftSearch ? 'Try a different callsign, aircraft address, or route.' : 'Waiting for live aircraft reports in this sector.'}
                        </span>
                      </div>
                    ) : (
                      <List
                        height={580}
                        itemCount={sortedFlights.length}
                        itemSize={72}
                        width="100%"
                      >
                        {Row}
                      </List>
                    )}
                  </div>
                </div>
              ) : (
                // Detail Drawer (slides in gracefully after chase cam arrives)
                <div className="flex flex-col h-full bg-[#080d18] p-4 overflow-y-auto animate-in slide-in-from-right-4 duration-300">
                  {/* Top Bar with Navigation & Flight Indicator */}
                  <div className="flex justify-between items-center pb-2.5 mb-3 border-b border-slate-800/80">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono tracking-widest text-slate-400 font-bold uppercase">
                        TARGET INSPECTION
                      </span>
                    </div>
                    <button
                      onClick={() => {
                        if (viewerRef.current?.camera) {
                          viewerRef.current.camera.cancelFlight();
                        }
                        setIsChaseFlying(false);
                        setChaseTargetCallsign(null);
                        activeChaseFlightRef.current = null;
                        setSelectedFlightId(null);
                      }}
                      className="text-[10px] bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 hover:text-slate-100 px-2.5 py-1 rounded font-bold transition-colors whitespace-nowrap flex items-center gap-1"
                      title="Return to tactical targets list"
                    >
                      <span>←</span>
                      <span>TARGET LIST</span>
                    </button>
                  </div>

                  {selectedFlight && (() => {
                    const isCritical = selectedFlight.status === 'critical';
                    const isSuspicious = selectedFlight.status === 'suspicious';
                    const isFlagged = isCritical || isSuspicious;
                    const airline = getAirlineInfo(selectedFlight.callsign);
                    const explanation = getPlainEnglishExplanation(selectedFlight, selectedFlightDetail);

                    // Route resolution
                    const depResolved = selectedRouteEntities?.origin;
                    const arrResolved = selectedRouteEntities?.destination;
                    const depIata = depResolved?.iata || selectedFlightRoute?.est_departure_airport || selectedFlight.estDepartureAirport || "---";
                    const arrIata = arrResolved?.iata || selectedFlightRoute?.est_arrival_airport || selectedFlight.estArrivalAirport || "---";
                    const depCity = depResolved?.city || (selectedFlightRoute?.route_text?.includes('→') ? selectedFlightRoute.route_text.split('→')[0].trim() : (selectedFlightRoute?.est_departure_airport || "Sector Ingress"));
                    const arrCity = arrResolved?.city || (selectedFlightRoute?.route_text?.includes('→') ? selectedFlightRoute.route_text.split('→')[1].trim() : (selectedFlightRoute?.est_arrival_airport || "Route unknown"));

                    const isRouteUnknown = !selectedFlightRoute?.est_departure_airport && !selectedFlightRoute?.est_arrival_airport && (!selectedFlightRoute?.route_text || selectedFlightRoute.route_text === "Route unknown");

                    const verticalRateMs = selectedFlightDetail?.live_state?.vertical_rate_ms ?? selectedFlight.verticalRate ?? 0;
                    const verticalRateFpm = Math.round(verticalRateMs * 196.85);
                    const firstSeenSessionText = selectedFlightDetail?.first_seen_session
                      ? new Date(selectedFlightDetail.first_seen_session).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' }) + ' UTC'
                      : (selectedFlight.firstSeen
                        ? new Date(selectedFlight.firstSeen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' }) + ' UTC'
                        : "Session ingress");

                    const isStaleTarget = selectedFlightDetail?.staleness?.is_stale || selectedFlight.staleness_status === 'STALE' || (selectedFlight.last_seen_seconds_ago !== undefined && selectedFlight.last_seen_seconds_ago > staleAfterSeconds);
                    const staleSeconds = Math.round(selectedFlightDetail?.staleness?.last_seen_seconds_ago || selectedFlight.last_seen_seconds_ago || 25);

                    const detailTrust = selectedFlightDetail?.trust_status;
                    const combinedRisk = detailTrust?.combined_risk_score ?? selectedFlight.combined_risk_score;
                    const hasValidRisk = typeof combinedRisk === 'number' && Number.isFinite(combinedRisk);

                    const rawTrust = detailTrust?.trust_score ?? (Number.isFinite(selectedFlight.trustScore) ? selectedFlight.trustScore : (hasValidRisk ? Math.round((1 - combinedRisk!) * 100) : null));
                    const trustScore = typeof rawTrust === 'number' && Number.isFinite(rawTrust) ? Math.round(rawTrust) : null;
                    const hasValidTrust = trustScore !== null;

                    const rawConfidence = detailTrust?.evidence_confidence ?? selectedFlight.evidence_confidence ?? (hasValidRisk ? 0.40 : null);
                    const evidenceCoveragePct = typeof rawConfidence === 'number' && Number.isFinite(rawConfidence) ? Math.round(rawConfidence * 100) : null;

                    const assessmentStatus = detailTrust?.assessment_status ?? selectedFlight.assessment_status ?? (isFlagged ? 'REVIEW_REQUIRED' : hasValidRisk ? 'PARTIALLY_ASSESSED' : 'INSUFFICIENT_EVIDENCE');

                    const isEnsembleAvailable = detailTrust?.technical_details?.ensemble_score !== null && detailTrust?.technical_details?.ensemble_score !== undefined;
                    const isAutoencoderAvailable = detailTrust?.technical_details?.autoencoder_score !== null && detailTrust?.technical_details?.autoencoder_score !== undefined;
                    const isReceiverAvailable = detailTrust?.technical_details?.receiver_consistency_score !== null && detailTrust?.technical_details?.receiver_consistency_score !== undefined;

                    return (
                      <div className="space-y-3.5 text-xs font-normal">

                        {/* STALENESS INTEGRITY BANNER */}
                        {isStaleTarget && (
                          <div className="bg-amber-950/70 border border-amber-500/60 rounded-lg p-2.5 flex items-center justify-between text-xs text-amber-200 shadow-md animate-in fade-in duration-200">
                            <div className="flex items-center gap-2">
                              <span className="text-amber-400 font-bold text-sm">⚠</span>
                              <div>
                                <span className="font-bold text-amber-300 block">SIGNAL DEGRADED — Last reported {staleSeconds}s ago</span>
                                <span className="text-[10px] text-amber-200/80">Showing the last reported position until another report arrives</span>
                              </div>
                            </div>
                            <span className="text-[9px] font-mono bg-amber-900/80 border border-amber-500/40 px-2 py-0.5 rounded text-amber-200 font-bold shrink-0">
                              LAST KNOWN
                            </span>
                          </div>
                        )}

                        {/* ======================================================== */}
                        {/* 1. TOP: TRUST SCORE + RISK + EVIDENCE COVERAGE HERO CARD */}
                        {/* ======================================================== */}
                        <div className={`p-4 rounded-lg border-2 relative overflow-hidden transition-all ${
                          isCritical
                            ? 'bg-gradient-to-br from-rose-950/90 via-[#230910] to-[#080d18] border-rose-500 shadow-[0_0_30px_rgba(244,63,94,0.30)] ring-1 ring-rose-500/60'
                            : isSuspicious
                            ? 'bg-gradient-to-br from-amber-950/90 via-[#261609] to-[#080d18] border-amber-500 shadow-[0_0_30px_rgba(245,158,11,0.25)] ring-1 ring-amber-500/50'
                            : assessmentStatus === 'ASSESSED'
                            ? 'bg-gradient-to-br from-emerald-950/80 via-[#071f1a] to-[#080d18] border-emerald-500/70 shadow-[0_0_20px_rgba(16,185,129,0.15)]'
                            : hasValidTrust
                            ? 'bg-gradient-to-br from-sky-950/70 via-[#0c1a2e] to-[#080d18] border-sky-600/70 shadow-[0_0_20px_rgba(56,189,248,0.12)]'
                            : 'bg-gradient-to-br from-slate-900/90 via-[#111827] to-[#080d18] border-slate-600/70'
                        }`}>
                          {/* Ambient glow highlight */}
                          <div className={`absolute top-0 right-0 w-44 h-44 rounded-full blur-3xl pointer-events-none ${
                            isCritical ? 'bg-rose-500/20' : isSuspicious ? 'bg-amber-500/20' : hasValidTrust ? 'bg-sky-500/15' : 'bg-slate-500/10'
                          }`} />

                          <div className="relative z-10 space-y-3">
                            {/* Header Status Row */}
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className={`w-2.5 h-2.5 rounded-full ${
                                  isCritical ? 'bg-rose-400 animate-ping' :
                                  isSuspicious ? 'bg-amber-400 animate-pulse' :
                                  assessmentStatus === 'ASSESSED' ? 'bg-emerald-400' :
                                  hasValidTrust ? 'bg-sky-400' :
                                  'bg-slate-400'
                                }`} />
                                <span className={`text-[10px] font-mono tracking-widest font-bold uppercase ${
                                  isCritical ? 'text-rose-400' :
                                  isSuspicious ? 'text-amber-400' :
                                  assessmentStatus === 'ASSESSED' ? 'text-emerald-400' :
                                  hasValidTrust ? 'text-sky-300' :
                                  'text-slate-300'
                                }`}>
                                  {isCritical ? 'REVIEW REQUIRED · CRITICAL ANOMALY' :
                                   isSuspicious ? 'REVIEW REQUIRED · SUSPICIOUS ANOMALY' :
                                   assessmentStatus === 'ASSESSED' ? 'ASSESSED · FULL EVIDENCE STACK' :
                                   assessmentStatus === 'PARTIALLY_ASSESSED' ? 'PARTIALLY ASSESSED · AVAILABLE EVIDENCE' :
                                   assessmentStatus === 'SUPPRESSED' ? 'SUPPRESSED · KNOWN ENTITY' :
                                   'INSUFFICIENT EVIDENCE · ACCUMULATING HISTORY'}
                                </span>
                              </div>
                              <span className={`text-[9px] font-mono font-bold px-2 py-0.5 rounded border ${
                                isFlagged ? 'bg-rose-950/80 text-rose-300 border-rose-500/50' :
                                hasValidTrust ? 'bg-sky-950/80 text-sky-200 border-sky-500/40' :
                                'bg-slate-900 text-slate-400 border-slate-700'
                              }`}>
                                {isFlagged ? '▲ FLAGGED' : hasValidTrust ? '● SCORED' : '— UNASSESSED'}
                              </span>
                            </div>

                            {/* Headline & Explanation */}
                            <div>
                              <h2 className="text-lg font-black tracking-tight text-white uppercase leading-snug">
                                {isFlagged
                                  ? 'Flagged by detector rules'
                                  : assessmentStatus === 'ASSESSED'
                                  ? 'Telemetry consistent across all detector layers'
                                  : hasValidTrust
                                  ? 'Telemetry evaluated on available real evidence'
                                  : 'Insufficient scored evidence'}
                              </h2>
                              <p className={`text-[11px] leading-relaxed font-medium mt-1 ${
                                isCritical ? 'text-rose-200/90' :
                                isSuspicious ? 'text-amber-200/90' :
                                'text-slate-300/90'
                              }`}>
                                {isFlagged
                                  ? (detailTrust?.explanation || explanation.summary || 'Signal inconsistency detected across physical flight envelope.')
                                  : hasValidTrust
                                  ? (detailTrust?.explanation || 'Telemetry Trust Index derived from physical rules and kinematic consistency. Not an airworthiness or flight safety rating.')
                                  : 'Observation history is accumulating. Temporal analysis requires multiple consecutive state vectors.'}
                              </p>
                            </div>

                            {/* Prominent Score Triad (Trust Score + Detector Risk + Evidence Coverage) */}
                            <div className="grid grid-cols-3 gap-2 pt-1">
                              {/* 1. TRUST SCORE */}
                              <div className={`p-2.5 rounded border backdrop-blur-md ${
                                isCritical ? 'bg-[#180509]/90 border-rose-500/60' :
                                isSuspicious ? 'bg-[#1a0f05]/90 border-amber-500/60' :
                                hasValidTrust && trustScore! >= 80 ? 'bg-[#061814]/90 border-emerald-500/50' :
                                hasValidTrust ? 'bg-[#081528]/90 border-sky-500/50' :
                                'bg-slate-950/90 border-slate-700/60'
                              }`}>
                                <span className="text-[9px] font-mono block uppercase font-bold text-slate-400 tracking-wider">
                                  TRUST SCORE
                                </span>
                                <div className="flex items-baseline gap-1 mt-0.5">
                                  <span className={`text-2xl font-black font-mono tracking-tighter ${
                                    isCritical ? 'text-rose-400' :
                                    isSuspicious ? 'text-amber-400' :
                                    hasValidTrust && trustScore! >= 80 ? 'text-emerald-300' :
                                    hasValidTrust ? 'text-sky-300' :
                                    'text-slate-500'
                                  }`}>
                                    {hasValidTrust ? trustScore : '—'}
                                  </span>
                                  {hasValidTrust && <span className="text-[10px] text-slate-400 font-mono font-bold">/ 100</span>}
                                </div>
                                <span className="text-[8px] font-mono block text-slate-400 uppercase mt-0.5 truncate">
                                  Telemetry Trust Index
                                </span>
                              </div>

                              {/* 2. DETECTOR RISK */}
                              <div className={`p-2.5 rounded border backdrop-blur-md ${
                                isCritical ? 'bg-[#180509]/90 border-rose-500/60' :
                                isSuspicious ? 'bg-[#1a0f05]/90 border-amber-500/60' :
                                'bg-slate-950/90 border-slate-700/60'
                              }`}>
                                <span className="text-[9px] font-mono block uppercase font-bold text-slate-400 tracking-wider">
                                  DETECTOR RISK
                                </span>
                                <div className="flex items-baseline gap-1 mt-0.5">
                                  <span className={`text-2xl font-black font-mono tracking-tighter ${
                                    isCritical ? 'text-rose-400' :
                                    isSuspicious ? 'text-amber-400' :
                                    hasValidRisk ? 'text-slate-100' :
                                    'text-slate-500'
                                  }`}>
                                    {hasValidRisk ? combinedRisk!.toFixed(2) : '—'}
                                  </span>
                                </div>
                                <span className="text-[8px] font-mono block text-slate-400 uppercase mt-0.5 truncate">
                                  Combined Risk (0–1)
                                </span>
                              </div>

                              {/* 3. EVIDENCE COVERAGE */}
                              <div className="p-2.5 rounded border border-slate-700/60 bg-slate-950/90 backdrop-blur-md">
                                <span className="text-[9px] font-mono block uppercase font-bold text-slate-400 tracking-wider">
                                  EVIDENCE STACK
                                </span>
                                <div className="flex items-baseline gap-1 mt-0.5">
                                  <span className="text-2xl font-black font-mono tracking-tighter text-cyan-300">
                                    {evidenceCoveragePct !== null ? `${evidenceCoveragePct}%` : '—'}
                                  </span>
                                </div>
                                <span className="text-[8px] font-mono block text-slate-400 uppercase mt-0.5 truncate">
                                  Detector Coverage
                                </span>
                              </div>
                            </div>

                            {/* Detector Layer Availability Matrix */}
                            <div className="pt-2 border-t border-slate-800/80">
                              <span className="text-[9px] font-mono text-slate-400 uppercase font-bold block mb-1.5">
                                DETECTOR LAYER AVAILABILITY & REAL EVIDENCE
                              </span>
                              <div className="grid grid-cols-2 gap-1.5 text-[10px] font-mono">
                                <div className="p-1.5 bg-[#03060f]/80 rounded border border-slate-800 flex items-center justify-between">
                                  <span className="text-slate-300">Physics Rules</span>
                                  <span className="text-emerald-400 font-bold">AVAILABLE</span>
                                </div>
                                <div className="p-1.5 bg-[#03060f]/80 rounded border border-slate-800 flex items-center justify-between">
                                  <span className="text-slate-300">Autoencoder</span>
                                  <span className={isAutoencoderAvailable ? 'text-emerald-400 font-bold' : 'text-slate-500'}>
                                    {isAutoencoderAvailable ? 'AVAILABLE' : 'UNAVAILABLE'}
                                  </span>
                                </div>
                                <div className="p-1.5 bg-[#03060f]/80 rounded border border-slate-800 flex items-center justify-between">
                                  <span className="text-slate-300">ML Ensemble</span>
                                  <span className={isEnsembleAvailable ? 'text-emerald-400 font-bold' : 'text-slate-500'}>
                                    {isEnsembleAvailable ? 'AVAILABLE' : 'UNAVAILABLE'}
                                  </span>
                                </div>
                                <div className="p-1.5 bg-[#03060f]/80 rounded border border-slate-800 flex items-center justify-between">
                                  <span className="text-slate-300">Receiver Consistency</span>
                                  <span className={isReceiverAvailable ? 'text-emerald-400 font-bold' : 'text-slate-500'}>
                                    {isReceiverAvailable ? 'AVAILABLE' : 'UNAVAILABLE'}
                                  </span>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>


                        {/* ======================================================== */}
                        {/* 2. STANDARD FLIGHT INFORMATION */}
                        {/* ======================================================== */}
                        <div className="bg-[#060913] border border-slate-800 rounded p-3 space-y-3">
                          {/* Callsign & Aircraft Header */}
                          <div className="flex items-center justify-between border-b border-slate-800/80 pb-2.5">
                            <div className="flex items-center gap-2.5">
                              <span
                                className="w-1.5 h-8 rounded-sm shrink-0 shadow-sm"
                                style={{ backgroundColor: airline.color || '#38bdf8' }}
                              />
                              <div>
                                <div className="flex items-baseline gap-2">
                                  <span className="text-lg font-black tracking-tight text-slate-100 font-mono">
                                    {selectedFlight.callsign}
                                  </span>
                                  <span className="text-xs text-cyan-400 font-bold">
<span className="text-xs text-cyan-400 font-bold">{selectedFlightDetail?.identity?.operator || selectedFlight.operator || 'Operator unavailable'} · {selectedFlightDetail?.identity?.typecode || selectedFlight.aircraftType || 'Aircraft type unavailable'}</span>
                                  </span>
                                </div>
                                <div className="text-[10px] text-slate-400 font-mono mt-0.5 flex items-center gap-2">
                                  <span>ICAO: <b className="text-slate-200">{selectedFlight.id.toUpperCase()}</b></span>
                                  <span>•</span>
                                  <span>SQK: <b className="text-slate-200">{isObservedField(selectedFlight.data_quality, 'squawk') ? selectedFlight.squawk || '—' : '—'}</b></span>
                                  <span>•</span>
                                  <span>MODE-S (1090 MHz)</span>
                                </div>
                              </div>
                            </div>
                            <div className="text-right">
                              <span className="text-[10px] px-2 py-0.5 rounded font-mono font-bold bg-slate-900 border border-slate-700 text-slate-300">
                                {(selectedFlight.source || "SOURCE UNKNOWN").replaceAll('_', ' ').toUpperCase()}
                              </span>
                            </div>
                          </div>

                          {/* Origin -> Destination Route Card */}
                          {isRouteUnknown ? (
                            <div className="bg-[#030712] border border-slate-800/90 rounded p-3">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2.5">
                                  <div className="w-8 h-8 rounded bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-400 font-mono text-sm font-bold">
                                    ?
                                  </div>
                                  <div>
                                    <span className="text-[9px] font-mono text-slate-500 uppercase block font-bold">
                                      FLIGHT ROUTE
                                    </span>
                                    <span className="text-base font-bold text-slate-200 font-mono">
                                      Route unknown
                                    </span>
                                  </div>
                                </div>
                                <span className="text-[9px] font-mono bg-slate-900 border border-slate-800 px-2 py-0.5 rounded text-slate-400">
                                  {isRouteLoading ? "QUERYING OPENSKY..." : "COVERAGE PARTIAL"}
                                </span>
                              </div>
                              <div className="mt-2 text-[10px] text-slate-400 leading-relaxed">
                                OpenSky state-vector coverage is partial; no flight-plan route is available for this segment.
                              </div>
                              <div className="mt-2.5 pt-2 border-t border-slate-800/60 flex items-center justify-between text-[10px] text-slate-500">
                                <span>3D route trajectory line omitted (origin/destination unfiled)</span>
                                <span className="font-mono text-slate-500">NO FIX</span>
                              </div>
                            </div>
                          ) : (
                            <div className="bg-[#030712] border border-slate-800/90 rounded p-3">
                              <div className="flex items-center justify-between">
                                {/* Origin Airport */}
                                <div className="w-[38%] text-left">
                                  <span className="text-[9px] font-mono text-slate-500 uppercase block font-bold">
                                    ORIGIN
                                  </span>
                                  <span className="text-xl font-black text-slate-100 font-mono tracking-tight block">
                                    {depIata.length === 3 ? depIata : depIata.slice(0, 4)}
                                  </span>
                                  <span className="text-[11px] font-semibold text-slate-300 block truncate" title={depCity}>
                                    {depCity}
                                  </span>
                                  <span className="text-[9px] font-mono text-slate-500 block mt-0.5">
                                    {isRouteLoading ? "Searching..." : (selectedFlightRoute?.first_seen
                                      ? new Date(selectedFlightRoute.first_seen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'
                                      : "First seen")}
                                  </span>
                                </div>

                                {/* Progress Track & Airplane Icon */}
                                <div className="flex-1 px-2 flex flex-col items-center justify-center">
                                  <div className="w-full flex items-center justify-center gap-1 text-slate-600">
                                    <div className="h-[2px] flex-1 bg-gradient-to-r from-slate-700 to-cyan-500" />
                                    <span className="text-cyan-400 text-sm transform rotate-90">✈</span>
                                    <div className={`h-[2px] flex-1 ${arrIata !== '---' && arrCity !== 'Route unknown' ? 'bg-gradient-to-r from-cyan-500 to-slate-700' : 'bg-slate-800'}`} />
                                  </div>
                                  <span className="text-[9px] font-mono text-cyan-400 uppercase tracking-widest font-bold mt-1">
                                    {isRouteLoading ? "QUERYING OPENSKY..." : (arrCity !== 'Route unknown' ? "EN ROUTE" : "SECTOR INGRESS")}
                                  </span>
                                </div>

                                {/* Destination Airport */}
                                <div className="w-[38%] text-right">
                                  <span className="text-[9px] font-mono text-slate-500 uppercase block font-bold">
                                    DESTINATION
                                  </span>
                                  <span className="text-xl font-black text-slate-100 font-mono tracking-tight block">
                                    {arrIata !== '---' ? (arrIata.length === 3 ? arrIata : arrIata.slice(0, 4)) : "???"}
                                  </span>
                                  <span className="text-[11px] font-semibold text-slate-300 block truncate" title={arrCity}>
                                    {arrCity}
                                  </span>
                                  <span className="text-[9px] font-mono text-slate-500 block mt-0.5">
                                    {arrCity !== 'Route unknown' ? "Estimated" : "Route unfiled"}
                                  </span>
                                </div>
                              </div>

                              {/* Globe Route Projection Notification */}
                              <div className="mt-2.5 pt-2 border-t border-slate-800/60 flex items-center justify-between text-[10px] text-slate-400">
                                <span className="flex items-center gap-1.5">
                                  <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
                                  <span>3D route line projected on globe (origin → position → destination)</span>
                                </span>
                                <span className="font-mono text-cyan-400 font-bold">LIVE CAM</span>
                              </div>
                            </div>
                          )}

                          {/* Key Telemetry Grid */}
                          <div>
                            <span className="text-[10px] text-slate-400 font-bold block mb-1.5 uppercase font-mono">
                              REPORTED FLIGHT TELEMETRY
                            </span>
                            <div className="grid grid-cols-4 gap-2 bg-[#040710] p-2.5 rounded border border-slate-800/80">
                              <div>
                                <span className="text-slate-500 text-[9px] block uppercase font-mono">ALTITUDE</span>
                                <div className="flex items-baseline gap-1">
                                  <span className="text-slate-100 font-bold text-xs font-mono">
                                    {formatObservedNumber(selectedFlight.data_quality, 'altitude', selectedFlight.altitude)} ft
                                  </span>
                                </div>
                                <span className="text-[9px] text-emerald-400 font-mono">
                                  {isObservedField(selectedFlight.data_quality, 'altitude') ? (selectedFlight.altitude > 25000 ? "CRUISE (FL" + Math.round(selectedFlight.altitude/100) + ")" : "LEVEL") : "ALTITUDE UNAVAILABLE"}
                                </span>
                              </div>

                              <div>
                                <span className="text-slate-500 text-[9px] block uppercase font-mono">SPEED</span>
                                <span className="text-slate-100 font-bold text-xs font-mono block">
                                  {formatObservedNumber(selectedFlight.data_quality, 'velocity', selectedFlight.speed)} kts
                                </span>
                                <span className="text-[9px] text-slate-400 font-mono">
                                  {isObservedField(selectedFlight.data_quality, 'velocity') ? `${Math.round(selectedFlight.speed * 1.852)} km/h` : '—'}
                                </span>
                              </div>

                              <div>
                                <span className="text-slate-500 text-[9px] block uppercase font-mono">TRACK</span>
                                <span className="text-slate-100 font-bold text-xs font-mono block">
                                  {formatObservedNumber(selectedFlight.data_quality, 'heading', selectedFlight.heading)}°
                                </span>
                                <span className="text-[9px] text-slate-400 font-mono">
                                  {!isObservedField(selectedFlight.data_quality, 'heading') ? 'TRACK UNAVAILABLE' : selectedFlight.heading >= 315 || selectedFlight.heading < 45 ? "NORTH" :
                                   selectedFlight.heading >= 45 && selectedFlight.heading < 135 ? "EAST" :
                                   selectedFlight.heading >= 135 && selectedFlight.heading < 225 ? "SOUTH" : "WEST"}
                                </span>
                              </div>

                              <div>
                                <span className="text-slate-500 text-[9px] block uppercase font-mono">VERTICAL RATE</span>
                                <span className={`text-xs font-mono font-bold block ${verticalRateFpm > 100 ? 'text-emerald-400' : verticalRateFpm < -100 ? 'text-amber-400' : 'text-slate-100'}`}>
                                  {verticalRateFpm > 0 ? `+${verticalRateFpm}` : verticalRateFpm} fpm
                                </span>
                                <span className="text-[9px] text-slate-400 font-mono">
                                  ({verticalRateMs >= 0 ? `+${verticalRateMs.toFixed(1)}` : verticalRateMs.toFixed(1)} m/s)
                                </span>
                              </div>

                              <div>
                                <span className="text-slate-500 text-[9px] block uppercase font-mono">FIRST SEEN (SESSION)</span>
                                <span className="text-slate-200 font-mono text-[10px] block font-bold truncate" title={firstSeenSessionText}>
                                  {firstSeenSessionText}
                                </span>
                                <span className="text-[9px] text-slate-400 font-mono">
                                  Session entry
                                </span>
                              </div>

                              <div>
                                <span className="text-slate-500 text-[9px] block uppercase font-mono">COORDINATES</span>
                                <span className="text-slate-200 font-mono text-[10px] block truncate">
                                  {selectedFlight.lat.toFixed(2)}°N, {selectedFlight.lng.toFixed(2)}°E
                                </span>
                                <span className="text-[9px] text-slate-500 font-mono">
                                  WGS84 Datum
                                </span>
                              </div>

                              <div>
                                <span className="text-slate-500 text-[9px] block uppercase font-mono">SIGNAL RSSI</span>
                                <span className="text-slate-200 font-mono text-[10px] block">
                                  {Number.isFinite(selectedFlight.signalStrength) ? selectedFlight.signalStrength + ' dBm' : 'Unavailable'}
                                </span>
                                <span className="text-[9px] text-slate-500 font-mono">
                                  Signal measurement unavailable
                                </span>
                              </div>

                              <div>
                                <span className="text-slate-500 text-[9px] block uppercase font-mono">DATA SOURCE</span>
                                <span className="text-cyan-400 font-mono text-[10px] block font-bold truncate">
                                  {selectedFlight.source || 'Source unavailable'}
                                </span>
                                <span className="text-[9px] text-slate-500 font-mono">
                                  Live Telemetry
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* ======================================================== */}
                        {/* 2B. AIRCRAFT IDENTITY (AIRFRAME METADATA & REGISTRY)     */}
                        {/* ======================================================== */}
                        <div className="bg-[#060913] border border-slate-800 rounded p-3">
                          <div className="flex items-center justify-between border-b border-slate-800/80 pb-2 mb-2.5">
                            <span className="text-[10px] text-slate-300 font-bold uppercase font-mono">
                              AIRFRAME IDENTITY & REGISTRY
                            </span>
                            <span className="text-[9px] font-mono text-cyan-400 uppercase font-bold">
                              {selectedFlightDetail?.identity?.source ? `SOURCE · ${selectedFlightDetail.identity.source.replaceAll('_', ' ')}` : "SOURCE UNAVAILABLE"}
                            </span>
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-[11px]">
                            <div className="bg-[#040710] p-2 rounded border border-slate-800/70">
                              <span className="text-[9px] text-slate-500 block uppercase font-mono">REGISTRATION</span>
                              <span className="font-mono font-bold text-slate-200">
                                {selectedFlightDetail?.identity?.registration || "Unavailable from current source"}
                              </span>
                            </div>
                            <div className="bg-[#040710] p-2 rounded border border-slate-800/70">
                              <span className="text-[9px] text-slate-500 block uppercase font-mono">AIRCRAFT MODEL</span>
                              <span className="font-bold text-slate-200 truncate block" title={selectedFlightDetail?.identity?.model || "Civil Transport"}>
                                {selectedFlightDetail?.identity?.model || "Commercial Transport"}
                              </span>
                            </div>
                            <div className="bg-[#040710] p-2 rounded border border-slate-800/70">
                              <span className="text-[9px] text-slate-500 block uppercase font-mono">OPERATOR</span>
                              <span className="font-bold text-slate-200 truncate block" title={selectedFlightDetail?.identity?.operator || airline.name}>
                                {selectedFlightDetail?.identity?.operator || airline.name || "Operator unavailable"}
                              </span>
                            </div>
                            <div className="bg-[#040710] p-2 rounded border border-slate-800/70">
                              <span className="text-[9px] text-slate-500 block uppercase font-mono">COUNTRY OF ORIGIN</span>
                              <span className="font-bold text-slate-200 truncate block">
                                {selectedFlightDetail?.identity?.country || "Country unavailable"}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* ======================================================== */}
                        {/* 3. THE "WHY" (EXPLAINABLE STORY MODE VS TECHNICAL SHAP)  */}
                        {/* ======================================================== */}
                        <div>
                          {isFlagged ? (
                            // FLAGGED CASE: Plain-English Story Mode + "Show technical detail" toggle (Prompt I & 35)
                            <div className="bg-[#060913] border border-slate-800 rounded p-3 space-y-2.5">
                              <div className="flex items-center justify-between">
                                <div>
                                  <span className="text-[10px] text-slate-200 font-bold block uppercase font-mono">
                                    {showShapTechnical ? "TECHNICAL SHAP ATTRIBUTION" : "WHY THIS AIRCRAFT WAS FLAGGED"}
                                  </span>
                                  <span className="text-[10px] text-slate-400 font-normal block mt-0.5">
                                    {showShapTechnical
                                      ? "Exact ML model feature attribution weights for operator audit."
                                      : "Plain-English physical explanation of anomalous broadcast."}
                                  </span>
                                </div>
                                <button
                                  onClick={() => setShowShapTechnical(!showShapTechnical)}
                                  className="text-[10px] px-2 py-0.5 rounded border border-slate-700 bg-slate-800/90 text-slate-200 hover:text-white hover:border-slate-500 transition-colors flex items-center gap-1.5 shrink-0"
                                  title="Toggle between plain-English story explanation and raw SHAP feature bars"
                                >
                                  <span className={`w-1.5 h-1.5 rounded-full ${showShapTechnical ? 'bg-cyan-400' : 'bg-slate-500'}`} />
                                  <span>Show technical detail</span>
                                  <span className="text-[9px] text-slate-400 font-bold">[{showShapTechnical ? 'ON' : 'OFF'}]</span>
                                </button>
                              </div>

                              {showShapTechnical ? (
                                // Technical SHAP Panel (Prompt 35)
                                <div className="space-y-2 pt-1">
                                  <div className="h-[160px] w-full bg-[#03060f] border border-slate-800 p-2 rounded">
                                    <ResponsiveContainer width="100%" height="100%">
                                      <BarChart
                                        layout="vertical"
                                        data={selectedFlight.shapValues}
                                        margin={{ top: 5, right: 10, left: 20, bottom: 5 }}
                                      >
                                        <XAxis type="number" stroke="#475569" fontSize={8} />
                                        <YAxis dataKey="name" type="category" stroke="#94a3b8" fontSize={7} width={80} />
                                        <Tooltip contentStyle={{ backgroundColor: '#0a0f1d', borderColor: '#1e293b', fontSize: '9px' }} />
                                        <Bar
                                          dataKey="value"
                                          fill={isCritical ? '#f43f5e' : '#f59e0b'}
                                          radius={[0, 2, 2, 0]}
                                        />
                                      </BarChart>
                                    </ResponsiveContainer>
                                  </div>
                                  <div className="text-[9px] font-mono text-slate-400 px-1">
                                    Values indicate directional deviation from expected civilian flight envelope.
                                  </div>
                                </div>
                              ) : (
                                // Plain-English Story Mode (Prompt I)
                                <div className="space-y-2 pt-1">
                                  <div className="text-xs text-slate-200 leading-relaxed font-normal bg-[#03060f] border border-slate-800/80 p-2.5 rounded">
                                    <span className={isCritical ? 'text-rose-400 font-bold mr-1.5' : 'text-amber-400 font-bold mr-1.5'}>
                                      {isCritical ? 'CRITICAL:' : 'SUSPICIOUS:'}
                                    </span>
                                    {explanation.summary}
                                  </div>

                                  <div className="border-t border-slate-800/80 pt-2 space-y-1">
                                    <span className="text-[9px] text-slate-500 font-bold uppercase font-mono block">
                                      PHYSICAL CONTRADICTIONS:
                                    </span>
                                    {explanation.reasons.map((reason, idx) => (
                                      <div key={idx} className="flex items-start gap-1.5 text-[11px] text-slate-300">
                                        <span className="text-rose-400 mt-0.5">•</span>
                                        <span>{reason}</span>
                                      </div>
                                    ))}
                                  </div>

                                  {/* Verification Rule Matrix */}
                                  <div className="border-t border-slate-800/80 pt-2 grid grid-cols-2 gap-1.5 text-[10px]">
                                    <div className="p-1.5 bg-[#03060f] rounded border border-slate-800 flex justify-between items-center">
                                      <span className="text-slate-400">Implied Speed</span>
                                  <span className={`font-bold ${selectedFlight.ruleFlags?.positionJump ? 'text-rose-400' : 'text-slate-500'}`}>
                                    {selectedFlight.ruleFlags?.positionJump ? "▲ FLAGGED" : "— NOT ASSESSED"}
                                      </span>
                                    </div>
                                    <div className="p-1.5 bg-[#03060f] rounded border border-slate-800 flex justify-between items-center">
                                      <span className="text-slate-400">Climb Envelope</span>
                                  <span className={`font-bold ${selectedFlight.ruleFlags?.climbRate ? 'text-rose-400' : 'text-slate-500'}`}>
                                    {selectedFlight.ruleFlags?.climbRate ? "▲ FLAGGED" : "— NOT ASSESSED"}
                                      </span>
                                    </div>
                                    <div className="p-1.5 bg-[#03060f] rounded border border-slate-800 flex justify-between items-center">
                                      <span className="text-slate-400">Alt-Vel Coherence</span>
                                  <span className={`font-bold ${selectedFlight.ruleFlags?.altVelMismatch ? 'text-rose-400' : 'text-slate-500'}`}>
                                    {selectedFlight.ruleFlags?.altVelMismatch ? "▲ FLAGGED" : "— NOT ASSESSED"}
                                      </span>
                                    </div>
                                    <div className="p-1.5 bg-[#03060f] rounded border border-slate-800 flex justify-between items-center">
                                      <span className="text-slate-400">ICAO Duplicate</span>
                                  <span className={`font-bold ${selectedFlight.ruleFlags?.duplicateIcao ? 'text-rose-400' : 'text-slate-500'}`}>
                                    {selectedFlight.ruleFlags?.duplicateIcao ? "▲ FLAGGED" : "— NOT ASSESSED"}
                                      </span>
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="bg-[#060913] border border-slate-700/60 rounded p-3 space-y-2">
                              <span className="text-[10px] text-slate-300 font-bold block uppercase font-mono tracking-wide">
                                ASSESSMENT EVIDENCE
                              </span>
                              <div className="text-xs text-slate-300 leading-relaxed bg-[#030d10] border border-slate-800 p-2.5 rounded">
                                No active review flag is attached to this track. The feed does not provide receiver quorum, multilateration, or an independent ground-truth position check.
                              </div>
                            </div>
                          )}
                        </div>

                        {/* ======================================================== */}
                        {/* 4. SUPPORTING CONTEXT: SESSION ROLLING TRUST TRAJECTORY  */}
                        {/* ======================================================== */}
                        <div className="bg-[#060913] border border-slate-800 p-3 rounded space-y-2">
                          <div className="flex items-center justify-between">
                            <div>
                              <span className="text-[10px] text-slate-300 font-bold block uppercase tracking-wide font-mono">
                                SESSION DETECTOR RISK (0–1)
                              </span>
                              <span className="text-[10px] text-slate-500 font-normal block">
                                Weighted mean of persisted heuristic scores; not a probability.
                              </span>
                            </div>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono font-bold uppercase ${
                              trustPattern === 'UNASSESSED' ? 'bg-slate-900 text-slate-400 border border-slate-700' : trustPattern === 'RISK_SPIKE' ? 'bg-rose-950/40 text-rose-400 border border-rose-500/40' :
                              trustPattern === 'RISK_RISING' ? 'bg-amber-950/40 text-amber-400 border border-amber-500/40' :
                              'bg-emerald-950/40 text-emerald-400 border border-emerald-500/40'
                            }`}>
                              {trustPattern === 'UNASSESSED' ? '— INSUFFICIENT HISTORY' : trustPattern === 'RISK_SPIKE' ? '▲ RISK SPIKE' :
                               trustPattern === 'RISK_RISING' ? '◆ RISK RISING' :
                               '● STABLE PATTERN'}
                            </span>
                          </div>

                          <div className="h-[110px] w-full pt-1">
                            {isTrustLoading ? (
                              <div className="h-full flex items-center justify-center text-[10px] text-slate-500">
                                Loading risk history...
                              </div>
                            ) : trustHistory.length > 0 ? (
                              <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={trustHistory} margin={{ top: 5, right: 10, left: -25, bottom: 0 }}>
                                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" opacity={0.6} />
                                  <XAxis dataKey="time" stroke="#475569" fontSize={7} tickLine={false} />
                                  <YAxis domain={[0, 1]} stroke="#475569" fontSize={7} tickLine={false} ticks={[0, 0.5, 1]} />
                                  <Tooltip contentStyle={{ backgroundColor: '#0a0f1d', borderColor: '#334155', borderRadius: '4px', fontSize: '9px', padding: '4px 8px' }} />
                                  <Line
                                    type="monotone"
                                    dataKey="smoothed_risk_score"
                                    stroke={isCritical ? '#f43f5e' : isSuspicious ? '#f59e0b' : '#f97316'}
                                    strokeWidth={2}
                                    dot={{ r: 2, fill: isCritical ? '#f43f5e' : isSuspicious ? '#f59e0b' : '#f97316' }}
                                    activeDot={{ r: 4 }}
                                    isAnimationActive={false}
                                  />
                                </LineChart>
                              </ResponsiveContainer>
                            ) : (
                              <div className="h-full flex items-center justify-center text-[10px] text-slate-500">
                                No scored risk observations recorded yet.
                              </div>
                            )}
                          </div>
                        </div>

                      </div>
                    );
                  })()}
                </div>
              )}
            </section>
          </div>

          {/* Collapsible Telemetry Toggle at bottom */}
          <div className="mt-2.5 flex items-center justify-between text-[10px] text-slate-500 font-normal">
            <button
              onClick={() => setShowTier2Telemetry(!showTier2Telemetry)}
              className="text-slate-400 hover:text-slate-200 flex items-center gap-1.5 transition-colors"
            >
              <span>{showTier2Telemetry ? '▼ HIDE' : '▶ SHOW'} SYSTEM DIAGNOSTIC TELEMETRY</span>
            </button>
            <span className="text-slate-600">UTC: {currentUtcTime}</span>
          </div>

          {/* Collapsible Bottom 4 Stat Cards */}
          {showTier2Telemetry && (
            <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-2">
              <div className="p-3 border border-slate-800 bg-[#080d18] rounded">
                <span className="text-[10px] text-slate-500 font-bold uppercase">Total Targets</span>
                <div className="flex items-baseline gap-2 mt-1">
                  <span className="text-xl font-bold text-slate-100">{stats.total}</span>
                  <span className="text-[10px] text-slate-500 font-normal">Active</span>
                </div>
              </div>
              <div className="p-3 border border-slate-800 bg-[#080d18] rounded">
                <span className="text-[10px] text-slate-500 font-bold uppercase">Anomalies</span>
                <div className="flex items-baseline gap-2 mt-1">
                  <span className="text-xl font-bold text-rose-400">{stats.anomalies}</span>
                  <span className="text-[10px] text-slate-500 font-normal">Flagged</span>
                </div>
              </div>
              <div className="p-3 border border-slate-800 bg-[#080d18] rounded">
                <span className="text-[10px] text-slate-500 font-bold uppercase">Mean Rule Triage Risk</span>
                <div className="flex items-baseline gap-2 mt-1">
                  <span className="text-xl font-bold text-slate-100">{Number.isFinite(stats.avgRisk) ? `${stats.avgRisk}%` : '—'}</span>
                  <span className="text-[10px] text-slate-500 font-normal">Heuristic, not calibrated</span>
                </div>
              </div>
              <div className="p-3 border border-slate-800 bg-[#080d18] rounded text-[10px] font-normal">
                <span className="text-[10px] text-slate-500 font-bold uppercase block mb-1">Ingestion Status</span>
                <div className="truncate text-slate-400">
                  CB: <span className="text-slate-200 font-bold">{healthData.circuit_breaker_state}</span> | LAT: {healthData.poll_latency_ms?.toFixed(1) ?? '—'}ms
                </div>
              </div>
            </section>
          )}

        </div>
      )}

      {/* ========================================================================= */}
      {/* Threat review, analytics, playback, system configuration, and administration */}
      {/* One clear focal point per tool. Muted neutral controls.                   */}
      {/* ========================================================================= */}
      {currentTier === 'tier3_tools' && (
        <div className="flex-1 flex flex-col min-h-0 relative z-10 px-4 md:px-6 py-4">

          {/* Shared workspace header and navigation */}
          <div className="flex flex-wrap items-center justify-between border-b border-slate-800 pb-3 mb-4 gap-3">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setCurrentTier('tier2_radar')}
                className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold px-3 py-1.5 rounded transition-colors flex items-center gap-1.5"
              >
                <span>← BACK TO AIRSPACE</span>
              </button>
              <span className="text-slate-700 hidden sm:inline">|</span>
              <span className="text-xs font-bold text-slate-400 uppercase hidden md:inline">
                AIRGUARD WORKSPACE
              </span>
            </div>

            {/* Workspace tabs */}
            <div className="flex flex-wrap bg-[#04070e] border border-slate-800 rounded p-0.5 text-xs font-bold">
              <button
                onClick={() => setTier3Tab('alerts')}
                className={`px-3 py-1 rounded transition-colors ${
                  tier3Tab === 'alerts'
                    ? 'bg-slate-800 text-cyan-400'
                    : 'text-slate-500 hover:text-slate-300 font-normal'
                }`}
              >
                ALERTS ({activeAlertCount !== undefined && activeAlertCount > 0 ? activeAlertCount : alerts.length})
              </button>
              <button
                onClick={() => setTier3Tab('analytics')}
                className={`px-3 py-1 rounded transition-colors ${
                  tier3Tab === 'analytics'
                    ? 'bg-slate-800 text-cyan-400'
                    : 'text-slate-500 hover:text-slate-300 font-normal'
                }`}
              >
                ANALYTICS
              </button>
              <button
                onClick={() => setTier3Tab('config')}
                className={`px-3 py-1 rounded transition-colors ${
                  tier3Tab === 'config'
                    ? 'bg-slate-800 text-cyan-400'
                    : 'text-slate-500 hover:text-slate-300 font-normal'
                }`}
              >
                THRESHOLDS
              </button>
              <button
                onClick={() => setTier3Tab('playback')}
                className={`px-3 py-1 rounded transition-colors ${
                  tier3Tab === 'playback'
                    ? 'bg-slate-800 text-cyan-400'
                    : 'text-slate-500 hover:text-slate-300 font-normal'
                }`}
              >
                PLAYBACK
              </button>
              {currentUser?.role === 'admin' && (
                <button
                  onClick={() => setTier3Tab('admin')}
                  className={`px-3 py-1 rounded transition-colors ${
                    tier3Tab === 'admin'
                      ? 'bg-slate-800 text-cyan-400'
                      : 'text-slate-500 hover:text-slate-300 font-normal'
                  }`}
                >
                  ADMIN
                </button>
              )}
              <button
                onClick={() => setTier3Tab('about')}
                className={`px-3 py-1 rounded transition-colors ${
                  tier3Tab === 'about'
                    ? 'bg-slate-800 text-cyan-400'
                    : 'text-slate-500 hover:text-slate-300 font-normal'
                }`}
              >
                PRODUCT GUIDE
              </button>
            </div>
          </div>

          {/* Tool 1: Alerts Audit Log Table */}
          {tier3Tab === 'alerts' && (
            <section className="flex-1 bg-[#080d18] border border-slate-800 rounded flex flex-col overflow-y-auto p-4 md:p-5 min-h-0 space-y-4">
              {/* Header & Quick Actions */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-slate-800 pb-3 gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-bold text-slate-100 uppercase m-0">ALERTS AUDIT LOG RECORD</h2>
                    <span className="bg-cyan-950/80 border border-cyan-800/80 text-cyan-300 text-[10px] font-bold px-2 py-0.5 rounded">
                      {alerts.length} LOADED ({activeAlertCount !== undefined ? `${activeAlertCount} ACTIVE` : 'LIVE'})
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1 font-normal">
                    Searchable log of flagged telemetry anomalies. Review, acknowledge, investigate on live radar, and export records.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={exportAlertsCSV}
                    className="bg-slate-900 border border-slate-700 hover:bg-slate-800 text-slate-200 font-bold text-xs py-1.5 px-3.5 rounded transition-colors flex items-center gap-1.5"
                  >
                    <span>📊 EXPORT CSV</span>
                  </button>
                  <button
                    onClick={downloadSessionReportPDF}
                    className="bg-slate-800 hover:bg-slate-700 text-slate-100 font-bold text-xs py-1.5 px-3.5 rounded transition-colors flex items-center gap-1.5"
                  >
                    <span>📄 SESSION PDF</span>
                  </button>
                </div>
              </div>

              {alertActionError && (
                <p className="rounded-lg border border-amber-800/60 bg-amber-950/30 p-2.5 text-xs text-amber-200" role="alert">
                  {alertActionError}
                </p>
              )}

              {/* Search and Filters Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-3 bg-[#04070e] border border-slate-800 rounded-lg p-3">
                <div className="flex flex-1 min-w-[240px] items-center gap-2">
                  <span className="text-slate-500 text-xs">🔍</span>
                  <input
                    type="text"
                    placeholder="Search by flight callsign, airline (e.g. IndiGo), ICAO hex, or anomaly reason..."
                    value={alertSearch}
                    onChange={(e) => {
                      setAlertSearch(e.target.value);
                      setAlertPage(0);
                    }}
                    className="w-full bg-transparent border-0 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-0 font-normal"
                  />
                  {alertSearch && (
                    <button
                      onClick={() => { setAlertSearch(''); setAlertPage(0); }}
                      className="text-slate-500 hover:text-slate-300 text-xs px-1"
                    >
                      ✕
                    </button>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <button
                    onClick={() => { setAlertSeverityFilter('all'); setAlertPage(0); }}
                    className={`px-2.5 py-1 rounded text-[11px] font-bold transition-colors ${
                      alertSeverityFilter === 'all'
                        ? 'bg-slate-700 text-cyan-300 border border-slate-600'
                        : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
                    }`}
                  >
                    ALL ({alerts.length})
                  </button>
                  <button
                    onClick={() => { setAlertSeverityFilter('high'); setAlertPage(0); }}
                    className={`px-2.5 py-1 rounded text-[11px] font-bold transition-colors ${
                      alertSeverityFilter === 'high'
                        ? 'bg-rose-950/80 text-rose-300 border border-rose-800'
                        : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
                    }`}
                  >
                    🔴 CRITICAL ({alerts.filter(a => a.severity === 'high').length})
                  </button>
                  <button
                    onClick={() => { setAlertSeverityFilter('medium'); setAlertPage(0); }}
                    className={`px-2.5 py-1 rounded text-[11px] font-bold transition-colors ${
                      alertSeverityFilter === 'medium'
                        ? 'bg-amber-950/80 text-amber-300 border border-amber-800'
                        : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
                    }`}
                  >
                    🟡 SUSPICIOUS ({alerts.filter(a => a.severity === 'medium').length})
                  </button>
                  <button
                    onClick={() => { setAlertSeverityFilter('unacked'); setAlertPage(0); }}
                    className={`px-2.5 py-1 rounded text-[11px] font-bold transition-colors ${
                      alertSeverityFilter === 'unacked'
                        ? 'bg-sky-950/80 text-sky-300 border border-sky-800'
                        : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
                    }`}
                  >
                    ⚠️ UNACKNOWLEDGED ({alerts.filter(a => !a.acknowledged).length})
                  </button>
                </div>

                <div className="flex items-center gap-2 text-xs text-slate-400 font-normal">
                  <span>Per page:</span>
                  <select
                    value={alertsPerPage}
                    onChange={(e) => {
                      setAlertPerPage(Number(e.target.value));
                      setAlertPage(0);
                    }}
                    className="bg-[#080d18] border border-slate-800 rounded px-2 py-1 text-slate-200 text-xs focus:outline-none"
                  >
                    <option value={10}>10</option>
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                </div>
              </div>

              {/* Airspace Event Candidates Panel (Collapsible) */}
              <details className="border border-slate-800/80 bg-[#04070e]/80 rounded-lg overflow-hidden group">
                <summary className="px-4 py-2.5 bg-slate-900/50 border-b border-slate-800/80 cursor-pointer flex items-center justify-between text-xs font-bold text-slate-300 hover:text-white select-none transition-colors">
                  <div className="flex items-center gap-2">
                    <span className="text-cyan-400">⚡</span>
                    <span className="tracking-wide">MULTI-AIRCRAFT PROXIMITY EVENT REVIEW & CASE DERIVATION</span>
                  </div>
                  <span className="text-[10px] text-slate-500 font-normal group-open:rotate-180 transition-transform">▼ Click to expand/collapse</span>
                </summary>
                <div className="p-3">
                  <Suspense fallback={<div className="p-4 text-xs text-slate-400">Loading airspace event review…</div>}>
                    <AirspaceEventCandidatePanel onInvestigate={(icao24) => {
                      setSelectedFlightId(icao24);
                      setIsDetailDrawerOpen(true);
                      setCurrentTier('tier2_radar');
                    }} />
                  </Suspense>
                </div>
              </details>

              {/* Alerts Audit Log Table */}
              <div className="border border-slate-800/80 rounded-lg overflow-x-auto bg-[#04070e]/50">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 bg-slate-900/60 text-slate-400 uppercase text-[10px] tracking-wider">
                      <th className="py-3 px-3 cursor-pointer hover:text-slate-200 font-bold" onClick={() => { setSortField('timestamp'); setSortAsc(!sortAsc); }}>
                        Timestamp {sortField === 'timestamp' && (sortAsc ? '▲' : '▼')}
                      </th>
                      <th className="py-3 px-3 cursor-pointer hover:text-slate-200 font-bold" onClick={() => { setSortField('callsign'); setSortAsc(!sortAsc); }}>
                        Aircraft & Airline {sortField === 'callsign' && (sortAsc ? '▲' : '▼')}
                      </th>
                      <th className="py-3 px-3 font-bold">ICAO Hex</th>
                      <th className="py-3 px-3 font-bold">Anomaly Evidence / Reason</th>
                      <th className="py-3 px-3 font-bold">Severity</th>
                      <th className="py-3 px-3 cursor-pointer hover:text-slate-200 font-bold" onClick={() => { setSortField('scoreImpact'); setSortAsc(!sortAsc); }}>
                        Impact {sortField === 'scoreImpact' && (sortAsc ? '▲' : '▼')}
                      </th>
                      <th className="py-3 px-3 font-bold text-center">Status / Acknowledge</th>
                      <th className="py-3 px-3 font-bold text-right">Radar Investigation</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-xs font-normal">
                    {paginatedAlerts.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="py-12 text-center text-slate-500">
                          {alertSearch ? `No alert logs matching "${alertSearch}".` : "No alert logs available in active stream."}
                        </td>
                      </tr>
                    ) : (
                      paginatedAlerts.map(a => {
                        const sevColor =
                          a.severity === 'high' ? 'bg-rose-950/80 text-rose-300 border border-rose-800' : 'bg-amber-950/80 text-amber-300 border border-amber-800';
                        const airlineInfo = getAirlineInfo(a.callsign, a.icao24);
                        return (
                          <tr key={a.id} className={`hover:bg-slate-800/30 transition-colors ${a.acknowledged ? 'opacity-50' : ''}`}>
                            <td className="py-2.5 px-3 text-slate-400 font-mono text-[11px] whitespace-nowrap">{a.timestamp}</td>
                            <td className="py-2.5 px-3">
                              <div className="flex items-center gap-2">
                                <span className="font-bold text-slate-100">{a.callsign}</span>
                                {airlineInfo.name && airlineInfo.code !== 'GEN' && (
                                  <span
                                    className="text-[9px] font-bold px-1.5 py-0.5 rounded border"
                                    style={{
                                      backgroundColor: `${airlineInfo.color}22`,
                                      borderColor: `${airlineInfo.color}66`,
                                      color: airlineInfo.color === '#002b66' || airlineInfo.color === '#003366' ? '#93c5fd' : airlineInfo.color
                                    }}
                                  >
                                    {airlineInfo.name}
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="py-2.5 px-3 text-slate-400 font-mono text-[11px]">{a.icao24.toUpperCase()}</td>
                            <td className="py-2.5 px-3 text-slate-300">
                              {a.is_synthetic && <span className="bg-slate-800 text-slate-300 text-[10px] px-1.5 py-0.5 rounded border border-slate-700 mr-2 uppercase font-bold">TEST</span>}
                              <span>{a.type}</span>
                            </td>
                            <td className="py-2.5 px-3 whitespace-nowrap">
                              <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${sevColor}`}>
                                {a.is_synthetic ? 'TEST' : a.severity}
                              </span>
                            </td>
                            <td className="py-2.5 px-3 text-rose-400 font-bold whitespace-nowrap">{a.scoreImpact} pts</td>
                            <td className="py-2.5 px-3 text-center">
                              {a.acknowledged ? (
                                <span className="text-[10px] text-slate-500 border border-slate-800 bg-[#04070e] px-2 py-0.5 rounded">
                                  ACKNOWLEDGED
                                </span>
                              ) : (
                                <button
                                  onClick={() => handleAcknowledge(a.id)}
                                  className="text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-200 px-2.5 py-1 rounded transition-colors font-medium border border-slate-700"
                                >
                                  ACKNOWLEDGE
                                </button>
                              )}
                            </td>
                            <td className="py-2.5 px-3 text-right">
                              <button
                                onClick={() => {
                                  setSelectedFlightId(a.icao24);
                                  setIsDetailDrawerOpen(true);
                                  setCurrentTier('tier2_radar');
                                }}
                                className="text-[10px] bg-cyan-950/80 hover:bg-cyan-900 border border-cyan-800 text-cyan-300 font-bold px-2.5 py-1 rounded transition-colors"
                              >
                                🎯 TRACK ON MAP
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination Controls */}
              <div className="flex flex-wrap items-center justify-between border-t border-slate-800 pt-3 gap-3 text-xs font-normal">
                <span className="text-slate-400 text-[11px]">
                  Showing {sortedAlerts.length > 0 ? alertPage * alertsPerPage + 1 : 0} - {Math.min((alertPage + 1) * alertsPerPage, sortedAlerts.length)} of {sortedAlerts.length} logs
                  {alerts.length !== sortedAlerts.length && ` (filtered from ${alerts.length} total)`}
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    disabled={alertPage === 0}
                    onClick={() => setAlertPage(0)}
                    className="border border-slate-800 bg-[#04070e] px-2 py-1 rounded text-slate-400 hover:text-slate-200 disabled:opacity-30 text-[11px]"
                  >
                    « FIRST
                  </button>
                  <button
                    disabled={alertPage === 0}
                    onClick={() => setAlertPage(alertPage - 1)}
                    className="border border-slate-800 bg-[#04070e] px-2.5 py-1 rounded text-slate-400 hover:text-slate-200 disabled:opacity-30 text-[11px]"
                  >
                    ‹ PREV
                  </button>
                  <span className="px-2 text-slate-300 font-bold text-[11px]">
                    Page {alertPage + 1} of {Math.max(1, Math.ceil(sortedAlerts.length / alertsPerPage))}
                  </span>
                  <button
                    disabled={(alertPage + 1) * alertsPerPage >= sortedAlerts.length}
                    onClick={() => setAlertPage(alertPage + 1)}
                    className="border border-slate-800 bg-[#04070e] px-2.5 py-1 rounded text-slate-400 hover:text-slate-200 disabled:opacity-30 text-[11px]"
                  >
                    NEXT ›
                  </button>
                  <button
                    disabled={(alertPage + 1) * alertsPerPage >= sortedAlerts.length}
                    onClick={() => setAlertPage(Math.max(0, Math.ceil(sortedAlerts.length / alertsPerPage) - 1))}
                    className="border border-slate-800 bg-[#04070e] px-2 py-1 rounded text-slate-400 hover:text-slate-200 disabled:opacity-30 text-[11px]"
                  >
                    LAST »
                  </button>
                </div>
              </div>
            </section>
          )}

          {/* Tool 2: Analytics & Replay */}
          {tier3Tab === 'analytics' && (
            <div className="flex-1 grid grid-cols-12 gap-5 min-h-0 overflow-y-auto">
              <section className="col-span-12 lg:col-span-7 bg-[#080d18] border border-slate-800 rounded p-5 space-y-4">
                <div className="border-b border-slate-800 pb-3">
                  <h2 className="text-sm font-bold text-slate-200 uppercase m-0">LIVE DATA & DETECTOR STATUS</h2>
                  <p className="text-[11px] text-slate-400 mt-1">Operational counts reflect observations currently available to this application instance.</p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="bg-[#060913] border border-slate-800 rounded p-4"><div className="text-[10px] text-slate-500">LIVE AIRCRAFT</div><div className="text-2xl text-slate-100 font-semibold mt-1">{liveAircraftCount}</div></div>
                  <div className="bg-[#060913] border border-slate-800 rounded p-4"><div className="text-[10px] text-slate-500">WITH DETECTOR SCORE</div><div className="text-2xl text-slate-100 font-semibold mt-1">{stats.scoredCount}</div></div>
                  <div className="bg-[#060913] border border-slate-800 rounded p-4"><div className="text-[10px] text-slate-500">SOURCE CONNECTION</div><div className={`text-lg font-semibold mt-2 ${backendHealth === 'online' ? 'text-emerald-400' : 'text-amber-300'}`}>{backendHealth === 'online' ? 'CONNECTED' : 'UNAVAILABLE'}</div></div>
                </div>
                <div className="bg-[#060913] border border-slate-800 rounded p-4 text-xs text-slate-300 leading-relaxed space-y-2">
                  <p>Coverage depends on the connected surveillance provider, its receiver network, API limits, and the current query area. This live view does not represent every aircraft worldwide.</p>
                  <p>Missing source fields remain unavailable. Aircraft without enough evidence are not assigned a detector score.</p>
                </div>
              </section>
              <section className="col-span-12 lg:col-span-5 bg-[#080d18] border border-slate-800 rounded p-5 space-y-3">
                <div className="border-b border-slate-800 pb-2"><h2 className="text-sm font-bold text-slate-200 uppercase m-0">VALIDATION STATUS</h2><span className="text-[10px] text-slate-400">Evidence status for the active detector</span></div>
                <div className="bg-[#060913] p-3 rounded border border-amber-900/60 text-xs text-slate-300 space-y-2 leading-relaxed">
                  <div className="font-bold text-amber-300">RESEARCH ML DISABLED · VALIDATION NOT ESTABLISHED</div>
                  <p>Live triage uses deterministic telemetry rules. No independently labeled real-world evaluation set is configured, so precision, recall, and model accuracy are not reported.</p>
                  <p>Detector scores are heuristic triage signals, not calibrated probabilities or proof of spoofing.</p>
                </div>
                <div className="bg-[#060913] p-3 rounded border border-slate-800 text-xs text-slate-300 leading-relaxed">
                  <div className="font-semibold text-slate-100 mb-1">ACTIVE EVIDENCE PIPELINE</div>
                  Real source observations are normalized, checked by deterministic kinematic rules, and retained with field-level data quality. Research ML scores are not part of live decisions.
                </div>
              </section>
            </div>
          )}

          {/* Tool 3: Threshold Config & System Telemetry Diagnostics */}
          {tier3Tab === 'config' && (
            <div className="flex-1 grid grid-cols-12 gap-5 min-h-0 overflow-y-auto">
              <section className="col-span-12 lg:col-span-7 bg-[#080d18] border border-slate-800 rounded p-5 flex flex-col justify-between">
                <div>
                  <div className="border-b border-slate-800 pb-2 mb-4">
                    <h2 className="text-sm font-bold text-slate-200 uppercase m-0">AERODYNAMIC CORRELATION THRESHOLDS</h2>
                    <p className="text-[11px] text-slate-400 mt-1 font-normal">
                      Adjust how sensitive the system is — stricter catches more, but risks more false alarms.
                    </p>
                  </div>

                  <div className="space-y-4 text-[10px] font-normal">
                    <div className="space-y-1">
                      <div className="flex justify-between">
                        <span className="text-slate-400">Max Implied Speed:</span>
                        <span className="text-slate-100 font-bold">{config.max_implied_speed_kmh} km/h</span>
                      </div>
                      <input
                        type="range" min="500" max="2500" step="50"
                        value={config.max_implied_speed_kmh}
                        onChange={(e) => setConfig({ ...config, max_implied_speed_kmh: parseFloat(e.target.value) })}
                        className="w-full accent-cyan-500 bg-slate-900 h-1 rounded cursor-pointer"
                      />
                    </div>

                    <div className="space-y-1">
                      <div className="flex justify-between">
                        <span className="text-slate-400">Duplicate ICAO Distance Limit:</span>
                        <span className="text-slate-100 font-bold">{config.duplicate_icao_dist_km} km</span>
                      </div>
                      <input
                        type="range" min="5" max="150" step="5"
                        value={config.duplicate_icao_dist_km}
                        onChange={(e) => setConfig({ ...config, duplicate_icao_dist_km: parseFloat(e.target.value) })}
                        className="w-full accent-cyan-500 bg-slate-900 h-1 rounded cursor-pointer"
                      />
                    </div>

                    <div className="space-y-1">
                      <div className="flex justify-between">
                        <span className="text-slate-400">Max Vertical Rate:</span>
                        <span className="text-slate-100 font-bold">{config.max_vertical_rate_ms} m/s</span>
                      </div>
                      <input
                        type="range" min="10" max="150" step="5"
                        value={config.max_vertical_rate_ms}
                        onChange={(e) => setConfig({ ...config, max_vertical_rate_ms: parseFloat(e.target.value) })}
                        className="w-full accent-cyan-500 bg-slate-900 h-1 rounded cursor-pointer"
                      />
                    </div>

                    <div className="space-y-1">
                      <div className="flex justify-between">
                        <span className="text-slate-400">Max Ground Altitude:</span>
                        <span className="text-slate-100 font-bold">{config.max_ground_altitude_m} m</span>
                      </div>
                      <input
                        type="range" min="10" max="500" step="10"
                        value={config.max_ground_altitude_m}
                        onChange={(e) => setConfig({ ...config, max_ground_altitude_m: parseFloat(e.target.value) })}
                        className="w-full accent-cyan-500 bg-slate-900 h-1 rounded cursor-pointer"
                      />
                    </div>

                    <div className="space-y-1">
                      <div className="flex justify-between">
                        <span className="text-slate-400">Max Ground Speed Limit:</span>
                        <span className="text-slate-100 font-bold">{config.max_ground_speed_ms} m/s</span>
                      </div>
                      <input
                        type="range" min="10" max="150" step="5"
                        value={config.max_ground_speed_ms}
                        onChange={(e) => setConfig({ ...config, max_ground_speed_ms: parseFloat(e.target.value) })}
                        className="w-full accent-cyan-500 bg-slate-900 h-1 rounded cursor-pointer"
                      />
                    </div>

                    <div className="space-y-1">
                      <div className="flex justify-between">
                        <span className="text-slate-400">Min Flight Speed:</span>
                        <span className="text-slate-100 font-bold">{config.min_flight_speed_ms} m/s</span>
                      </div>
                      <input
                        type="range" min="5" max="100" step="5"
                        value={config.min_flight_speed_ms}
                        onChange={(e) => setConfig({ ...config, min_flight_speed_ms: parseFloat(e.target.value) })}
                        className="w-full accent-cyan-500 bg-slate-900 h-1 rounded cursor-pointer"
                      />
                    </div>
                  </div>
                </div>

                <div className="pt-5 border-t border-slate-800 flex gap-3">
                  <button
                    onClick={handleSaveConfig}
                    className="flex-1 bg-cyan-500 hover:bg-cyan-400 text-black font-bold py-2 px-4 rounded transition-colors text-xs"
                  >
                    SAVE CONFIG
                  </button>
                  <button
                    onClick={handleResetConfig}
                    className="border border-slate-800 bg-slate-900 hover:bg-slate-800 text-slate-300 font-bold py-2 px-4 rounded transition-colors text-xs"
                  >
                    RESET TO DEFAULTS
                  </button>
                </div>
              </section>

              {/* Right 40%: Infrastructure Telemetry */}
              <section className="col-span-12 lg:col-span-5 bg-[#080d18] border border-slate-800 rounded p-5 flex flex-col justify-between">
                <div>
                  <div className="border-b border-slate-800 pb-2 mb-3">
                    <h2 className="text-sm font-bold text-slate-200 uppercase m-0">INFRASTRUCTURE TELEMETRY</h2>
                    <span className="text-[10px] text-slate-500 font-normal">Gateway metrics & receiver health diagnostics</span>
                  </div>

                  <div className="space-y-2.5 text-[10px] font-normal">
                    <div className="p-3 bg-[#060913] rounded border border-slate-800 space-y-2">
                      <div className="flex justify-between">
                        <span className="text-slate-500">DATA SOURCE:</span>
                        <span className="text-slate-200 font-bold">Configured feed</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">MONITORED REGION:</span>
                        <span className="text-slate-200 font-bold">India Subcontinent</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">CIRCUIT BREAKER:</span>
                        <span className="text-slate-200 font-bold">{healthData.circuit_breaker_state}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">QUEUE DEPTH:</span>
                        <span className="text-slate-200 font-bold">{healthData.queue_depth ?? '—'} vectors</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">POLL LATENCY:</span>
                        <span className="text-slate-200 font-bold">{healthData.poll_latency_ms?.toFixed(1) ?? '—'} ms</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">LAST SUCCESSFUL SYNC:</span>
                        <span className="text-slate-400">
                          {healthData.last_successful_poll ? healthData.last_successful_poll.split('T')[1]?.substring(0, 8) || '—' : '—'}
                        </span>
                      </div>
                    </div>

                    {/* Reduce Motion Preferences */}
                    <div className="p-3 bg-[#060913] rounded border border-slate-800 space-y-2 mt-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                            <span>{reduceMotion ? '⚡' : '🎬'}</span>
                            <span>REDUCE MOTION</span>
                          </div>
                          <div className="text-[10px] text-slate-400">
                            {reduceMotion
                              ? "Camera fly-to animations and transitions disabled (honoring prefers-reduced-motion)"
                              : "Standard animations active (camera lerp, fly-tos, cloud drift)"}
                          </div>
                        </div>
                        <button
                          onClick={() => handleToggleReduceMotion(!reduceMotion)}
                          className={`px-3 py-1.5 rounded font-mono text-xs font-bold border transition-all ${
                            reduceMotion
                              ? "bg-amber-950/80 border-amber-500 text-amber-300 shadow-[0_0_10px_rgba(245,158,11,0.3)]"
                              : "bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200"
                          }`}
                        >
                          {reduceMotion ? "REDUCED (ON)" : "NORMAL (OFF)"}
                        </button>
                      </div>

                      <div className="text-[10px] text-slate-500 pt-1 border-t border-slate-800/80">
                        <span className="text-amber-400 font-medium">Accessibility & Comfort:</span> Respects system-level <code>prefers-reduced-motion</code> accessibility settings. When active, camera pans and selection zooms are instantaneous, bypassing motion-sickness triggers and optimizing execution on lower-spec hardware.
                      </div>
                    </div>

                    {/* Auditory Feedback Layer Preferences */}
                    <div className="p-3 bg-[#060913] rounded border border-slate-800 space-y-2 mt-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                            <span>{isSoundEnabled ? '🔊' : '🔇'}</span>
                            <span>AUDITORY FEEDBACK LAYER</span>
                          </div>
                          <div className="text-[10px] text-slate-400">
                            {isSoundEnabled
                              ? "Soft anomaly chimes and close-orbit ambient hum active on globe"
                              : "Audio muted globally (off by default, opt-in mode)"}
                          </div>
                        </div>
                        <button
                          onClick={handleToggleSound}
                          className={`px-3 py-1.5 rounded font-mono text-xs font-bold border transition-all ${
                            isSoundEnabled
                              ? "bg-cyan-950/80 border-cyan-500 text-cyan-300 shadow-[0_0_10px_rgba(6,182,212,0.3)]"
                              : "bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200"
                          }`}
                        >
                          {isSoundEnabled ? "ENABLED (ON)" : "MUTED (OFF)"}
                        </button>
                      </div>

                      <div className="text-[10px] text-slate-500 pt-1 border-t border-slate-800/80 space-y-1">
                        <div><b className="text-cyan-400">Pleasant Chime:</b> Plays a soft harmonic acoustic triad (&lt; 1.4s) when a live anomaly is flagged on the globe. Never a siren or klaxon.</div>
                        <div><b className="text-cyan-400">Ambient Hum:</b> Optional low-volume audio during aircraft follow mode.</div>
                        <div><b className="text-amber-400 font-medium">Data-Reading Silence:</b> Audio is strictly silenced in the Detail drawer, Analytics, and Config screens so reading and concentration are never disturbed.</div>
                      </div>
                    </div>

                    {/* Detector Risk Overlay Preferences */}
                    <div className="p-3 bg-[#060913] rounded border border-slate-800 space-y-2 mt-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full bg-sky-400"></span>
                            <span>DETECTOR RISK OVERLAY</span>
                          </div>
                          <div className="text-[10px] text-slate-400">
                            Shows sectors with scored aircraft and their mean heuristic detector risk. Unscored tracks are omitted.
                          </div>
                        </div>
                        <button
                          onClick={() => handleToggleConfidenceOverlay(!showConfidenceOverlay)}
                          className={`px-3 py-1.5 rounded font-mono text-xs font-bold border transition-all ${
                            showConfidenceOverlay
                              ? "bg-sky-950/80 border-sky-500 text-sky-300 shadow-[0_0_10px_rgba(56,189,248,0.3)]"
                              : "bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200"
                          }`}
                        >
                          {showConfidenceOverlay ? "ENABLED (ON)" : "DISABLED (OFF)"}
                        </button>
                      </div>

                      <div className="text-[10px] text-slate-500 pt-1 border-t border-slate-800/80 space-y-1">
                        <div><b className="text-sky-400">AirGuard Approach:</b> AirGuard stores source observations and detector signals for evidence-led review.</div>
                        <div><b className="text-sky-400">Sector view:</b> Averages persisted heuristic detector-risk scores by location. This is not source integrity, a probability, or independent position verification.</div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="pt-3 border-t border-slate-800 text-center">
                  <span className="text-[10px] text-slate-600 block uppercase font-normal">
                    AirGuard Ingestion Engine v0.1.0
                  </span>
                </div>
              </section>
            </div>
          )}

          {/* Playback is built only from stored upstream aircraft observations. */}
          {tier3Tab === 'playback' && (
            <Suspense fallback={<div className="p-6 text-sm text-slate-400">Loading historical playback…</div>}>
              <HistoricalPlaybackView />
            </Suspense>
          )}
          {/* Tool 5: Admin System Panel */}
          {tier3Tab === 'admin' && currentUser?.role === 'admin' && (
            <div className="flex-1 grid grid-cols-12 gap-5 min-h-0 overflow-y-auto">
              <section className="col-span-12 lg:col-span-8 bg-[#080d18] border border-slate-800 rounded p-4 flex flex-col gap-3">
                <div className="flex justify-between items-center border-b border-slate-800 pb-2.5">
                  <div>
                    <h2 className="text-sm font-bold text-slate-200 uppercase m-0">SYSTEM AUDIT LOGS & USER ACCESS</h2>
                    <p className="text-[11px] text-slate-400 mt-1 font-normal">
                      Manage who has access to this ground station and audit every action taken by operators.
                    </p>
                  </div>
                  <select
                    value={logFilterAction}
                    onChange={(e) => setLogFilterAction(e.target.value)}
                    className="bg-[#060913] border border-slate-800 rounded px-2 py-1 text-[10px] text-slate-300 focus:outline-none focus:border-cyan-500 font-normal"
                  >
                    <option value="">ALL ACTIONS</option>
                    <option value="acknowledge">Acknowledge Alert</option>
                    <option value="update_config">Update Thresholds</option>
                    <option value="replay">Trigger Replay</option>
                    <option value="create_user">Create User</option>
                    <option value="delete_user">Delete User</option>
                  </select>
                </div>

                <div className="flex-1 overflow-x-auto min-h-0">
                  <table className="w-full text-[10px] text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-500 uppercase">
                        <th className="py-2 px-2.5 font-bold">Timestamp</th>
                        <th className="py-2 px-2.5 font-bold">Operator</th>
                        <th className="py-2 px-2.5 font-bold">Action</th>
                        <th className="py-2 px-2.5 font-bold">Target</th>
                        <th className="py-2 px-2.5 font-bold">IP</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 font-normal">
                      {auditLogs.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="py-6 text-center text-slate-600">
                            NO AUDIT RECORD ENTRIES FOUND.
                          </td>
                        </tr>
                      ) : (
                        auditLogs.map((log) => (
                          <tr key={log.id} className="hover:bg-slate-800/20 text-slate-300">
                            <td className="py-2 px-2.5 text-slate-500">
                              {log.timestamp.replace("T", " ").substring(0, 19)} UTC
                            </td>
                            <td className="py-2 px-2.5 text-slate-200 font-bold">
                              {log.user_id ? `OP-${log.user_id}` : "SYSTEM"}
                            </td>
                            <td className="py-2 px-2.5 uppercase">
                              <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                                {log.action.replace("_", " ")}
                              </span>
                            </td>
                            <td className="py-2 px-2.5 text-slate-400">{log.target_type}</td>
                            <td className="py-2 px-2.5 text-slate-500">{log.ip_address || "127.0.0.1"}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="col-span-12 lg:col-span-4 bg-[#080d18] border border-slate-800 rounded p-4 flex flex-col gap-3">
                <div className="border-b border-slate-800 pb-2">
                  <h2 className="text-sm font-bold text-slate-200 uppercase m-0">USER MANAGEMENT</h2>
                  <span className="text-[10px] text-slate-500 font-normal">Provision operator clearance profiles</span>
                </div>

                {adminError && (
                  <div className="bg-rose-950/30 border border-rose-500/30 text-rose-400 text-[10px] p-2 rounded font-normal">
                    ▲ ERROR: {adminError}
                  </div>
                )}
                {adminSuccess && (
                  <div className="bg-slate-900 border border-slate-700 text-slate-200 text-[10px] p-2 rounded font-normal">
                    ● SUCCESS: {adminSuccess}
                  </div>
                )}

                <form onSubmit={handleCreateUser} className="space-y-2.5 bg-[#060913] p-3 rounded border border-slate-800">
                  <div className="text-[10px] text-slate-400 uppercase font-bold border-b border-slate-800 pb-1 mb-2">
                    Register Operator
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-500 block mb-1 uppercase font-bold">Operator Email</label>
                    <input
                      type="email" required placeholder="name@airguard.sec"
                      value={newUserEmail} onChange={(e) => setNewUserEmail(e.target.value)}
                      className="w-full bg-[#0a0f1d] border border-slate-800 rounded px-2.5 py-1 text-xs text-slate-100 placeholder-slate-600 focus:outline-none focus:border-cyan-500 font-normal"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-500 block mb-1 uppercase font-bold">Temporary Password</label>
                    <input
                      type="password" required placeholder="••••••••••••"
                      value={newUserPassword} onChange={(e) => setNewUserPassword(e.target.value)}
                      className="w-full bg-[#0a0f1d] border border-slate-800 rounded px-2.5 py-1 text-xs text-slate-100 placeholder-slate-600 focus:outline-none focus:border-cyan-500 font-normal"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-500 block mb-1 uppercase font-bold">Clearance Role</label>
                    <select
                      value={newUserRole} onChange={(e) => setNewUserRole(e.target.value)}
                      className="w-full bg-[#0a0f1d] border border-slate-800 rounded px-2 py-1 text-xs text-slate-100 focus:outline-none focus:border-cyan-500 font-normal"
                    >
                      <option value="viewer">Viewer (Read-Only)</option>
                      <option value="analyst">Analyst (Acknowledge, Config)</option>
                      <option value="admin">Admin (Full Clearance)</option>
                    </select>
                  </div>
                  <button
                    type="submit"
                    className="w-full bg-cyan-500 hover:bg-cyan-400 text-black font-bold text-xs py-1.5 rounded transition-colors mt-2"
                  >
                    PROVISION OPERATOR
                  </button>
                </form>

                <div className="flex-1 overflow-y-auto">
                  <div className="text-[10px] text-slate-500 uppercase font-bold mb-1.5">
                    Active Operators ({adminUsers.length})
                  </div>
                  <div className="space-y-1.5">
                    {adminUsers.map((u) => (
                      <div key={u.id} className="flex justify-between items-center p-2 rounded bg-[#060913] border border-slate-800 text-[10px] font-normal">
                        <div>
                          <div className="text-slate-200 font-bold">{u.email}</div>
                          <div className="text-[10px] text-slate-500 uppercase">Role: <span className="text-slate-300 font-bold">{u.role}</span></div>
                        </div>
                        {u.id !== currentUser.id && (
                          <button
                            onClick={() => handleDeleteUser(u.id)}
                            className="text-rose-400 hover:text-rose-300 border border-slate-800 bg-[#0a0f1d] px-2 py-0.5 rounded text-[10px] font-normal"
                          >
                            REVOKE
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            </div>
          )}

          {/* Tool 6: System Overview & Architecture Explainer */}
          {tier3Tab === 'about' && (
            <div className="flex-1 bg-[#080d18] border border-slate-800 rounded p-6 overflow-y-auto max-w-4xl mx-auto w-full">
              <span className="text-[10px] text-cyan-300 uppercase font-bold tracking-[0.18em] border border-cyan-900/70 bg-cyan-950/30 px-2.5 py-1 rounded">AIRGUARD FIELD GUIDE</span>
              <h2 className="text-2xl font-semibold mt-4 text-white tracking-tight">A clearer view of the sky</h2>
              <p className="mt-2 text-sm text-slate-400 leading-relaxed max-w-3xl">Explore aircraft reports, follow a live position, and understand what the system has actually observed. AirGuard turns transponder data into an approachable airspace picture for curious travellers, students, and aviation teams.</p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-7">
                <article className="p-5 border border-slate-800 bg-slate-950/60 rounded-xl"><span className="text-cyan-300 text-xs font-semibold">01 · LIVE AIRCRAFT</span><h3 className="text-base font-semibold text-slate-100 mt-2">Find a flight</h3><p className="text-sm text-slate-400 mt-2 leading-relaxed">Search by callsign, aircraft address, or known route. Select a target to center the map, inspect its current altitude and speed, and turn on follow mode to keep it in view as new reports arrive.</p></article>
                <article className="p-5 border border-slate-800 bg-slate-950/60 rounded-xl"><span className="text-indigo-300 text-xs font-semibold">02 · ROUTE CONTEXT</span><h3 className="text-base font-semibold text-slate-100 mt-2">Planned endpoints and observed movement</h3><p className="text-sm text-slate-400 mt-2 leading-relaxed">When route data is available, the dashed line connects reported departure and arrival airports. The solid trail represents positions received by this session. A route estimate is not proof of the exact path flown.</p></article>
                <article className="p-5 border border-slate-800 bg-slate-950/60 rounded-xl"><span className="text-amber-300 text-xs font-semibold">03 · TRUST SIGNALS</span><h3 className="text-base font-semibold text-slate-100 mt-2">Read alerts with context</h3><p className="text-sm text-slate-400 mt-2 leading-relaxed">Review and critical markers flag reports for closer inspection. They describe data-quality or motion-pattern concerns, not a confirmed safety incident. Open the aircraft record to see the reasons and supporting details returned by the analysis pipeline.</p></article>
                <article className="p-5 border border-slate-800 bg-slate-950/60 rounded-xl"><span className="text-emerald-300 text-xs font-semibold">04 · DATA FRESHNESS</span><h3 className="text-base font-semibold text-slate-100 mt-2">Know what is live</h3><p className="text-sm text-slate-400 mt-2 leading-relaxed">Aircraft visibility depends on receiver coverage, feed availability, and transponder reporting. Positions can be delayed or missing; AirGuard does not represent a complete, authoritative air traffic control picture.</p></article>
                <article className="p-5 border border-slate-800 bg-slate-950/60 rounded-xl"><span className="text-violet-300 text-xs font-semibold">05 · LOCAL AIRSPACE</span><h3 className="text-base font-semibold text-slate-100 mt-2">See what is flying nearby</h3><p className="text-sm text-slate-400 mt-2 leading-relaxed">Choose “Aircraft near me” on the map to compare reported aircraft with your device’s location. Your location stays in the browser and is never uploaded; nearby results depend on local feed coverage.</p></article>
              </div>
              <div className="mt-6 rounded-xl border border-slate-800 bg-[#060913] p-4"><h3 className="text-sm font-semibold text-slate-200">How the picture is built</h3><div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mt-3 text-xs"><div className="text-slate-300"><b className="text-slate-500">01</b> · Receive transponder reports</div><div className="text-slate-300"><b className="text-slate-500">02</b> · Decode position and motion</div><div className="text-slate-300"><b className="text-slate-500">03</b> · Compare with expected aircraft behaviour</div><div className="text-slate-300"><b className="text-slate-500">04</b> · Show evidence and freshness</div></div></div>
            </div>
          )}

        </div>
      )}

      {/* --- Footer --- */}
      <footer className="border-t border-slate-800 bg-[#060913] px-6 py-2 flex items-center justify-between text-[10px] text-slate-500 relative z-20 font-normal">
        <div>AirGuard · Airspace Trust &amp; Threat Intelligence</div>
        <div className="flex items-center gap-4">
          <button onClick={() => { setCurrentTier('tier3_tools'); setTier3Tab('about'); }} className="hover:text-slate-300 transition-colors">Product guide</button>
          <button onClick={() => { setCurrentTier('tier3_tools'); setTier3Tab('alerts'); }} className="hover:text-slate-300 transition-colors">Alerts</button>
          <button onClick={() => { setCurrentTier('tier3_tools'); setTier3Tab('config'); }} className="hover:text-slate-300 transition-colors">Thresholds</button>
        </div>
      </footer>
    </div>
  );
}
