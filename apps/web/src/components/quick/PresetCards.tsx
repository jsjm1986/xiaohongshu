import { Check, Plus, Star } from 'lucide-react';
import type { ContentPreset } from '../../types';

interface Props {
  presets: ContentPreset[];
  mode: 'single' | 'multi';
  selectedId?: string;
  selectedIds?: string[];
  onSelect?: (id: string) => void;
  onToggle?: (id: string) => void;
  onSave?: () => void;
  disabled?: boolean;
}

/** 预设选择器的卡片形态:单选态用于单篇生成,多选态用于批量的预设维度。 */
export function PresetCards({ presets, mode, selectedId, selectedIds = [], onSelect, onToggle, onSave, disabled }: Props) {
  const isSelected = (id: string) => (mode === 'single' ? id === selectedId : selectedIds.includes(id));
  return (
    <div className="qc-preset-cards" role={mode === 'single' ? 'radiogroup' : 'group'} aria-label="内容预设">
      {presets.map((preset) => {
        const selected = isSelected(preset.id);
        return (
          <button
            key={preset.id}
            type="button"
            className={`qc-preset-card${selected ? ' selected' : ''}`}
            role={mode === 'single' ? 'radio' : 'checkbox'}
            aria-checked={selected}
            disabled={disabled}
            onClick={() => (mode === 'single' ? onSelect?.(preset.id) : onToggle?.(preset.id))}
          >
            <span className="qc-preset-card__head">
              <strong>{preset.name}</strong>
              {preset.isDefault && <Star size={12} className="qc-preset-card__star" aria-label="默认" />}
            </span>
            {preset.description && <small className="qc-preset-card__desc">{preset.description}</small>}
            {selected && (
              <span className="qc-preset-card__tick" aria-hidden="true">
                <Check size={13} />
              </span>
            )}
          </button>
        );
      })}
      {onSave && (
        <button type="button" className="qc-preset-card qc-preset-card--add" disabled={disabled} onClick={onSave}>
          <Plus size={16} />
          <span>存为预设</span>
        </button>
      )}
    </div>
  );
}
