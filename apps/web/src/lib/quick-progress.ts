// 真实生成进度 → 阶段文案。纯函数,不 import ./api(该模块加载期会碰
// document/sessionStorage,Node 测试下会崩),可独立 import。
export function progressStageText(progress?: number): string {
  if (progress === undefined || progress < 12) return '排队等待中';
  if (progress < 28) return '解析选题与已确认信息';
  if (progress < 50) return '组织内容结构';
  if (progress < 90) return '生成初稿';
  if (progress < 100) return '质检与合规校验';
  return '完成';
}
