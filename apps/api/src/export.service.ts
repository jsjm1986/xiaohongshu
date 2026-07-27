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
    // Cref contract v1.1 packages export in the two-part layout (executive
    // copy first, audit appendix last). Historical packages without any v1.1
    // marker keep the legacy single-flow output below byte-for-byte.
    if (isCrefV11Package(pkg)) return renderCrefV11TwoPartMarkdown(pkg);
    const content = asObject(pkg.content);
    const headline = asObject(content.N);
    const hashtags = stringArray(asObject(content.H).hashtags);
    const comments = asObject(content.Cref);
    const threads = objectArray(comments.threads);
    const dialoguePlans = objectArray(pkg.dialogueThreads);
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
    // Cref contract v1.1: publisher-owned first comment, only when the model
    // actually produced one (never synthesized after the fact).
    if (text(comments.ownedFirstComment)) {
      lines.push(`> 【可发布首评参考】由发布账号（publisher）身份发布：${text(comments.ownedFirstComment)}`, '');
    }
    if (threads.length === 0) {
      lines.push('_未提供评论区参考_', '');
    } else {
      appendCommentThreadAudit(lines, threads, dialoguePlans);
    }

    appendUncoveredGapProjection(lines, comments);

    appendDeploymentOperations(lines, pkg);

    appendAuditTrail(lines, pkg);
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

/**
 * Two-part layout gate (Cref contract v1.1). Returns true only when the
 * package actually carries v1.1 Cref data: schemaVersion "1.1", a Cref-level
 * ownedFirstComment / uncoveredGaps projection, or any thread / followUp
 * v1.1 field (kind / answerKind / boundary / nextStep / evidenceIds).
 * Historical v1.0 packages without those markers keep the legacy single-flow
 * markdown byte-for-byte. Deployment-plan v1.1 markers alone (sla /
 * updatePolicy / structured liveRouting) do not flip the layout — they only
 * open the aC rules section within whichever layout applies.
 */
function isCrefV11Package(pkg: JsonObject): boolean {
  if (text(pkg.schemaVersion) === '1.1') return true;
  const comments = asObject(asObject(pkg.content).Cref);
  if (text(comments.ownedFirstComment)) return true;
  if (Array.isArray(comments.uncoveredGaps)) return true;
  return objectArray(comments.threads).some((thread) => hasCrefV11NodeFields(thread));
}

function hasCrefV11NodeFields(node: JsonObject): boolean {
  if (text(node.kind) || text(node.answerKind) || text(node.boundary) || text(node.nextStep)) return true;
  if (stringArray(node.evidenceIds).length > 0) return true;
  return objectArray(node.followUps).some((followUp) => hasCrefV11NodeFields(followUp));
}

/**
 * Two-part markdown for Cref contract v1.1 packages: an executive part the
 * operator can act on directly (publish copy, owned first comment, dialogue
 * scripts, aC operating rules), then a clearly separated audit appendix with
 * the full metadata trail. Audit vocabulary (role cards, density proxies,
 * reply plans, discovery plans, evidence ids) stays out of the executive part.
 */
function renderCrefV11TwoPartMarkdown(pkg: JsonObject): string {
  const content = asObject(pkg.content);
  const headline = asObject(content.N);
  const hashtags = stringArray(asObject(content.H).hashtags);
  const comments = asObject(content.Cref);
  const threads = objectArray(comments.threads);
  const dialoguePlans = objectArray(pkg.dialogueThreads);
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
  ];

  // Publisher-owned first comment, only when the model actually produced one
  // (never synthesized after the fact).
  if (text(comments.ownedFirstComment)) {
    lines.push(
      '## 可发布首评参考',
      '',
      `> 【可发布首评参考】由发布账号（publisher）身份发布：${text(comments.ownedFirstComment)}`,
      '',
    );
  }

  // Dialogue scripts: only what the operator needs to reply — question,
  // answer, accountable identity, boundary, next step and follow-up pairs.
  lines.push(
    '## 问答话术（模拟情景演练，非真实评论）',
    '',
    `> 【模拟情景，非真实评论】${text(comments.disclaimer) || '以下内容仅用于演练潜在读者问题与可追责答复。'}`,
    '',
  );
  if (threads.length === 0) {
    lines.push('_未提供问答话术_', '');
  } else {
    threads.forEach((thread, index) => {
      // 读者互动层:T2 读者互聊的「回复」位是读者 B 接话;T3 漂浮短反应无回答
      // 需求;T1(含历史包缺省 threadKind)维持机构问答格式。
      const threadKind = text(thread.threadKind);
      const replyOrg = commentReplyOrgName(thread);
      if (threadKind === 'organic_reaction') {
        lines.push(
          `### 话术 ${index + 1}（漂浮短反应）`,
          '',
          `- 漂浮反应：${commentNicknamePrefix(thread.displayName)}${text(thread.question) || '未提供'}`,
          '- 无需机构回复（4-20 字短共鸣，机构不出现）',
        );
      } else if (threadKind === 'reader_exchange') {
        lines.push(
          `### 话术 ${index + 1}（读者互聊）`,
          '',
          `- 提问：${commentNicknamePrefix(thread.displayName)}${text(thread.question) || '未提供'}`,
          `- 读者接话：${commentNicknamePrefix(thread.replyDisplayName)}${text(thread.answer) || '未提供'}`,
          `- 互动类型：读者互聊（模拟读者之间接话，不谈项目事实；真实问题由${postingIdentityText(thread.postingIdentity) || '可追责发布者'}承接）`,
        );
      } else {
        lines.push(
          `### 话术 ${index + 1}`,
          '',
          `- 提问：${commentNicknamePrefix(thread.displayName)}${text(thread.question) || '未提供'}`,
          `- 回复：${replyOrg ? `${replyOrg}：` : ''}${text(thread.answer) || '未提供'}`,
          `- 可追责答复身份：${postingIdentityText(thread.postingIdentity) || '未标注'}`,
        );
      }
      if (threadKind !== 'organic_reaction' && text(thread.boundary)) lines.push(`- 答复边界：${text(thread.boundary)}`);
      if (threadKind !== 'organic_reaction' && text(thread.nextStep)) lines.push(`- 下一步：${text(thread.nextStep)}`);
      for (const followUp of objectArray(thread.followUps)) {
        lines.push(
          `  - 追问：${commentNicknamePrefix(followUp.displayName)}${text(followUp.question) || '未提供'}`,
          `  - 补充：${text(followUp.answer) || '未提供'}`,
        );
      }
      lines.push('');
    });
  }

  appendDeploymentOperations(lines, pkg);

  lines.push(
    '---',
    '',
    '# 审计附录（非发布素材）',
    '',
    '## 评论线程完整元数据',
    '',
  );
  if (threads.length === 0) {
    lines.push('_无评论线程_', '');
  } else {
    appendCommentThreadAudit(lines, threads, dialoguePlans);
  }
  appendUncoveredGapProjection(lines, comments);
  appendAuditTrail(lines, pkg);
  return lines.join('\n');
}

/** Full per-thread audit metadata, shared by the legacy flow and the v1.1 audit appendix. */
function appendCommentThreadAudit(lines: string[], threads: JsonObject[], dialoguePlans: JsonObject[]): void {
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
      `- ${auditAnswerAttribution(thread).label}：${text(thread.answer) || '未提供'}`,
      `- 可追责答复身份：${auditAnswerAttribution(thread).identity}`,
    );
    // v1.1 node metadata; each line renders only when the field exists, so
    // historical packages keep their previous output verbatim.
    if (text(thread.kind) || text(thread.answerKind)) lines.push(
      `- 节点类型：提问=${commentKindText(text(thread.kind)) || '问题（默认）'}；答复=${commentKindText(text(thread.answerKind)) || '回答（默认）'}`,
    );
    // 读者互动层:线程形态只在字段存在时输出;历史包保持原样。
    if (text(thread.threadKind)) lines.push(
      `- 互动类型：${commentThreadKindText(text(thread.threadKind))}${text(thread.threadKind) === 'reader_exchange' && text(thread.replyDisplayName) ? `（${text(thread.displayName) || '读者A'} → ${text(thread.replyDisplayName)}）` : ''}`,
    );
    if (text(thread.boundary)) lines.push(`- 答复边界：${text(thread.boundary)}`);
    if (stringArray(thread.evidenceIds).length) lines.push(`- 证据引用：${stringArray(thread.evidenceIds).join('、')}`);
    if (text(thread.nextStep)) lines.push(`- 下一步：${text(thread.nextStep)}`);
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
      if (text(followUp.kind)) lines.push(`  - 追问节点类型：${commentKindText(text(followUp.kind)) || text(followUp.kind)}`);
      if (text(followUp.boundary)) lines.push(`  - 追问边界：${text(followUp.boundary)}`);
      if (stringArray(followUp.evidenceIds).length) lines.push(`  - 追问证据引用：${stringArray(followUp.evidenceIds).join('、')}`);
    }
    lines.push('');
  });
}

/**
 * Cref contract v1.1: plan-level uncovered-gap projection. Absent means "not
 * computed" (historical packages) and renders nothing; an empty list is an
 * honest computed result, not a missing field.
 */
function appendUncoveredGapProjection(lines: string[], comments: JsonObject): void {
  if (Array.isArray(comments.uncoveredGaps)) {
    const uncovered = stringArray(comments.uncoveredGaps);
    lines.push(
      uncovered.length
        ? `- 本篇未展开缺口（规划期投影，非遗漏错误）：${uncovered.join('、')}`
        : '- 本篇未展开缺口（规划期投影）：无；所有选中缺口已由评论线程或正文承担。',
      '',
    );
  }
}

/**
 * Audit-trail sections after the comment content: coverage ledger, evidence,
 * reasoning, unknowns, conflicts, diagnostics, production ledger, opportunity
 * audit, validation result and generation trace. Shared verbatim by the
 * legacy single flow and the v1.1 audit appendix.
 */
function appendAuditTrail(lines: string[], pkg: JsonObject): void {
  const coverageLedger = asObject(asObject(pkg.orchestrationSnapshot).gapCoverageLedger);
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

  appendVisualProductionLedger(lines, pkg, text(asObject(asObject(pkg.content).N).imageBrief));
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

/**
 * aC operating rules (Cref contract v1.1), listed separately from Cref
 * reference content (F03). The section renders only when the deployment plan
 * carries v1.1 markers (sla / updatePolicy / structured liveRouting), so
 * historical packages with a legacy static template keep their previous
 * output verbatim.
 */
function appendDeploymentOperations(lines: string[], pkg: JsonObject): void {
  const deployment = asObject(pkg.deploymentPlan);
  if (!Object.keys(deployment).length) return;
  const routing = Array.isArray(deployment.liveRouting) ? deployment.liveRouting : [];
  const hasStructuredRouting = routing.some(
    (rule) => typeof rule === 'object' && rule !== null && !Array.isArray(rule)
      && ('route' in rule || 'condition' in rule || 'action' in rule),
  );
  const hasV11Operations = Boolean(text(deployment.sla))
    || stringArray(deployment.updatePolicy).length > 0
    || hasStructuredRouting;
  if (!hasV11Operations) return;

  lines.push('## aC · 评论运营规则（运营动作计划，非 Cref 内容，非已执行）', '');
  if (text(deployment.sla) || text(deployment.responseSla)) {
    lines.push(`- 答复时效（SLA）：${text(deployment.sla) || text(deployment.responseSla)}`);
  }
  for (const rule of routing) {
    if (typeof rule === 'string') {
      lines.push(`- 路由：${rule}`);
      continue;
    }
    const structured = asObject(rule);
    lines.push(
      `- 路由 ${text(structured.route) || text(structured.intent) || '未命名'}：${text(structured.condition) || text(structured.reason) || '条件未标注'} → ${text(structured.action) || text(structured.target) || '动作未标注'}`,
    );
  }
  for (const item of stringArray(deployment.updatePolicy)) lines.push(`- 更新政策：${item}`);
  for (const item of stringArray(deployment.updateTriggers)) lines.push(`- 更新触发：${item}`);
  for (const item of stringArray(deployment.stopRules)) lines.push(`- 停止规则：${item}`);
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

/** Dialogic node kind → Chinese label (Cref contract v1.1); unknown values pass through raw. */
function commentKindText(value: string): string {
  const labels: Record<string, string> = {
    question: '问题',
    answer: '回答',
    follow_up: '追问',
    clarification: '澄清',
  };
  return value ? labels[value] || value : '';
}

/** 线程级互动形态(读者互动层) → 中文标签;未知值原样透传。 */
function commentThreadKindText(value: string): string {
  const labels: Record<string, string> = {
    org_answer: '机构问答',
    reader_exchange: '读者互聊',
    organic_reaction: '漂浮短反应',
  };
  return value ? labels[value] || value : '';
}

/**
 * Accountable posting identity for export. `publisher` (v1.1) is the
 * publishing account itself; historical values stay raw for readability.
 */
function postingIdentityText(value: unknown): string {
  const raw = text(value);
  if (!raw) return '';
  return raw === 'publisher' ? '发布账号（publisher）' : raw;
}

function objectArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(asObject).filter((item) => Object.keys(item).length > 0) : [];
}

/** 提问侧展示昵称前缀:有 displayName 时输出「昵称：」,历史包(无昵称)保持原格式。 */
function commentNicknamePrefix(value: unknown): string {
  const name = text(value).trim();
  return name ? `${name}：` : '';
}

/**
 * 答复侧机构名:surfaceRoleCard.replyDisplayRole 原样显示;assistant_account /
 * host_account 这类内部 id 形态只显示「机构助理/机构 IP」通用文案,不裸露内部
 * id;缺失时返回空串,导出保持原格式不加前缀。
 */
function commentReplyOrgName(thread: JsonObject): string {
  const raw = text(asObject(thread.surfaceRoleCard).replyDisplayRole).trim();
  if (!raw) return '';
  if (/^[a-z][a-z0-9_]*$/.test(raw)) return text(thread.postingIdentity) === 'staff' ? '机构助理' : '机构 IP';
  return raw;
}

/**
 * 审计附录里「这条 answer 由谁发出」。与 web 侧 comment-cref.auditAnswerAttribution
 * 同一套判定(这里是手抄:export.service 在 api 包,不引 web 的模块)。
 *
 * 起因是审计附录此前无条件套机构口径,而正文区(话术段)早已按 threadKind 分路,
 * 于是同一份导出里同一句读者接话在正文标「读者接话」、在附录标「可追责答复身份：
 * staff」。reader_exchange 的 answer 是另一位模拟读者接话,replyDisplayName 就带着
 * 正确昵称;postingIdentity 是规划层按线程统一赋的预留身份,不表示谁在说话。
 */
function auditAnswerAttribution(thread: JsonObject): { label: string; identity: string } {
  if (text(thread.threadKind) === 'reader_exchange') {
    const nickname = text(thread.replyDisplayName).trim();
    return {
      label: nickname ? `模拟读者接话（${nickname}）` : '模拟读者接话',
      identity: '不适用（读者互聊，非机构发言）',
    };
  }
  return {
    label: '回复',
    identity: postingIdentityText(thread.postingIdentity) || '未标注',
  };
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
