import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { QuickCandidateView } from '../../lib/quick-generation';
import type { SimpleSettingOverrides } from '../../lib/simple-generation';
import type { ContentPreset, GenerationJob, Project, TopicOpportunity } from '../../types';

/**
 * 项目工作区的跨区状态。
 *
 * 四个区改成真路由后,页面组件会按区卸载。而这些状态**必须活过区切换**——
 * 「在创作区勾了 8 个选题 → 去产出区确认一下 → 回来提交」是批量提交前的常见动作,
 * 勾选丢掉等于让用户重勾一遍。所以提到这一层,由布局路由持有。
 *
 * 反过来,只在单区内有意义的东西不进来:busy / generating / 筛选词 / 展开项
 * 都留在各自页面里,离开就该清掉。
 *
 * provider 挂在 /quick/:projectId 布局上并带 key={projectId}:换项目时整体重挂,
 * 天然完成原来 onProjectChosen 里那十几行手工清理(clearDownstreamOfProject 因此删掉)。
 */
export interface QuickWorkspaceValue {
  /** 由路由的 :projectId 在 projects 列表里查出,不是独立状态——单一真源 */
  project: Project;

  opportunities: TopicOpportunity[];
  setOpportunities: (o: TopicOpportunity[]) => void;
  opportunityId: string;
  setOpportunityId: (id: string) => void;

  presets: ContentPreset[];
  setPresets: (p: ContentPreset[]) => void;
  presetId: string | undefined;
  setPresetId: (id: string | undefined) => void;
  overrides: SimpleSettingOverrides;
  setOverrides: (o: SimpleSettingOverrides) => void;
  imageAssetIds: string[];
  setImageAssetIds: (ids: string[]) => void;

  /** 刚生成、用户还没处理的结果 */
  results: QuickCandidateView[];
  setResults: (r: QuickCandidateView[]) => void;
  jobId: string | undefined;
  setJobId: (id: string | undefined) => void;

  /** 产出列表:产出区渲染它,总览页也读它算摘要 */
  history: GenerationJob[];
  setHistory: (h: GenerationJob[]) => void;

  /** 批量:左栏勾选 + 右栏批量态 + 预设多选 */
  checkedIds: string[];
  setCheckedIds: (ids: string[] | ((cur: string[]) => string[])) => void;
  batchMode: boolean;
  setBatchMode: (b: boolean) => void;
  batchPresetIds: string[];
  setBatchPresetIds: (ids: string[] | ((cur: string[]) => string[])) => void;

  /** 跨区交接的落点标记 */
  activeBatchId: string | undefined;
  setActiveBatchId: (id: string | undefined) => void;
}

const QuickWorkspaceContext = createContext<QuickWorkspaceValue | null>(null);

export function QuickWorkspaceProvider({ project, children }: { project: Project; children: ReactNode }) {
  const [opportunities, setOpportunities] = useState<TopicOpportunity[]>([]);
  const [opportunityId, setOpportunityId] = useState('');
  const [presets, setPresets] = useState<ContentPreset[]>([]);
  const [presetId, setPresetId] = useState<string | undefined>(undefined);
  const [overrides, setOverrides] = useState<SimpleSettingOverrides>({});
  const [imageAssetIds, setImageAssetIds] = useState<string[]>([]);
  const [results, setResults] = useState<QuickCandidateView[]>([]);
  const [jobId, setJobId] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<GenerationJob[]>([]);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [batchMode, setBatchMode] = useState(false);
  const [batchPresetIds, setBatchPresetIds] = useState<string[]>([]);
  const [activeBatchId, setActiveBatchId] = useState<string | undefined>(undefined);

  const value = useMemo<QuickWorkspaceValue>(
    () => ({
      project,
      opportunities, setOpportunities,
      opportunityId, setOpportunityId,
      presets, setPresets,
      presetId, setPresetId,
      overrides, setOverrides,
      imageAssetIds, setImageAssetIds,
      results, setResults,
      jobId, setJobId,
      history, setHistory,
      checkedIds, setCheckedIds,
      batchMode, setBatchMode,
      batchPresetIds, setBatchPresetIds,
      activeBatchId, setActiveBatchId,
    }),
    [
      project, opportunities, opportunityId, presets, presetId, overrides, imageAssetIds,
      results, jobId, history, checkedIds, batchMode, batchPresetIds, activeBatchId,
    ],
  );

  return <QuickWorkspaceContext.Provider value={value}>{children}</QuickWorkspaceContext.Provider>;
}

export function useQuickWorkspace(): QuickWorkspaceValue {
  const value = useContext(QuickWorkspaceContext);
  if (!value) throw new Error('useQuickWorkspace 必须在 QuickWorkspaceProvider 内使用');
  return value;
}
