export const PERMISSIONS = [
  'workspace.manage',
  'member.manage',
  'provider.manage',
  'quota.manage',
  'project.read',
  'project.write',
  'project.delete',
  'knowledge.read',
  'knowledge.write',
  'knowledge.import',
  'knowledge.delete',
  'formula.read',
  'formula.manage',
  'formula.activate',
  'research.read',
  'research.write',
  'research.approve',
  'release.manage',
  'generation.run',
  'generation.chat',
  'generation.edit',
  'generation.export',
  'audit.read',
  'api.read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type WorkspaceRole = 'Owner' | 'Admin' | 'KnowledgeEditor' | 'ContentEditor' | 'Viewer';

export const ROLE_PERMISSIONS: Record<WorkspaceRole, ReadonlySet<Permission>> = {
  Owner: new Set(PERMISSIONS),
  Admin: new Set(PERMISSIONS),
  KnowledgeEditor: new Set([
    'project.read',
    'knowledge.read',
    'knowledge.write',
    'knowledge.import',
    'knowledge.delete',
    'formula.read',
    'research.read',
    'research.write',
  ]),
  ContentEditor: new Set([
    'project.read',
    'knowledge.read',
    'formula.read',
    'research.read',
    'research.write',
    'generation.run',
    'generation.chat',
    'generation.edit',
    'generation.export',
  ]),
  Viewer: new Set(['project.read', 'knowledge.read', 'formula.read', 'research.read']),
};

export interface SessionPrincipal {
  kind: 'session';
  userId: string;
  username: string;
  systemRole: 'admin' | 'user';
  mustChangePassword: boolean;
  tokenHash: string;
  csrfHash: string;
}

export interface ApiKeyPrincipal {
  kind: 'apiKey';
  apiKeyId: string;
  workspaceId: string;
  permissions: Permission[];
}

export type Principal = SessionPrincipal | ApiKeyPrincipal;

export interface AuthenticatedRequest {
  principal: Principal;
  cookies?: Record<string, string | undefined>;
  headers: Record<string, string | string[] | undefined>;
  method: string;
  url: string;
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
}

export function parseStringArray(value: unknown): Permission[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Permission =>
    typeof item === 'string' && (PERMISSIONS as readonly string[]).includes(item),
  );
}
