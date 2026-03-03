'use client';

import { Filter } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface FilterOption {
  value: string;
  label: string;
}

interface FilterSelectProps {
  options: FilterOption[];
  value: string;
  onChange: (value: string) => void;
  /** Show filter icon on the left (default: true) */
  icon?: boolean;
  /** Size variant (default: 'md') */
  size?: 'sm' | 'md';
  className?: string;
}

export function FilterSelect({
  options,
  value,
  onChange,
  icon = true,
  size = 'md',
  className,
}: FilterSelectProps) {
  const sizeClasses = size === 'sm'
    ? 'py-1.5 text-xs'
    : 'py-2 text-sm';

  return (
    <div className="relative">
      {icon && (
        <Filter
          size={14}
          className={cn(
            'absolute top-1/2 -translate-y-1/2 text-hxa-text-muted pointer-events-none',
            size === 'sm' ? 'left-2.5' : 'left-3',
          )}
        />
      )}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'w-full bg-black/30 border border-hxa-border rounded-lg pr-3 text-hxa-text outline-none focus:border-hxa-accent transition-colors appearance-none cursor-pointer',
          icon ? (size === 'sm' ? 'pl-8' : 'pl-9') : (size === 'sm' ? 'px-2' : 'px-3'),
          sizeClasses,
          className,
        )}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value} className="bg-hxa-bg">
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
