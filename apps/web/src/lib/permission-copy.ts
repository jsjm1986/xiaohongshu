/**
 * 权限的中文文案。
 *
 * 「细分权限」弹窗原来直接把 `workspace.manage` 这类内部标识符摆给用户看,对着
 * 一串点分英文勾授权/拒绝,没法判断勾下去到底放开了什么。这里给每条权限一个
 * 中文名和一句「能做什么」,标识符保留为副标题——它仍是审计日志和 API 里的真名,
 * 排查问题时要对得上。
 *
 * 文案是逐条对照后端实际校验点写的,不是照字面翻译。几处容易望文生义的:
 *   generation.chat  实际管的是「提交修改要求」(generation.controller.ts revise),
 *                    不是聊天;
 *   generation.edit  管的是删除与恢复内容包,不是编辑正文;
 *   api.read         是 API Key 自身的准入门槛(guards.ts),不是「读取 API」;
 *   release.manage   管研究结论的发布/复核/启用(research.controller.ts releases)。
 *
 * PERMISSION_ORDER 与后端 models.ts 的 PERMISSIONS 同序同集合,由测试守住。
 */
export interface PermissionCopy {
  /** 中文名,弹窗里的主标题。 */
  label: string;
  /** 勾选后允许做什么,一句话。 */
  hint: string;
  /** 所属分组,用于把 24 条权限分段。 */
  group: PermissionGroupId;
}

export type PermissionGroupId = 'workspace' | 'project' | 'knowledge' | 'formula' | 'research' | 'generation' | 'audit';

export const PERMISSION_GROUPS: ReadonlyArray<{ id: PermissionGroupId; label: string }> = [
  { id: 'workspace', label: '工作区与成员' },
  { id: 'project', label: '项目' },
  { id: 'knowledge', label: '知识库' },
  { id: 'formula', label: '公式版本' },
  { id: 'research', label: '研究与证据' },
  { id: 'generation', label: '内容生成' },
  { id: 'audit', label: '审计与接口' },
] as const;

export const PERMISSION_COPY: Record<string, PermissionCopy> = {
  'workspace.manage': { label: '管理工作区', hint: '改工作区名称、删除工作区', group: 'workspace' },
  'member.manage': { label: '管理成员', hint: '增删成员、改成员角色与细分权限', group: 'workspace' },
  'provider.manage': { label: '管理模型凭据', hint: '配置模型服务商与自带密钥(BYOK)', group: 'workspace' },
  'quota.manage': { label: '管理用量额度', hint: '设置每月可用的生成额度', group: 'workspace' },
  'project.read': { label: '查看项目', hint: '查看项目列表与项目配置', group: 'project' },
  'project.write': { label: '编辑项目', hint: '新建项目、修改项目配置与选题', group: 'project' },
  'project.delete': { label: '删除项目', hint: '删除项目(连带其下的内容与配置)', group: 'project' },
  'knowledge.read': { label: '查看知识库', hint: '查看已入库的资料与摘要', group: 'knowledge' },
  'knowledge.write': { label: '编辑知识库', hint: '上传资料、修改条目内容', group: 'knowledge' },
  'knowledge.import': { label: '整理知识库', hint: '批量导入、重新归类资料', group: 'knowledge' },
  'knowledge.delete': { label: '删除知识库条目', hint: '移除已入库的资料', group: 'knowledge' },
  'formula.read': { label: '查看公式版本', hint: '查看评分公式及其参数', group: 'formula' },
  'formula.manage': { label: '编辑公式版本', hint: '新建与修改公式版本', group: 'formula' },
  'formula.activate': { label: '启用公式版本', hint: '切换项目当前生效的公式版本', group: 'formula' },
  'research.read': { label: '查看研究与证据', hint: '查看主张、证据来源与数据集', group: 'research' },
  'research.write': { label: '提交研究与证据', hint: '登记主张、上传证据来源与数据集', group: 'research' },
  'research.approve': { label: '复核研究与证据', hint: '审核主张、证据与数据集是否采信', group: 'research' },
  'release.manage': { label: '管理研究发布', hint: '创建、复核并启用研究结论的发布版本', group: 'research' },
  'generation.run': { label: '发起生成', hint: '单篇与批量生成内容,消耗额度', group: 'generation' },
  'generation.chat': { label: '提交修改要求', hint: '对已生成的候选提出修改并重新生成', group: 'generation' },
  'generation.edit': { label: '删除与恢复内容', hint: '删除生成记录,以及撤销删除', group: 'generation' },
  'generation.export': { label: '导出内容', hint: '导出成稿与随附的核查附录', group: 'generation' },
  'audit.read': { label: '查看操作审计', hint: '查看谁在何时对哪个资源做了什么', group: 'audit' },
  'api.read': { label: '使用 API Key', hint: '允许 API Key 调用接口;这是 Key 的准入门槛', group: 'audit' },
};

/** 与后端 PERMISSIONS 同序;弹窗按此顺序渲染。 */
export const PERMISSION_ORDER: readonly string[] = [
  'workspace.manage',
  'member.manage',
  'provider.manage',
  'quota.manage',
  'project.read',
  'project.write',
  'project.delete',
  'knowledge.read',
  'knowledge.write',
  'knowledge.import',
  'knowledge.delete',
  'formula.read',
  'formula.manage',
  'formula.activate',
  'research.read',
  'research.write',
  'research.approve',
  'release.manage',
  'generation.run',
  'generation.chat',
  'generation.edit',
  'generation.export',
  'audit.read',
  'api.read',
] as const;

/**
 * 取一条权限的文案。
 *
 * 后端新增权限而这里没跟上时,不能把它藏起来——那会让一条真实生效的权限在
 * 界面上不可见。降级为「标识符 + 未登记说明」,如实暴露缺口。
 */
export function permissionCopy(permission: string): PermissionCopy {
  return PERMISSION_COPY[permission] ?? { label: permission, hint: '这条权限还没有中文说明', group: 'audit' };
}

/** 按 PERMISSION_GROUPS 顺序分组,丢掉空组。 */
export function groupPermissions(
  permissions: readonly string[],
): Array<{ id: PermissionGroupId; label: string; permissions: string[] }> {
  return PERMISSION_GROUPS.map((group) => ({
    ...group,
    permissions: permissions.filter((permission) => permissionCopy(permission).group === group.id),
  })).filter((group) => group.permissions.length > 0);
}
