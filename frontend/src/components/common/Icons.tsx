import React from 'react';

const Icon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5v5M12 16.5h.01" />
  </svg>
);

export {
  Icon as ShieldAlert, Icon as ShieldCheck, Icon as Shield, Icon as AlertTriangle, Icon as AlertOctagon,
  Icon as Plane, Icon as Radio, Icon as Activity, Icon as Database, Icon as Search, Icon as Filter,
  Icon as Layers, Icon as Settings, Icon as RefreshCw, Icon as Download, Icon as Play, Icon as Pause,
  Icon as SkipForward, Icon as Terminal, Icon as User, Icon as Users, Icon as Lock, Icon as CheckCircle,
  Icon as CheckCircle2, Icon as XCircle, Icon as Compass, Icon as Gauge, Icon as Wind, Icon as Eye,
  Icon as EyeOff, Icon as Check, Icon as ChevronRight, Icon as ChevronLeft, Icon as ChevronDown, Icon as Info,
  Icon as Sliders, Icon as FileText, Icon as BarChart2, Icon as BarChart3, Icon as Cpu, Icon as Volume2,
  Icon as VolumeX, Icon as Globe, Icon as MapPin, Icon as TrendingDown, Icon as TrendingUp, Icon as History,
  Icon as Zap, Icon as Crosshair, Icon as Wifi, Icon as WifiOff, Icon as Server, Icon as Key,
  Icon as LogOut, Icon as Plus, Icon as Trash2, Icon as Copy, Icon as ExternalLink, Icon as Radar
};
