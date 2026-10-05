export interface AirlineInfo {
  name: string;
  code: string;
  iata: string;
  color: string;
  country?: string;
  callsignName?: string;
}

export const AIRLINE_DIRECTORY: Record<string, AirlineInfo> = {
  // Indian Subcontinent & Regional Carriers
  IGO: { name: 'IndiGo', code: 'IGO', iata: '6E', color: '#004b93', country: 'India', callsignName: 'IFLY' },
  AIC: { name: 'Air India', code: 'AIC', iata: 'AI', color: '#e21836', country: 'India', callsignName: 'AIRINDIA' },
  SEJ: { name: 'SpiceJet', code: 'SEJ', iata: 'SG', color: '#e03a27', country: 'India', callsignName: 'SPICEJET' },
  VTI: { name: 'Vistara', code: 'VTI', iata: 'UK', color: '#53234d', country: 'India', callsignName: 'VISTARA' },
  AKJ: { name: 'Akasa Air', code: 'AKJ', iata: 'QP', color: '#ff6600', country: 'India', callsignName: 'AKASA AIR' },
  AXB: { name: 'Air India Express', code: 'AXB', iata: 'IX', color: '#d91d2a', country: 'India', callsignName: 'EXPRESS INDIA' },
  LLR: { name: 'Alliance Air', code: 'LLR', iata: '9I', color: '#003366', country: 'India', callsignName: 'ALLIED' },
  BDA: { name: 'Blue Dart Aviation', code: 'BDA', iata: 'BZ', color: '#002b66', country: 'India', callsignName: 'BLUE DART' },
  GOW: { name: 'Go First', code: 'GOW', iata: 'G8', color: '#005baa', country: 'India', callsignName: 'GOAIR' },
  FLY: { name: 'Fly91', code: 'FLY', iata: 'IC', color: '#0ea5e9', country: 'India', callsignName: 'GOA AIR' },
  IAD: { name: 'AIX Connect', code: 'IAD', iata: 'I5', color: '#dc2626', country: 'India', callsignName: 'RED KNIGHT' },
  ALK: { name: 'SriLankan Airlines', code: 'ALK', iata: 'UL', color: '#008542', country: 'Sri Lanka', callsignName: 'SRILANKAN' },
  BBC: { name: 'Biman Bangladesh', code: 'BBC', iata: 'BG', color: '#006a4e', country: 'Bangladesh', callsignName: 'BANGLADESH' },
  UBG: { name: 'US-Bangla Airlines', code: 'UBG', iata: 'BS', color: '#0284c7', country: 'Bangladesh', callsignName: 'BANGLA STAR' },
  PIA: { name: 'Pakistan International', code: 'PIA', iata: 'PK', color: '#004225', country: 'Pakistan', callsignName: 'PAKISTAN' },
  RNA: { name: 'Nepal Airlines', code: 'RNA', iata: 'RA', color: '#dc2626', country: 'Nepal', callsignName: 'ROYAL NEPAL' },
  DRK: { name: 'Drukair (Royal Bhutan)', code: 'DRK', iata: 'KB', color: '#f59e0b', country: 'Bhutan', callsignName: 'ROYAL BHUTAN' },

  // Middle East & Gulf Carriers
  UAE: { name: 'Emirates', code: 'UAE', iata: 'EK', color: '#d71921', country: 'UAE', callsignName: 'EMIRATES' },
  ETD: { name: 'Etihad Airways', code: 'ETD', iata: 'EY', color: '#bd9b60', country: 'UAE', callsignName: 'ETIHAD' },
  QTR: { name: 'Qatar Airways', code: 'QTR', iata: 'QR', color: '#5c0632', country: 'Qatar', callsignName: 'QATARI' },
  FDB: { name: 'Flydubai', code: 'FDB', iata: 'FZ', color: '#0080c6', country: 'UAE', callsignName: 'SKYDUBAI' },
  ABY: { name: 'Air Arabia', code: 'ABY', iata: 'G9', color: '#d71921', country: 'UAE', callsignName: 'ARABIA' },
  GFA: { name: 'Gulf Air', code: 'GFA', iata: 'GF', color: '#bd9b60', country: 'Bahrain', callsignName: 'GULF AIR' },
  OMA: { name: 'Oman Air', code: 'OMA', iata: 'WY', color: '#007a87', country: 'Oman', callsignName: 'OMAN AIR' },
  KAC: { name: 'Kuwait Airways', code: 'KAC', iata: 'KU', color: '#00205b', country: 'Kuwait', callsignName: 'KUWAITI' },
  JZR: { name: 'Jazeera Airways', code: 'JZR', iata: 'J9', color: '#0099cc', country: 'Kuwait', callsignName: 'JAZEERA' },
  SVA: { name: 'Saudia', code: 'SVA', iata: 'SV', color: '#006633', country: 'Saudi Arabia', callsignName: 'SAUDIA' },
  FAS: { name: 'Flyadeal', code: 'FAS', iata: 'F3', color: '#84cc16', country: 'Saudi Arabia', callsignName: 'ADEAL' },
  KNE: { name: 'Flynas', code: 'KNE', iata: 'XY', color: '#06b6d4', country: 'Saudi Arabia', callsignName: 'NAS EXPRESS' },
  RJA: { name: 'Royal Jordanian', code: 'RJA', iata: 'RJ', color: '#8a1538', country: 'Jordan', callsignName: 'JORDANIAN' },
  MSR: { name: 'EgyptAir', code: 'MSR', iata: 'MS', color: '#002b66', country: 'Egypt', callsignName: 'EGYPTAIR' },
  MEA: { name: 'Middle East Airlines', code: 'MEA', iata: 'ME', color: '#e11d48', country: 'Lebanon', callsignName: 'CEDAR JET' },
  IRA: { name: 'Iran Air', code: 'IRA', iata: 'IR', color: '#0284c7', country: 'Iran', callsignName: 'IRANAIR' },
  MHD: { name: 'Mahan Air', code: 'MHD', iata: 'W5', color: '#16a34a', country: 'Iran', callsignName: 'MAHAN AIR' },
  IAW: { name: 'Iraqi Airways', code: 'IAW', iata: 'IA', color: '#15803d', country: 'Iraq', callsignName: 'IRAQI' },

  // Southeast & East Asia Carriers
  SIA: { name: 'Singapore Airlines', code: 'SIA', iata: 'SQ', color: '#f5a623', country: 'Singapore', callsignName: 'SINGAPORE' },
  TGW: { name: 'Scoot', code: 'TGW', iata: 'TR', color: '#fbbf24', country: 'Singapore', callsignName: 'SCOOTER' },
  THA: { name: 'Thai Airways', code: 'THA', iata: 'TG', color: '#4f2d7f', country: 'Thailand', callsignName: 'THAI' },
  AIQ: { name: 'Thai AirAsia', code: 'AIQ', iata: 'FD', color: '#e11d48', country: 'Thailand', callsignName: 'THAI ASIA' },
  BKP: { name: 'Bangkok Airways', code: 'BKP', iata: 'PG', color: '#0284c7', country: 'Thailand', callsignName: 'BANGKOK AIR' },
  MAS: { name: 'Malaysia Airlines', code: 'MAS', iata: 'MH', color: '#003b80', country: 'Malaysia', callsignName: 'MALAYSIAN' },
  AXM: { name: 'AirAsia', code: 'AXM', iata: 'AK', color: '#e11d48', country: 'Malaysia', callsignName: 'ASIAN EXPRESS' },
  MXD: { name: 'Batik Air Malaysia', code: 'MXD', iata: 'OD', color: '#9333ea', country: 'Malaysia', callsignName: 'MALINDO' },
  GIA: { name: 'Garuda Indonesia', code: 'GIA', iata: 'GA', color: '#007a87', country: 'Indonesia', callsignName: 'INDONESIA' },
  LNI: { name: 'Lion Air', code: 'LNI', iata: 'JT', color: '#dc2626', country: 'Indonesia', callsignName: 'LION INTER' },
  BTK: { name: 'Batik Air', code: 'BTK', iata: 'ID', color: '#7e22ce', country: 'Indonesia', callsignName: 'BATIK' },
  CPA: { name: 'Cathay Pacific', code: 'CPA', iata: 'CX', color: '#006564', country: 'Hong Kong', callsignName: 'CATHAY' },
  HKE: { name: 'HK Express', code: 'HKE', iata: 'UO', color: '#9333ea', country: 'Hong Kong', callsignName: 'HONGKONG SHUTTLE' },
  CRK: { name: 'Hong Kong Airlines', code: 'CRK', iata: 'HX', color: '#dc2626', country: 'Hong Kong', callsignName: 'BAUHINIA' },
  ANA: { name: 'All Nippon Airways', code: 'ANA', iata: 'NH', color: '#00205b', country: 'Japan', callsignName: 'ALL NIPPON' },
  JAL: { name: 'Japan Airlines', code: 'JAL', iata: 'JL', color: '#cc0000', country: 'Japan', callsignName: 'JAPANAIR' },
  KAL: { name: 'Korean Air', code: 'KAL', iata: 'KE', color: '#0062a9', country: 'South Korea', callsignName: 'KOREANAIR' },
  AAR: { name: 'Asiana Airlines', code: 'AAR', iata: 'OZ', color: '#d71921', country: 'South Korea', callsignName: 'ASIANA' },
  CCA: { name: 'Air China', code: 'CCA', iata: 'CA', color: '#d81e05', country: 'China', callsignName: 'AIR CHINA' },
  CES: { name: 'China Eastern', code: 'CES', iata: 'MU', color: '#1e3888', country: 'China', callsignName: 'CHINA EASTERN' },
  CSN: { name: 'China Southern', code: 'CSN', iata: 'CZ', color: '#003b7a', country: 'China', callsignName: 'CHINA SOUTHERN' },
  CHH: { name: 'Hainan Airlines', code: 'CHH', iata: 'HU', color: '#dc2626', country: 'China', callsignName: 'HAINAN' },
  CSZ: { name: 'Shenzhen Airlines', code: 'CSZ', iata: 'ZH', color: '#b91c1c', country: 'China', callsignName: 'SHENZHEN AIR' },
  CAL: { name: 'China Airlines', code: 'CAL', iata: 'CI', color: '#93c5fd', country: 'Taiwan', callsignName: 'DYNASTY' },
  EVA: { name: 'EVA Air', code: 'EVA', iata: 'BR', color: '#15803d', country: 'Taiwan', callsignName: 'EVA' },
  HVN: { name: 'Vietnam Airlines', code: 'HVN', iata: 'VN', color: '#0284c7', country: 'Vietnam', callsignName: 'VIET NAM AIRLINES' },
  VJC: { name: 'VietJet Air', code: 'VJC', iata: 'VJ', color: '#dc2626', country: 'Vietnam', callsignName: 'VIETJET' },
  PAL: { name: 'Philippine Airlines', code: 'PAL', iata: 'PR', color: '#2563eb', country: 'Philippines', callsignName: 'PHILIPPINE' },
  CEB: { name: 'Cebu Pacific', code: 'CEB', iata: '5J', color: '#eab308', country: 'Philippines', callsignName: 'CEBU AIR' },

  // European Carriers
  BAW: { name: 'British Airways', code: 'BAW', iata: 'BA', color: '#075aaa', country: 'UK', callsignName: 'SPEEDBIRD' },
  EZY: { name: 'easyJet', code: 'EZY', iata: 'U2', color: '#ea580c', country: 'UK', callsignName: 'EASY' },
  VIR: { name: 'Virgin Atlantic', code: 'VIR', iata: 'VS', color: '#cc0000', country: 'UK', callsignName: 'VIRGIN' },
  DLH: { name: 'Lufthansa', code: 'DLH', iata: 'LH', color: '#ffab00', country: 'Germany', callsignName: 'LUFTHANSA' },
  AFR: { name: 'Air France', code: 'AFR', iata: 'AF', color: '#002157', country: 'France', callsignName: 'AIRFRANS' },
  KLM: { name: 'KLM Royal Dutch', code: 'KLM', iata: 'KL', color: '#00a1de', country: 'Netherlands', callsignName: 'KLM' },
  THY: { name: 'Turkish Airlines', code: 'THY', iata: 'TK', color: '#e81932', country: 'Turkey', callsignName: 'TURKISH' },
  PGT: { name: 'Pegasus Airlines', code: 'PGT', iata: 'PC', color: '#f59e0b', country: 'Turkey', callsignName: 'SUNTURK' },
  SWR: { name: 'Swiss International', code: 'SWR', iata: 'LX', color: '#e30613', country: 'Switzerland', callsignName: 'SWISS' },
  AUA: { name: 'Austrian Airlines', code: 'AUA', iata: 'OS', color: '#d81e05', country: 'Austria', callsignName: 'AUSTRIAN' },
  SAS: { name: 'Scandinavian Airlines', code: 'SAS', iata: 'SK', color: '#000066', country: 'Sweden/Norway/Denmark', callsignName: 'SCANDINAVIAN' },
  FIN: { name: 'Finnair', code: 'FIN', iata: 'AY', color: '#0b1560', country: 'Finland', callsignName: 'FINNAIR' },
  IBE: { name: 'Iberia', code: 'IBE', iata: 'IB', color: '#d71921', country: 'Spain', callsignName: 'IBERIA' },
  RYR: { name: 'Ryanair', code: 'RYR', iata: 'FR', color: '#2563eb', country: 'Ireland', callsignName: 'RYANAIR' },
  EIN: { name: 'Aer Lingus', code: 'EIN', iata: 'EI', color: '#16a34a', country: 'Ireland', callsignName: 'SHAMROCK' },
  TAP: { name: 'TAP Air Portugal', code: 'TAP', iata: 'TP', color: '#80b62e', country: 'Portugal', callsignName: 'AIR PORTUGAL' },
  AZA: { name: 'ITA Airways', code: 'AZA', iata: 'AZ', color: '#0066b2', country: 'Italy', callsignName: 'ITARROW' },
  WZZ: { name: 'Wizz Air', code: 'WZZ', iata: 'W6', color: '#db2777', country: 'Hungary', callsignName: 'WIZZ AIR' },
  LOT: { name: 'LOT Polish Airlines', code: 'LOT', iata: 'LO', color: '#1d4ed8', country: 'Poland', callsignName: 'LOT' },
  AFL: { name: 'Aeroflot', code: 'AFL', iata: 'SU', color: '#0284c7', country: 'Russia', callsignName: 'AEROFLOT' },

  // Americas & Oceania Carriers
  AAL: { name: 'American Airlines', code: 'AAL', iata: 'AA', color: '#0078d2', country: 'USA', callsignName: 'AMERICAN' },
  UAL: { name: 'United Airlines', code: 'UAL', iata: 'UA', color: '#005da4', country: 'USA', callsignName: 'UNITED' },
  DAL: { name: 'Delta Air Lines', code: 'DAL', iata: 'DL', color: '#e01933', country: 'USA', callsignName: 'DELTA' },
  SWA: { name: 'Southwest Airlines', code: 'SWA', iata: 'WN', color: '#304cb2', country: 'USA', callsignName: 'SOUTHWEST' },
  JBU: { name: 'JetBlue Airways', code: 'JBU', iata: 'B6', color: '#003876', country: 'USA', callsignName: 'JETBLUE' },
  ASA: { name: 'Alaska Airlines', code: 'ASA', iata: 'AS', color: '#01426a', country: 'USA', callsignName: 'ALASKA' },
  ACA: { name: 'Air Canada', code: 'ACA', iata: 'AC', color: '#e31837', country: 'Canada', callsignName: 'AIR CANADA' },
  AMX: { name: 'Aeroméxico', code: 'AMX', iata: 'AM', color: '#1e3a8a', country: 'Mexico', callsignName: 'AEROMEXICO' },
  LAN: { name: 'LATAM Airlines', code: 'LAN', iata: 'LA', color: '#be123c', country: 'Chile/Brazil', callsignName: 'LAN' },
  AVA: { name: 'Avianca', code: 'AVA', iata: 'AV', color: '#dc2626', country: 'Colombia', callsignName: 'AVIANCA' },
  QFA: { name: 'Qantas', code: 'QFA', iata: 'QF', color: '#e0001b', country: 'Australia', callsignName: 'QANTAS' },
  VOZ: { name: 'Virgin Australia', code: 'VOZ', iata: 'VA', color: '#cc0000', country: 'Australia', callsignName: 'VELOCITY' },
  ANZ: { name: 'Air New Zealand', code: 'ANZ', iata: 'NZ', color: '#1e293b', country: 'New Zealand', callsignName: 'NEW ZEALAND' },

  // Global Cargo & Special Carriers
  FDX: { name: 'FedEx Express', code: 'FDX', iata: 'FX', color: '#4d148c', country: 'USA', callsignName: 'FEDEX' },
  UPS: { name: 'UPS Airlines', code: 'UPS', iata: '5X', color: '#351c15', country: 'USA', callsignName: 'UPS' },
  GTI: { name: 'Atlas Air', code: 'GTI', iata: '5Y', color: '#002f6c', country: 'USA', callsignName: 'GIANT' },
  CLX: { name: 'Cargolux', code: 'CLX', iata: 'CV', color: '#d71921', country: 'Luxembourg', callsignName: 'CARGOLUX' },
  BOX: { name: 'AeroLogic', code: 'BOX', iata: '3S', color: '#ffcc00', country: 'Germany', callsignName: 'GERMAN CARGO' },
  CSS: { name: 'SF Airlines', code: 'CSS', iata: 'O3', color: '#ff6600', country: 'China', callsignName: 'SHUN FENG' },
  ETH: { name: 'Ethiopian Airlines', code: 'ETH', iata: 'ET', color: '#008542', country: 'Ethiopia', callsignName: 'ETHIOPIAN' },
  QAF: { name: 'Amiri Flight', code: 'QAF', iata: 'QAF', color: '#831843', country: 'Qatar', callsignName: 'AMIRI' },
  IAM: { name: 'Italian Air Force', code: 'IAM', iata: 'IAM', color: '#1e40af', country: 'Italy', callsignName: 'ITALIAN AIR FORCE' },
  RFF: { name: 'Russian Federation Air Force', code: 'RFF', iata: 'RFF', color: '#991b1b', country: 'Russia', callsignName: 'RUSSIAN AIR FORCE' },
};

/**
 * Extract airline company information from callsign (e.g. "IGO5323", "UAE568", "AIC1SK")
 */
export function getAirlineInfo(callsign?: string | null, _icao24?: string | null): AirlineInfo {
  if (!callsign || typeof callsign !== 'string') {
    return { name: 'Commercial Aircraft', code: 'GEN', iata: '--', color: '#38bdf8' };
  }

  const clean = callsign.trim().toUpperCase();
  if (!clean) {
    return { name: 'Commercial Aircraft', code: 'GEN', iata: '--', color: '#38bdf8' };
  }

  // Check 3-letter ICAO prefix
  const prefix3 = clean.slice(0, 3);
  if (AIRLINE_DIRECTORY[prefix3]) {
    return AIRLINE_DIRECTORY[prefix3];
  }

  // Check 2-letter IATA prefix
  const prefix2 = clean.slice(0, 2);
  for (const info of Object.values(AIRLINE_DIRECTORY)) {
    if (info.iata === prefix2 && prefix2 !== '--') {
      return info;
    }
  }

  // Synthetic / Test Aircraft
  if (clean.startsWith('SIM') || clean.startsWith('TEST')) {
    return { name: 'Simulation Target', code: 'SIM', iata: 'ST', color: '#a855f7' };
  }

  // Private / General Aviation
  if (clean.startsWith('N') && /^[N][0-9]/.test(clean)) {
    return { name: 'General Aviation (US)', code: 'GA', iata: 'GA', color: '#94a3b8', country: 'USA' };
  }
  if (clean.startsWith('VT-') || (clean.startsWith('VT') && clean.length <= 5)) {
    return { name: 'General Aviation (India)', code: 'GA', iata: 'GA', color: '#94a3b8', country: 'India' };
  }

  return {
    name: `${prefix3} Flight`,
    code: prefix3,
    iata: prefix2,
    color: '#38bdf8',
  };
}

/**
 * Returns human-readable company name (e.g. "IndiGo", "Emirates", "Air India")
 */
export function getAirlineDisplayName(callsign?: string | null, icao24?: string | null): string {
  const info = getAirlineInfo(callsign, icao24);
  return info.name;
}
