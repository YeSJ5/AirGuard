import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

interface Flight {
  id: string; // ICAO24
  callsign: string;
  squawk?: string;
  altitude: number; // ft
  speed: number; // knots
  heading: number; // degrees
  verticalRate?: number; // m/s
  trustScore: number; // 0-100
  signalStrength?: number; // dBm
  status: 'normal' | 'suspicious' | 'critical';
  lat: number;
  lng: number;
  is_synthetic?: boolean;
  source?: string;
  estDepartureAirport?: string | null;
  estArrivalAirport?: string | null;
  last_seen_seconds_ago?: number;
  staleness_status?: string;
  history?: Array<{ lat: number; lng: number }>;
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
  const radians = (degrees: number) => degrees * Math.PI / 180;
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

// Crisp 2D aircraft SVG glyph
const createAircraftSvg = (color: string, isSelected: boolean) => `
<svg viewBox="0 0 32 32" width="${isSelected ? 32 : 26}" height="${isSelected ? 32 : 26}" style="filter: drop-shadow(0px 1px 2px rgba(0,0,0,0.45));">
  <path 
    d="M16 2 C15.2 2 14.5 3 14.5 4.5 L14.5 11.5 L4.5 17.5 L4.5 20.5 L14.5 16.5 L14.5 24 L11.5 26.5 L11.5 28.5 L16 27.2 L20.5 28.5 L20.5 26.5 L17.5 24 L17.5 16.5 L27.5 20.5 L27.5 17.5 L17.5 11.5 L17.5 4.5 C17.5 3 16.8 2 16 2 Z" 
    fill="${color}" 
    stroke="#1e293b" 
    stroke-width="1.2" 
    stroke-linejoin="round"
  />
</svg>
`;

export const AirspaceMap: React.FC<AirspaceMapProps> = ({
  flights,
  selectedFlight,
  onSelectFlight,
  onOpenFlightDetails,
  route,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Map<string, L.Marker>>(new Map());
  const markerVisualsRef = useRef<Map<string, string>>(new Map());
  const latestFlightsRef = useRef<Map<string, Flight>>(new Map());
  const [activeFloatingFlight, setActiveFloatingFlight] = useState<Flight | null>(null);
  const [zoomLevel, setZoomLevel] = useState<number>(5);
  const [followSelected, setFollowSelected] = useState(false);
  const [nearbyLocation, setNearbyLocation] = useState<UserLocation | null>(null);
  const [nearbyStatus, setNearbyStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [isNearbyOpen, setIsNearbyOpen] = useState(false);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const nearbyLayerRef = useRef<L.LayerGroup | null>(null);
  const previousSelectedIdRef = useRef<string | null>(null);
  latestFlightsRef.current = new Map(flights.map(flight => [flight.id, flight]));
  const nearbyFlights = useMemo(() => {
    if (!nearbyLocation) return [];
    return flights.map(flight => ({ flight, distance: distanceKm(nearbyLocation, { lat: flight.lat, lng: flight.lng }) }))
      .filter(item => Number.isFinite(item.distance) && item.distance <= 120)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 8);
  }, [flights, nearbyLocation]);

  const locateNearbyAircraft = () => {
    if (!navigator.geolocation) {
      setNearbyStatus('error');
      return;
    }
    setNearbyStatus('loading');
    navigator.geolocation.getCurrentPosition(
      position => {
        const location = { lat: position.coords.latitude, lng: position.coords.longitude };
        setNearbyLocation(location);
        setNearbyStatus('ready');
        mapRef.current?.flyTo([location.lat, location.lng], 7, { duration: 0.8 });
      },
      () => setNearbyStatus('error'),
      { enableHighAccuracy: false, maximumAge: 60_000, timeout: 10_000 },
    );
  };

  // Initialize Leaflet 2D Map with clean light basemap
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center: [21.5, 78.9], // Central India
      zoom: 5,
      zoomControl: false,
      attributionControl: true,
      minZoom: 4,
      maxZoom: 18,
    });

    // OpenStreetMap tiles are darkened locally so targets remain the visual focus.
    const lightTiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    });

    lightTiles.addTo(map);

    // Zoom control in bottom right
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    map.on('zoomend', () => {
      setZoomLevel(map.getZoom());
    });

    map.on('click', (e) => {
      // Clicking on empty map area closes floating popup
      const target = e.originalEvent?.target as HTMLElement;
      if (!target?.closest('.leaflet-marker-icon') && !target?.closest('.airguard-floating-label')) {
        setActiveFloatingFlight(null);
      }
    });

    mapRef.current = map;
    routeLayerRef.current = L.layerGroup().addTo(map);
    nearbyLayerRef.current = L.layerGroup().addTo(map);

    return () => {
      map.remove();
      mapRef.current = null;
      routeLayerRef.current = null;
      nearbyLayerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const layer = nearbyLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!nearbyLocation) return;
    L.circle([nearbyLocation.lat, nearbyLocation.lng], {
      radius: 120_000, color: '#67e8f9', weight: 1, opacity: 0.65,
      fillColor: '#22d3ee', fillOpacity: 0.035, dashArray: '5 7',
    }).addTo(layer);
    L.circleMarker([nearbyLocation.lat, nearbyLocation.lng], {
      radius: 6, color: '#cffafe', weight: 2, fillColor: '#06b6d4', fillOpacity: 1,
    }).bindTooltip('Your location · stored in this browser only', { direction: 'top' }).addTo(layer);
  }, [nearbyLocation]);

  // Show the selected aircraft's verified route endpoints and observed position history.
  useEffect(() => {
    const layer = routeLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!selectedFlight) return;
    const history = (selectedFlight.history || []).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (history.length > 1) {
      L.polyline([...history].reverse().map(p => [p.lat, p.lng] as [number, number]), {
        color: '#38bdf8', weight: 3, opacity: 0.85,
      }).addTo(layer);
    }
    if (route?.origin && route?.destination) {
      L.polyline([[route.origin.lat, route.origin.lng], [route.destination.lat, route.destination.lng]], {
        color: '#a5b4fc', weight: 2, opacity: 0.8, dashArray: '7 8',
      }).addTo(layer);
      for (const [point, label, color] of [[route.origin, `Origin · ${route.origin.label}`, '#34d399'], [route.destination, `Destination · ${route.destination.label}`, '#a5b4fc']] as const) {
        L.circleMarker([point.lat, point.lng], { radius: 5, color, weight: 2, fillColor: '#0b1220', fillOpacity: 1 })
          .bindTooltip(label, { direction: 'top' }).addTo(layer);
      }
    }
  }, [selectedFlight, route]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedFlight) { previousSelectedIdRef.current = selectedFlight?.id ?? null; return; }
    const changed = previousSelectedIdRef.current !== selectedFlight.id;
    previousSelectedIdRef.current = selectedFlight.id;
    if (changed || followSelected) {
      map.flyTo([selectedFlight.lat, selectedFlight.lng], Math.max(map.getZoom(), 7), { duration: changed ? 0.65 : 0.25 });
    }
  }, [selectedFlight?.id, selectedFlight?.lat, selectedFlight?.lng, followSelected]);

  // Update markers smoothly on aircraft churn
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const currentFlightIds = new Set<string>();

    flights.forEach((flight) => {
      if (typeof flight.lat !== 'number' || typeof flight.lng !== 'number' || isNaN(flight.lat) || isNaN(flight.lng)) {
        return;
      }

      currentFlightIds.add(flight.id);
      const isSelected = selectedFlight?.id === flight.id;
      const isFloatingActive = activeFloatingFlight?.id === flight.id;

      // Calm cyan for normal traffic; reserve warm colors for elevated risk.
      let glyphColor = '#67e8f9';
      if (flight.status === 'critical') glyphColor = '#ef4444'; // Red alert
      else if (flight.status === 'suspicious') glyphColor = '#f97316'; // Amber warning
      else if (isSelected) glyphColor = '#0284c7'; // Active blue

      const heading = flight.heading || 0;
      const showCallsignLabel = zoomLevel >= 8 || isSelected || isFloatingActive;
      const visualKey = `${heading}|${glyphColor}|${isSelected}|${showCallsignLabel}|${flight.callsign}`;

      const htmlContent = `
        <div class="airguard-aircraft-container" role="img" aria-label="${flight.callsign || 'Aircraft'}" style="position: relative; display: flex; flex-direction: column; align-items: center; pointer-events: auto; cursor: pointer;">
          <div class="airguard-glyph" style="transform: rotate(${heading}deg); transform-origin: center; transition: transform 0.4s ease;">
            ${createAircraftSvg(glyphColor, isSelected)}
          </div>
          ${showCallsignLabel ? `
            <div class="airguard-callsign-tag" style="
              margin-top: 1px;
              background: rgba(15, 23, 42, 0.88);
              color: ${isSelected ? '#38bdf8' : '#f8fafc'};
              font-family: 'Share Tech Mono', monospace, sans-serif;
              font-size: 10px;
              font-weight: 700;
              padding: 1px 4px;
              border-radius: 3px;
              border: 1px solid ${isSelected ? '#38bdf8' : 'rgba(255,255,255,0.2)'};
              white-space: nowrap;
              box-shadow: 0 1px 3px rgba(0,0,0,0.3);
              letter-spacing: 0.5px;
            ">
              ${flight.callsign}
            </div>
          ` : ''}
        </div>
      `;

      const existingMarker = markersRef.current.get(flight.id);

      if (existingMarker) {
        const position = existingMarker.getLatLng();
        if (position.lat !== flight.lat || position.lng !== flight.lng) existingMarker.setLatLng([flight.lat, flight.lng]);
        if (markerVisualsRef.current.get(flight.id) !== visualKey) {
          existingMarker.setIcon(L.divIcon({
            className: 'airguard-marker-custom',
            html: htmlContent,
            iconSize: isSelected ? [36, 46] : [30, 40],
            iconAnchor: isSelected ? [18, 18] : [15, 15],
          }));
          markerVisualsRef.current.set(flight.id, visualKey);
        }
      } else {
        const newMarker = L.marker([flight.lat, flight.lng], {
          icon: L.divIcon({
            className: 'airguard-marker-custom',
            html: htmlContent,
            iconSize: isSelected ? [36, 46] : [30, 40],
            iconAnchor: isSelected ? [18, 18] : [15, 15],
          }),
          zIndexOffset: isSelected ? 1000 : 100,
        });

        newMarker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          const latestFlight = latestFlightsRef.current.get(flight.id) || flight;
          setActiveFloatingFlight(latestFlight);
          onSelectFlight(latestFlight);
        });

        newMarker.addTo(map);
        markersRef.current.set(flight.id, newMarker);
        markerVisualsRef.current.set(flight.id, visualKey);
      }
    });

    // Remove old stale markers cleanly (zero memory leak under high churn)
    markersRef.current.forEach((marker, id) => {
      if (!currentFlightIds.has(id)) {
        map.removeLayer(marker);
        markersRef.current.delete(id);
        markerVisualsRef.current.delete(id);
      }
    });
  }, [flights, selectedFlight, activeFloatingFlight, zoomLevel, onSelectFlight]);

  // Keep active floating flight data up-to-date
  useEffect(() => {
    if (activeFloatingFlight) {
      const updated = flights.find((f) => f.id === activeFloatingFlight.id);
      if (updated) {
        setActiveFloatingFlight(updated);
      }
    }
  }, [flights]);

  // Handle Quick City/Region Zoom
  const zoomToRegion = (lat: number, lng: number, zoom: number) => {
    if (mapRef.current) {
      mapRef.current.flyTo([lat, lng], zoom, { duration: 1.0 });
    }
  };

  return (
    <div className="relative w-full h-full bg-[#0b1220] overflow-hidden select-none">
      {/* 2D Leaflet Map Canvas */}
      <div ref={mapContainerRef} className="w-full h-full z-0" />

      {/* Quick Region Navigation Bar */}
      <div className="absolute top-4 left-4 z-[400] max-w-[calc(100%-2rem)] flex items-center gap-1.5 overflow-x-auto bg-[#0b1220]/90 backdrop-blur-xl px-2.5 py-2 rounded-xl shadow-xl border border-white/10 text-xs font-medium text-slate-200">
        <span className="text-[10px] uppercase font-bold tracking-wider text-slate-500 mr-1 shrink-0">Region</span>
        <button
          onClick={() => zoomToRegion(21.5, 78.9, 5)}
          className="px-2.5 py-1.5 rounded-lg bg-sky-400/10 text-sky-200 hover:bg-sky-400/20 transition-colors font-semibold whitespace-nowrap"
        >
          All India
        </button>
        <span className="text-slate-700">|</span>
        <button
          onClick={() => zoomToRegion(28.5562, 77.1000, 10)}
          className="px-2.5 py-1.5 rounded-lg text-slate-300 hover:bg-white/10 transition-colors whitespace-nowrap"
        >
          Delhi (DEL)
        </button>
        <button
          onClick={() => zoomToRegion(19.0896, 72.8656, 10)}
          className="px-2.5 py-1.5 rounded-lg text-slate-300 hover:bg-white/10 transition-colors whitespace-nowrap"
        >
          Mumbai (BOM)
        </button>
        <button
          onClick={() => zoomToRegion(13.1986, 77.7066, 10)}
          className="px-2.5 py-1.5 rounded-lg text-slate-300 hover:bg-white/10 transition-colors whitespace-nowrap"
        >
          Bengaluru (BLR)
        </button>
        <button
          onClick={() => zoomToRegion(22.6547, 88.4467, 10)}
          className="px-2.5 py-1.5 rounded-lg text-slate-300 hover:bg-white/10 transition-colors whitespace-nowrap"
        >
          Kolkata (CCU)
        </button>
        <button
          onClick={() => zoomToRegion(12.9941, 80.1709, 10)}
          className="px-2.5 py-1.5 rounded-lg text-slate-300 hover:bg-white/10 transition-colors whitespace-nowrap"
        >
          Chennai (MAA)
        </button>
      </div>

      {/* Floating Lightweight Flight Label Card (Click-to-Label, instant, no heavy drawer animation) */}
      {activeFloatingFlight && (
        <div className="absolute bottom-5 left-5 z-[500] bg-[#0b1220]/95 backdrop-blur-xl text-white border border-white/10 rounded-2xl p-4 shadow-2xl shadow-black/40 w-[min(21rem,calc(100%-2.5rem))] animate-in fade-in slide-in-from-bottom-3 duration-200">
          <div className="flex items-center justify-between border-b border-white/10 pb-2.5 mb-3">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${activeFloatingFlight.status === 'critical' ? 'bg-rose-400' : activeFloatingFlight.status === 'suspicious' ? 'bg-amber-400' : 'bg-emerald-400'}`} />
              <span className="font-mono text-base font-bold tracking-wide text-white">
                {activeFloatingFlight.callsign}
              </span>
              <span className="text-[10px] font-mono text-slate-400 bg-slate-800 px-1.5 py-0.5 rounded">
                {activeFloatingFlight.id.toUpperCase()}
              </span>
            </div>
            <button
              onClick={() => setActiveFloatingFlight(null)}
              className="text-slate-400 hover:text-white text-lg leading-none px-1"
              title="Close"
            >
              &times;
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2 text-center text-xs mb-3">
            <div className="bg-slate-800/70 p-1.5 rounded-lg border border-slate-700/40">
              <div className="text-[9px] uppercase tracking-wider text-slate-400">Altitude</div>
              <div className="font-mono font-bold text-slate-100">
                {Math.round(activeFloatingFlight.altitude).toLocaleString()} <span className="text-[10px] font-normal text-slate-400">FT</span>
              </div>
            </div>
            <div className="bg-slate-800/70 p-1.5 rounded-lg border border-slate-700/40">
              <div className="text-[9px] uppercase tracking-wider text-slate-400">Speed</div>
              <div className="font-mono font-bold text-slate-100">
                {Math.round(activeFloatingFlight.speed)} <span className="text-[10px] font-normal text-slate-400">KT</span>
              </div>
            </div>
            <div className="bg-slate-800/70 p-1.5 rounded-lg border border-slate-700/40">
              <div className="text-[9px] uppercase tracking-wider text-slate-400">Trust</div>
              <div className={`font-mono font-bold ${
                activeFloatingFlight.trustScore >= 80 ? 'text-emerald-400' :
                activeFloatingFlight.trustScore >= 50 ? 'text-amber-400' : 'text-rose-400'
              }`}>
                {activeFloatingFlight.trustScore}%
              </div>
            </div>
          </div>

          {/* Secondary Action: Open Full Detail Panel */}
          <button
            onClick={() => {
              onOpenFlightDetails(activeFloatingFlight);
            }}
            className="w-full py-1.5 px-3 bg-cyan-600 hover:bg-cyan-500 active:bg-cyan-700 text-white text-xs font-semibold rounded-lg shadow transition-all flex items-center justify-center gap-1.5"
          >
            <span>View Full Details &amp; ADS-B Security</span>
            <span className="text-sm">→</span>
          </button>
        </div>
      )}

      {/* Map Mode Indicator */}
      <div className="absolute top-[4.25rem] sm:top-4 right-3 sm:right-4 z-[400] bg-[#0b1220]/90 backdrop-blur-xl px-3 py-2 rounded-xl shadow-xl border border-white/10 text-xs font-semibold text-slate-200 flex items-center gap-2.5">
        <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,.55)]" />
        <span>Live airspace</span>
        <span className="text-[11px] text-slate-400 border-l border-white/10 pl-2.5 font-mono">
          {flights.length.toLocaleString()} aircraft
        </span>
      </div>

      {selectedFlight && <button type="button" onClick={() => setFollowSelected(value => !value)} aria-pressed={followSelected}
        className={`absolute top-[7.25rem] right-3 sm:top-[4.5rem] sm:right-4 z-[400] rounded-lg border px-3 py-2 text-[11px] font-semibold shadow-lg backdrop-blur-xl ${followSelected ? 'border-cyan-400/50 bg-cyan-950/90 text-cyan-200' : 'border-white/10 bg-[#0b1220]/90 text-slate-300 hover:text-white'}`}>
        {followSelected ? 'Following aircraft' : 'Follow aircraft'}
      </button>}

      <div className="absolute bottom-4 right-4 z-[400] hidden sm:flex items-center gap-3 bg-[#0b1220]/85 backdrop-blur-xl px-3 py-2 rounded-xl border border-white/10 text-[10px] text-slate-300 shadow-lg">
        <span className="font-semibold text-slate-500 uppercase tracking-wider">Signal status</span>
        <span className="flex items-center gap-1.5"><i className="w-1.5 h-1.5 rounded-full bg-violet-400" />Demo</span>
        <span className="flex items-center gap-1.5"><i className="w-1.5 h-1.5 rounded-full bg-sky-400" />Nominal</span>
        <span className="flex items-center gap-1.5"><i className="w-1.5 h-1.5 rounded-full bg-amber-400" />Review</span>
        <span className="flex items-center gap-1.5"><i className="w-1.5 h-1.5 rounded-full bg-rose-400" />Critical</span>
      </div>

      <div className="absolute bottom-4 left-4 z-[450] w-[min(21rem,calc(100%-2rem))]">
        {isNearbyOpen && <section className="mb-2 overflow-hidden rounded-xl border border-slate-700/80 bg-[#08111f]/[.97] shadow-2xl backdrop-blur-xl" aria-label="Nearby aircraft">
          <div className="flex items-center justify-between border-b border-white/10 px-3.5 py-3">
            <div><h2 className="m-0 text-sm font-semibold text-white">Aircraft near me</h2><p className="m-0 mt-0.5 text-[10px] text-slate-400">Live reports within 120 km · sorted by distance</p></div>
            <button type="button" onClick={() => setIsNearbyOpen(false)} aria-label="Close nearby aircraft" className="px-2 text-lg text-slate-400 hover:text-white">×</button>
          </div>
          <div className="max-h-64 overflow-y-auto p-2.5">
            {!nearbyLocation && <div className="px-1 py-2">
              <p className="m-0 text-xs leading-relaxed text-slate-300">Use your device location to see which reported aircraft are closest to you.</p>
              <p className="mb-3 mt-1.5 text-[10px] leading-relaxed text-slate-500">Location is used in this browser only. AirGuard does not send it to the server.</p>
              <button type="button" onClick={locateNearbyAircraft} disabled={nearbyStatus === 'loading'} className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-60">{nearbyStatus === 'loading' ? 'Finding your location…' : 'Use my location'}</button>
              {nearbyStatus === 'error' && <p role="status" className="mb-0 mt-2 text-[10px] text-amber-300">Location is unavailable. Allow location access and try again, or check browser location settings.</p>}
            </div>}
            {nearbyLocation && <>
              <div className="flex items-center justify-between px-1 pb-2 text-[10px] text-slate-400"><span>{nearbyFlights.length} nearby report{nearbyFlights.length === 1 ? '' : 's'} found</span><button type="button" onClick={locateNearbyAircraft} className="text-cyan-300 hover:text-cyan-100">Refresh location</button></div>
              {nearbyFlights.length === 0 ? <p className="px-1 py-3 text-xs text-slate-400">No aircraft reports within 120 km in the current feed. Coverage and transponder visibility vary by area.</p> : nearbyFlights.map(({ flight, distance }) => {
                const stale = flight.staleness_status === 'STALE' || (flight.last_seen_seconds_ago ?? 0) > 20;
                return <button key={flight.id} type="button" onClick={() => { onSelectFlight(flight); setFollowSelected(true); }} className="mb-1.5 flex w-full items-center justify-between gap-3 rounded-lg border border-white/[.08] bg-white/[.03] px-3 py-2 text-left hover:border-cyan-500/40 hover:bg-cyan-500/[.06]">
                  <span className="min-w-0"><span className="block truncate text-xs font-semibold text-slate-100">{flight.callsign || 'Unknown callsign'}</span><span className="mt-0.5 block text-[10px] text-slate-400">{Math.round(flight.altitude).toLocaleString()} ft · {stale ? `last report ${Math.round(flight.last_seen_seconds_ago ?? 0)}s ago` : 'recent report'}</span></span>
                  <span className="shrink-0 text-right"><span className="block font-mono text-xs font-semibold text-cyan-200">{distance < 10 ? distance.toFixed(1) : Math.round(distance)} km</span><span className="text-[9px] text-slate-500">ground distance</span></span>
                </button>;
              })}
            </>}
          </div>
        </section>}
        <button type="button" onClick={() => { setIsNearbyOpen(open => !open); setActiveFloatingFlight(null); }} aria-expanded={isNearbyOpen} className="flex items-center gap-2 rounded-lg border border-white/15 bg-[#0b1220]/95 px-3 py-2.5 text-xs font-semibold text-slate-100 shadow-xl backdrop-blur-xl hover:border-cyan-400/50 hover:text-cyan-100">
          <span aria-hidden="true" className="text-cyan-300">◎</span>Aircraft near me
          {nearbyLocation && <span className="rounded-full bg-cyan-500/15 px-1.5 py-0.5 text-[9px] text-cyan-200">{nearbyFlights.length}</span>}
        </button>
      </div>
    </div>
  );
};
