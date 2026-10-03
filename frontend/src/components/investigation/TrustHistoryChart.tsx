import React from 'react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import type { TrustHistoryPoint } from '../../types';
import { Badge } from '../common/Badge';
import { Activity } from '../common/Icons';

export interface TrustHistoryChartProps {
  history?: TrustHistoryPoint[] | any[];
  aircraftCallsign?: string;
  currentTrust?: number;
  pattern?: 'STABLE' | 'GRADUAL_DECLINE' | 'SUDDEN_DROP' | string;
  className?: string;
}

export const TrustHistoryChart: React.FC<TrustHistoryChartProps> = ({
  history = [],
  aircraftCallsign,
  currentTrust,
  pattern = 'UNASSESSED',
  className = ''
}) => {
  const chartData = (history || []).map((pt: any, idx: number) => ({
    step: idx + 1,
    time: pt.timestamp ? new Date(pt.timestamp).toLocaleTimeString() : `T-${history.length - idx}`,
    trust: pt.trust_score !== undefined ? pt.trust_score : typeof pt.trust === 'number' ? pt.trust : null,
    risk: pt.instantaneous_risk !== undefined ? (pt.instantaneous_risk * 100) : null,
    isAlert: !!pt.is_alert
  }));

  const latestTrust = typeof currentTrust === 'number' && Number.isFinite(currentTrust)
    ? currentTrust 
    : chartData.length > 0 
      ? chartData[chartData.length - 1].trust 
      : null;

  return (
    <div className={`p-5 rounded-2xl border border-slate-800 bg-slate-900/60 backdrop-blur-md ${className}`}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-mono uppercase tracking-wider text-slate-300 font-semibold flex items-center gap-2">
            <Activity className="w-4 h-4 text-emerald-400" />
            <span>Detector Score History</span>
          </h3>
          <p className="text-[10px] text-slate-500 font-mono">
            {aircraftCallsign ? `${aircraftCallsign} • ` : ''}10-state weighted rolling average (WMA)
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Badge
            variant={
              pattern === 'SUDDEN_DROP'
                ? 'critical'
                : pattern === 'GRADUAL_DECLINE'
                ? 'warning'
              : pattern === 'UNASSESSED' ? 'neutral' : 'info'
            }
            size="sm"
          >
            {pattern}
          </Badge>
          <span className="text-lg font-bold font-mono text-white">{typeof latestTrust === 'number' && Number.isFinite(latestTrust) ? `${latestTrust}%` : '—'}</span>
        </div>
      </div>

      {chartData.length === 0 ? (
        <div className="p-8 text-center text-slate-500 text-xs font-mono">
          No persisted detector-score history is available for this aircraft.
        </div>
      ) : (
        <div className="h-44 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="trustGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0.0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="time" stroke="#64748b" fontSize={10} tickLine={false} />
              <YAxis domain={[0, 100]} stroke="#64748b" fontSize={10} tickLine={false} />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#0f172a',
                  borderColor: '#334155',
                  borderRadius: '0.5rem',
                  fontSize: '11px',
                  color: '#f8fafc'
                }}
              />
              <Area
                type="monotone"
                dataKey="trust"
                stroke="#10b981"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#trustGradient)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="mt-3 pt-2 border-t border-slate-800/80 flex items-center justify-between text-[10px] font-mono text-slate-500">
        <span>{pattern === 'SUDDEN_DROP' ? 'Score change: sharp drop' : pattern === 'GRADUAL_DECLINE' ? 'Score change: gradual decline' : pattern === 'UNASSESSED' ? 'Pattern: insufficient scored history' : 'Pattern: no significant score change'}</span>
        <span>Window: 10 states</span>
      </div>
    </div>
  );
};
