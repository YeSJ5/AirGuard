import React from 'react';
import type { Flight, RuleFlags } from '../../types';
import { CheckCircle2, XCircle } from '../common/Icons';

export interface EvidenceChecklistProps {
  flight?: Flight;
  triggers?: RuleFlags;
  ruleFlags?: RuleFlags;
  className?: string;
}

export const EvidenceChecklist: React.FC<EvidenceChecklistProps> = ({
  flight,
  triggers,
  ruleFlags,
  className = ''
}) => {
  const flags: RuleFlags = triggers || ruleFlags || flight?.ruleFlags || {};

  const rules = [
    {
      key: 'positionJump',
      title: 'Implied Speed Boundary',
      desc: 'Checks if distance delta exceeds Mach 1 (>1200 km/h)',
      isViolated: flags.positionJump === true,
      isAssessed: typeof flags.positionJump === 'boolean'
    },
    {
      key: 'duplicateIcao',
      title: 'ICAO Address Collision',
      desc: 'Detects cloned transmitters (>50 km apart in same second)',
      isViolated: flags.duplicateIcao === true,
      isAssessed: typeof flags.duplicateIcao === 'boolean'
    },
    {
      key: 'climbRate',
      title: 'Vertical Envelope Ceiling',
      desc: 'Checks if climb/dive rate exceeds ±50 m/s (~9842 ft/min)',
      isViolated: flags.climbRate === true,
      isAssessed: typeof flags.climbRate === 'boolean'
    },
    {
      key: 'altVelMismatch',
      title: 'Altitude-Velocity Coherence',
      desc: 'Flags ground status at cruise speeds or 0m altitude airborne',
      isViolated: flags.altVelMismatch === true,
      isAssessed: typeof flags.altVelMismatch === 'boolean'
    },
    {
      key: 'lowSignalConfidence',
      title: 'Navigation Integrity (NIC)',
      desc: 'Checks reported NIC (<7) together with a position jump (>10 km)',
      isViolated: flags.lowSignalConfidence === true,
      isAssessed: typeof flags.lowSignalConfidence === 'boolean'
    }
  ];

  return (
    <div className={`p-5 rounded-2xl border border-slate-800 bg-slate-900/60 backdrop-blur-md ${className}`}>
      <h3 className="text-sm font-mono uppercase tracking-wider text-slate-300 font-semibold mb-4 flex items-center justify-between">
        <span>Configured Rule Checks</span>
        <span className="text-[10px] text-slate-500 lowercase font-normal">evidence reported by the detector</span>
      </h3>

      <div className="space-y-2.5">
        {rules.map((r) => (
          <div
            key={r.key}
            className={`p-3 rounded-xl border flex items-center justify-between gap-3 transition-all ${
              r.isViolated
                ? 'bg-red-950/40 border-red-500/40 text-red-300'
                : 'bg-slate-950/40 border-slate-800/80 text-slate-400'
            }`}
          >
            <div className="flex items-center gap-3">
              {r.isViolated ? (
                <XCircle className="w-5 h-5 text-red-400 shrink-0" />
              ) : (
                <CheckCircle2 className={`w-5 h-5 shrink-0 ${r.isAssessed ? 'text-slate-400' : 'text-slate-600'}`} />
              )}
              <div>
                <h4
                  className={`text-xs font-semibold ${
                    r.isViolated ? 'text-red-200' : 'text-slate-200'
                  }`}
                >
                  {r.title}
                </h4>
                <p className="text-[10px] text-slate-400">{r.desc}</p>
              </div>
            </div>

            <div className="shrink-0">
              {r.isViolated ? (
                <span className="text-[10px] font-mono font-bold text-red-400 px-2 py-0.5 rounded bg-red-900/50 border border-red-500/30">
                  FLAGGED
                </span>
              ) : (
                <span className="text-[10px] font-mono text-slate-400 px-2 py-0.5 rounded bg-slate-900 border border-slate-700">
                  {r.isAssessed ? 'NO FLAG' : 'NOT ASSESSED'}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
