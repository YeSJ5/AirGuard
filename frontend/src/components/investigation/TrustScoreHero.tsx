import React from 'react';
import { Badge } from '../common/Badge';
import { ShieldCheck, ShieldAlert, AlertTriangle } from '../common/Icons';

export interface TrustScoreHeroProps {
  score?: number;
  trustScore?: number;
  risk?: number;
  riskScore?: number;
  status?: 'normal' | 'suspicious' | 'critical' | string;
  anomalyType?: string | null;
  isSimulated?: boolean;
  callsign?: string;
  className?: string;
}

export const TrustScoreHero: React.FC<TrustScoreHeroProps> = ({
  score,
  trustScore,
  risk,
  riskScore,
  status = 'normal',
  anomalyType,
  isSimulated = false,
  callsign,
  className = ''
}) => {
  const finalScore = score !== undefined ? score : trustScore;
  const hasScore = typeof finalScore === 'number' && Number.isFinite(finalScore);
  const finalRisk = risk !== undefined ? risk : riskScore !== undefined ? riskScore : (hasScore ? (100 - finalScore) / 100 : undefined);

  const isCritical = status === 'critical' || finalScore < 40;
  const isSuspicious = status === 'suspicious' || (finalScore >= 40 && finalScore < 70);

  const getStatusColor = () => {
    if (isCritical) return 'text-red-400 border-red-500/30 bg-red-950/40';
    if (isSuspicious) return 'text-amber-400 border-amber-500/30 bg-amber-950/40';
    return 'text-slate-300 border-slate-700 bg-slate-950/60';
  };

  const getBadgeVariant = () => {
    if (isCritical) return 'critical';
    if (isSuspicious) return 'warning';
    return 'neutral';
  };

  return (
    <div
      className={`p-6 rounded-2xl border ${getStatusColor()} backdrop-blur-md relative overflow-hidden transition-all duration-300 ${className}`}
    >
      {/* Background glow */}
      <div
        className={`absolute -right-12 -top-12 w-48 h-48 rounded-full blur-3xl pointer-events-none opacity-20 ${
          isCritical ? 'bg-red-500' : isSuspicious ? 'bg-amber-500' : 'bg-emerald-500'
        }`}
      />

      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 relative z-10">
        <div className="flex items-center gap-4">
          <div
            className={`p-4 rounded-xl border flex items-center justify-center ${
              isCritical
                ? 'bg-red-900/50 border-red-500/40 text-red-400'
                : isSuspicious
                ? 'bg-amber-900/50 border-amber-500/40 text-amber-400'
                : 'bg-emerald-900/50 border-emerald-500/40 text-emerald-400'
            }`}
          >
            {isCritical ? (
              <ShieldAlert className="w-8 h-8" />
            ) : isSuspicious ? (
              <AlertTriangle className="w-8 h-8" />
            ) : (
              <ShieldCheck className="w-8 h-8" />
            )}
          </div>
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-mono tracking-widest text-slate-400 uppercase">
                AirGuard Detector Assessment
              </span>
              {isSimulated && (
                <Badge variant="simulated" size="sm">
                  DEMONSTRATION DATA
                </Badge>
              )}
            </div>
            <h2 className="text-2xl font-bold font-mono tracking-tight text-white flex items-center gap-2">
              {callsign ? `${callsign} — ` : ''}
              {hasScore ? `${finalScore}%` : 'NOT ASSESSED'}
              {typeof finalRisk === 'number' && Number.isFinite(finalRisk) && (
                <span className="text-sm font-normal text-slate-400">(Detector score: {(finalRisk * 100).toFixed(1)}%)</span>
              )}
            </h2>
          </div>
        </div>

        <div className="flex flex-col items-start sm:items-end gap-1.5">
          <Badge variant={getBadgeVariant()} size="md" dot>
            {isCritical
              ? 'CRITICAL ANOMALY'
              : isSuspicious
              ? 'SUSPICIOUS SIGNAL'
              : 'NO ACTIVE REVIEW FLAG'}
          </Badge>
          {anomalyType && (
            <span className="text-xs font-mono text-red-300 max-w-xs text-left sm:text-right">
              {anomalyType}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
