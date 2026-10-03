import React from 'react';
import { Layers, Activity, Cpu, Radio } from '../common/Icons';

export interface DetectionPipelineTiersProps {
  ruleRisk?: number | null;
  ensembleScore?: number | null;
  autoencoderScore?: number | null;
  spatialConsistency?: number | null;
  trilaterationScore?: number;
  className?: string;
}

export const DetectionPipelineTiers: React.FC<DetectionPipelineTiersProps> = ({
  ruleRisk,
  ensembleScore,
  autoencoderScore,
  spatialConsistency,
  trilaterationScore,
  className = ''
}) => {
  const finalSpatial = trilaterationScore !== undefined ? trilaterationScore : spatialConsistency;

  const tiers = [
    {
      id: 1,
      title: 'Tier 1: Kinematic Rules',
      subtitle: 'Aerodynamic physical conservation bounds',
      icon: <Layers className="w-4 h-4 text-sky-400" />,
      score: ruleRisk,
      isTriggered: typeof ruleRisk === 'number' && ruleRisk > 0.5,
      format: (val?: number | null) => val == null ? 'NO DATA' : val > 0.5 ? 'FLAGGED' : 'NO FLAG'
    },
    {
      id: 2,
      title: 'Tier 2: Supervised Ensemble',
      subtitle: 'RF + GBDT soft voting with SHAP explainability',
      icon: <Activity className="w-4 h-4 text-purple-400" />,
      score: ensembleScore,
      isTriggered: typeof ensembleScore === 'number' && ensembleScore >= 0.5,
      format: (val?: number | null) => val == null ? 'NO DATA' : `${(val * 100).toFixed(1)}% score`
    },
    {
      id: 3,
      title: 'Tier 3: PyTorch Autoencoder',
      subtitle: 'Unsupervised deep reconstruction MSE error',
      icon: <Cpu className="w-4 h-4 text-emerald-400" />,
      score: autoencoderScore,
      isTriggered: typeof autoencoderScore === 'number' && autoencoderScore >= 0.5,
      format: (val?: number | null) => val == null ? 'NO DATA' : `${(val * 100).toFixed(1)}% anomaly score`
    },
    {
      id: 4,
      title: 'Tier 4: Multilateration Geometry',
      subtitle: 'Independent receiver evidence, when available',
      icon: <Radio className="w-4 h-4 text-cyan-400" />,
      score: finalSpatial,
      isTriggered: typeof finalSpatial === 'number' && finalSpatial < 0.7,
      format: (val?: number | null) => val == null ? 'UNAVAILABLE' : `${(val * 100).toFixed(0)}%`
    }
  ];

  return (
    <div className={`p-5 rounded-2xl border border-slate-800 bg-slate-900/60 backdrop-blur-md ${className}`}>
      <h3 className="text-sm font-mono uppercase tracking-wider text-slate-300 font-semibold mb-4 flex items-center justify-between">
        <span>Detection Evidence</span>
        <span className="text-[10px] text-slate-500 lowercase font-normal">only scores returned by the backend</span>
      </h3>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {tiers.map((tier) => (
          <div
            key={tier.id}
            className={`p-3.5 rounded-xl border transition-all ${
              tier.isTriggered
                ? 'bg-red-950/30 border-red-500/30'
                : 'bg-slate-950/40 border-slate-800/80 hover:border-slate-700'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-slate-800/70 border border-slate-700/50">
                  {tier.icon}
                </div>
                <div>
                  <h4 className="text-xs font-semibold text-slate-200">{tier.title}</h4>
                  <p className="text-[10px] text-slate-400">{tier.subtitle}</p>
                </div>
              </div>
              <span
                className={`text-xs font-mono font-bold ${
                  tier.isTriggered ? 'text-red-400' : 'text-slate-300'
                }`}
              >
                {tier.format(tier.score)}
              </span>
            </div>

            {/* Progress bar */}
            <div className="w-full h-1.5 rounded-full bg-slate-800 overflow-hidden mt-2">
              {typeof tier.score === 'number' && Number.isFinite(tier.score) && (
                <div
                  className={`h-full rounded-full transition-all duration-500 ${tier.isTriggered ? 'bg-red-500' : 'bg-cyan-500'}`}
                  style={{ width: `${Math.min(100, Math.max(0, tier.score * 100))}%` }}
                />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
