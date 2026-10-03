import React from 'react';
import type { AlertLog } from '../../types';
import { Badge } from '../common/Badge';
import { ShieldAlert, Check, ChevronRight } from '../common/Icons';

export interface ThreatCardProps {
  alert: AlertLog;
  onSelect?: (icao24: string) => void;
  onAcknowledge?: (id: string) => void;
  className?: string;
}

export const ThreatCard: React.FC<ThreatCardProps> = ({
  alert,
  onSelect,
  onAcknowledge,
  className = ''
}) => {
  const isHigh = alert.severity === 'high' || alert.scoreImpact <= -40;

  return (
    <div
      className={`p-4 rounded-xl border transition-all duration-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 ${
        alert.acknowledged
          ? 'bg-slate-950/30 border-slate-800/60 opacity-60'
          : isHigh
          ? 'bg-red-950/40 border-red-500/40 hover:border-red-500/70 shadow-lg shadow-red-950/20'
          : 'bg-amber-950/30 border-amber-500/30 hover:border-amber-500/60'
      } ${className}`}
    >
      <div className="flex items-start sm:items-center gap-3.5">
        <div
          className={`p-2.5 rounded-xl border shrink-0 ${
            alert.acknowledged
              ? 'bg-slate-800 text-slate-400 border-slate-700'
              : isHigh
              ? 'bg-red-900/60 text-red-400 border-red-500/40'
              : 'bg-amber-900/60 text-amber-400 border-amber-500/40'
          }`}
        >
          <ShieldAlert className="w-5 h-5" />
        </div>

        <div>
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-xs font-mono font-bold text-white tracking-wide">
              {alert.callsign || alert.icao24.toUpperCase()}
            </span>
            <Badge variant={isHigh ? 'critical' : 'warning'} size="sm">
              {alert.severity.toUpperCase()}
            </Badge>
            {alert.is_synthetic && (
              <Badge variant="simulated" size="sm">
                SYNTHETIC
              </Badge>
            )}
            <span className="text-[10px] font-mono text-slate-500">{alert.timestamp}</span>
          </div>

          <p className="text-xs text-slate-300 font-medium">{alert.type || alert.reason_text}</p>
          <p className="text-[10px] font-mono text-slate-400 mt-0.5">
            ICAO: {alert.icao24.toUpperCase()} • Impact: {alert.scoreImpact} Trust Points
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
        {!alert.acknowledged && onAcknowledge && (
          <button
            onClick={() => onAcknowledge(alert.id)}
            className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-xs font-mono font-semibold text-slate-200 transition-colors flex items-center gap-1.5"
          >
            <Check className="w-3.5 h-3.5 text-emerald-400" />
            <span>Acknowledge</span>
          </button>
        )}

        {onSelect && (
          <button
            onClick={() => onSelect(alert.icao24)}
            className="px-3 py-1.5 rounded-lg border border-sky-500/40 bg-sky-950/60 hover:bg-sky-900/60 text-xs font-mono font-semibold text-sky-300 transition-colors flex items-center gap-1"
          >
            <span>Investigate</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
};
