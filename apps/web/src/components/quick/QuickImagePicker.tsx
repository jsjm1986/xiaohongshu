import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Check, ImagePlus, Images, Trash2 } from 'lucide-react';
import { Button, useToast } from '../Ui';
import { api } from '../../lib/api';
import type { ImageAsset, Project } from '../../types';

const MAX_SELECTED = 9;
const MAX_BYTES = 8 * 1024 * 1024;

interface Props {
  project: Project;
  busy: boolean;
  setBusy: (b: boolean) => void;
  fail: (e: unknown, fallback: string) => void;
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}

// 源素材图选择器:上传(≤9 张 jpeg/png/webp ≤8MiB)→ 自动分析 → 确认观察 → 勾选。
// 上传/确认/删除用内部 working 状态,不占壳的 busy(避免触发生成进度条);
// busy(生成中)时所有操作禁用。setBusy 按约定接收但此处不使用。
export function QuickImagePicker({ project, busy, fail, selectedIds, onChange }: Props) {
  const toast = useToast();
  const [assets, setAssets] = useState<ImageAsset[]>([]);
  const [working, setWorking] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // 壳的 fail 每次渲染都是新引用,经 ref 调用以免 load 依赖抖动重复拉取
  const failRef = useRef(fail);
  failRef.current = fail;

  const load = useCallback(async () => {
    try {
      const list = await api.imageAssets.list(project.id);
      setAssets(list.items);
    } catch (e) {
      failRef.current(e, '加载源素材图失败');
    }
  }, [project.id]);

  useEffect(() => { void load(); }, [load]);

  const disabled = busy || working;

  const toggle = (asset: ImageAsset) => {
    if (disabled) return;
    if (!asset.approved) {
      toast.push('需先「确认观察」才能勾选该图', 'info');
      return;
    }
    if (selectedIds.includes(asset.id)) {
      onChange(selectedIds.filter((id) => id !== asset.id));
      return;
    }
    if (selectedIds.length >= MAX_SELECTED) {
      toast.push(`最多选 ${MAX_SELECTED} 张源素材图`, 'info');
      return;
    }
    onChange([...selectedIds, asset.id]);
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    if (!files.length) return;
    setWorking(true);
    try {
      for (const file of files) {
        if (!/^image\/(jpeg|png|webp)$/u.test(file.type) || file.size > MAX_BYTES) {
          toast.push(`${file.name} 不是支持的图片或超过 8 MiB`, 'error');
          continue;
        }
        const created = await api.imageAssets.upload(project.id, file);
        // 自动分析失败不阻塞:回落为已上传状态,稍后可重试
        await api.imageAssets.analyze(project.id, created.id).catch(() => created);
      }
      await load();
    } catch (e) {
      failRef.current(e, '上传图片失败');
    } finally {
      setWorking(false);
    }
  };

  const approve = async (asset: ImageAsset) => {
    setWorking(true);
    try {
      await api.imageAssets.approve(project.id, asset.id, asset.latestAnalysisId);
      await load();
      toast.push('观察已确认，可勾选该图');
    } catch (e) {
      failRef.current(e, '确认观察失败');
    } finally {
      setWorking(false);
    }
  };

  const remove = async (asset: ImageAsset) => {
    setWorking(true);
    try {
      await api.imageAssets.remove(project.id, asset.id);
      setAssets((current) => current.filter((item) => item.id !== asset.id));
      if (selectedIds.includes(asset.id)) onChange(selectedIds.filter((id) => id !== asset.id));
    } catch (e) {
      failRef.current(e, '删除图片失败');
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="qc-picker">
      <div className="qc-picker__head">
        <Button variant="secondary" disabled={disabled} icon={<ImagePlus size={14} />} onClick={() => fileInput.current?.click()}>上传图片</Button>
        <input ref={fileInput} hidden multiple type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => void upload(e)} />
        <small className="qc-hint">{working ? '处理中…' : `已选 ${selectedIds.length}/${MAX_SELECTED} · 仅已确认观察的图可勾选`}</small>
      </div>
      {assets.length === 0 ? (
        <div className="qc-empty">
          <span className="qc-empty__icon"><Images size={18} /></span>
          可不选源素材图；上传原图只作生成参考，不会产出成品图。
        </div>
      ) : (
        <div className="qc-asset-grid">
          {assets.map((asset) => {
            const selected = selectedIds.includes(asset.id);
            const pendingConfirm = !asset.approved && asset.status === 'ready' && Boolean(asset.latestAnalysisId);
            return (
              <figure key={asset.id} className={`qc-asset${selected ? ' selected' : ''}${asset.approved ? '' : ' qc-asset--locked'}`}>
                <button
                  type="button"
                  className="qc-asset__pick"
                  title={asset.approved ? asset.filename : '需先确认观察才能勾选'}
                  onClick={() => toggle(asset)}
                >
                  <img src={api.imageAssets.contentUrl(project.id, asset.id)} alt={asset.filename} />
                  {selected && <span className="qc-asset__check"><Check size={13} /></span>}
                </button>
                <figcaption>
                  <span className="qc-asset__status">
                    {asset.approved ? '已确认' : pendingConfirm ? '待确认观察' : asset.status === 'failed' ? '分析失败' : '分析中…'}
                  </span>
                  {pendingConfirm && (
                    <button type="button" className="qc-asset__action" disabled={disabled} onClick={() => void approve(asset)}>确认观察</button>
                  )}
                </figcaption>
                <button type="button" className="qc-asset__remove" aria-label="删除图片" disabled={disabled} onClick={() => void remove(asset)}>
                  <Trash2 size={12} />
                </button>
              </figure>
            );
          })}
        </div>
      )}
    </div>
  );
}
