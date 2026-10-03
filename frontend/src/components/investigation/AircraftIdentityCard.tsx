import React from 'react';
import type { Flight } from '../../types';
import { Badge } from '../common/Badge';
import { Plane, MapPin } from '../common/Icons';

export interface AircraftIdentityCardProps {
  flight: Flight;
  identity?: {
    registration?: string | null;
    model?: string | null;
    operator?: string | null;
    country?: string | null;
    typecode?: string | null;
    source?: string;
  };
  className?: string;
}

export const AircraftIdentityCard: React.FC<AircraftIdentityCardProps> = ({
  flight,
  identity,
  className = ''
}) => {
  const reg = identity?.registration || flight.registration || 'Unavailable';
  const op = identity?.operator || flight.operator || 'Operator unavailable';
  const model = identity?.model || flight.aircraftType || 'Aircraft type unavailable';
  const country = identity?.country || flight.country || 'Country unavailable';

  return (
    <div className={`p-5 rounded-2xl border border-slate-800 bg-slate-900/60 backdrop-blur-md ${className}`}>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-xl bg-sky-950/60 border border-sky-500/30 text-sky-400">
            <Plane className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <h3 className="text-lg font-bold font-mono text-white tracking-wide">
                {flight.callsign || flight.id.toUpperCase()}
              </h3>
              <Badge variant="primary" size="sm">
                ICAO: {flight.id.toUpperCase()}
              </Badge>
            </div>
            <p className="text-xs text-slate-400 font-medium">
              {op} • {model} • {country}
            </p>
            <p className="text-[10px] text-slate-500 mt-1">Metadata source: {identity?.source || 'unavailable'}</p>
          </div>
        </div>

        <div className="text-right">
          <span className="text-[10px] font-mono text-slate-500 block uppercase">Registration</span>
          <span className="text-sm font-mono font-bold text-slate-200">{reg}</span>
        </div>
      </div>

      {/* Flight Route Banner */}
      {flight.route && (
        <div className="mb-4 p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80 flex items-center justify-between text-xs font-mono">
          <span className="text-slate-400 flex items-center gap-1.5">
            <MapPin className="w-3.5 h-3.5 text-sky-400" />
            <span>Route estimate:</span>
          </span>
          <span className="text-slate-200 font-semibold">{flight.route}</span>
        </div>
      )}

      {/* Kinematics Grid */}
      <div className="grid grid-cols-3 gap-2.5 pt-2 border-t border-slate-800/80 text-center font-mono">
        <div className="p-2 rounded-lg bg-slate-950/40 border border-slate-800/60">
          <span className="text-[10px] text-slate-500 block">Altitude</span>
          <span className="text-xs font-bold text-slate-200">{flight.altitude.toLocaleString()} ft</span>
        </div>
        <div className="p-2 rounded-lg bg-slate-950/40 border border-slate-800/60">
          <span className="text-[10px] text-slate-500 block">Speed</span>
          <span className="text-xs font-bold text-slate-200">{flight.speed} kts</span>
        </div>
        <div className="p-2 rounded-lg bg-slate-950/40 border border-slate-800/60">
          <span className="text-[10px] text-slate-500 block">Heading</span>
          <span className="text-xs font-bold text-slate-200">{flight.heading}°</span>
        </div>
      </div>
    </div>
  );
};
