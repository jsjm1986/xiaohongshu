import type { GenerationJob } from '../types';

export interface ReaderNeighbors {
  previous?: GenerationJob;
  next?: GenerationJob;
  /** 当前是第几篇(1 起);不在可读集合里时为 0 */
  position: number;
  /** 可读集合总数 */
  total: number;
}

/**
 * 阅读页的上一篇/下一篇。
 *
 * 只在**可读**的任务之间翻:已完成且有内容的才算。把排队中和失败的也串进来,
 * 「下一篇」会翻到一个只有等待卡或错误信息的页面——批量里一半是失败时,连点几下
 * 全是空页。那些条目在产出列表里各有自己的处理入口(重试/看进度),不属于阅读流。
 *
 * 顺序沿用列表接口给的顺序(后端按创建时间倒序),不重新排:用户在列表里看到的
 * 顺序就该是翻页的顺序。
 */
export function readerNeighbors(jobs: readonly GenerationJob[], currentId: string): ReaderNeighbors {
  const readable = jobs.filter((job) => job.status === 'completed');
  const index = readable.findIndex((job) => job.id === currentId);
  if (index === -1) {
    // 当前这篇不可读(还在跑/失败),或列表还没拉到。不给翻页,但也不谎报总数。
    return { position: 0, total: readable.length };
  }
  return {
    previous: index > 0 ? readable[index - 1] : undefined,
    next: index < readable.length - 1 ? readable[index + 1] : undefined,
    position: index + 1,
    total: readable.length,
  };
}
