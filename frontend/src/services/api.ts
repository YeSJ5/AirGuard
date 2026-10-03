import type { Flight, AlertLog, HealthStats, ModelRunStats, User, AuditLog, RuleConfigState, AircraftTrustHistory } from '../types';

const BACKEND_PORT = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_BACKEND_PORT) || '8001';
const HOSTNAME = typeof window !== 'undefined' && window.location?.hostname
  ? (window.location.hostname === 'localhost' ? '127.0.0.1' : window.location.hostname)
  : '127.0.0.1';
export const API_BASE = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_URL) || `http://${HOSTNAME}:${BACKEND_PORT}`;
export const WS_BASE = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_WS_URL) || `ws://${HOSTNAME}:${BACKEND_PORT}`;

export const getAuthToken = (): string | null => {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('airguard_token');
};

export const fetchWithAuth = async (url: string, options: RequestInit = {}): Promise<Response> => {
  const token = getAuthToken();
  const headers = new Headers(options.headers || {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(url, { ...options, headers });
};

// --- API Service Methods ---

export const fetchAircraft = async (limit?: number): Promise<Flight[]> => {
  const url = limit ? `${API_BASE}/api/v1/aircraft?limit=${limit}` : `${API_BASE}/api/v1/aircraft`;
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error(`Failed to fetch aircraft: ${res.statusText}`);
  return res.json();
};

export const fetchAircraftDetail = async (icao24: string): Promise<any> => {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/aircraft/${icao24}/detail`);
  if (!res.ok) throw new Error(`Failed to fetch detail for ${icao24}: ${res.statusText}`);
  return res.json();
};

export const fetchAircraftTrustHistory = async (icao24: string, window = 10): Promise<AircraftTrustHistory> => {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/aircraft/${icao24}/trust-history?window=${window}`);
  if (!res.ok) throw new Error(`Failed to fetch trust history for ${icao24}: ${res.statusText}`);
  return res.json();
};

export const fetchAlerts = async (limit = 100): Promise<AlertLog[]> => {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/alerts?limit=${limit}`);
  if (!res.ok) throw new Error(`Failed to fetch alerts: ${res.statusText}`);
  return res.json();
};

export const acknowledgeAlert = async (id: string | number): Promise<any> => {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/alerts/${id}/acknowledge`, {
    method: 'POST'
  });
  if (!res.ok) throw new Error(`Failed to acknowledge alert ${id}: ${res.statusText}`);
  return res.json();
};

export const fetchSystemHealth = async (strict = false): Promise<HealthStats> => {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/system-health${strict ? '?strict=true' : ''}`);
  if (!res.ok) throw new Error(`System health failed: ${res.statusText}`);
  return res.json();
};

export const fetchConfig = async (): Promise<RuleConfigState> => {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/config`);
  if (!res.ok) throw new Error(`Failed to fetch config: ${res.statusText}`);
  return res.json();
};

export const updateConfig = async (payload: RuleConfigState): Promise<RuleConfigState> => {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`Failed to update config: ${res.statusText}`);
  return res.json();
};

export const replaySessionValidation = async (): Promise<ModelRunStats> => {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/model-runs/replay`, {
    method: 'POST'
  });
  if (!res.ok) throw new Error(`Failed to execute replay: ${res.statusText}`);
  return res.json();
};

export const fetchModelRuns = async (limit = 50): Promise<ModelRunStats[]> => {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/model-runs?limit=${limit}`);
  if (!res.ok) throw new Error(`Failed to fetch model runs: ${res.statusText}`);
  return res.json();
};

export const fetchAuditLogs = async (action?: string, limit = 100): Promise<AuditLog[]> => {
  const url = action 
    ? `${API_BASE}/api/v1/admin/audit-logs?action=${action}&limit=${limit}` 
    : `${API_BASE}/api/v1/admin/audit-logs?limit=${limit}`;
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error(`Failed to fetch audit logs: ${res.statusText}`);
  return res.json();
};

export const fetchAdminUsers = async (): Promise<User[]> => {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/users`);
  if (!res.ok) throw new Error(`Failed to fetch users: ${res.statusText}`);
  return res.json();
};

export const createAdminUser = async (user: Partial<User> & { password?: string }): Promise<User> => {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(user)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || 'Failed to create user');
  }
  return res.json();
};

export const deleteAdminUser = async (id: number): Promise<any> => {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/users/${id}`, {
    method: 'DELETE'
  });
  if (!res.ok) throw new Error(`Failed to delete user: ${res.statusText}`);
  return res.json();
};
