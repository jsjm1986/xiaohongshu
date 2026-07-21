import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import { resolve } from 'node:path';
import { BadRequestException, Injectable } from '@nestjs/common';
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
  type ISectionOptions,
} from 'docx';
import PDFDocument from 'pdfkit';
import {
  normalizeContentPackageForApi,
  normalizeDiagnosticForApi,
  normalizeDiagnosticProxyForApi,
} from './diagnostic-contract.js';

export type ExportFormat = 'markdown' | 'json' | 'docx' | 'pdf';

export interface ExportOptions {
  cjkFontPath?: string;
  docxFontName?: string;
}

type JsonObject = Record<string, unknown>;

const WINDOWS_FONT_CANDIDATES = [
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/msyh.ttf',
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/simsun.ttc',
];

const LINUX_FONT_CANDIDATES = [
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
];

const MAC_FONT_CANDIDATES = [
  '/System/Library/Fonts/PingFang.ttc',
  '/System/Library/Fonts/STHeiti Light.ttc',
];

@Injectable()
export class ExportService {
  async exportPackage(
    rawPackage: unknown,
    format: ExportFormat,
    options: ExportOptions = {},
  ): Promise<Buffer> {
    const contentPackage = this.validatePackage(rawPackage);
    switch (format) {
      case 'markdown':
        return Buffer.from(this.toMarkdown(contentPackage), 'utf8');
      case 'json':
        return Buffer.from(`${JSON.stringify(contentPackage, null, 2)}\n`, 'utf8');
      case 'docx':
        return this.toDocx(contentPackage, options);
      case 'pdf':
        return this.toPdf(contentPackage, options);
      default:
        throw new BadRequestException(`不支持的导出格式：${String(format)}`);
    }
  }

  toMarkdown(rawPackage: unknown): string {
    const pkg = this.validatePackage(rawPackage);
    const content = asObject(pkg.content);
    const headline = asObject(content.N);
    const hashtags = stringArray(asObject(content.H).hashtags);
    const comments = asObject(content.Cref);
    const threads = objectArray(comments.threads);
    const dialoguePlans = objectArray(pkg.dialogueThreads);
    const orchestration = asObject(pkg.orchestrationSnapshot);
    const coverageLedger = asObject(orchestration.gapCoverageLedger);
    const title = text(headline.title) || '未命名内容包';
    const lines: string[] = [
      `# ${title}`,
      '',
      `> 内容包 ID：${text(pkg.id) || 'unknown'} ｜ 项目：${text(pkg.projectId) || 'unknown'} ｜ 候选：${text(pkg.candidateIndex) || '0'}`,
      '',
      '## 发布内容',
      '',
      '### 图片简报（实际 N.imageBrief，非图片成品）',
      '',
      text(headline.imageBrief) || '_未提供_',
      '',
      '### 正文',
      '',
      text(headline.body) || '_未提供_',
      '',
      '### 标签',
      '',
      hashtags.length ? hashtags.map(normalizeHashtag).join(' ') : '_未提供_',
      '',
      '## 评论区信息补全参考',
      '',
    ];

    const disclaimer = text(comments.disclaimer);
    lines.push(`> 【模拟情景，非真实评论】${disclaimer || '以下内容仅用于演练潜在读者问题与可追责答复。'}`, '');
    if (threads.length === 0) {
      lines.push('_未提供评论区参考_', '');
    } else {
      threads.forEach((thread, index) => {
        const plan = dialoguePlans.find((item) => text(item.id) && text(item.id) === text(thread.id)) ?? dialoguePlans[index] ?? {};
        const metadata = (key: string) => thread[key] ?? plan[key];
        const simulated = metadata('simulated') === true;
        const roleCard = asObject(metadata('roleCard'));
        const density = asObject(metadata('densityProxy'));
        const replyPlan = asObject(metadata('replyPlan'));
        const discoveryPlan = asObject(metadata('discoveryPlan'));
        lines.push(
          `### 模拟问答 ${index + 1}`,
          '',
          `- 情景标识：${simulated ? text(metadata('simulationLabel')) || '模拟潜在读者情景' : '历史内容，未标注模拟字段'}${simulated ? '（不是真实评论）' : ''}`,
          `- 潜在读者角色：${text(metadata('personaRole')) || '未标注'}`,
          `- 提问方类型：${text(metadata('speakerType')) || '未标注'}`,
          `- 声明状态：${text(metadata('claimStatus')) || '未标注'}`,
          `- 回复关系：${text(metadata('replyTo')) || '根线程'} ｜ 深度：${text(metadata('threadDepth')) || '0'}`,
          `- 提问：${text(thread.question) || '未提供'}`,
          `- 回复：${text(thread.answer) || '未提供'}`,
          `- 可追责答复身份：${text(thread.postingIdentity) || '未标注'}`,
        );
        if (Object.keys(roleCard).length) lines.push(
          `- 动态角色卡：阶段=${text(roleCard.stage) || '未标注'}；知识=${stringArray(roleCard.knowledge).join('、') || '未标注'}；约束=${stringArray(roleCard.constraints).join('、') || '无'}；任务=${text(roleCard.decisionTask) || '未标注'}；证据态度=${text(roleCard.evidenceStance) || '未标注'}`,
          `- 缺口结构：主缺口=${text(metadata('primaryGapId')) || '未标注'}；辅助缺口=${stringArray(metadata('auxiliaryGapIds')).join('、') || '无'}`,
        );
        if (Object.keys(density).length) lines.push(
          `- 信息密度代理：角色维度=${text(density.roleDimensionCount) || '0'}；现实约束=${text(density.constraintCount) || '0'}；辅助维度=${text(density.auxiliaryDimensionCount) || '0'}；短问软目标≈${text(density.questionTargetChars) || '未标注'}字（非效果分）`,
        );
        if (Object.keys(replyPlan).length) lines.push(
          `- 隐藏答复计划：直接回答=${text(replyPlan.directAnswer)}；条件=${text(replyPlan.condition)}；边界=${text(replyPlan.boundary)}；未知=${text(replyPlan.unknown)}；下一问=${text(replyPlan.nextQuestion)}`,
        );
        if (Object.keys(discoveryPlan).length) lines.push(
          `- 发现式路径：线索=${text(discoveryPlan.cue)}；一步推断=${text(discoveryPlan.inferencePrompt)}；同线程揭示=${text(discoveryPlan.reveal)}；自检=${text(discoveryPlan.selfCheck)}；边界=${text(discoveryPlan.boundary)}；难度=${text(discoveryPlan.difficulty)}`,
        );
        const followUps = objectArray(thread.followUps);
        for (const followUp of followUps) {
          lines.push(
            `  - 追问：${text(followUp.question) || '未提供'}`,
            `  - 补充：${text(followUp.answer) || '未提供'}`,
            `  - 追问角色 / 声明：${text(followUp.personaRole) || text(metadata('personaRole')) || '未标注'} / ${text(followUp.claimStatus) || '未标注'}`,
          );
        }
        lines.push('');
      });
    }

    if (Object.keys(coverageLedger).length) {
      lines.push('## 信息闭合台账', '');
      lines.push(
        `- 闭合覆盖率：${text(coverageLedger.closureRate) || '未标注'}（包含明确未知/延后）`,
        `- 真正解决率：${text(coverageLedger.resolvedRate) || '未标注'}（仅正文/评论已回答）`,
        `- 线程可读性目标 / 实际：${text(coverageLedger.targetThreadCount) || '0'} / ${text(coverageLedger.effectiveThreadCount) || '0'}`,
      );
      if (text(coverageLedger.capacityWarning)) lines.push(`- 容量提示：${text(coverageLedger.capacityWarning)}`);
      for (const entry of objectArray(coverageLedger.entries)) lines.push(
        `- ${text(entry.label) || text(entry.gapId) || 'gap'}：${text(entry.status) || '未标注'}；${text(entry.reason) || '无说明'}${text(entry.requiredInput) ? `；所需输入=${text(entry.requiredInput)}` : ''}${text(entry.verificationPath) ? `；核验路径=${text(entry.verificationPath)}` : ''}`,
      );
      lines.push('');
    }

    appendObjectList(lines, '证据来源', objectArray(pkg.evidence), (item) => {
      const location = [text(item.path), text(item.section)].filter(Boolean).join(' · ');
      const quote = text(item.quote);
      return `${text(item.id) || 'evidence'}：${location || '未注明来源'}${quote ? `；摘录：${quote}` : ''}`;
    });
    appendObjectList(lines, '事实、推理与猜想', objectArray(pkg.reasoning), (item) => {
      return `[${text(item.status) || 'unknown'}] ${text(item.statement) || '未提供'}`;
    });
    appendObjectList(lines, '未知信息', objectArray(pkg.unknowns), (item) => {
      return `[${text(item.impact) || 'unknown'}] ${text(item.question) || text(item.key) || '未提供'}：${text(item.reason) || '未说明原因'}`;
    });
    appendObjectList(lines, '知识冲突', objectArray(pkg.conflicts), (item) => {
      return `${text(item.key) || text(item.id) || '未命名冲突'}（${text(item.status) || 'unresolved'}）${text(item.resolution) ? `：${text(item.resolution)}` : ''}`;
    });
    appendDiagnosticLedger(lines, pkg);

    appendVisualProductionLedger(lines, pkg, text(headline.imageBrief));
    appendOpportunityRankAudit(lines, pkg);

    const validation = asObject(pkg.validation);
    lines.push(
      '## 校验结果',
      '',
      `- 是否通过：${validation.valid === true ? '是' : '否'}`,
      `- 修复次数：${typeof validation.repairAttempts === 'number' ? validation.repairAttempts : 0}`,
    );
    for (const issue of objectArray(validation.issues)) {
      lines.push(`- [${text(issue.severity) || 'warning'}] ${text(issue.message) || text(issue.code) || '未说明'}`);
    }

    const formula = asObject(pkg.formulaSnapshot);
    const knowledge = asObject(pkg.knowledgeSnapshot);
    lines.push(
      '',
      '## 生成追溯',
      '',
      `- 生成时间：${text(pkg.createdAt) || 'unknown'}`,
      `- 随机种子：${text(pkg.seed) || 'unknown'}`,
      `- 公式版本：${text(formula.versionId) || 'unknown'}`,
      `- 公式摘要：${text(formula.digest) || 'unknown'}`,
      `- 知识注入模式：${text(knowledge.mode) || 'unknown'}`,
      `- 知识文件数：${objectArray(knowledge.documents).length}`,
      '',
    );
    return lines.join('\n');
  }

  resolveCjkFontPath(configured?: string): string | undefined {
    const explicit = configured ?? process.env.CONTENT_AGENT_CJK_FONT_PATH;
    const candidates = [
      ...(explicit ? [resolve(explicit)] : []),
      ...(platform() === 'win32'
        ? WINDOWS_FONT_CANDIDATES
        : platform() === 'darwin'
          ? MAC_FONT_CANDIDATES
          : LINUX_FONT_CANDIDATES),
      ...WINDOWS_FONT_CANDIDATES,
      ...LINUX_FONT_CANDIDATES,
      ...MAC_FONT_CANDIDATES,
    ];
    return candidates.find((candidate) => existsSync(candidate));
  }

  private validatePackage(value: unknown): JsonObject {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('ContentPackage 必须是 JSON 对象');
    }
    const pkg = normalizeContentPackageForApi(value as JsonObject);
    const content = asObject(pkg.content);
    if (!Object.keys(content).length || !Object.keys(asObject(content.N)).length) {
      throw new BadRequestException('ContentPackage 缺少 content.N');
    }
    const validation = asObject(pkg.validation);
    if (validation.valid !== true) {
      throw new BadRequestException('候选未通过事实、证据与信息闭合校验，禁止导出；请先修复错误或重新生成');
    }
    return pkg;
  }

  private async toDocx(pkg: JsonObject, options: ExportOptions): Promise<Buffer> {
    const markdown = this.toMarkdown(pkg);
    const font = options.docxFontName ?? process.env.CONTENT_AGENT_DOCX_FONT_NAME ?? 'Microsoft YaHei';
    const children = markdown.split('\n').map((line) => markdownLineToParagraph(line, font));
    const section: ISectionOptions = { properties: {}, children };
    const document = new Document({
      styles: {
        default: {
          document: {
            run: { font, size: 21 },
            paragraph: { spacing: { after: 100, line: 300 } },
          },
        },
      },
      sections: [section],
    });
    return Packer.toBuffer(document);
  }

  private async toPdf(pkg: JsonObject, options: ExportOptions): Promise<Buffer> {
    const markdown = this.toMarkdown(pkg);
    const document = new PDFDocument({
      size: 'A4',
      margins: { top: 48, right: 48, bottom: 48, left: 48 },
      bufferPages: true,
      info: {
        Title: text(asObject(asObject(pkg.content).N).title) || 'Content Package',
        Author: 'Content Agent',
      },
    });
    const chunks: Buffer[] = [];
    const completed = new Promise<Buffer>((resolveBuffer, reject) => {
      document.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      document.on('end', () => resolveBuffer(Buffer.concat(chunks)));
      document.on('error', reject);
    });

    const fontPath = this.resolveCjkFontPath(options.cjkFontPath);
    if (fontPath) {
      try {
        document.font(fontPath);
      } catch {
        document.font('Helvetica');
      }
    } else {
      document.font('Helvetica');
    }

    for (const rawLine of markdown.split('\n')) {
      const line = rawLine.trimEnd();
      if (line.startsWith('# ')) {
        document.moveDown(0.3).fontSize(20).text(line.slice(2), { lineGap: 4 }).moveDown(0.4);
      } else if (line.startsWith('## ')) {
        document.moveDown(0.4).fontSize(15).text(line.slice(3), { lineGap: 3 }).moveDown(0.25);
      } else if (line.startsWith('### ')) {
        document.moveDown(0.25).fontSize(12).text(line.slice(4), { lineGap: 2 });
      } else if (!line) {
        document.moveDown(0.35);
      } else {
        document.fontSize(10.5).text(stripMarkdown(line), { lineGap: 3 });
      }
    }
    document.end();
    return completed;
  }
}

function markdownLineToParagraph(line: string, font: string): Paragraph {
  if (line.startsWith('# ')) {
    return new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: line.slice(2), font, bold: true })],
    });
  }
  if (line.startsWith('## ')) {
    return new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: line.slice(3), font, bold: true })],
    });
  }
  if (line.startsWith('### ')) {
    return new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [new TextRun({ text: line.slice(4), font, bold: true })],
    });
  }
  if (line.startsWith('- ')) {
    return new Paragraph({
      bullet: { level: 0 },
      children: [new TextRun({ text: stripMarkdown(line.slice(2)), font })],
    });
  }
  if (line.startsWith('  - ')) {
    return new Paragraph({
      bullet: { level: 1 },
      children: [new TextRun({ text: stripMarkdown(line.slice(4)), font })],
    });
  }
  if (line.startsWith('> ')) {
    return new Paragraph({
      indent: { left: 360 },
      children: [new TextRun({ text: stripMarkdown(line.slice(2)), font, italics: true })],
    });
  }
  return new Paragraph({ children: [new TextRun({ text: stripMarkdown(line), font })] });
}

function appendObjectList(
  lines: string[],
  title: string,
  items: JsonObject[],
  render: (item: JsonObject) => string,
): void {
  lines.push(`## ${title}`, '');
  if (!items.length) {
    lines.push('_无_', '');
    return;
  }
  for (const item of items) lines.push(`- ${render(item)}`);
  lines.push('');
}

function appendDiagnosticLedger(lines: string[], pkg: JsonObject): void {
  const diagnostics = objectArray(pkg.diagnostics).map(normalizeDiagnosticForApi);
  const seenFormulaIds = new Set(
    diagnostics
      .map((diagnostic) => text(diagnostic.formulaId))
      .filter((formulaId) => formulaId === 'F32' || formulaId === 'F33'),
  );
  const impactProxies = objectArray(asObject(pkg.impactReport).diagnosticProxies)
    .map(normalizeDiagnosticProxyForApi)
    .filter((proxy) => {
      const formulaId = text(proxy.formulaId);
      if (formulaId !== 'F32' && formulaId !== 'F33') return false;
      if (seenFormulaIds.has(formulaId)) return false;
      seenFormulaIds.add(formulaId);
      return true;
    });
  const proxyDiagnostics = [
    ...diagnostics.filter((diagnostic) => ['F32', 'F33'].includes(text(diagnostic.formulaId))),
    ...impactProxies,
  ];
  const ordinaryDiagnostics = diagnostics.filter((diagnostic) => !['F32', 'F33'].includes(text(diagnostic.formulaId)));

  lines.push('## 校验与一般诊断', '');
  if (!ordinaryDiagnostics.length) {
    lines.push('_无_', '');
  } else {
    for (const diagnostic of ordinaryDiagnostics) {
      const metric = typeof diagnostic.score === 'number' ? `，校验指标值 ${diagnostic.score}` : '';
      lines.push(`- [${text(diagnostic.status) || 'unknown'}] ${text(diagnostic.name) || '未命名'}${metric}：${text(diagnostic.explanation) || '未说明'}`);
    }
    lines.push('');
  }

  lines.push('## F32/F33 分项审查元数据（非质量分）', '');
  if (!proxyDiagnostics.length) {
    lines.push('_本内容包未记录 F32/F33 分项合同；不得据此推断分项值、总分或质量。_', '');
    return;
  }
  for (const diagnostic of proxyDiagnostics) appendProxyDiagnostic(lines, diagnostic);
  lines.push('- 统一边界：emphasis 只控制展示顺序和人工复核优先级；不改变阈值、结论、生成、规划、选稿或校验。', '');
}

function appendProxyDiagnostic(lines: string[], diagnostic: JsonObject): void {
  const formulaId = text(diagnostic.formulaId) || 'unknown';
  const contractStatus = text(diagnostic.contractStatus)
    || (Object.keys(asObject(diagnostic.diagnosticContract)).length ? 'reviewed_snapshot' : 'unknown');
  lines.push(
    `### ${formulaId} · ${text(diagnostic.name) || '未命名分项审查'}`,
    '',
    `- 合同状态：${contractStatus}`,
    `- 语义：${text(diagnostic.semantics) || 'unknown'}`,
    `- 状态 / 求值状态：${text(diagnostic.status) || 'unknown'} / ${text(diagnostic.evaluationStatus) || 'unknown'}`,
    `- 证据状态：${text(diagnostic.evidenceStatus) || 'unknown'}`,
    `- 聚合方式：${text(diagnostic.aggregation) || 'unknown'}`,
    `- 聚合值：${diagnostic.aggregateValue === null ? 'unknown（null）' : 'unknown'}`,
    `- 是否产生分数：${diagnostic.scoreProduced === false ? '否' : 'unknown'}`,
    `- 公式语义指纹：${text(diagnostic.formulaSemanticFingerprint) || 'unknown'}`,
  );
  const unknown = asObject(diagnostic.unknown);
  if (Object.keys(unknown).length) {
    lines.push(
      `- 历史未知原因：${text(unknown.reason) || 'unknown'}；缺失字段=${stringArray(unknown.missingFields).join('、') || 'unknown'}`,
    );
  }
  const warning = text(diagnostic.warning) || text(diagnostic.explanation);
  if (warning) lines.push(`- 边界说明：${warning}`);

  const components = objectArray(diagnostic.components);
  if (!components.length) {
    lines.push('- 分项：unknown；不得把缺失分项记为 0。', '');
    return;
  }
  for (const component of components) {
    const displayOrder = typeof component.displayOrder === 'number' ? String(component.displayOrder) : 'unknown';
    const reviewRank = typeof component.manualReviewRank === 'number' ? String(component.manualReviewRank) : 'unknown';
    const emphasis = typeof component.emphasis === 'number' ? String(component.emphasis) : 'unknown';
    lines.push(
      `- 分项 ${text(component.id) || 'unknown'}（${text(component.label) || '未命名'}）：展示顺序=${displayOrder}；人工复核排名=${reviewRank}；emphasis=${emphasis}；emphasis语义=${text(component.emphasisSemantics) || 'unknown'}；方向=${text(component.direction) || 'unknown'}；状态=${text(component.status) || 'unknown'}；求值状态=${text(component.evaluationStatus) || 'unknown'}；值=${component.value === null ? 'unknown（null）' : 'unknown'}；证据=${text(component.evidenceStatus) || 'unknown'}`,
    );
    if (text(component.boundary)) lines.push(`  - 分项边界：${text(component.boundary)}`);
  }
  lines.push('');
}

function appendVisualProductionLedger(lines: string[], pkg: JsonObject, actualImageBrief: string): void {
  const packageArtifacts = asObject(pkg.productionArtifacts);
  const artifacts = Object.keys(packageArtifacts).length
    ? packageArtifacts
    : asObject(asObject(pkg.orchestrationSnapshot).productionArtifacts);
  const imagePlan = asObject(pkg.imagePlan);
  lines.push('## 图片生产事实台账', '');
  lines.push(
    `- 实际图片简报（content.N.imageBrief）：${actualImageBrief || '未提供'}`,
    `- 图片规划：${Object.keys(imagePlan).length ? '已记录规划；它不是最终图片' : '未记录'}`,
  );
  if (text(imagePlan.role)) lines.push(`- 规划角色：${text(imagePlan.role)}`);
  if (text(imagePlan.composition)) lines.push(`- 规划构图：${text(imagePlan.composition)}`);

  if (!Object.keys(artifacts).length) {
    lines.push('- 生产状态：历史内容包未记录，不能据此推断已有最终图片、入口快照或已经发布。', '');
    return;
  }

  const lifecycleNodes: Array<[string, string]> = [
    ['图片观察', 'imageObservation'],
    ['图片规划', 'imagePlan'],
    ['图片简报', 'imageBrief'],
    ['最终图片资产', 'finalImageAsset'],
    ['入口快照', 'entrySnapshot'],
    ['发布部署', 'deployment'],
  ];
  for (const [label, key] of lifecycleNodes) {
    const node = asObject(artifacts[key]);
    const status = text(node.status);
    if (!status) continue;
    const sourceAssetId = text(node.sourceAssetId);
    const analysisAssetIds = stringArray(node.analysisAssetIds);
    const finalAssetId = text(node.assetId);
    const snapshotId = text(node.snapshotId);
    const note = text(node.note);
    lines.push(
      `- ${label}状态：${status}${sourceAssetId ? `；源素材=${sourceAssetId}` : ''}${analysisAssetIds.length ? `；已审批分析=${analysisAssetIds.join('、')}` : ''}${finalAssetId ? `；最终资产=${finalAssetId}` : ''}${snapshotId ? `；入口快照=${snapshotId}` : ''}${note ? `；说明=${note}` : ''}`,
    );
  }
  const alignments: Array<[string, string]> = [
    ['规划→图片简报', 'planToCopyAlignment'],
    ['规划/简报→最终图片', 'finalAssetAlignment'],
    ['最终图片/文案→入口快照', 'entrySnapshotAlignment'],
  ];
  for (const [label, key] of alignments) {
    const alignment = asObject(artifacts[key]);
    const status = text(alignment.status);
    if (!status) continue;
    const reasons = stringArray(alignment.reasons);
    lines.push(`- ${label}一致性：${status}；是否已评估=${alignment.evaluated === true ? '是' : '否'}${reasons.length ? `；原因=${reasons.join('；')}` : ''}`);
    for (const check of objectArray(alignment.checks)) {
      lines.push(`  - [${text(check.status) || 'not_evaluated'}] ${text(check.id) || 'check'}：${text(check.reason) || '未说明'}`);
    }
  }
  lines.push('- 边界：上传 image_assets 仅是源素材；规划与简报也不证明最终图片、入口截图或发布事实。', '');
}

function appendOpportunityRankAudit(lines: string[], pkg: JsonObject): void {
  const snapshot = asObject(pkg.opportunitySnapshot);
  const audit = asObject(snapshot.opportunitySelectionAudit);
  if (!Object.keys(audit).length) return;

  lines.push('## 机会选择与排序审计', '');
  lines.push(
    `- 选中机会：${text(audit.selectedOpportunityId) || 'unknown'}`,
    `- 选择方式：${text(audit.selectionMode) || 'unknown'}`,
    `- 排序状态：${text(audit.rankStatus) || 'unknown'}`,
  );
  if (text(audit.rankNotAppliedReason)) {
    lines.push(`- 未运行排序的原因：${text(audit.rankNotAppliedReason)}`);
  }

  const ranked = asObject(audit.selectedOpportunityRank);
  if (!Object.keys(ranked).length) {
    lines.push('- 排序结果：未作为本次选择依据；不得从空值推断排名或分数。', '');
    return;
  }
  const heuristic = asObject(ranked.heuristic);
  lines.push(
    `- 算法：${text(heuristic.id) || 'unknown'} / ${text(heuristic.version) || 'unknown'}`,
    `- 语义：${text(ranked.scoreSemantics) || text(heuristic.scoreSemantics) || 'unknown'}（仅为非因果顺序启发式）`,
    `- 权重已标定：${heuristic.weightsCalibrated === false ? '否' : 'unknown'}`,
    `- 因果模型：${heuristic.causal === false ? '否' : 'unknown'}`,
    `- 是否为 F28：${heuristic.notF28 === true ? '否（notF28=true）' : 'unknown'}`,
    `- 名次 / 最终值：${text(ranked.rank) || 'unranked'} / ${text(ranked.finalScore) || 'unknown'}`,
    `- 生效资格：${text(ranked.effectiveEligibility) || 'unknown'}；需要复核=${ranked.reviewRequired === true ? '是' : '否'}`,
    `- 未知指标：${stringArray(ranked.unknownMetrics).join('、') || '无'}`,
  );
  const reviewReasons = stringArray(ranked.reviewReasons);
  if (reviewReasons.length) lines.push(`- 复核原因：${reviewReasons.join('；')}`);
  const weights = asObject(heuristic.weights);
  if (Object.keys(weights).length) lines.push(`- 固定权重（未标定）：${JSON.stringify(weights)}`);
  const policy = asObject(ranked.policy);
  if (Object.keys(policy).length) lines.push(`- 本次资格与去重策略快照：${JSON.stringify(policy)}`);
  for (const component of objectArray(ranked.components)) {
    const componentSource = asObject(component.source);
    lines.push(
      `- 分项 ${text(component.metric) || 'unknown'}：原值=${text(component.rawValue) || 'unknown'}，变换=${text(component.transformation) || 'unknown'}，贡献=${text(component.contribution) || 'unknown'}，来源=${text(componentSource.source) || 'unknown'}${text(componentSource.sourceRef) ? ` (${text(componentSource.sourceRef)})` : ''}`,
    );
  }
  const inputs = asObject(ranked.inputSources);
  for (const field of ['status', 'topic', 'gapIds', 'recentCoverage', 'options']) {
    const source = asObject(inputs[field]);
    if (Object.keys(source).length) {
      lines.push(`- 输入来源 ${field}：${text(source.source) || 'unknown'}${text(source.sourceRef) ? ` (${text(source.sourceRef)})` : ''}`);
    }
  }
  lines.push('');
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

function objectArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(asObject).filter((item) => Object.keys(item).length > 0) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

function normalizeHashtag(value: string): string {
  const clean = value.trim().replace(/^#+/, '').replace(/\s+/g, '');
  return clean ? `#${clean}` : '';
}

function stripMarkdown(value: string): string {
  return value
    .replace(/^>\s?/, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}
