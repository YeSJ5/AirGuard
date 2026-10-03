import React from 'react';
import type { ShapValue } from '../../types';
import { BarChart2, Activity } from '../common/Icons';

export interface SHAPEvidencePanelProps {
  shapValues?: ShapValue[] | Array<{ feature?: string; name?: string; value: number }>;
  isLoading?: boolean;
  baseValue?: number;
  className?: string;
}

export const SHAPEvidencePanel: React.FC<SHAPEvidencePanelProps> = ({
  shapValues = [],
  isLoading = false,
  baseValue,
  className = ''
}) => {
  const normalizedValues = (shapValues || []).map((v) => ({
    name: (v as any).name || (v as any).feature || 'feature',
    value: typeof v.value === 'number' ? v.value : parseFloat(v.value) || 0
  }));

  const maxVal = Math.max(0.01, ...normalizedValues.map((v) => Math.abs(v.value)));

  return (
    <div className={`p-5 rounded-2xl border border-slate-800 bg-slate-900/60 backdrop-blur-md ${className}`}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-mono uppercase tracking-wider text-slate-300 font-semibold flex items-center gap-2">
          <BarChart2 className="w-4 h-4 text-purple-400" />
          <span>SHAP Feature Attribution</span>
        </h3>
        <span className="text-[10px] text-slate-500 font-mono">TreeExplainer Attribution</span>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center p-8 text-slate-500 text-xs font-mono animate-pulse">
          Computing Shapley feature values...
        </div>
      ) : normalizedValues.length === 0 ? (
        <div className="p-6 text-center text-slate-400 text-xs rounded-xl bg-slate-950/40 border border-slate-800/80">
          <Activity className="w-6 h-6 text-slate-600 mx-auto mb-2" />
          <p>No SHAP feature attribution is available for this record.</p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-[11px] text-slate-400 leading-relaxed">
            Feature attributions returned by the configured ensemble for this detector result:
          </p>

          <div className="space-y-2 mt-3">
            {normalizedValues.map((item, idx) => {
              const isPositive = item.value > 0;
              const barWidth = Math.min(100, Math.max(5, (Math.abs(item.value) / maxVal) * 100));

              return (
                <div key={idx} className="space-y-1">
                  <div className="flex items-center justify-between text-xs font-mono">
                    <span className="text-slate-300 font-semibold truncate max-w-[200px]">
                      {item.name}
                    </span>
                    <span
                      className={`font-bold ${
                        isPositive ? 'text-red-400' : 'text-emerald-400'
                      }`}
                    >
                      {isPositive ? `+${item.value.toFixed(3)}` : item.value.toFixed(3)}
                    </span>
                  </div>

                  {/* Horizontal Bar */}
                  <div className="w-full h-2 rounded-full bg-slate-800/80 overflow-hidden flex">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        isPositive ? 'bg-red-500' : 'bg-emerald-500'
                      }`}
                      style={{ width: `${barWidth}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between text-[10px] font-mono text-slate-500">
            {typeof baseValue === 'number' && Number.isFinite(baseValue) && <span>Model baseline: {baseValue.toFixed(3)}</span>}
            <span className="text-slate-400">Attribution timing unavailable</span>
          </div>
        </div>
      )}
    </div>
  );
};
