/**
 * 客服联系方式。
 *
 * 原来只写在 RegisterPage 里。但真正需要它的是**已经在用的付费客户**:额度用完时
 * 界面给的出路是「联系管理员增加额度或改用自有密钥」,而 SaaS 用户既看不到管理员
 * 是谁,也没权限配 BYOK(PATCH /api/settings 对他 403)——那句话等于没给出路。
 */
export const SUPPORT_WECHAT = 'wjyy5035';

/** 额度用完 / 需要人工介入时的统一出路文案。 */
export const SUPPORT_HINT = `额度用完后需要人工增加，可添加客服微信 ${SUPPORT_WECHAT}`;
