import type { Candidate, CommentThread } from '../types';

export interface QuickComment {
  question: string;
  answer: string;
  boundary?: string;
  nextStep?: string;
  followUps?: Array<{ question: string; answer: string; boundary?: string }>;
}

export interface QuickCandidateView {
  id: string;
  label?: string;
  publishable: boolean;
  title: string;
  body: string;
  tags: string[];
  imageBrief?: string;
  commentOwnedFirstComment?: string;
  comments: QuickComment[];
}

function mapComment(thread: CommentThread): QuickComment {
  return {
    question: thread.question,
    answer: thread.answer,
    boundary: thread.boundary,
    nextStep: thread.nextStep,
    followUps: thread.followUps?.map((f) => ({
      question: f.question,
      answer: f.answer,
      boundary: f.boundary,
    })),
  };
}

export function quickCandidateFields(candidate: Candidate): QuickCandidateView {
  return {
    id: candidate.id,
    label: candidate.label,
    publishable: candidate.validation?.valid === true,
    title: candidate.title,
    body: candidate.body,
    tags: candidate.tags ?? [],
    imageBrief: candidate.imageBrief,
    commentOwnedFirstComment: candidate.commentOwnedFirstComment,
    comments: (candidate.comments ?? []).map(mapComment),
  };
}

export function quickCandidateToMarkdown(view: QuickCandidateView): string {
  const parts: string[] = [];
  parts.push(`# ${view.title}`);
  parts.push('');
  parts.push(view.body);
  if (view.tags.length) {
    parts.push('');
    parts.push(view.tags.map((t) => `#${t}`).join(' '));
  }
  if (view.imageBrief) {
    parts.push('');
    parts.push(`## 图片简报`);
    parts.push(view.imageBrief);
  }
  if (view.commentOwnedFirstComment) {
    parts.push('');
    parts.push(`## 可发布首评`);
    parts.push(view.commentOwnedFirstComment);
  }
  if (view.comments.length) {
    parts.push('');
    parts.push(`## 问答话术`);
    for (const c of view.comments) {
      parts.push('');
      parts.push(`Q: ${c.question}`);
      parts.push(`A: ${c.answer}`);
      if (c.boundary) parts.push(`边界: ${c.boundary}`);
      if (c.nextStep) parts.push(`下一步: ${c.nextStep}`);
      for (const f of c.followUps ?? []) {
        parts.push(`  · 追问: ${f.question}`);
        parts.push(`    回应: ${f.answer}`);
      }
    }
  }
  return parts.join('\n');
}
