import React, { useEffect, useState } from 'react';
import { useAirGuardStore } from '../../store/useAirGuardStore';
import type { Flight, AlertLog } from '../../types';
import { fetchAircraftDetail, fetchAircraftTrustHistory } from '../../services/api';
import { EmptyState } from '../common/EmptyState';
import { Badge } from '../common/Badge';
import { TrustScoreHero } from './TrustScoreHero';
import { AircraftIdentityCard } from './AircraftIdentityCard';
import { DetectionPipelineTiers } from './DetectionPipelineTiers';
import { EvidenceChecklist } from './EvidenceChecklist';
import { SHAPEvidencePanel } from './SHAPEvidencePanel';
import { TrustHistoryChart } from './TrustHistoryChart';
import { Shield, Plane, Search, ChevronRight } from '../common/Icons';

export const InvestigationView: React.FC = () => {
  const { flights, selectedFlightId, setSelectedFlightId, alerts } = useAirGuardStore();
  const [detailData, setDetailData] = useState<any | null>(null);
  const [trustHistory, setTrustHistory] = useState<any | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');

  const selectedFlight = flights.find((f: Flight) => f.id === selectedFlightId);

  useEffect(() => {
    if (!selectedFlightId) {
      setDetailData(null);
      setTrustHistory(null);
      return;
    }

    const loadDetail = async () => {
      setIsLoading(true);
      try {
        const [detail, history] = await Promise.allSettled([
          fetchAircraftDetail(selectedFlightId),
          fetchAircraftTrustHistory(selectedFlightId)
        ]);

        if (detail.status === 'fulfilled') setDetailData(detail.value);
        if (history.status === 'fulfilled') setTrustHistory(history.value);
      } catch (err) {
        console.error('Failed to load investigation detail:', err);
      } finally {
        setIsLoading(false);
      }
    };

    loadDetail();
  }, [selectedFlightId]);

  const matchedAlert = alerts.find(
    (a: AlertLog) => a.icao24.toLowerCase() === selectedFlightId?.toLowerCase()
  );

  const filteredFlights = flights.filter((f: Flight) => {
    const query = searchQuery.toLowerCase().trim();
    if (!query) return true;
    return (
      f.id.toLowerCase().includes(query) ||
      f.callsign.toLowerCase().includes(query) ||
      (f.operator && f.operator.toLowerCase().includes(query))
    );
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-[750px]">
      {/* Sidebar: Target Selection */}
      <div className="lg:col-span-4 space-y-4">
        <div className="p-4 rounded-2xl border border-slate-800 bg-slate-900/60 backdrop-blur-md">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-mono uppercase tracking-wider text-slate-300 font-semibold flex items-center gap-2">
              <Shield className="w-4 h-4 text-sky-400" />
              <span>Investigation Targets</span>
            </h3>
            <span className="text-xs font-mono text-slate-500">{filteredFlights.length} Airframes</span>
          </div>

          <div className="relative mb-3">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search ICAO, Callsign, Operator..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 text-xs font-mono rounded-xl bg-slate-950/80 border border-slate-800 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-sky-500 transition-colors"
            />
          </div>

          <div className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
            {filteredFlights.length === 0 ? (
              <div className="p-6 text-center text-slate-500 text-xs font-mono">
                No aircraft matched query.
              </div>
            ) : (
              filteredFlights.map((f: Flight) => {
                const isSelected = f.id === selectedFlightId;
                const hasScore = Number.isFinite(f.trustScore) && !f.is_synthetic;
                const isCritical = f.status === 'critical' || (hasScore && f.trustScore < 40);
                const isSuspicious = f.status === 'suspicious' || (hasScore && f.trustScore >= 40 && f.trustScore < 70);

                return (
                  <button
                    key={f.id}
                    onClick={() => setSelectedFlightId(f.id)}
                    className={`w-full p-3 rounded-xl border text-left transition-all flex items-center justify-between ${
                      isSelected
                        ? 'bg-sky-950/50 border-sky-500/60 shadow-lg shadow-sky-950/30'
                        : 'bg-slate-950/40 border-slate-800/80 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`p-2 rounded-lg border ${
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
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono font-bold text-white">
                            {f.callsign || f.id.toUpperCase()}
                          </span>
                          <span className="text-[10px] font-mono text-slate-500">
                            {f.id.toUpperCase()}
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-400 truncate max-w-[140px]">
                          {f.operator || 'Operator unavailable'}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Badge
                        variant={isCritical ? 'critical' : isSuspicious ? 'warning' : hasScore ? 'info' : 'neutral'}
                        size="sm"
                      >
                        {f.is_synthetic ? 'DEMO' : hasScore ? `${f.trustScore}% SCORE` : '—'}
                      </Badge>
                      <ChevronRight className="w-4 h-4 text-slate-600" />
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Main Investigation Canvas */}
      <div className="lg:col-span-8 space-y-5">
        {!selectedFlight ? (
          <EmptyState
            icon={<Plane className="w-10 h-10" />}
            title="No aircraft selected"
            description="Select a track to review its source, route context, and the detector evidence available for it."
            className="h-full min-h-[500px]"
          />
        ) : (
          <>
            {/* Top Trust Score Hero */}
            <TrustScoreHero
              score={selectedFlight.trustScore}
              risk={selectedFlight.combined_risk_score}
              status={selectedFlight.status}
              anomalyType={matchedAlert?.type || detailData?.trust_status?.explanation}
              isSimulated={selectedFlight.is_synthetic}
              callsign={selectedFlight.callsign}
            />

            {/* Aircraft Identity & Route Progression */}
            <AircraftIdentityCard flight={selectedFlight} identity={detailData?.identity} />

            {/* 4-Tier Detection Pipeline Breakdown */}
            <DetectionPipelineTiers
              ruleRisk={detailData?.trust_status?.technical_details?.rule_risk}
              ensembleScore={detailData?.trust_status?.technical_details?.ensemble_score}
              autoencoderScore={detailData?.trust_status?.technical_details?.autoencoder_score}
              spatialConsistency={detailData?.trust_status?.technical_details?.receiver_consistency_score}
            />

            {/* Evidence Checklist & SHAP Breakdown */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <EvidenceChecklist
                flight={selectedFlight}
                triggers={detailData?.trust_status?.rule_flags || selectedFlight.ruleFlags}
              />
              <SHAPEvidencePanel
                shapValues={
                  detailData?.trust_status?.technical_details?.shap?.top_features ||
                  selectedFlight.shapValues ||
                  []
                }
                isLoading={isLoading}
              />
            </div>

            {/* Historical Trust Graph */}
            <TrustHistoryChart
              history={trustHistory?.history || []}
              aircraftCallsign={selectedFlight.callsign}
              currentTrust={trustHistory?.current_trust_score ?? undefined}
              pattern={trustHistory?.pattern || 'UNASSESSED'}
            />
          </>
        )}
      </div>
    </div>
  );
};
