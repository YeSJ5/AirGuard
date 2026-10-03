import React, { useState } from 'react';
import { useAirGuardStore } from '../../store/useAirGuardStore';
import type { Flight } from '../../types';
import { AirspaceMap } from '../AirspaceMap';
import { Badge } from '../common/Badge';
import { Search, Plane, ChevronRight } from '../common/Icons';

export const MapContainer: React.FC = () => {
  const {
    flights,
    selectedFlightId,
    setSelectedFlightId,
    activeFilter,
    setActiveFilter,
    setCurrentTier
  } = useAirGuardStore();

  const [searchQuery, setSearchQuery] = useState<string>('');

  const selectedFlight = flights.find((f: Flight) => f.id === selectedFlightId) || null;

  const filteredFlights = flights.filter((f: Flight) => {
    // 1. Status Filter
    if (activeFilter === 'critical' && f.status !== 'critical') return false;
    if (activeFilter === 'suspicious' && f.status !== 'suspicious' && f.status !== 'critical') return false;

    // 2. Text Search
    const query = searchQuery.toLowerCase().trim();
    if (!query) return true;
    return (
      f.id.toLowerCase().includes(query) ||
      f.callsign.toLowerCase().includes(query) ||
      (f.operator && f.operator.toLowerCase().includes(query)) ||
      (f.route && f.route.toLowerCase().includes(query))
    );
  });

  const criticalCount = flights.filter((f: Flight) => f.status === 'critical').length;
  const suspiciousCount = flights.filter((f: Flight) => f.status === 'suspicious').length;

  const handleSelectFlight = (flight: Flight | null) => {
    setSelectedFlightId(flight ? flight.id : null);
  };

  const handleOpenFlightDetails = (flight: Flight) => {
    setSelectedFlightId(flight.id);
    setCurrentTier('tier2_investigation');
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 h-[760px]">
      {/* 2D / 3D Tactical Map Canvas */}
      <div className="lg:col-span-8 h-full rounded-2xl border border-slate-800 bg-slate-950 overflow-hidden relative shadow-2xl flex flex-col">
        {/* Map Top Bar */}
        <div className="absolute top-4 left-4 right-4 z-[400] flex items-center justify-between pointer-events-none">
          <div className="flex items-center gap-2 pointer-events-auto p-1.5 rounded-xl bg-slate-900/90 border border-slate-800 backdrop-blur-md shadow-lg">
            <button
              onClick={() => setActiveFilter('all')}
              className={`px-3 py-1 rounded-lg text-xs font-mono font-semibold transition-colors ${
                activeFilter === 'all'
                  ? 'bg-sky-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              All ({flights.length})
            </button>
            <button
              onClick={() => setActiveFilter('suspicious')}
              className={`px-3 py-1 rounded-lg text-xs font-mono font-semibold transition-colors ${
                activeFilter === 'suspicious'
                  ? 'bg-amber-600 text-white shadow'
                  : 'text-amber-400 hover:text-amber-300'
              }`}
            >
              Suspicious ({suspiciousCount})
            </button>
            <button
              onClick={() => setActiveFilter('critical')}
              className={`px-3 py-1 rounded-lg text-xs font-mono font-semibold transition-colors ${
                activeFilter === 'critical'
                  ? 'bg-red-600 text-white shadow'
                  : 'text-red-400 hover:text-red-300'
              }`}
            >
              Critical ({criticalCount})
            </button>
          </div>

          <div className="pointer-events-auto p-2 rounded-xl bg-slate-900/90 border border-slate-800 backdrop-blur-md shadow-lg text-[10px] font-mono text-slate-400 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-ping" />
            <span>SECTOR: 6°N–37°N / 68°E–98°E</span>
          </div>
        </div>

        {/* Tactical Leaflet Map */}
        <div className="w-full h-full">
          <AirspaceMap
            flights={filteredFlights}
            selectedFlight={selectedFlight}
            onSelectFlight={handleSelectFlight}
            onOpenFlightDetails={handleOpenFlightDetails}
          />
        </div>
      </div>

      {/* Flight Radar List & Quick Inspector */}
      <div className="lg:col-span-4 h-full flex flex-col gap-4">
        <div className="p-4 rounded-2xl border border-slate-800 bg-slate-900/60 backdrop-blur-md flex-1 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-mono uppercase tracking-wider text-slate-300 font-semibold flex items-center gap-2">
              <Plane className="w-4 h-4 text-sky-400" />
              <span>Airspace Contacts</span>
            </h3>
            <span className="text-xs font-mono text-slate-500">{filteredFlights.length} Active</span>
          </div>

          {/* Search Input */}
          <div className="relative mb-3">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search Callsign, ICAO, Route..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 text-xs font-mono rounded-xl bg-slate-950/80 border border-slate-800 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-sky-500 transition-colors"
            />
          </div>

          {/* Virtualized Flight Contact List */}
          <div className="flex-1 overflow-y-auto space-y-2 pr-1">
            {filteredFlights.length === 0 ? (
              <div className="p-8 text-center text-slate-500 text-xs font-mono">
                No aircraft matched the active filter.
              </div>
            ) : (
              filteredFlights.map((flight: Flight) => {
                const isSelected = flight.id === selectedFlightId;
                const isCritical = flight.status === 'critical' || flight.trustScore < 40;
                const isSuspicious = flight.status === 'suspicious' || (flight.trustScore >= 40 && flight.trustScore < 70);

                return (
                  <div
                    key={flight.id}
                    onClick={() => setSelectedFlightId(flight.id)}
                    className={`p-3 rounded-xl border transition-all cursor-pointer flex items-center justify-between ${
                      isSelected
                        ? 'bg-sky-950/60 border-sky-500/70 shadow-lg shadow-sky-950/40'
                        : 'bg-slate-950/40 border-slate-800/80 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`p-2 rounded-lg border shrink-0 ${
                          isCritical
                            ? 'bg-red-950/60 border-red-500/40 text-red-400'
                            : isSuspicious
                            ? 'bg-amber-950/60 border-amber-500/40 text-amber-400'
                            : 'bg-slate-800/60 border-slate-700 text-slate-300'
                        }`}
                      >
                        <Plane className="w-4 h-4" />
                      </div>

                      <div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-mono font-bold text-white">
                            {flight.callsign}
                          </span>
                          <span className="text-[10px] font-mono text-slate-500">
                            {flight.id.toUpperCase()}
                          </span>
                        </div>
                        <p className="text-[10px] font-mono text-slate-400">
                          {flight.altitude.toLocaleString()} ft • {flight.speed} kts
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Badge
                        variant={isCritical ? 'critical' : isSuspicious ? 'warning' : 'success'}
                        size="sm"
                      >
                        {flight.trustScore}%
                      </Badge>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleOpenFlightDetails(flight);
                        }}
                        className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Selected Airframe Quick Snapshot Card */}
        {selectedFlight && (
          <div className="p-4 rounded-2xl border border-sky-500/30 bg-slate-900/80 backdrop-blur-md space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono font-bold text-white">
                  {selectedFlight.callsign}
                </span>
                <Badge
                  variant={
                    selectedFlight.status === 'critical'
                      ? 'critical'
                      : selectedFlight.status === 'suspicious'
                      ? 'warning'
                      : 'success'
                  }
                  size="sm"
                >
                  {selectedFlight.trustScore}% TRUST
                </Badge>
              </div>

              <button
                onClick={() => setCurrentTier('tier2_investigation')}
                className="text-xs font-mono font-semibold text-sky-400 hover:text-sky-300 flex items-center gap-1"
              >
                <span>Full Investigation</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="text-xs font-mono text-slate-400 grid grid-cols-2 gap-2 pt-1 border-t border-slate-800">
              <div>
                <span className="text-slate-500 text-[10px] block">Coordinates</span>
                <span>{selectedFlight.lat.toFixed(2)}°N, {selectedFlight.lng.toFixed(2)}°E</span>
              </div>
              <div>
                <span className="text-slate-500 text-[10px] block">Route</span>
                <span className="truncate block">{selectedFlight.route || 'Route unknown'}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
