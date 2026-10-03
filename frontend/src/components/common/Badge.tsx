import React from 'react';

export type BadgeVariant = 
  | 'success' 
  | 'warning' 
  | 'critical' 
  | 'danger' 
  | 'info' 
  | 'neutral' 
  | 'simulated' 
  | 'primary';

export interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  dot?: boolean;
}

const variantStyles: Record<BadgeVariant, { container: string; dot: string }> = {
  success: {
    container: 'bg-emerald-950/70 text-emerald-400 border-emerald-500/30',
    dot: 'bg-emerald-400'
  },
  warning: {
    container: 'bg-amber-950/70 text-amber-400 border-amber-500/30',
    dot: 'bg-amber-400'
  },
  critical: {
    container: 'bg-red-950/80 text-red-400 border-red-500/40',
    dot: 'bg-red-400'
  },
  danger: {
    container: 'bg-red-950/80 text-red-400 border-red-500/40',
    dot: 'bg-red-400'
  },
  info: {
    container: 'bg-sky-950/70 text-sky-400 border-sky-500/30',
    dot: 'bg-sky-400'
  },
  neutral: {
    container: 'bg-slate-800/80 text-slate-300 border-slate-700',
    dot: 'bg-slate-400'
  },
  simulated: {
    container: 'bg-purple-950/70 text-purple-300 border-purple-500/30',
    dot: 'bg-purple-400'
  },
  primary: {
    container: 'bg-cyan-950/70 text-cyan-400 border-cyan-500/30',
    dot: 'bg-cyan-400'
  }
};

const sizeStyles = {
  sm: 'text-[10px] px-1.5 py-0.5 font-mono tracking-wider',
  md: 'text-xs px-2.5 py-1 font-mono',
  lg: 'text-sm px-3 py-1.5 font-medium'
};

export const Badge: React.FC<BadgeProps> = ({
  children,
  variant = 'neutral',
  size = 'md',
  className = '',
  dot = false
}) => {
  const styles = variantStyles[variant] || variantStyles.neutral;
  const sizeClass = sizeStyles[size] || sizeStyles.md;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border ${styles.container} ${sizeClass} font-semibold uppercase ${className}`}
    >
      {dot && (
        <span
          className={`h-1.5 w-1.5 rounded-full ${styles.dot} animate-pulse`}
        />
      )}
      {children}
    </span>
  );
};
