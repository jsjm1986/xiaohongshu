import { Clipboard } from 'lucide-react';

export function CopyMiniButton({ deliverable, onCopy }: {
  deliverable: boolean;
  onCopy: () => void;
}) {
  return (
    <button
      type="button"
      className="copy-mini"
      disabled={!deliverable}
      aria-disabled={!deliverable}
      title={deliverable ? undefined : '存在硬阻断，须修复后重新生成'}
      onClick={deliverable ? onCopy : undefined}
    >
      <Clipboard size={14} />
      复制
    </button>
  );
}
