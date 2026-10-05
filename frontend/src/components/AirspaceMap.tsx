import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { formatObservedNumber } from '../utils/dataQuality';
import { getAirlineDisplayName, getAirlineInfo } from '../utils/airlineDirectory';

export interface Flight {
  id: string; // ICAO24
  callsign: string;
  squawk?: string;
  altitude: number; // ft
  speed: number; // knots
  heading: number; // degrees
  verticalRate?: number; // m/s
  trustScore: number; // 0-100
  trust_score?: number | null;
  combined_risk_score?: number | null;
  assessment_status?: string | null;
  signalStrength?: number; // dBm
  status: 'normal' | 'suspicious' | 'critical' | 'unassessed';
  lat: number;
  lng: number;
  is_synthetic?: boolean;
  source?: string;
  estDepartureAirport?: string | null;
  estArrivalAirport?: string | null;
  last_seen_seconds_ago?: number;
  staleness_status?: string;
  history?: Array<{ lat: number; lng: number }>;
  data_quality?: { observed_fields?: string[]; missing_fields?: string[] };
}

interface RouteOverlay {
  origin?: { lat: number; lng: number; label: string } | null;
  destination?: { lat: number; lng: number; label: string } | null;
}

interface UserLocation {
  lat: number;
  lng: number;
}

const distanceKm = (from: UserLocation, to: UserLocation) => {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = radians(to.lat - from.lat);
  const dLng = radians(to.lng - from.lng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(from.lat)) * Math.cos(radians(to.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

interface AirspaceMapProps {
  flights: Flight[];
  selectedFlight: Flight | null;
  onSelectFlight: (flight: Flight | null) => void;
  onOpenFlightDetails: (flight: Flight) => void;
  route?: RouteOverlay | null;
}

type MapLayerType = 'dark' | 'satellite' | 'street';

const MAP_LAYERS: Record<MapLayerType, { name: string; url: string; subdomains?: string; maxZoom: number; attribution: string }> = {
  dark: {
    name: 'Dark Tactical',
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 18,
    attribution: '&copy; Esri, DeLorme, NAVTEQ'
  },
  satellite: {
    name: 'Satellite Hybrid',
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 18,
    attribution: '&copy; Esri &copy; Maxar'
  },
  street: {
    name: 'Aviation Standard',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }
};

const REGION_CENTERS = [
  { name: 'All India', lat: 21.5, lng: 78.9, zoom: 5 },
  { name: 'Delhi (DEL)', lat: 28.5562, lng: 77.1000, zoom: 10 },
  { name: 'Mumbai (BOM)', lat: 19.0896, lng: 72.8656, zoom: 10 },
  { name: 'Bengaluru (BLR)', lat: 13.1986, lng: 77.7066, zoom: 10 },
  { name: 'Hyderabad (HYD)', lat: 17.2403, lng: 78.4294, zoom: 10 },
  { name: 'Kolkata (CCU)', lat: 22.6547, lng: 88.4467, zoom: 10 },
  { name: 'Chennai (MAA)', lat: 12.9941, lng: 80.1709, zoom: 10 }
];

// Calculate accurate status theme matching the map legend (Nominal: Cyan, Review: Amber, Critical: Red, Unassessed: Slate)
function getFlightStatusTheme(flight: Flight) {
  const trust = flight.trustScore ?? flight.trust_score;
  const risk = flight.combined_risk_score;
  const status = flight.status;
  const assessment = flight.assessment_status;

  const isCritical =
    status === 'critical' ||
    (typeof trust === 'number' && Number.isFinite(trust) && trust < 40) ||
    (typeof risk === 'number' && Number.isFinite(risk) && risk >= 0.8) ||
    assessment === 'CRITICAL';

  const isReview =
    status === 'suspicious' ||
    assessment === 'REVIEW_REQUIRED' ||
    (typeof trust === 'number' && Number.isFinite(trust) && trust >= 40 && trust < 70) ||
    (typeof risk === 'number' && Number.isFinite(risk) && risk >= 0.65);

  const isUnassessed =
    status === 'unassessed' ||
    assessment === 'INSUFFICIENT_EVIDENCE';

  if (isCritical) {
    return {
      fill: '#ef4444', // Red / Critical
      stroke: '#7f1d1d',
      glow: 'rgba(239, 68, 68, 0.7)',
      badgeDot: '#ef4444',
      badgeBorder: 'rgba(239, 68, 68, 0.85)',
      statusLabel: 'CRITICAL',
    };
  }

  if (isReview) {
    return {
      fill: '#f59e0b', // Amber / Review
      stroke: '#78350f',
      glow: 'rgba(245, 158, 11, 0.6)',
      badgeDot: '#f59e0b',
      badgeBorder: 'rgba(245, 158, 11, 0.8)',
      statusLabel: 'REVIEW',
    };
  }

  if (isUnassessed) {
    return {
      fill: '#94a3b8', // Slate / Unassessed
      stroke: '#334155',
      glow: 'rgba(148, 163, 184, 0.35)',
      badgeDot: '#94a3b8',
      badgeBorder: 'rgba(148, 163, 184, 0.5)',
      statusLabel: 'UNASSESSED',
    };
  }

  // Nominal / Normal (Default Cyan)
  return {
    fill: '#38bdf8', // Cyan / Nominal
    stroke: '#0369a1',
    glow: 'rgba(56, 189, 248, 0.45)',
    badgeDot: '#38bdf8',
    badgeBorder: 'rgba(56, 189, 248, 0.6)',
    statusLabel: 'NOMINAL',
  };
}

// High performance aircraft renderer (0 allocations in loop, selective glow)
function drawAnimatedAircraft(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  headingDeg: number,
  size: number,
  theme: ReturnType<typeof getFlightStatusTheme>,
  isSelected: boolean,
  isHovered: boolean,
  timeSec: number
) {
  ctx.save();
  ctx.translate(x, y);

  // Animated Tactical Target Rings on Selected Aircraft
  if (isSelected) {
    const pulsePhase1 = (timeSec * 1.6) % 1;
    const pulsePhase2 = (timeSec * 1.6 + 0.5) % 1;

    ctx.beginPath();
    ctx.arc(0, 0, 14 + pulsePhase1 * 22, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(56, 189, 248, ${(1 - pulsePhase1) * 0.85})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, 14 + pulsePhase2 * 22, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(56, 189, 248, ${(1 - pulsePhase2) * 0.85})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, 16, 0, Math.PI * 2);
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;
    ctx.stroke();
  } else if (theme.statusLabel === 'CRITICAL') {
    const pulse = 0.5 + 0.5 * Math.sin(timeSec * 7);
    ctx.beginPath();
    ctx.arc(0, 0, 13 + pulse * 8, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(239, 68, 68, ${0.4 + pulse * 0.55})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  } else if (theme.statusLabel === 'REVIEW') {
    const pulse = 0.5 + 0.5 * Math.sin(timeSec * 4);
    ctx.beginPath();
    ctx.arc(0, 0, 12 + pulse * 6, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(245, 158, 11, ${0.35 + pulse * 0.45})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  } else if (isHovered) {
    ctx.beginPath();
    ctx.arc(0, 0, 16, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Rotate to heading
  ctx.rotate((headingDeg * Math.PI) / 180);
  const s = size / 32;
  ctx.scale(s, s);

  // High definition jet vector silhouette
  ctx.beginPath();
  ctx.moveTo(0, -15);
  ctx.bezierCurveTo(1.5, -15, 2.2, -12, 2.2, -8);
  ctx.lineTo(2.2, -1.5);
  ctx.lineTo(14, 5.5);
  ctx.lineTo(14, 8.5);
  ctx.lineTo(2.2, 4.5);
  ctx.lineTo(2.2, 11);
  ctx.lineTo(6.5, 13.5);
  ctx.lineTo(6.5, 15.5);
  ctx.lineTo(0, 14.5);
  ctx.lineTo(-6.5, 15.5);
  ctx.lineTo(-6.5, 13.5);
  ctx.lineTo(-2.2, 11);
  ctx.lineTo(-2.2, 4.5);
  ctx.lineTo(-14, 8.5);
  ctx.lineTo(-14, 5.5);
  ctx.lineTo(-2.2, -1.5);
  ctx.lineTo(-2.2, -8);
  ctx.bezierCurveTo(-2.2, -12, -1.5, -15, 0, -15);
  ctx.closePath();

  // Vibrant fill with status coloration (only apply shadow blur for selected/hovered to maintain 60fps)
  if (isSelected || isHovered) {
    ctx.shadowColor = theme.glow;
    ctx.shadowBlur = isSelected ? 14 : 8;
  }
  ctx.fillStyle = theme.fill;
  ctx.fill();

  if (isSelected || isHovered) {
    ctx.shadowBlur = 0;
  }

  // Clean dark outline
  ctx.strokeStyle = '#04070e';
  ctx.lineWidth = 1.4;
  ctx.stroke();

  ctx.restore();
}

// Draw crisp callsign badge with airline company name and status indicator dot
function drawCallsignAndCompanyBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  callsign: string,
  airlineName: string,
  theme: ReturnType<typeof getFlightStatusTheme>,
  isSelected: boolean,
  showCompany: boolean
) {
  ctx.save();
  ctx.font = isSelected
    ? 'bold 11px "Share Tech Mono", monospace, sans-serif'
    : '10px "Share Tech Mono", monospace, sans-serif';

  const labelText = showCompany && airlineName && !airlineName.includes('Flight') && !airlineName.includes('Aircraft')
    ? `${callsign} • ${airlineName}`
    : callsign;

  const textWidth = ctx.measureText(labelText).width;
  const dotWidth = 8;
  const paddingX = 6;
  const badgeW = textWidth + dotWidth + paddingX * 2;
  const badgeH = 15;
  const badgeX = x - badgeW / 2;
  const badgeY = y + 13;

  // Background Badge
  ctx.fillStyle = isSelected ? 'rgba(15, 23, 42, 0.95)' : 'rgba(11, 18, 32, 0.92)';
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 4);
  } else {
    ctx.rect(badgeX, badgeY, badgeW, badgeH);
  }
  ctx.fill();

  // Border colored by status
  ctx.strokeStyle = isSelected ? '#38bdf8' : theme.badgeBorder;
  ctx.lineWidth = isSelected ? 1.5 : 1;
  ctx.stroke();

  // Status indicator dot
  ctx.beginPath();
  ctx.arc(badgeX + paddingX + 3, badgeY + badgeH / 2, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = theme.badgeDot;
  ctx.fill();

  // Text
  ctx.fillStyle = isSelected ? '#38bdf8' : '#f8fafc';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(labelText, badgeX + paddingX + dotWidth + 1, badgeY + badgeH / 2 + 0.5);
  ctx.restore();
}

export const AirspaceMap: React.FC<AirspaceMapProps> = ({
  flights,
  selectedFlight,
  onSelectFlight,
  onOpenFlightDetails,
  route,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const currentTileLayerRef = useRef<L.TileLayer | null>(null);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const nearbyLayerRef = useRef<L.LayerGroup | null>(null);
  const hoverTooltipRef = useRef<HTMLDivElement | null>(null);

  const lastCenterRef = useRef<[number, number]>([21.5, 78.9]);
  const lastZoomRef = useRef<number>(5);
  const lastHoveredIdRef = useRef<string | null>(null);

  const [activeRegion, setActiveRegion] = useState<string>('All India');
  const [activeMapLayer, setActiveMapLayer] = useState<MapLayerType>('dark');
  const [activeFloatingFlight, setActiveFloatingFlight] = useState<Flight | null>(null);
  const [hoveredFlight, setHoveredFlight] = useState<Flight | null>(null);
  const [followSelected, setFollowSelected] = useState<boolean>(false);
  const [nearbyLocation, setNearbyLocation] = useState<UserLocation | null>(null);
  const [nearbyStatus, setNearbyStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [isNearbyOpen, setIsNearbyOpen] = useState<boolean>(false);
  const [isLayerMenuOpen, setIsLayerMenuOpen] = useState<boolean>(false);
  const [isRegionMenuOpen, setIsRegionMenuOpen] = useState<boolean>(false);
  const [quickFilter, setQuickFilter] = useState<'all' | 'flagged' | 'airborne'>('all');

  // Fullscreen & Right Sidebar state
  const [isExpanded, setIsExpanded] = useState<boolean>(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(false);
  const [sidebarSearch, setSidebarSearch] = useState<string>('');
  const [sidebarFilter, setSidebarFilter] = useState<'all' | 'suspicious' | 'critical'>('all');

  const latestFlightsRef = useRef<Flight[]>(flights);
  const latestSelectedFlightRef = useRef<Flight | null>(selectedFlight);
  const latestHoveredFlightRef = useRef<Flight | null>(hoveredFlight);
  const onSelectFlightRef = useRef(onSelectFlight);
  const continuousAnimRef = useRef<number | null>(null);
  const previousSelectedIdRef = useRef<string | null>(null);

  // Filtered flights for the map view based on quickFilter
  const displayableFlights = useMemo(() => {
    if (quickFilter === 'flagged') {
      return flights.filter(f => f.status === 'critical' || f.status === 'suspicious');
    }
    if (quickFilter === 'airborne') {
      return flights.filter(f => (f.altitude ?? 0) >= 10000);
    }
    return flights;
  }, [flights, quickFilter]);

  latestFlightsRef.current = displayableFlights;
  latestSelectedFlightRef.current = selectedFlight;
  latestHoveredFlightRef.current = hoveredFlight;
  onSelectFlightRef.current = onSelectFlight;

  // Nearby aircraft computation
  const nearbyFlights = useMemo(() => {
    if (!nearbyLocation || !isNearbyOpen) return [];
    return flights
      .map((flight) => ({
        flight,
        distance: distanceKm(nearbyLocation, { lat: flight.lat, lng: flight.lng }),
        airline: getAirlineDisplayName(flight.callsign),
      }))
      .filter((item) => Number.isFinite(item.distance) && item.distance <= 120)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 8);
  }, [flights, nearbyLocation, isNearbyOpen]);

  // Filtered flights for the enlarged right sidebar list
  const filteredSidebarFlights = useMemo(() => {
    return flights.filter((f) => {
      if (sidebarFilter === 'critical' && f.status !== 'critical') return false;
      if (sidebarFilter === 'suspicious' && f.status !== 'suspicious' && f.status !== 'critical') return false;
      if (!sidebarSearch) return true;
      const query = sidebarSearch.toLowerCase().trim();
      const callsign = (f.callsign || '').toLowerCase();
      const id = (f.id || '').toLowerCase();
      const originCountry = (f.source || '').toLowerCase();
      const airline = (getAirlineDisplayName(f.callsign) || '').toLowerCase();
      return callsign.includes(query) || id.includes(query) || originCountry.includes(query) || airline.includes(query);
    });
  }, [flights, sidebarSearch, sidebarFilter]);

  // High performance Canvas render loop with rock-solid transform stability
  const renderCanvas = useCallback(() => {
    const map = mapRef.current;
    const canvas = canvasRef.current;
    const container = mapContainerRef.current;
    if (!map || !canvas || !container) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width === 0 || height === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.round(width * dpr);
    const targetH = Math.round(height * dpr);

    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const mapBounds = map.getBounds().pad(0.1);
    const zoom = map.getZoom();
    const currentFlights = latestFlightsRef.current;
    const currentSelected = latestSelectedFlightRef.current;
    const currentHovered = latestHoveredFlightRef.current;
    const timeSec = performance.now() * 0.001;

    const baseSize = zoom >= 10 ? 28 : zoom >= 7 ? 24 : zoom >= 5 ? 20 : 16;
    const showCallsigns = zoom >= 7;
    const showCompanyInTag = zoom >= 9;

    let selectedFlightToDraw: { flight: Flight; x: number; y: number } | null = null;
    let hoveredFlightToDraw: { flight: Flight; x: number; y: number } | null = null;

    for (let i = 0; i < currentFlights.length; i++) {
      const flight = currentFlights[i];
      if (typeof flight.lat !== 'number' || typeof flight.lng !== 'number' || isNaN(flight.lat) || isNaN(flight.lng)) {
        continue;
      }

      const isSelected = currentSelected?.id === flight.id;
      const isHovered = currentHovered?.id === flight.id;

      if (!isSelected && !mapBounds.contains([flight.lat, flight.lng])) {
        continue;
      }

      const point = map.latLngToContainerPoint([flight.lat, flight.lng]);
      const x = point.x;
      const y = point.y;

      if (x < -60 || x > width + 60 || y < -60 || y > height + 60) {
        continue;
      }

      if (isSelected) {
        selectedFlightToDraw = { flight, x, y };
        continue;
      }
      if (isHovered) {
        hoveredFlightToDraw = { flight, x, y };
        continue;
      }

      const theme = getFlightStatusTheme(flight);
      const heading = Number.isFinite(flight.heading) ? flight.heading : 0;
      drawAnimatedAircraft(ctx, x, y, heading, baseSize, theme, false, false, timeSec);

      if (showCallsigns && flight.callsign) {
        const airline = getAirlineDisplayName(flight.callsign);
        drawCallsignAndCompanyBadge(ctx, x, y, flight.callsign, airline, theme, false, showCompanyInTag);
      }
    }

    // Draw hovered flight on top
    if (hoveredFlightToDraw) {
      const { flight, x, y } = hoveredFlightToDraw;
      const theme = getFlightStatusTheme(flight);
      const heading = Number.isFinite(flight.heading) ? flight.heading : 0;
      drawAnimatedAircraft(ctx, x, y, heading, baseSize + 4, theme, false, true, timeSec);
      if (flight.callsign) {
        const airline = getAirlineDisplayName(flight.callsign);
        drawCallsignAndCompanyBadge(ctx, x, y, flight.callsign, airline, theme, false, true);
      }
    }

    // Draw selected flight with verified breadcrumb trail and pulsing target ring
    if (selectedFlightToDraw) {
      const { flight, x, y } = selectedFlightToDraw;
      const theme = getFlightStatusTheme(flight);

      const history = (flight.history || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
      if (history.length > 1) {
        // Glowing background aura for the path
        ctx.beginPath();
        for (let j = 0; j < history.length; j++) {
          const hp = map.latLngToContainerPoint([history[j].lat, history[j].lng]);
          if (j === 0) ctx.moveTo(hp.x, hp.y);
          else ctx.lineTo(hp.x, hp.y);
        }
        ctx.strokeStyle = theme.glow;
        ctx.lineWidth = 5;
        ctx.stroke();

        // Crisp dashed trajectory line
        ctx.beginPath();
        for (let j = 0; j < history.length; j++) {
          const hp = map.latLngToContainerPoint([history[j].lat, history[j].lng]);
          if (j === 0) ctx.moveTo(hp.x, hp.y);
          else ctx.lineTo(hp.x, hp.y);
        }
        ctx.strokeStyle = theme.fill;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Waypoint fix nodes along trail
        const step = Math.max(1, Math.floor(history.length / 20));
        for (let j = 0; j < history.length - 1; j += step) {
          const hp = map.latLngToContainerPoint([history[j].lat, history[j].lng]);
          ctx.beginPath();
          ctx.arc(hp.x, hp.y, 2.5, 0, Math.PI * 2);
          ctx.fillStyle = j === 0 ? theme.fill : 'rgba(56, 189, 248, 0.65)';
          ctx.fill();
        }
      }

      const heading = Number.isFinite(flight.heading) ? flight.heading : 0;
      drawAnimatedAircraft(ctx, x, y, heading, baseSize + 6, theme, true, false, timeSec);
      if (flight.callsign) {
        const airline = getAirlineDisplayName(flight.callsign);
        drawCallsignAndCompanyBadge(ctx, x, y, flight.callsign, airline, theme, true, true);
      }
    }
  }, []);

  // Continuous animation loop for strobes and expanding sonar rings
  useEffect(() => {
    let animId: number;
    const loop = () => {
      renderCanvas();
      animId = requestAnimationFrame(loop);
    };
    animId = requestAnimationFrame(loop);
    continuousAnimRef.current = animId;
    return () => {
      cancelAnimationFrame(animId);
      continuousAnimRef.current = null;
    };
  }, [renderCanvas]);

  // Lock body scroll when in expanded full-window mode
  useEffect(() => {
    if (isExpanded) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isExpanded]);

  // Fullscreen toggle handler
  const toggleFullscreen = useCallback(() => {
    setIsExpanded((prev) => {
      const next = !prev;
      if (next) {
        setIsSidebarOpen(false);
      } else {
        setIsSidebarOpen(false);
      }
      return next;
    });
  }, []);

  // Handle ESC key to exit full window mode
  useEffect(() => {
    if (!isExpanded) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsExpanded(false);
        setIsSidebarOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isExpanded]);

  // Handle sidebar resize in expanded mode
  useEffect(() => {
    if (!mapRef.current) return;
    const handleResize = () => {
      mapRef.current?.invalidateSize();
      renderCanvas();
    };
    handleResize();
    const t1 = setTimeout(handleResize, 50);
    const t2 = setTimeout(handleResize, 150);
    const t3 = setTimeout(handleResize, 350);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [isSidebarOpen, renderCanvas]);

  // Switch Map Layer cleanly
  const switchMapLayer = (layerKey: MapLayerType) => {
    const map = mapRef.current;
    if (!map) return;
    setActiveMapLayer(layerKey);
    setIsLayerMenuOpen(false);

    if (currentTileLayerRef.current) {
      map.removeLayer(currentTileLayerRef.current);
    }

    const cfg = MAP_LAYERS[layerKey];
    const newLayer = L.tileLayer(cfg.url, {
      maxZoom: cfg.maxZoom,
      subdomains: cfg.subdomains || 'abc',
      attribution: cfg.attribution,
    });
    newLayer.addTo(map);
    currentTileLayerRef.current = newLayer;
  };

  // Initialize Map with high-performance Inertia and Smooth Panning
  useEffect(() => {
    if (!mapContainerRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center: lastCenterRef.current,
      zoom: lastZoomRef.current,
      zoomControl: false,
      attributionControl: false,
      minZoom: 2,
      maxZoom: 19,
      preferCanvas: true,
      zoomAnimation: true,
      fadeAnimation: true,
      markerZoomAnimation: true,
      inertia: true,
      inertiaDeceleration: 3400,
      inertiaMaxSpeed: 2400,
      easeLinearity: 0.18,
      wheelDebounceTime: 35,
      wheelPxPerZoomLevel: 80,
    });

    const cfg = MAP_LAYERS[activeMapLayer];
    const tileLayer = L.tileLayer(cfg.url, {
      maxZoom: cfg.maxZoom,
      subdomains: cfg.subdomains || 'abc',
      attribution: cfg.attribution,
    });
    tileLayer.addTo(map);
    currentTileLayerRef.current = tileLayer;

    routeLayerRef.current = L.layerGroup().addTo(map);
    nearbyLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    const handleResize = () => {
      map.invalidateSize();
      renderCanvas();
    };

    handleResize();
    const t1 = setTimeout(handleResize, 50);
    const t2 = setTimeout(handleResize, 150);
    const t3 = setTimeout(handleResize, 350);

    const container = map.getContainer();

    // Zero-lag mouse hover hit-testing with direct tooltip DOM updates
    const handleMouseMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const currentFlights = latestFlightsRef.current;
      let found: Flight | null = null;
      let minDistSq = 22 * 22;

      for (let i = 0; i < currentFlights.length; i++) {
        const f = currentFlights[i];
        if (typeof f.lat !== 'number' || typeof f.lng !== 'number') continue;
        const pt = map.latLngToContainerPoint([f.lat, f.lng]);
        const dx = pt.x - mouseX;
        const dy = pt.y - mouseY;
        const distSq = dx * dx + dy * dy;
        if (distSq < minDistSq) {
          minDistSq = distSq;
          found = f;
        }
      }

      // Direct DOM transform update without React re-render thrashing
      if (hoverTooltipRef.current) {
        if (found) {
          hoverTooltipRef.current.style.transform = `translate3d(${mouseX}px, ${mouseY - 14}px, 0)`;
          hoverTooltipRef.current.style.display = 'block';
        } else {
          hoverTooltipRef.current.style.display = 'none';
        }
      }

      // Only update React state when the target flight identity actually changes
      if (found?.id !== lastHoveredIdRef.current) {
        lastHoveredIdRef.current = found?.id ?? null;
        container.style.cursor = found ? 'pointer' : '';
        setHoveredFlight(found);
      }
    };

    const handleClick = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const currentFlights = latestFlightsRef.current;
      let clicked: Flight | null = null;
      let minDistSq = 24 * 24;

      for (let i = 0; i < currentFlights.length; i++) {
        const f = currentFlights[i];
        if (typeof f.lat !== 'number' || typeof f.lng !== 'number') continue;
        const pt = map.latLngToContainerPoint([f.lat, f.lng]);
        const dx = pt.x - mouseX;
        const dy = pt.y - mouseY;
        const distSq = dx * dx + dy * dy;
        if (distSq < minDistSq) {
          minDistSq = distSq;
          clicked = f;
        }
      }

      if (clicked) {
        onSelectFlightRef.current?.(clicked);
        setActiveFloatingFlight(clicked);
        setIsSidebarOpen(true);
      } else {
        const target = e.target as HTMLElement;
        if (
          !target?.closest('.airguard-floating-card') &&
          !target?.closest('.airguard-expanded-sidebar') &&
          !target?.closest('.airguard-sidebar-toggle-btn') &&
          !target?.closest('.airguard-map-controls')
        ) {
          setActiveFloatingFlight(null);
        }
      }
    };

    container.addEventListener('mousemove', handleMouseMove, { passive: true });
    container.addEventListener('click', handleClick);
    window.addEventListener('resize', handleResize);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      container.removeEventListener('mousemove', handleMouseMove);
      container.removeEventListener('click', handleClick);
      window.removeEventListener('resize', handleResize);
      try {
        const c = map.getCenter();
        lastCenterRef.current = [c.lat, c.lng];
        lastZoomRef.current = map.getZoom();
        map.remove();
      } catch (_err) {
        // Map instance already unmounted or disposed
      }
      mapRef.current = null;
      currentTileLayerRef.current = null;
      routeLayerRef.current = null;
      nearbyLayerRef.current = null;
    };
  }, [isExpanded, renderCanvas, activeMapLayer]);

  // Smooth follow selected flight
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedFlight) {
      previousSelectedIdRef.current = selectedFlight?.id ?? null;
      return;
    }
    const changed = previousSelectedIdRef.current !== selectedFlight.id;
    previousSelectedIdRef.current = selectedFlight.id;
    if (changed || followSelected) {
      map.flyTo([selectedFlight.lat, selectedFlight.lng], Math.max(map.getZoom(), 7), {
        duration: changed ? 0.6 : 0.25,
      });
    }
  }, [selectedFlight, followSelected]);

  // Route overlay
  useEffect(() => {
    const layer = routeLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!route?.origin || !route?.destination) return;

    L.polyline(
      [
        [route.origin.lat, route.origin.lng],
        [route.destination.lat, route.destination.lng],
      ],
      {
        color: '#a5b4fc',
        weight: 2,
        opacity: 0.8,
        dashArray: '7 8',
      }
    ).addTo(layer);

    for (const [point, label, color] of [
      [route.origin, `Origin · ${route.origin.label}`, '#34d399'],
      [route.destination, `Destination · ${route.destination.label}`, '#a5b4fc'],
    ] as const) {
      L.circleMarker([point.lat, point.lng], {
        radius: 5,
        color,
        weight: 2,
        fillColor: '#0b1220',
        fillOpacity: 1,
      })
        .bindTooltip(label, { direction: 'top' })
        .addTo(layer);
    }
  }, [route]);

  // Nearby layer
  useEffect(() => {
    const layer = nearbyLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!nearbyLocation) return;

    L.circle([nearbyLocation.lat, nearbyLocation.lng], {
      radius: 120_000,
      color: '#67e8f9',
      weight: 1,
      opacity: 0.65,
      fillColor: '#22d3ee',
      fillOpacity: 0.035,
      dashArray: '5 7',
    }).addTo(layer);

    L.circleMarker([nearbyLocation.lat, nearbyLocation.lng], {
      radius: 6,
      color: '#cffafe',
      weight: 2,
      fillColor: '#06b6d4',
      fillOpacity: 1,
    })
      .bindTooltip('Your location · stored in this browser only', { direction: 'top' })
      .addTo(layer);
  }, [nearbyLocation]);

  // Sync active floating flight with live telemetry updates
  useEffect(() => {
    if (activeFloatingFlight) {
      const updated = flights.find((f) => f.id === activeFloatingFlight.id);
      if (
        updated &&
        (updated.lat !== activeFloatingFlight.lat ||
          updated.lng !== activeFloatingFlight.lng ||
          updated.altitude !== activeFloatingFlight.altitude ||
          updated.speed !== activeFloatingFlight.speed ||
          updated.heading !== activeFloatingFlight.heading ||
          updated.trustScore !== activeFloatingFlight.trustScore ||
          updated.status !== activeFloatingFlight.status)
      ) {
        setActiveFloatingFlight(updated);
      }
    }
  }, [flights, activeFloatingFlight]);

  const zoomToRegion = (regionName: string, lat: number, lng: number, zoom: number) => {
    setActiveRegion(regionName);
    if (mapRef.current) {
      mapRef.current.flyTo([lat, lng], zoom, { duration: 0.7 });
    }
  };

  const centerAllFlights = () => {
    const map = mapRef.current;
    if (!map || flights.length === 0) return;
    const validFlights = flights.filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lng));
    if (validFlights.length === 0) return;

    const bounds = L.latLngBounds(validFlights.map((f) => [f.lat, f.lng]));
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 8 });
    setActiveRegion('Auto Fit');
  };

  const zoomIn = () => mapRef.current?.zoomIn();
  const zoomOut = () => mapRef.current?.zoomOut();
  const resetNorth = () => {
    if (mapRef.current) {
      mapRef.current.flyTo([21.5, 78.9], 5, { duration: 0.7 });
      setActiveRegion('All India');
    }
  };

  const locateNearbyAircraft = () => {
    if (!navigator.geolocation) {
      setNearbyStatus('error');
      return;
    }
    setNearbyStatus('loading');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const location = { lat: position.coords.latitude, lng: position.coords.longitude };
        setNearbyLocation(location);
        setNearbyStatus('ready');
        mapRef.current?.flyTo([location.lat, location.lng], 7, { duration: 0.8 });
      },
      () => setNearbyStatus('error'),
      { enableHighAccuracy: false, maximumAge: 60_000, timeout: 10_000 }
    );
  };

  const hoveredAirline = hoveredFlight ? getAirlineInfo(hoveredFlight.callsign) : null;
  const activeAirline = activeFloatingFlight ? getAirlineInfo(activeFloatingFlight.callsign) : null;
  const activeDetailedFlight = selectedFlight || activeFloatingFlight;
  const detailedAirline = activeDetailedFlight ? getAirlineInfo(activeDetailedFlight.callsign) : null;

  const criticalCount = useMemo(() => flights.filter(f => f.status === 'critical' || f.assessment_status === 'CRITICAL' || (f.trustScore !== undefined && f.trustScore !== null && Number.isFinite(f.trustScore) && f.trustScore < 40)).length, [flights]);
  const reviewCount = useMemo(() => flights.filter(f => f.status === 'suspicious' || f.assessment_status === 'REVIEW_REQUIRED' || (f.trustScore !== undefined && f.trustScore !== null && Number.isFinite(f.trustScore) && f.trustScore >= 40 && f.trustScore < 70)).length, [flights]);
  const unassessedCount = useMemo(() => flights.filter(f => f.status === 'unassessed' || f.assessment_status === 'INSUFFICIENT_EVIDENCE').length, [flights]);
  const nominalCount = useMemo(() => Math.max(0, flights.length - criticalCount - reviewCount - unassessedCount), [flights.length, criticalCount, reviewCount, unassessedCount]);

  // Main Map JSX
  const mapContent = (
    <div
      className={`relative w-full h-full bg-[#060913] overflow-hidden select-none ${
        isExpanded
          ? 'fixed inset-0 z-[999999] w-screen h-screen flex flex-col md:flex-row bg-[#04070e]'
          : 'min-h-[360px]'
      }`}
      style={
        isExpanded
          ? {
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              width: '100vw',
              height: '100vh',
              zIndex: 999999,
            }
          : undefined
      }
    >
      {/* Main Map Canvas Area */}
      <div className="flex-1 h-full relative overflow-hidden flex flex-col min-w-0">
        {/* 2D Leaflet Map Container */}
        <div ref={mapContainerRef} className="w-full h-full z-0 flex-1" style={{ width: '100%', height: '100%' }} />

        {/* Hardware-Accelerated Viewport Canvas Overlay */}
        <canvas
          ref={canvasRef}
          className="absolute inset-0 pointer-events-none z-[400] w-full h-full"
        />

        {/* Top Unified Tactical Header Bar (Clean, Non-Colliding) */}
        <div className="airguard-map-controls absolute top-3 left-3 right-3 z-[450] flex flex-wrap sm:flex-nowrap items-center justify-between gap-2 pointer-events-auto">
          {/* Left: Region Select & Quick Filters */}
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            {/* Region Dropdown */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setIsRegionMenuOpen((v) => !v)}
                className="bg-[#070d1a]/95 hover:bg-cyan-950/90 text-cyan-200 hover:text-white border border-cyan-500/40 backdrop-blur-xl px-2.5 py-1.5 rounded-xl text-xs font-semibold shadow-xl transition-all flex items-center gap-1.5 cursor-pointer"
                title="Select Airspace Sector / Region"
              >
                <span>📍</span>
                <span className="font-bold">{activeRegion}</span>
                <span className="text-[10px] text-slate-400">▾</span>
              </button>

              {isRegionMenuOpen && (
                <div className="absolute top-full left-0 mt-1.5 w-48 bg-[#081020]/98 border border-cyan-500/30 rounded-xl p-1.5 shadow-2xl backdrop-blur-2xl z-50 animate-in fade-in zoom-in-95 duration-100">
                  {REGION_CENTERS.map((reg) => (
                    <button
                      key={reg.name}
                      type="button"
                      onClick={() => {
                        zoomToRegion(reg.name, reg.lat, reg.lng, reg.zoom);
                        setIsRegionMenuOpen(false);
                      }}
                      className={`w-full text-left px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center justify-between transition-all cursor-pointer ${
                        activeRegion === reg.name
                          ? 'bg-cyan-600/30 text-cyan-200 border border-cyan-500/40'
                          : 'text-slate-300 hover:bg-white/10'
                      }`}
                    >
                      <span>{reg.name}</span>
                      {activeRegion === reg.name && <span className="text-cyan-400 font-bold">✓</span>}
                    </button>
                  ))}
                  <div className="border-t border-white/10 my-1" />
                  <button
                    type="button"
                    onClick={() => {
                      centerAllFlights();
                      setIsRegionMenuOpen(false);
                    }}
                    className="w-full text-left px-3 py-1.5 rounded-lg text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20 transition-all flex items-center gap-1.5 cursor-pointer"
                  >
                    <span>⤢</span>
                    <span>Fit All Detected Aircraft</span>
                  </button>
                </div>
              )}
            </div>

            {/* Quick Filter Chips */}
            <div className="flex items-center gap-1 bg-[#070d1a]/90 backdrop-blur-xl p-0.5 rounded-xl border border-white/10 text-[11px] font-mono">
              <button
                onClick={() => setQuickFilter('all')}
                className={`px-2 py-1 rounded-lg transition-all cursor-pointer ${
                  quickFilter === 'all'
                    ? 'bg-cyan-950/90 text-cyan-200 font-bold shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                All ({flights.length})
              </button>
              <button
                onClick={() => setQuickFilter('flagged')}
                className={`px-2 py-1 rounded-lg transition-all cursor-pointer ${
                  quickFilter === 'flagged'
                    ? 'bg-rose-950/90 text-rose-300 font-bold shadow-[0_0_8px_rgba(244,63,94,0.3)]'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Flagged ({criticalCount + reviewCount})
              </button>
              <button
                onClick={() => setQuickFilter('airborne')}
                className={`px-2 py-1 rounded-lg transition-all cursor-pointer hidden md:inline-block ${
                  quickFilter === 'airborne'
                    ? 'bg-sky-950/90 text-sky-200 font-bold'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Cruising (&gt;10k ft)
              </button>
            </div>
          </div>

          {/* Right: Map Style, Fullscreen, Live Count */}
          <div className="flex items-center gap-1.5 shrink-0">
            {/* Map Layer Selector */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setIsLayerMenuOpen((v) => !v)}
                aria-label="Select Map Style"
                title="Change Map Style"
                className="bg-[#070d1a]/92 hover:bg-cyan-950/90 text-cyan-200 hover:text-white border border-white/10 hover:border-cyan-400/60 backdrop-blur-xl px-2.5 py-1.5 rounded-xl text-xs font-semibold shadow-xl transition-all flex items-center gap-1 cursor-pointer"
              >
                <span>🗺</span>
                <span className="hidden sm:inline">{MAP_LAYERS[activeMapLayer].name}</span>
                <span className="text-[10px] text-slate-400">▾</span>
              </button>

              {isLayerMenuOpen && (
                <div className="absolute top-full right-0 mt-1.5 w-44 bg-[#081020]/98 border border-cyan-500/30 rounded-xl p-1.5 shadow-2xl backdrop-blur-2xl z-50 animate-in fade-in zoom-in-95 duration-100">
                  {(Object.keys(MAP_LAYERS) as MapLayerType[]).map((key) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => switchMapLayer(key)}
                      className={`w-full text-left px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center justify-between transition-all cursor-pointer ${
                        activeMapLayer === key
                          ? 'bg-cyan-600/30 text-cyan-200 border border-cyan-500/40'
                          : 'text-slate-300 hover:bg-white/10'
                      }`}
                    >
                      <span>{MAP_LAYERS[key].name}</span>
                      {activeMapLayer === key && <span className="text-cyan-400 font-bold">✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Fullscreen / Enlarge Map Button */}
            <button
              type="button"
              onClick={toggleFullscreen}
              aria-label={isExpanded ? 'Exit full screen map' : 'Enlarge map to full window'}
              title={isExpanded ? 'Exit full screen (Esc)' : 'Enlarge map to full window'}
              className="bg-[#070d1a]/92 hover:bg-cyan-950/90 text-cyan-200 hover:text-white border border-cyan-500/40 hover:border-cyan-400/70 backdrop-blur-xl px-2.5 py-1.5 rounded-xl text-xs font-semibold shadow-xl transition-all flex items-center gap-1 cursor-pointer"
            >
              <span className="text-sm leading-none">{isExpanded ? '🗗' : '⛶'}</span>
              <span className="hidden sm:inline">{isExpanded ? 'Exit Fullscreen' : 'Enlarge'}</span>
            </button>

            {/* Live Airspace Count Badge */}
            <div className="bg-[#070d1a]/92 backdrop-blur-xl px-2.5 py-1.5 rounded-xl shadow-xl border border-white/10 text-xs font-semibold text-slate-200 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,.6)] animate-pulse" />
              <span className="hidden sm:inline">Live</span>
              <span className="text-[11px] text-cyan-300 sm:border-l border-white/10 sm:pl-2 font-mono font-bold">
                {flights.length.toLocaleString()}
              </span>
            </div>

            {/* 3-Lines (Hamburger) Button in Fullscreen Mode */}
            {isExpanded && !isSidebarOpen && (
              <button
                type="button"
                onClick={() => setIsSidebarOpen(true)}
                aria-label="Open flight details sidebar"
                title="View flight details & aircraft list (3 lines)"
                className="airguard-sidebar-toggle-btn bg-cyan-600/95 hover:bg-cyan-500 text-white border border-cyan-400/60 px-2.5 py-1.5 rounded-xl text-xs font-semibold shadow-[0_0_15px_rgba(6,182,212,0.4)] backdrop-blur-xl flex items-center gap-1.5 cursor-pointer transition-all hover:scale-105"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </svg>
                <span className="hidden sm:inline">Details</span>
              </button>
            )}
          </div>
        </div>

        {/* Hover Tooltip (Positioned directly with CSS transform for 0ms lag) */}
        <div
          ref={hoverTooltipRef}
          className="pointer-events-none absolute z-[550] -translate-x-1/2 -translate-y-full mb-2 bg-[#081020]/95 border border-cyan-500/40 rounded-xl px-3 py-2 shadow-2xl backdrop-blur-md text-white font-mono text-[11px] whitespace-nowrap will-change-transform"
          style={{ display: 'none', left: 0, top: 0 }}
        >
          {hoveredFlight && (
            <>
              <div className="flex items-center gap-2">
                <span
                  className={`w-2.5 h-2.5 rounded-full ${
                    hoveredFlight.status === 'critical'
                      ? 'bg-rose-400 shadow-[0_0_8px_rgba(244,63,94,0.8)]'
                      : hoveredFlight.status === 'suspicious'
                      ? 'bg-amber-400 shadow-[0_0_8px_rgba(245,158,11,0.8)]'
                      : 'bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.8)]'
                  }`}
                />
                <span className="font-bold text-slate-100 text-xs">{hoveredFlight.callsign || 'UNKNOWN'}</span>
                {hoveredAirline && hoveredAirline.name && (
                  <span
                    className="text-[10px] font-sans font-semibold px-1.5 py-0.5 rounded text-white"
                    style={{ backgroundColor: `${hoveredAirline.color}33`, borderColor: `${hoveredAirline.color}88`, borderWidth: '1px' }}
                  >
                    {hoveredAirline.name}
                  </span>
                )}
                <span className="text-slate-400 text-[10px]">({hoveredFlight.id.toUpperCase()})</span>
              </div>
              <div className="text-[10px] text-slate-300 mt-1 flex items-center gap-2">
                <span>Alt: {formatObservedNumber(hoveredFlight.data_quality, 'altitude', hoveredFlight.altitude)} ft</span>
                <span>•</span>
                <span>Spd: {formatObservedNumber(hoveredFlight.data_quality, 'velocity', hoveredFlight.speed)} kt</span>
                <span>•</span>
                <span className="text-cyan-300">
                  Trust: {Number.isFinite(hoveredFlight.trustScore) ? `${hoveredFlight.trustScore}%` : 'N/A'}
                </span>
              </div>
            </>
          )}
        </div>

        {/* Floating Lightweight Flight Card (Standard View) */}
        {activeFloatingFlight && !isExpanded && (
          <div className="airguard-floating-card absolute bottom-5 left-5 z-[500] bg-[#081020]/95 backdrop-blur-xl text-white border border-white/15 rounded-2xl p-4 shadow-2xl shadow-black/70 w-[min(23rem,calc(100%-2.5rem))] animate-in fade-in slide-in-from-bottom-3 duration-150">
            <div className="flex items-center justify-between border-b border-white/10 pb-2.5 mb-3">
              <div className="flex items-center gap-2">
                <span
                  className={`w-2.5 h-2.5 rounded-full ${
                    activeFloatingFlight.status === 'critical'
                      ? 'bg-rose-400 shadow-[0_0_8px_rgba(244,63,94,0.7)]'
                      : activeFloatingFlight.status === 'suspicious'
                      ? 'bg-amber-400 shadow-[0_0_8px_rgba(245,158,11,0.7)]'
                      : activeFloatingFlight.status === 'normal'
                      ? 'bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.7)]'
                      : 'bg-slate-500'
                  }`}
                />
                <div className="flex flex-col">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-base font-bold tracking-wide text-white">
                      {activeFloatingFlight.callsign || 'N/A'}
                    </span>
                    <span className="text-[10px] font-mono text-cyan-300 bg-cyan-950/70 border border-cyan-500/40 px-1.5 py-0.2 rounded font-bold">
                      {activeFloatingFlight.id.toUpperCase()}
                    </span>
                  </div>
                  {activeAirline && (
                    <span className="text-[11px] font-semibold text-slate-300 flex items-center gap-1 mt-0.5">
                      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: activeAirline.color }} />
                      {activeAirline.name} {activeAirline.country ? `(${activeAirline.country})` : ''}
                    </span>
                  )}
                </div>
              </div>
              <button
                onClick={() => setActiveFloatingFlight(null)}
                className="text-slate-400 hover:text-white text-lg leading-none px-1 transition-colors cursor-pointer"
                title="Close card"
              >
                &times;
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2 text-center text-xs mb-3">
              <div className="bg-slate-900/80 p-2 rounded-lg border border-slate-700/40">
                <div className="text-[9px] uppercase tracking-wider text-slate-400">Altitude</div>
                <div className="font-mono font-bold text-slate-100">
                  {formatObservedNumber(activeFloatingFlight.data_quality, 'altitude', activeFloatingFlight.altitude)}{' '}
                  <span className="text-[10px] font-normal text-slate-400">FT</span>
                </div>
              </div>
              <div className="bg-slate-900/80 p-2 rounded-lg border border-slate-700/40">
                <div className="text-[9px] uppercase tracking-wider text-slate-400">Speed</div>
                <div className="font-mono font-bold text-slate-100">
                  {formatObservedNumber(activeFloatingFlight.data_quality, 'velocity', activeFloatingFlight.speed)}{' '}
                  <span className="text-[10px] font-normal text-slate-400">KT</span>
                </div>
              </div>
              <div className="bg-slate-900/80 p-2 rounded-lg border border-slate-700/40">
                <div className="text-[9px] uppercase tracking-wider text-slate-400">Trust Index</div>
                <div
                  className={`font-mono font-bold ${
                    !Number.isFinite(activeFloatingFlight.trustScore)
                      ? 'text-slate-400'
                      : activeFloatingFlight.trustScore >= 70
                      ? 'text-emerald-400'
                      : activeFloatingFlight.trustScore >= 40
                      ? 'text-amber-400'
                      : 'text-rose-400'
                  }`}
                >
                  {Number.isFinite(activeFloatingFlight.trustScore) ? `${activeFloatingFlight.trustScore}%` : 'UNASSESSED'}
                </div>
              </div>
            </div>

            <button
              onClick={() => {
                if (isExpanded) {
                  setIsExpanded(false);
                  setIsSidebarOpen(false);
                }
                onSelectFlight(activeFloatingFlight);
                onOpenFlightDetails(activeFloatingFlight);
              }}
              className="w-full py-2.5 px-3 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 active:scale-[0.98] text-white text-xs font-semibold rounded-lg shadow-lg shadow-cyan-900/30 transition-all flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <span>Inspect Telemetry &amp; Detection Matrix</span>
              <span className="text-sm">→</span>
            </button>
          </div>
        )}

        {/* Follow Target Indicator (Positioned beneath top-right HUD) */}
        {selectedFlight && (
          <div className="airguard-map-controls absolute top-14 right-3 sm:top-14 sm:right-4 z-[450] pointer-events-auto">
            <button
              type="button"
              onClick={() => setFollowSelected((val) => !val)}
              aria-pressed={followSelected}
              className={`rounded-xl border px-3 py-1.5 text-[11px] font-semibold shadow-lg backdrop-blur-xl transition-all cursor-pointer ${
                followSelected
                  ? 'border-cyan-400/60 bg-cyan-950/90 text-cyan-200 shadow-[0_0_12px_rgba(6,182,212,0.35)]'
                  : 'border-white/10 bg-[#070d1a]/90 text-slate-300 hover:text-white'
              }`}
            >
              {followSelected ? '◉ Following aircraft' : '○ Follow aircraft'}
            </button>
          </div>
        )}

        {/* Tactile Map Zoom & Orientation Controller (Bottom Right) */}
        <div className="airguard-map-controls absolute bottom-4 right-4 z-[450] flex flex-col items-end gap-2 pointer-events-auto">
          {/* Zoom Buttons Group */}
          <div className="flex flex-col rounded-xl overflow-hidden border border-white/15 bg-[#070d1a]/92 backdrop-blur-xl shadow-xl">
            <button
              type="button"
              onClick={zoomIn}
              aria-label="Zoom In"
              title="Zoom In"
              className="px-3 py-2 hover:bg-white/10 text-slate-200 hover:text-white font-mono text-base font-bold transition-colors cursor-pointer border-b border-white/10"
            >
              +
            </button>
            <button
              type="button"
              onClick={zoomOut}
              aria-label="Zoom Out"
              title="Zoom Out"
              className="px-3 py-2 hover:bg-white/10 text-slate-200 hover:text-white font-mono text-base font-bold transition-colors cursor-pointer border-b border-white/10"
            >
              −
            </button>
            <button
              type="button"
              onClick={resetNorth}
              aria-label="Reset Orientation to North"
              title="Reset View (All India)"
              className="px-2.5 py-2 hover:bg-white/10 text-cyan-300 hover:text-white font-mono text-xs font-bold transition-colors cursor-pointer flex items-center justify-center"
            >
              ▲N
            </button>
          </div>

          {/* Status Legend Pill */}
          <div className="hidden sm:flex items-center gap-3 bg-[#070d1a]/90 backdrop-blur-xl px-3 py-1.5 rounded-xl border border-white/10 text-[10px] text-slate-300 shadow-lg font-mono">
            <span className="font-semibold text-slate-500 uppercase tracking-wider">Status</span>
            <span className="flex items-center gap-1.5">
              <i className="w-2 h-2 rounded-full bg-sky-400 inline-block shadow-[0_0_6px_rgba(56,189,248,0.6)]" />
              Nominal ({nominalCount})
            </span>
            <span className="flex items-center gap-1.5">
              <i className="w-2 h-2 rounded-full bg-amber-400 inline-block shadow-[0_0_6px_rgba(245,158,11,0.6)]" />
              Review ({reviewCount})
            </span>
            <span className="flex items-center gap-1.5">
              <i className="w-2 h-2 rounded-full bg-rose-400 inline-block shadow-[0_0_6px_rgba(244,63,94,0.6)]" />
              Critical ({criticalCount})
            </span>
          </div>
        </div>

        {/* Geolocation / Nearby Aircraft Drawer (Bottom Left) */}
        <div className="airguard-map-controls absolute bottom-4 left-4 z-[450] w-[min(22rem,calc(100%-2rem))] pointer-events-auto">
          {isNearbyOpen && (
            <section
              className="mb-2 overflow-hidden rounded-2xl border border-slate-700/80 bg-[#08111f]/[.98] shadow-2xl backdrop-blur-2xl"
              aria-label="Nearby aircraft"
            >
              <div className="flex items-center justify-between border-b border-white/10 px-3.5 py-3">
                <div>
                  <h2 className="m-0 text-sm font-semibold text-white">Aircraft near me</h2>
                  <p className="m-0 mt-0.5 text-[10px] text-slate-400">Live reports within 120 km · sorted by distance</p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsNearbyOpen(false)}
                  aria-label="Close nearby aircraft"
                  className="px-2 text-lg text-slate-400 hover:text-white cursor-pointer"
                >
                  ×
                </button>
              </div>
              <div className="max-h-64 overflow-y-auto p-2.5">
                {!nearbyLocation && (
                  <div className="px-1 py-2">
                    <p className="m-0 text-xs leading-relaxed text-slate-300">
                      Use your device location to see which reported aircraft are closest to you.
                    </p>
                    <p className="mb-3 mt-1.5 text-[10px] leading-relaxed text-slate-500">
                      Location is used in this browser only. AirGuard does not send it to the server.
                    </p>
                    <button
                      type="button"
                      onClick={locateNearbyAircraft}
                      disabled={nearbyStatus === 'loading'}
                      className="rounded-xl border border-cyan-500/40 bg-cyan-500/15 px-3 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-500/25 disabled:opacity-60 cursor-pointer transition-all"
                    >
                      {nearbyStatus === 'loading' ? 'Finding your location…' : 'Use my location'}
                    </button>
                    {nearbyStatus === 'error' && (
                      <p role="status" className="mb-0 mt-2 text-[10px] text-amber-300">
                        Location is unavailable. Allow location access and try again.
                      </p>
                    )}
                  </div>
                )}
                {nearbyLocation && (
                  <>
                    <div className="flex items-center justify-between px-1 pb-2 text-[10px] text-slate-400">
                      <span>
                        {nearbyFlights.length} nearby report{nearbyFlights.length === 1 ? '' : 's'} found
                      </span>
                      <button type="button" onClick={locateNearbyAircraft} className="text-cyan-300 hover:text-cyan-100 cursor-pointer">
                        Refresh location
                      </button>
                    </div>
                    {nearbyFlights.length === 0 ? (
                      <p className="px-1 py-3 text-xs text-slate-400">
                        No aircraft reports within 120 km in the current feed.
                      </p>
                    ) : (
                      nearbyFlights.map(({ flight, distance, airline }) => {
                        const stale = flight.staleness_status === 'STALE';
                        return (
                          <button
                            key={flight.id}
                            type="button"
                            onClick={() => {
                              onSelectFlight(flight);
                              setActiveFloatingFlight(flight);
                              setFollowSelected(true);
                              if (isExpanded) setIsSidebarOpen(true);
                            }}
                            className="mb-1.5 flex w-full items-center justify-between gap-3 rounded-xl border border-white/[.08] bg-white/[.03] px-3 py-2 text-left hover:border-cyan-500/40 hover:bg-cyan-500/[.08] cursor-pointer transition-all"
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-xs font-semibold text-slate-100">
                                {airline && !airline.includes('Flight') ? `${airline} (${flight.callsign || 'N/A'})` : flight.callsign || 'Unknown'}
                              </span>
                              <span className="mt-0.5 block text-[10px] text-slate-400">
                                {formatObservedNumber(flight.data_quality, 'altitude', flight.altitude)} ft ·{' '}
                                {stale ? `last report ${Math.round(flight.last_seen_seconds_ago ?? 0)}s ago` : 'recent report'}
                              </span>
                            </span>
                            <span className="shrink-0 text-right">
                              <span className="block font-mono text-xs font-semibold text-cyan-200">
                                {distance < 10 ? distance.toFixed(1) : Math.round(distance)} km
                              </span>
                              <span className="text-[9px] text-slate-500">ground distance</span>
                            </span>
                          </button>
                        );
                      })
                    )}
                  </>
                )}
              </div>
            </section>
          )}
          <button
            type="button"
            onClick={() => {
              setIsNearbyOpen((open) => !open);
              setActiveFloatingFlight(null);
            }}
            aria-expanded={isNearbyOpen}
            className="flex items-center gap-2 rounded-xl border border-white/15 bg-[#070d1a]/95 px-3 py-2.5 text-xs font-semibold text-slate-100 shadow-xl backdrop-blur-xl hover:border-cyan-400/50 hover:text-cyan-100 cursor-pointer transition-all"
          >
            <span aria-hidden="true" className="text-cyan-300">
              ◎
            </span>
            Aircraft near me
            {nearbyLocation && (
              <span className="rounded-full bg-cyan-500/20 px-1.5 py-0.5 text-[9px] text-cyan-200">
                {nearbyFlights.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Enlarged Map Right Sidebar (Appears ONLY on clicking 3 lines or clicking a flight) */}
      {isExpanded && isSidebarOpen && (
        <aside className="airguard-expanded-sidebar w-full md:w-[380px] lg:w-[420px] xl:w-[450px] shrink-0 h-full bg-[#070d1a]/98 border-t md:border-t-0 md:border-l border-cyan-500/20 backdrop-blur-2xl flex flex-col z-[460] shadow-2xl overflow-hidden animate-in slide-in-from-right duration-200 select-text">
          {/* Sidebar Header */}
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 bg-[#0a1224]/90 shrink-0">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 shadow-[0_0_10px_rgba(6,182,212,0.8)] animate-pulse" />
              <h2 className="text-sm font-semibold text-white tracking-wide m-0">
                {activeDetailedFlight ? 'Flight Telemetry & Analysis' : 'Airspace Aircraft Monitor'}
              </h2>
            </div>
            <div className="flex items-center gap-2">
              {activeDetailedFlight && (
                <button
                  type="button"
                  onClick={() => {
                    setActiveFloatingFlight(null);
                    onSelectFlight(null);
                  }}
                  className="text-[10px] font-semibold text-cyan-300 hover:text-white px-2 py-1 rounded-md bg-cyan-950/60 border border-cyan-500/30 hover:bg-cyan-900/80 transition-all cursor-pointer"
                >
                  All Aircraft
                </button>
              )}
              <button
                type="button"
                onClick={() => setIsSidebarOpen(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-white/10 transition-colors text-sm cursor-pointer"
                title="Hide sidebar (Click 3-lines button to reopen)"
                aria-label="Hide sidebar"
              >
                ✕
              </button>
            </div>
          </div>

          {/* Sidebar Body */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {activeDetailedFlight ? (
              <>
                {/* 1. Target Identity & Airline Banner */}
                <div className="bg-[#0b1424] border border-cyan-500/30 rounded-2xl p-3.5 shadow-lg relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-32 h-32 bg-cyan-500/10 rounded-full blur-2xl pointer-events-none" />
                  <div className="flex items-start justify-between gap-2 relative z-10">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xl font-bold tracking-wider text-white">
                          {activeDetailedFlight.callsign || 'NO CALLSIGN'}
                        </span>
                        <span className="text-[11px] font-mono text-cyan-300 bg-cyan-950/80 border border-cyan-500/40 px-2 py-0.5 rounded font-bold">
                          {activeDetailedFlight.id.toUpperCase()}
                        </span>
                      </div>
                      {detailedAirline && (
                        <div className="flex items-center gap-1.5 mt-1 text-xs text-slate-300 font-semibold">
                          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: detailedAirline.color }} />
                          <span>{detailedAirline.name}</span>
                          {detailedAirline.country && <span className="text-slate-500 font-normal">({detailedAirline.country})</span>}
                        </div>
                      )}
                      {activeDetailedFlight.source && (
                        <div className="text-[10px] text-slate-400 mt-1 font-mono">
                          Source: <span className="text-slate-200">{activeDetailedFlight.source}</span>
                        </div>
                      )}
                    </div>
                    <span
                      className={`text-[10px] font-mono font-bold px-2 py-1 rounded-md uppercase border shrink-0 ${
                        activeDetailedFlight.status === 'critical'
                          ? 'bg-rose-950/90 text-rose-300 border-rose-500/60 shadow-[0_0_12px_rgba(244,63,94,0.4)]'
                          : activeDetailedFlight.status === 'suspicious'
                          ? 'bg-amber-950/90 text-amber-300 border-amber-500/60 shadow-[0_0_12px_rgba(245,158,11,0.3)]'
                          : 'bg-cyan-950/90 text-cyan-300 border-cyan-500/50'
                      }`}
                    >
                      {activeDetailedFlight.status === 'critical'
                        ? 'CRITICAL'
                        : activeDetailedFlight.status === 'suspicious'
                        ? 'REVIEW'
                        : 'NOMINAL'}
                    </span>
                  </div>
                </div>

                {/* 2. Trust Score Hero Card */}
                <div className="bg-[#0c1626] border border-white/10 rounded-2xl p-3.5 shadow-md">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Signal Trust Index</span>
                    <span
                      className={`text-base font-mono font-black ${
                        !Number.isFinite(activeDetailedFlight.trustScore)
                          ? 'text-slate-400'
                          : activeDetailedFlight.trustScore >= 70
                          ? 'text-emerald-400'
                          : activeDetailedFlight.trustScore >= 40
                          ? 'text-amber-400'
                          : 'text-rose-400'
                      }`}
                    >
                      {Number.isFinite(activeDetailedFlight.trustScore) ? `${activeDetailedFlight.trustScore}%` : 'UNASSESSED'}
                    </span>
                  </div>
                  <div className="w-full bg-slate-800/80 rounded-full h-2 overflow-hidden mb-2">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        !Number.isFinite(activeDetailedFlight.trustScore)
                          ? 'bg-slate-500 w-0'
                          : activeDetailedFlight.trustScore >= 70
                          ? 'bg-emerald-400'
                          : activeDetailedFlight.trustScore >= 40
                          ? 'bg-amber-400'
                          : 'bg-rose-400'
                      }`}
                      style={{ width: `${Math.max(0, Math.min(100, activeDetailedFlight.trustScore || 0))}%` }}
                    />
                  </div>
                  <p className="text-[11px] text-slate-400 m-0 leading-relaxed">
                    {activeDetailedFlight.status === 'critical'
                      ? 'Severe kinematic or transponder anomaly detected. Immediate review required.'
                      : activeDetailedFlight.status === 'suspicious'
                      ? 'Elevated residual variance or transponder drift detected.'
                      : 'Signal vectors correlate consistently with physical kinematic flight bounds.'}
                  </p>
                </div>

                {/* 3. Comprehensive Kinematic Telemetry Grid */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-[#0b1424] border border-white/[0.08] p-2.5 rounded-xl">
                    <span className="text-[10px] text-slate-400 uppercase font-semibold block">Altitude</span>
                    <span className="font-mono text-sm font-bold text-white">
                      {formatObservedNumber(activeDetailedFlight.data_quality, 'altitude', activeDetailedFlight.altitude)}
                    </span>
                    <span className="text-[10px] text-slate-400 ml-1">FT</span>
                  </div>

                  <div className="bg-[#0b1424] border border-white/[0.08] p-2.5 rounded-xl">
                    <span className="text-[10px] text-slate-400 uppercase font-semibold block">Ground Speed</span>
                    <span className="font-mono text-sm font-bold text-white">
                      {formatObservedNumber(activeDetailedFlight.data_quality, 'velocity', activeDetailedFlight.speed)}
                    </span>
                    <span className="text-[10px] text-slate-400 ml-1">KT</span>
                  </div>

                  <div className="bg-[#0b1424] border border-white/[0.08] p-2.5 rounded-xl">
                    <span className="text-[10px] text-slate-400 uppercase font-semibold block">True Heading</span>
                    <span className="font-mono text-sm font-bold text-white">
                      {Number.isFinite(activeDetailedFlight.heading) ? `${Math.round(activeDetailedFlight.heading)}°` : 'N/A'}
                    </span>
                  </div>

                  <div className="bg-[#0b1424] border border-white/[0.08] p-2.5 rounded-xl">
                    <span className="text-[10px] text-slate-400 uppercase font-semibold block">Vertical Rate</span>
                    <span className="font-mono text-sm font-bold text-white">
                      {activeDetailedFlight.verticalRate !== undefined && Number.isFinite(activeDetailedFlight.verticalRate)
                        ? `${activeDetailedFlight.verticalRate > 0 ? '+' : ''}${Math.round(activeDetailedFlight.verticalRate * 196.85)}`
                        : '0'}
                    </span>
                    <span className="text-[10px] text-slate-400 ml-1">FPM</span>
                  </div>

                  <div className="bg-[#0b1424] border border-white/[0.08] p-2.5 rounded-xl">
                    <span className="text-[10px] text-slate-400 uppercase font-semibold block">Squawk Code</span>
                    <span className="font-mono text-sm font-bold text-cyan-200">
                      {activeDetailedFlight.squawk || 'N/A'}
                    </span>
                  </div>

                  <div className="bg-[#0b1424] border border-white/[0.08] p-2.5 rounded-xl">
                    <span className="text-[10px] text-slate-400 uppercase font-semibold block">Signal Staleness</span>
                    <span className="font-mono text-xs font-bold text-slate-200">
                      {activeDetailedFlight.last_seen_seconds_ago !== undefined
                        ? `${Math.round(activeDetailedFlight.last_seen_seconds_ago)}s ago`
                        : 'Live'}
                    </span>
                  </div>
                </div>

                {/* 4. Position & Geodesic Coordinates */}
                <div className="bg-[#0b1424] border border-white/[0.08] p-3 rounded-xl">
                  <span className="text-[10px] text-slate-400 uppercase font-semibold block mb-1">Geographic Coordinates</span>
                  <div className="flex items-center justify-between font-mono text-xs text-slate-200">
                    <span>LAT: <strong className="text-white">{activeDetailedFlight.lat.toFixed(4)}°</strong></span>
                    <span>LNG: <strong className="text-white">{activeDetailedFlight.lng.toFixed(4)}°</strong></span>
                  </div>
                </div>

                {/* 5. Route Information */}
                {(activeDetailedFlight.estDepartureAirport || activeDetailedFlight.estArrivalAirport) && (
                  <div className="bg-[#0b1424] border border-white/[0.08] p-3 rounded-xl">
                    <span className="text-[10px] text-slate-400 uppercase font-semibold block mb-1">Estimated Route</span>
                    <div className="flex items-center justify-between text-xs font-mono">
                      <span className="text-emerald-300">{activeDetailedFlight.estDepartureAirport || 'DEP N/A'}</span>
                      <span className="text-slate-500">⟶</span>
                      <span className="text-sky-300">{activeDetailedFlight.estArrivalAirport || 'ARR N/A'}</span>
                    </div>
                  </div>
                )}

                {/* 6. Action Buttons */}
                <div className="space-y-2 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (isExpanded) {
                        setIsExpanded(false);
                        setIsSidebarOpen(false);
                      }
                      onSelectFlight(activeDetailedFlight);
                      onOpenFlightDetails(activeDetailedFlight);
                    }}
                    className="w-full py-2.5 px-4 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 active:scale-[0.98] text-white text-xs font-semibold rounded-xl shadow-lg shadow-cyan-900/40 transition-all flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <span>Open Full Investigation Matrix</span>
                    <span>→</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      if (mapRef.current) {
                        mapRef.current.flyTo([activeDetailedFlight.lat, activeDetailedFlight.lng], 9, { duration: 0.8 });
                        setFollowSelected(true);
                      }
                    }}
                    className="w-full py-2 px-3 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-200 text-xs font-semibold rounded-xl transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <span>◉ Center &amp; Track Aircraft</span>
                  </button>
                </div>
              </>
            ) : (
              /* No Flight Selected: Live Airspace Quick Selector */
              <div className="space-y-3">
                <div className="relative">
                  <input
                    type="search"
                    value={sidebarSearch}
                    onChange={(e) => setSidebarSearch(e.target.value)}
                    placeholder="Search callsign, ICAO, or airline..."
                    className="w-full rounded-xl border border-white/15 bg-slate-950/80 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 outline-none focus:border-cyan-400 transition-colors"
                  />
                  {sidebarSearch && (
                    <button
                      type="button"
                      onClick={() => setSidebarSearch('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white text-xs cursor-pointer"
                    >
                      ×
                    </button>
                  )}
                </div>

                <div className="flex gap-1.5 bg-[#0a1222] p-1 rounded-xl border border-white/10 text-xs">
                  {(['all', 'suspicious', 'critical'] as const).map((filter) => (
                    <button
                      key={filter}
                      type="button"
                      onClick={() => setSidebarFilter(filter)}
                      className={`flex-1 py-1 rounded-lg text-[11px] font-semibold transition-all capitalize cursor-pointer ${
                        sidebarFilter === filter
                          ? 'bg-cyan-600 text-white shadow-md'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {filter}
                    </button>
                  ))}
                </div>

                <div className="text-[10px] text-slate-400 px-1 font-mono">
                  {filteredSidebarFlights.length} aircraft reporting in current sector
                </div>

                <div className="space-y-1.5 max-h-[calc(100vh-220px)] overflow-y-auto pr-1">
                  {filteredSidebarFlights.length === 0 ? (
                    <div className="p-6 text-center text-slate-400 text-xs border border-dashed border-white/10 rounded-xl">
                      No matching aircraft found in current airspace sector.
                    </div>
                  ) : (
                    filteredSidebarFlights.map((f) => {
                      const airline = getAirlineDisplayName(f.callsign);
                      return (
                        <button
                          key={f.id}
                          type="button"
                          onClick={() => {
                            onSelectFlight(f);
                            setActiveFloatingFlight(f);
                            if (mapRef.current) {
                              mapRef.current.flyTo([f.lat, f.lng], 8, { duration: 0.6 });
                            }
                          }}
                          className="w-full text-left p-2.5 rounded-xl border border-white/[0.08] bg-[#0b1424]/80 hover:bg-cyan-950/40 hover:border-cyan-500/40 transition-all flex items-center justify-between gap-2 group cursor-pointer"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span
                                className={`w-2 h-2 rounded-full ${
                                  f.status === 'critical'
                                    ? 'bg-rose-400 shadow-[0_0_6px_rgba(244,63,94,0.6)]'
                                    : f.status === 'suspicious'
                                    ? 'bg-amber-400 shadow-[0_0_6px_rgba(245,158,11,0.6)]'
                                    : 'bg-cyan-400'
                                }`}
                              />
                              <span className="font-mono font-bold text-xs text-white group-hover:text-cyan-200">
                                {f.callsign || 'N/A'}
                              </span>
                              <span className="text-[10px] font-mono text-slate-400">
                                {f.id.toUpperCase()}
                              </span>
                            </div>
                            {airline && (
                              <span className="text-[10px] text-slate-400 block truncate mt-0.5">
                                {airline}
                              </span>
                            )}
                          </div>
                          <div className="text-right shrink-0">
                            <span className="font-mono text-xs font-semibold text-slate-200 block">
                              {Math.round(f.altitude).toLocaleString()} ft
                            </span>
                            <span
                              className={`text-[10px] font-mono font-bold ${
                                Number.isFinite(f.trustScore) && f.trustScore >= 70
                                  ? 'text-emerald-400'
                                  : Number.isFinite(f.trustScore) && f.trustScore >= 40
                                  ? 'text-amber-400'
                                  : 'text-rose-400'
                              }`}
                            >
                              {Number.isFinite(f.trustScore) ? `${f.trustScore}%` : '—'}
                            </span>
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>
        </aside>
      )}
    </div>
  );

  // If enlarged to full window, use React Portal to mount directly on document.body
  if (isExpanded) {
    return (
      <>
        <div className="relative w-full h-full min-h-[360px] bg-[#070c18] rounded-xl border border-slate-800 flex items-center justify-center text-slate-500 font-mono text-xs">
          <span>Map enlarged to full window (Press Esc or Exit Fullscreen to return)</span>
        </div>
        {createPortal(mapContent, document.body)}
      </>
    );
  }

  return mapContent;
};

