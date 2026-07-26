import type { ReactNode } from 'react';

/**
 * v2 设计原语：页面级构图的共享件。
 * 视觉与 DashboardPage 试点完全一致（同一套 .v2-* CSS），供全站页面复用。
 */

export function V2Hero({
  index,
  status,
  title,
  description,
  actions,
}: {
  /** 幽影巨号（页面序号，如 "01"）；不传则不显示 */
  index?: string;
  /** 状态行（绿点 + 项目/系统状态），如 "去眼袋项目 · 系统正常" */
  status: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="v2-hero">
      {index && <span className="v2-hero__ghost">{index}</span>}
      <div className="v2-hero__text">
        <div className="v2-hero__status"><i />{status}</div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
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
