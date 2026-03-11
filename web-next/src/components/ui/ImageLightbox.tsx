'use client';

import { useEffect, useRef, useCallback } from 'react';
import { X } from 'lucide-react';
import { useTranslations } from '@/i18n/context';

interface ImageLightboxProps {
  src: string | null;
  alt?: string;
  onClose: () => void;
}

export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  const { t } = useTranslations();
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const stableOnClose = useCallback(() => onCloseRef.current(), []);

  useEffect(() => {
    if (!src) return;
    triggerRef.current = document.activeElement;
    dialogRef.current?.focus();

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') stableOnClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (triggerRef.current instanceof HTMLElement) {
        triggerRef.current.focus();
      }
    };
  }, [src, stableOnClose]);

  if (!src) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={alt || t('image.lightbox.close')}
      tabIndex={-1}
      className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center outline-none"
      onClick={(e) => { if (e.target === e.currentTarget) stableOnClose(); }}
    >
      <button
        onClick={stableOnClose}
        className="absolute top-4 right-4 w-10 h-10 flex items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors z-10"
        aria-label={t('image.lightbox.close')}
      >
        <X size={20} />
      </button>
      <img
        src={src}
        alt={alt || ''}
        className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
      />
    </div>
  );
}
