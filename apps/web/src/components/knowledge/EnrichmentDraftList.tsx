import { EmptyState } from '../Ui';
import { applyDraftChange } from '../../lib/enrich-flow';
import type { DraftItem } from '../../lib/enrich-types';
import { DraftItemCard } from './DraftItemCard';

export function EnrichmentDraftList({
  items,
  onChange,
}: {
  items: DraftItem[];
  onChange: (items: DraftItem[]) => void;
}) {
  if (items.length === 0) {
    return (
      <EmptyState
        title="没有可补充的内容"
        description="AI 没能基于现有资料生成建议,先上传一些原始资料再试。"
      />
    );
  }
  return (
    <div className="enrich-list">
      {items.map((item) => (
        <DraftItemCard
          key={item.gapId}
          item={item}
          onChange={(updated) => onChange(applyDraftChange(items, updated))}
        />
      ))}
    </div>
  );
}
