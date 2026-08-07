import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../../components/Ui';
import { ProjectKnowledgeTab } from '../../components/quick/ProjectKnowledgeTab';
import { useQuickWorkspace } from '../../components/quick/QuickWorkspaceContext';
import { areaPath } from '../../lib/quick-routes';
import type { TopicOpportunity } from '../../types';

/** 知识库区。分析完把选题灌进跨区状态,然后跳创作区。 */
export function QuickKnowledgePage() {
  const { project, setOpportunities, setOpportunityId, setPublishing, setResults, setJobId } = useQuickWorkspace();
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown, fallback: string) => {
    toast.push(e instanceof Error ? e.message : fallback, 'error');
    setBusy(false);
  };

  /**
   * 分析产出新一批选题:清掉上一轮的选中与结果再跳区。
   * 不清的话,创作区会带着旧选题的结果显示新选题池,右栏和左栏说的不是一回事。
   */
  const onAnalyzed = (opps: TopicOpportunity[]) => {
    setPublishing({});
    setOpportunities(opps);
    setOpportunityId('');
    setResults([]);
    setJobId(undefined);
    navigate(areaPath(project.id, 'create'));
  };

  return (
    <ProjectKnowledgeTab
      project={project}
      busy={busy}
      setBusy={setBusy}
      fail={fail}
      onAnalyzed={onAnalyzed}
    />
  );
}
