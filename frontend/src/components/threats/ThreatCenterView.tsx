import React, { useState } from 'react';
import { useAirGuardStore } from '../../store/useAirGuardStore';
import type { AlertLog } from '../../types';
import { ThreatCard } from './ThreatCard';
import { EmptyState } from '../common/EmptyState';
import { ShieldAlert, ShieldCheck } from '../common/Icons';
import { acknowledgeAlert } from '../../services/api';

export const ThreatCenterView: React.FC = () => {
  const { alerts, setSelectedFlightId, setCurrentTier, acknowledgeAlert: acknowledgeInStore } = useAirGuardStore();
  const [filterMode, setFilterMode] = useState<'all' | 'unacknowledged' | 'acknowledged'>('all');

  const unacknowledgedCount = alerts.filter((a: AlertLog) => !a.acknowledged).length;
  const acknowledgedCount = alerts.filter((a: AlertLog) => a.acknowledged).length;

  const filteredAlerts = alerts.filter((a: AlertLog) => {
    if (filterMode === 'unacknowledged') return !a.acknowledged;
    if (filterMode === 'acknowledged') return a.acknowledged;
    return true;
  });

  const handleAcknowledge = async (id: string) => {
    try {
      await acknowledgeAlert(id);
      acknowledgeInStore(id);
    } catch (err) {
      console.error('Failed to acknowledge alert:', err);
      // Optimistic update in store
      acknowledgeInStore(id);
    }
  };

  const handleInvestigate = (icao24: string) => {
    setSelectedFlightId(icao24);
    setCurrentTier('tier2_investigation');
  };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="p-6 rounded-2xl border border-red-500/30 bg-gradient-to-r from-red-950/40 via-slate-900/60 to-slate-900/60 backdrop-blur-md flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="p-3.5 rounded-xl bg-red-900/50 border border-red-500/40 text-red-400">
            <ShieldAlert className="w-8 h-8" />
          </div>
          <div>
            <h2 className="text-xl font-bold font-mono text-white flex items-center gap-3">
              <span>Cyber-Physical Threat Center</span>
              {unacknowledgedCount > 0 && (
                <span className="px-2.5 py-0.5 rounded-full bg-red-600 text-white text-xs font-mono font-bold animate-pulse">
                  {unacknowledgedCount} ACTIVE
                </span>
              )}
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Live threat matrix logging transponder spoofing, velocity jumps, climb rate violations, and GPS interference.
            </p>
          </div>
        </div>

        {/* Filter Switcher */}
        <div className="flex items-center gap-1.5 p-1 rounded-xl bg-slate-950/80 border border-slate-800">
          <button
            onClick={() => setFilterMode('all')}
            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-semibold transition-colors ${
              filterMode === 'all'
                ? 'bg-sky-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            All ({alerts.length})
          </button>
          <button
            onClick={() => setFilterMode('unacknowledged')}
            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-semibold transition-colors ${
              filterMode === 'unacknowledged'
                ? 'bg-red-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Active ({unacknowledgedCount})
          </button>
          <button
            onClick={() => setFilterMode('acknowledged')}
            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-semibold transition-colors ${
              filterMode === 'acknowledged'
                ? 'bg-emerald-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Archived ({acknowledgedCount})
          </button>
        </div>
      </div>

      {/* Threat List */}
      <div className="space-y-3">
        {filteredAlerts.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck className="w-10 h-10 text-emerald-400" />}
            title={
              filterMode === 'unacknowledged'
                ? 'No Active Unacknowledged Threats'
                : 'No Security Alerts Logged in Active Session'
            }
            description="AirGuard is actively evaluating live transponder signals across the monitored sector. When cyber-physical anomalies occur, they will register here."
            className="py-16"
          />
        ) : (
          filteredAlerts.map((alert: AlertLog) => (
            <ThreatCard
              key={alert.id}
              alert={alert}
              onAcknowledge={handleAcknowledge}
              onSelect={handleInvestigate}
            />
          ))
        )}
      </div>
    </div>
  );
};
