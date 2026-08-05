// SaaS 用户(极简创作产品)API 白名单。命中外一律拒绝。
//
// 这里刻意列出具体 method + route shape，而不是放行整个控制器前缀。
// `/api/projects/:id` 同时挂着极简创作、ACL、研究中心和内部配置端点；
// 前缀放行会让以后新增的专家端点自动变成 SaaS 可达，属于 fail-open。
export function isSaasApiAllowed(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  const pathname = path.split('?')[0] || '/';
  const segment = '[^/]+';
  const allowed: ReadonlyArray<{ methods: readonly string[]; route: RegExp }> = [
    { methods: ['GET'], route: /^\/api\/auth\/me$/u },
    { methods: ['POST'], route: /^\/api\/auth\/(?:logout|change-password)$/u },
    { methods: ['GET'], route: /^\/api\/workspaces$/u },

    { methods: ['GET', 'POST'], route: /^\/api\/projects$/u },
    { methods: ['GET', 'PATCH', 'DELETE'], route: new RegExp(`^/api/projects/${segment}$`, 'u') },

    // 项目分析的极简工作流：分析、查看任务、确认情报与七个蓝图模块。
    { methods: ['GET'], route: new RegExp(`^/api/projects/${segment}/intelligence$`, 'u') },
    { methods: ['POST'], route: new RegExp(`^/api/projects/${segment}/intelligence/analyze$`, 'u') },
    { methods: ['GET'], route: new RegExp(`^/api/projects/${segment}/intelligence/analysis-tasks(?:/${segment})?$`, 'u') },
    { methods: ['POST'], route: new RegExp(`^/api/projects/${segment}/intelligence/${segment}/approve$`, 'u') },
    { methods: ['GET'], route: new RegExp(`^/api/projects/${segment}/blueprint-modules$`, 'u') },
    { methods: ['POST'], route: new RegExp(`^/api/projects/${segment}/blueprint-modules/${segment}/approve$`, 'u') },

    // 生成前只允许读取并确认依赖；深度编辑仍属于科研版。
    { methods: ['GET'], route: new RegExp(`^/api/projects/${segment}/information-gaps$`, 'u') },
    { methods: ['POST'], route: new RegExp(`^/api/projects/${segment}/information-gaps/${segment}/approve$`, 'u') },
    { methods: ['GET'], route: new RegExp(`^/api/projects/${segment}/expression-strategies$`, 'u') },
    { methods: ['POST'], route: new RegExp(`^/api/projects/${segment}/expression-strategies/${segment}/approve$`, 'u') },

    { methods: ['GET'], route: new RegExp(`^/api/projects/${segment}/topic-opportunities$`, 'u') },
    { methods: ['POST'], route: new RegExp(`^/api/projects/${segment}/topic-opportunities/refresh$`, 'u') },
    { methods: ['POST'], route: new RegExp(`^/api/projects/${segment}/topic-opportunities/${segment}/(?:approve|collection)$`, 'u') },
    { methods: ['DELETE'], route: new RegExp(`^/api/projects/${segment}/topic-opportunities/${segment}$`, 'u') },
    { methods: ['GET'], route: new RegExp(`^/api/projects/${segment}/topic-opportunity-batches$`, 'u') },
    { methods: ['GET', 'POST'], route: new RegExp(`^/api/projects/${segment}/opportunity-prompt-templates$`, 'u') },
    { methods: ['DELETE'], route: new RegExp(`^/api/projects/${segment}/opportunity-prompt-templates/${segment}$`, 'u') },

    { methods: ['GET', 'POST'], route: new RegExp(`^/api/projects/${segment}/presets$`, 'u') },
    { methods: ['GET', 'PATCH', 'DELETE'], route: new RegExp(`^/api/projects/${segment}/presets/${segment}$`, 'u') },
    { methods: ['POST'], route: new RegExp(`^/api/projects/${segment}/presets/${segment}/(?:copy|default)$`, 'u') },

    { methods: ['GET', 'POST'], route: new RegExp(`^/api/projects/${segment}/image-assets$`, 'u') },
    { methods: ['GET', 'DELETE'], route: new RegExp(`^/api/projects/${segment}/image-assets/${segment}$`, 'u') },
    { methods: ['GET'], route: new RegExp(`^/api/projects/${segment}/image-assets/${segment}/(?:content|analyses)$`, 'u') },
    { methods: ['POST'], route: new RegExp(`^/api/projects/${segment}/image-assets/${segment}/(?:analyze|analyses)$`, 'u') },
    { methods: ['POST'], route: new RegExp(`^/api/projects/${segment}/image-assets/${segment}/analyses/${segment}/approve$`, 'u') },

    // 项目内嵌知识路由仍有少量只读调用；写入统一走扁平知识端点。
    { methods: ['GET'], route: new RegExp(`^/api/projects/${segment}/knowledge(?:/index|/evidence-sections|/${segment})?$`, 'u') },

    { methods: ['GET', 'POST'], route: /^\/api\/knowledge$/u },
    { methods: ['GET', 'PATCH', 'DELETE'], route: new RegExp(`^/api/knowledge/${segment}$`, 'u') },

    { methods: ['GET', 'POST'], route: /^\/api\/generations$/u },
    { methods: ['GET', 'DELETE'], route: new RegExp(`^/api/generations/${segment}$`, 'u') },
    { methods: ['GET'], route: new RegExp(`^/api/generations/${segment}/(?:reader|trace)$`, 'u') },
    { methods: ['POST'], route: new RegExp(`^/api/generations/${segment}/(?:revise|restore)$`, 'u') },
    { methods: ['GET'], route: new RegExp(`^/api/generations/${segment}/candidates/${segment}/export$`, 'u') },
    { methods: ['POST'], route: new RegExp(`^/api/generations/${segment}/candidates/${segment}/manual-delivery-confirmation$`, 'u') },

    { methods: ['GET', 'POST'], route: /^\/api\/generation-batches$/u },
    { methods: ['GET'], route: new RegExp(`^/api/generation-batches/${segment}$`, 'u') },
    { methods: ['GET'], route: /^\/api\/generation-parameters\/schema$/u },

    // 裸 /api/settings 会暴露供应商与生成配置，SaaS 只读额度快照。
    { methods: ['GET'], route: /^\/api\/settings\/quota$/u },
  ];

  return allowed.some(({ methods, route }) => methods.includes(verb) && route.test(pathname));
}
