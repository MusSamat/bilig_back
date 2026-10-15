/** Shared input for deck exporters (PPTX, PDF). */
import type { Slide } from '@bilig/content-model/api';

export interface DeckImage {
  body: Buffer;
  contentType: string;
}

export interface DeckInput {
  title: string;
  slides: Slide[];
  /** Snapshot images by snapshot id (only the owner's snapshots). */
  images: Map<string, DeckImage>;
}

export const imageMime = (contentType: string): 'png' | 'jpeg' | 'webp' | null =>
  contentType === 'image/png' ? 'png' : contentType === 'image/jpeg' ? 'jpeg' : contentType === 'image/webp' ? 'webp' : null;
