import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { ALL_CHANNELS } from '../lib/channels';
import { navItemForPath } from '../lib/nav-groups';

/**
 * hero 左侧的频道标记:图标卡片 + 频道名。
 *
 * 按当前路径回查频道表。路径不在表里(例如 /generations/:id 这类详情页)时
 * 整块不渲染——与其显示一个错的频道,不如不显示。
 */
function HeroMark() {
  const { pathname } = useLocation();
  const channel = navItemForPath(ALL_CHANNELS, pathname);
  if (!channel) return null;
  const Icon = channel.icon;
  return (
    <span className="v2-hero__mark" aria-hidden="true">
      <Icon size={21} strokeWidth={1.9} />
    </span>
  );
}

/**
 * v2 设计原语：页面级构图的共享件。
 * 视觉与 DashboardPage 试点完全一致（同一套 .v2-* CSS），供全站页面复用。
 */

/**
 * 页面 hero。
 *
 * mark 取代了原来的 index="01".."10" 幽影巨号:那是十处硬编码序号,靠人工与
 * 侧边栏顺序对齐,导航一改就指错位置。现在由 <HeroMark /> 按当前路径回查导航
 * 定义,图标与频道名都来自 AppShell 那一张表,不再需要每页维护一个字符串。
 */
export function V2Hero({
  status,
  title,
  description,
  actions,
}: {
  /** 状态行（绿点 + 项目/系统状态），如 "去眼袋项目 · 系统正常" */
  status: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="v2-hero">
      <div className="v2-hero__text">
        <div className="v2-hero__status"><i />{status}</div>
        <div className="v2-hero__headline">
          <HeroMark />
          <div>
            <h1>{title}</h1>
            {description && <p>{description}</p>}
          </div>
        </div>
      </div>
      {actions && <div className="v2-hero__actions">{actions}</div>}
    </section>
  );
}

export type V2InstrumentTone = 'brand' | 'blue' | 'ai' | 'ok' | 'error' | 'warn';

export function V2Instrument({ children, columns }: { children: ReactNode; columns?: 2 | 3 | 4 }) {
  return (
    <section className={`v2-instrument${columns && columns !== 4 ? ` v2-instrument--${columns}` : ''}`}>
      {children}
    </section>
  );
}

export function V2InstrumentCell({
  tone,
  icon,
  label,
  value,
  unit,
  note,
  mono,
  text,
}: {
  tone: V2InstrumentTone;
  icon: ReactNode;
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  note?: ReactNode;
  /** 大数字使用等宽字体（版本号/编号类） */
  mono?: boolean;
  /**
   * 值是文字而非数字（「驾驶培训」「尚未分析」）。
   *
   * 读数样式是为数字设计的：28—31px / 750 字重 / 负字距。套在词组上，一个纯标签
   * 会和页面标题一样重——实测知识库页「实体：驾驶培训」就是这样，两格 30px 大字
   * 压过了真正的读数「18 个选题」。文字值降一档、字距归零。
   */
  text?: boolean;
}) {
  const valueClass = [
    'v2-instrument__value',
    mono ? 'v2-instrument__value--mono' : '',
    text ? 'v2-instrument__value--text' : '',
  ].filter(Boolean).join(' ');
  return (
    <div className={`v2-instrument__cell v2-instrument__cell--${tone}`}>
      <div className="v2-instrument__label">
        <span className={`v2-instrument__chip v2-instrument__chip--${tone}`}>{icon}</span>
        {label}
      </div>
      <div className={valueClass}>
        {value}
        {unit && <small>{unit}</small>}
      </div>
      {note && <div className="v2-instrument__note">{note}</div>}
    </div>
  );
}

export function V2SecLabel({ children }: { children: ReactNode }) {
  return <span className="v2-sec-label">{children}</span>;
}
