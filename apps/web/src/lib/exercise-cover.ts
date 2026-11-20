import type { ExerciseMediaItem } from './exercise-media';

type CoverMedia = Pick<ExerciseMediaItem, 'mediaType' | 'url' | 'thumbnailUrl' | 'mimeType'>;

export function getExerciseCoverUrl(media: readonly CoverMedia[]) {
  return (
    media.find((item) => item.mediaType === 'video' && item.thumbnailUrl)?.thumbnailUrl ||
    media.find((item) => item.mediaType === 'image' && item.mimeType !== 'image/svg+xml')?.url
  );
}
