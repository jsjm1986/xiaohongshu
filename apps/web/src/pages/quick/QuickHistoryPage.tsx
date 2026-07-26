import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
// HistoryTab 自己持有加载态,不读外部 busy;这里的 busy 只用来防「再来一篇同款」
// 在回填过程中被连点两次(那会拉两轮接口、灌两次配置)。
import { useToast } from '../../components/Ui';
import { HistoryTab } from '../../components/quick/HistoryTab';
import { useQuickWorkspace } from '../../components/quick/QuickWorkspaceContext';
import { api } from '../../lib/api';
import { extractRecipe, resolveRecipeTargets } from '../../lib/quick-recipe';
import { areaPath } from '../../lib/quick-routes';
import type { GenerationJob } from '../../types';

/** 产出区。 */
export function QuickHistoryPage() {
  const w = useQuickWorkspace();
  const { project } = w;
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  /**
   * 「生成耗时过长」交接过来时要展开的那一条。
   *
   * 原来是壳里的一个 state,现在走 location.state——它属于"这一次跳转",不属于
   * 工作区:同一个区刷新一次就该忘掉,不然用户会莫名看到某条被展开。
   */
  const focusJobId = (location.state as { focusJobId?: string } | null)?.focusJobId;

  const fail = (e: unknown, fallback: string) => {
    toast.push(e instanceof Error ? e.message : fallback, 'error');
    setBusy(false);
  };

  /** 「再来一篇同款」:把历史任务的配方回灌创作区(不直接生成,留一步给人改)。 */
  const onReuseRecipe = async (job: GenerationJob) => {
    if (busy) return;
    setBusy(true);
    try {
      // 选题池/预设可能还没在本次会话加载过,按需各拉一次再校验失效
      const [oppList, presetList] = await Promise.all([
        w.opportunities.length > 0 ? Promise.resolve({ items: w.opportunities }) : api.opportunities.list(project.id),
        api.presets.list(project.id),
      ]);
      w.setOpportunities(oppList.items);
      w.setPresets(presetList.items);
      const targets = resolveRecipeTargets(extractRecipe(job), oppList.items, presetList.items);
      w.setOpportunityId(targets.opportunityId);
      w.setPresetId(targets.presetId);
      w.setOverrides(targets.overrides);
      w.setImageAssetIds(targets.imageAssetIds);
      w.setResults([]);
      w.setJobId(undefined);
      w.setBatchMode(false);
      w.setBatchPresetIds([]);
      setBusy(false);
      navigate(areaPath(project.id, 'create'));
      for (const warning of targets.warnings) toast.push(warning, 'info');
      if (targets.warnings.length === 0) toast.push('已回填这篇的配置，确认后点「生成文案」');
    } catch (e) { fail(e, '回填配方失败'); }
  };

  return (
    <HistoryTab
      project={project}
      history={w.history}
      setHistory={w.setHistory}
      fail={fail}
      activeBatchId={w.activeBatchId}
      focusJobId={focusJobId}
      onReuseRecipe={(job) => void onReuseRecipe(job)}
    />
  );
}
