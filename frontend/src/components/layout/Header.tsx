import React from 'react';
import { useAirGuardStore } from '../../store/useAirGuardStore';
import { Badge } from '../common/Badge';
import { Radar, ShieldAlert, Activity, Settings, LogOut, Volume2, VolumeX, Radio } from '../common/Icons';

export const Header: React.FC = () => {
  const {
    currentTier,
    setCurrentTier,
    tier3Tab,
    setTier3Tab,
    websocketStatus,
    flights,
    alerts,
    soundEnabled,
    setSoundEnabled,
    currentUser,
    logout
  } = useAirGuardStore();

  const activeAlertsCount = alerts.filter((a) => !a.acknowledged).length;

  return (
    <header className="border-b border-slate-800 bg-slate-950/80 backdrop-blur-md sticky top-0 z-50 px-4 py-2.5">
      <div className="max-w-[1920px] mx-auto flex items-center justify-between gap-4">
        {/* Left: Brand Identity */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-gradient-to-tr from-sky-600 to-cyan-500 text-white shadow-lg shadow-sky-500/20">
              <Radar className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold font-mono tracking-wider text-white">
                  AIRGUARD
                </h1>
                <span className="text-[10px] font-mono font-bold px-1.5 py-0.2 rounded bg-sky-500/20 text-sky-400 border border-sky-500/30">
                  ADS-B STATION
                </span>
              </div>
              <p className="text-[10px] font-mono text-slate-400">
                Civilian Avionics Trust & Threat Detection
              </p>
            </div>
          </div>

          {/* Telemetry Status Badges */}
          <div className="hidden xl:flex items-center gap-2 pl-4 border-l border-slate-800">
            <Badge variant={websocketStatus === 'connected' ? 'success' : 'warning'} size="sm" dot>
              {websocketStatus === 'connected' ? 'WS STREAM ACTIVE' : websocketStatus.toUpperCase()}
            </Badge>

            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-900 border border-slate-800 text-[11px] font-mono text-slate-300">
              <Radio className="w-3 h-3 text-sky-400" />
              <span>{flights.length} Tracks</span>
            </div>
          </div>
        </div>

        {/* Center: Main Navigation Tiers */}
        <div className="flex items-center p-1 rounded-xl bg-slate-900 border border-slate-800">
          <button
            onClick={() => setCurrentTier('tier1_overview')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-mono font-semibold transition-all flex items-center gap-2 ${
              currentTier === 'tier1_overview'
                ? 'bg-sky-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Radar className="w-3.5 h-3.5" />
            <span>Tactical Radar</span>
          </button>

          <button
            onClick={() => setCurrentTier('tier2_investigation')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-mono font-semibold transition-all flex items-center gap-2 ${
              currentTier === 'tier2_investigation'
                ? 'bg-sky-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            <span>Forensic Investigation</span>
          </button>

          <button
            onClick={() => {
              setCurrentTier('tier3_tools');
              setTier3Tab('threats');
            }}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-mono font-semibold transition-all flex items-center gap-2 relative ${
              currentTier === 'tier3_tools'
                ? 'bg-sky-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <ShieldAlert className="w-3.5 h-3.5" />
            <span>Threat Center</span>
            {activeAlertsCount > 0 && (
              <span className="h-2 w-2 rounded-full bg-red-500 animate-ping absolute top-1 right-1" />
            )}
          </button>

          <button
            onClick={() => {
              setCurrentTier('tier3_tools');
              setTier3Tab('config');
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-semibold transition-all flex items-center gap-1.5 ${
              currentTier === 'tier3_tools' && tier3Tab === 'config'
                ? 'bg-sky-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Settings className="w-3.5 h-3.5" />
            <span>Tools & Config</span>
          </button>
        </div>

        {/* Right: Controls & User Clearance */}
        <div className="flex items-center gap-3">
          {/* Sound Toggle */}
          <button
            onClick={() => setSoundEnabled(!soundEnabled)}
            className={`p-2 rounded-xl border transition-colors ${
              soundEnabled
                ? 'bg-sky-950/60 border-sky-500/40 text-sky-400'
                : 'bg-slate-900 border-slate-800 text-slate-500 hover:text-slate-300'
            }`}
            title={soundEnabled ? 'Mute Radar Audio' : 'Enable Radar Sound'}
          >
            {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
          </button>

          {/* User Account / Clearance Badge */}
          <div className="flex items-center gap-2 pl-3 border-l border-slate-800">
            <div className="text-right hidden sm:block">
              <span className="text-xs font-mono font-bold text-white block">
                {currentUser?.email?.split('@')[0] || 'Operator'}
              </span>
              <span className="text-[10px] font-mono text-sky-400 uppercase">
                {currentUser?.role || 'analyst'} Clearance
              </span>
            </div>

            <button
              onClick={logout}
              className="p-2 rounded-xl border border-slate-800 bg-slate-900 text-slate-400 hover:text-red-400 hover:border-red-500/30 transition-colors"
              title="Sign Out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};
