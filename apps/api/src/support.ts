/**
 * 客服联系方式与额度用尽的话术。
 *
 * 原来 consumePlatformQuota 抛的是「平台测试额度已用完，请联系管理员增加额度或配置
 * BYOK」——对付费的 SaaS 用户来说这两条出路都不存在:他看不到管理员是谁,也没有
 * 配 BYOK 的权限(PATCH /api/settings 对 userKind='saas' 一律 403)。实测该用户
 * 触发知识库分析,拿到的就是这句无法执行的建议。
 *
 * 前端的额度卡早已改用客服话术(web/src/lib/support.ts),但**接口报错**这条路径
 * 没跟上——而它恰恰是用户真正撞墙的时刻。话术放在服务端,三个扣额度的入口
 * (生成 / 按意见修改 / 知识库分析)一次性都对。
 *
 * 与 web/src/lib/support.ts 的 SUPPORT_WECHAT 必须保持一致。
 */
export const SUPPORT_WECHAT = 'wjyy5035';

/** 额度用尽时给用户的出路(不提管理员,不提 BYOK)。 */
export const QUOTA_EXHAUSTED_MESSAGE =
  `本月额度已用完，无法继续生成。额度用完后需要人工增加，可添加客服微信 ${SUPPORT_WECHAT}`;
