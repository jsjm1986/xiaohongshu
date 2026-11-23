import type { ReactNode } from 'react';
import { api } from '../lib/api';
import type { ArticleImage } from '../types';

export function ArticleWithImages({ projectId, images, children }: {
  projectId?: string;
  images?: ArticleImage[];
  children: ReactNode;
}) {
  if (!projectId || !images?.length) return <>{children}</>;
  const [cover, ...details] = images;

  const photo = (image: ArticleImage, coverPhoto = false) => {
    const url = api.imageAssets.contentUrl(projectId, image.assetId);
    return (
      <a className="article-photo" key={image.assetId} href={url} target="_blank" rel="noreferrer" title={image.filename}>
        <img src={url} width={image.width} height={image.height} alt={image.altText || image.filename} loading={coverPhoto ? 'eager' : 'lazy'} decoding="async" />
      </a>
    );
  };

  return (
    <div className="article-with-images">
      {photo(cover, true)}
      {children}
      {details.length > 0 && <div className="article-photo-grid">{details.map((image) => photo(image))}</div>}
    </div>
  );
}
