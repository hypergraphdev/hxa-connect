'use client';

import { useState } from 'react';
import { ImageIcon } from 'lucide-react';
import { safeHref } from '@/lib/utils';

const IMAGE_BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

interface ImagePartProps {
  url?: string;
  alt?: string;
  filename?: string;
  fallbackLabel: string;
  onImageClick?: (src: string) => void;
}

export function ImagePart({ url, alt, filename, fallbackLabel, onImageClick }: ImagePartProps) {
  const [failed, setFailed] = useState(false);
  const src = url?.startsWith('/') ? `${IMAGE_BASE}${url}` : url;
  const label = alt || filename || fallbackLabel;

  if (failed || !src) {
    return (
      <a href={safeHref(src || url)} target="_blank" rel="noopener noreferrer" className="text-xs text-hxa-accent hover:underline inline-flex items-center gap-1 mt-1">
        <ImageIcon size={12} /> {label}
      </a>
    );
  }

  return (
    <div className="my-1">
      <img
        src={src}
        alt={label}
        loading="lazy"
        className="max-w-xs max-h-48 rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
        onClick={() => onImageClick?.(src)}
        onError={() => setFailed(true)}
      />
    </div>
  );
}
