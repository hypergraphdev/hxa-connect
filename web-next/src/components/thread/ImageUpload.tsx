'use client';

import { useRef } from 'react';
import { ImagePlus, X, RotateCcw, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslations } from '@/i18n/context';

export interface PendingImage {
  id: string;
  file: File;
  preview: string;
  status: 'pending' | 'uploading' | 'done' | 'error';
  progress: number;
  uploadResult?: { id: string; url: string; name: string };
  error?: string;
}

/** Conservative fallback if server config is unavailable. */
const DEFAULT_MAX_IMAGE_SIZE_MB = 10;
export const MAX_IMAGES_PER_MESSAGE = 10;
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const ACCEPT_STRING = ACCEPTED_TYPES.join(',');

export function validateImage(file: File, t: (key: string, params?: Record<string, string | number>) => string, maxSizeMb?: number): string | null {
  if (!file.type.startsWith('image/') || !ACCEPTED_TYPES.includes(file.type))
    return t('image.error.invalidType');
  const limitMb = maxSizeMb ?? DEFAULT_MAX_IMAGE_SIZE_MB;
  if (file.size > limitMb * 1024 * 1024) return t('image.error.tooLarge', { limit: limitMb });
  return null;
}

interface ImageUploadButtonProps {
  onAdd: (files: File[]) => void;
  disabled?: boolean;
}

export function ImageUploadButton({ onAdd, disabled }: ImageUploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslations();

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_STRING}
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          if (files.length > 0) onAdd(files);
          // Reset so same file can be selected again
          if (inputRef.current) inputRef.current.value = '';
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        className="shrink-0 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg text-hxa-text-muted hover:text-hxa-accent transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        aria-label={t('image.upload')}
      >
        <ImagePlus size={18} />
      </button>
    </>
  );
}

interface PendingImagePreviewProps {
  images: PendingImage[];
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
}

export function PendingImagePreview({ images, onRemove, onRetry }: PendingImagePreviewProps) {
  const { t } = useTranslations();
  if (images.length === 0) return null;

  return (
    <div className="flex gap-2 overflow-x-auto max-h-[80px] py-1 px-4">
      {images.map((img) => (
        <div
          key={img.id}
          className="flex-shrink-0 w-16 h-16 relative rounded-lg overflow-hidden border border-hxa-border"
        >
          <img
            src={img.preview}
            alt={img.file.name}
            className="w-full h-full object-cover"
          />

          {/* Uploading overlay */}
          {img.status === 'uploading' && (
            <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
              <span className="text-[10px] font-bold text-white">{img.progress}%</span>
            </div>
          )}

          {/* Done badge */}
          {img.status === 'done' && (
            <div className="absolute bottom-0.5 right-0.5 w-4 h-4 bg-emerald-500 rounded-full flex items-center justify-center">
              <Check size={10} className="text-white" />
            </div>
          )}

          {/* Error overlay */}
          {img.status === 'error' && (
            <div className="absolute inset-0 bg-red-900/60 flex items-center justify-center">
              <button
                onClick={() => onRetry(img.id)}
                className="text-white hover:text-red-200 transition-colors"
                aria-label={t('image.retry')}
              >
                <RotateCcw size={16} />
              </button>
            </div>
          )}

          {/* Remove button — always visible except during upload */}
          {img.status !== 'uploading' && (
            <button
              onClick={() => onRemove(img.id)}
              className="absolute top-0 right-0 w-5 h-5 bg-black/70 flex items-center justify-center text-white hover:text-red-300 transition-colors"
              aria-label={t('image.remove')}
            >
              <X size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
