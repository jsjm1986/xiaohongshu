import {
  KeyRound,
  Plus,
  ShieldCheck,
  Trash2,
  UserCog,
  UsersRound,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Modal,
  PageHeader,
  Skeleton,
  useToast,
} from "../components/Ui";
import { api } from "../lib/api";
import type {
  AuditEntry,
  SystemUser,
  WorkspaceApiKey,
  WorkspaceMember,
} from "../types";
import { useAuth } from "../components/AuthContext";

const roles: WorkspaceMember["role"][] = [
  "Owner",
  "Admin",
  "KnowledgeEditor",
  "ContentEditor",
  "Viewer",
];
const permissions = [
  "workspace.manage",
  "member.manage",
  "provider.manage",
  "quota.manage",
  "project.read",
  "project.write",
  "project.delete",
  "knowledge.read",
  "knowledge.write",
  "knowledge.import",
  "knowledge.delete",
  "formula.read",
  "formula.manage",
  "formula.activate",
  "generation.run",
  "generation.chat",
  "generation.edit",
  "generation.export",
  "audit.read",
  "api.read",
];

export function TeamPage() {
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }>>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [users, setUsers] = useState<SystemUser[]>([]);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [apiKeys, setApiKeys] = useState<WorkspaceApiKey[]>([]);
  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const [apiKeyName, setApiKeyName] = useState("只读集成");
  const [revealedKey, setRevealedKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [permissionMember, setPermissionMember] =
    useState<WorkspaceMember | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    username: "",
    password: "",
    systemRole: "user" as "admin" | "user",
    role: "Viewer" as WorkspaceMember["role"],
  });
  const toast = useToast();
  const { user: currentUser } = useAuth();
  const isSystemAdmin = currentUser?.role === "系统管理员";

  const load = async (requestedWorkspaceId?: string) => {
    setLoading(true);
    try {
      const workspaces = await api.workspaces.list();
      setWorkspaces(workspaces);
      const selected = requestedWorkspaceId || workspaceId || workspaces[0]?.id || "";
      setWorkspaceId(selected);
      if (!selected) return;
      const [userList, memberList, auditList, keyList] = await Promise.all([
        isSystemAdmin ? api.admin.users() : Promise.resolve([]),
        api.workspaces.members(selected),
        api.audit.list(selected),
        api.workspaces.apiKeys(selected),
      ]);
      setUsers(userList);
      setMembers(memberList);
      setAudit(auditList);
      setApiKeys(keyList);
    } catch (error) {
      toast.push(
        error instanceof Error ? error.message : "无法读取团队权限",
        "error",
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const createUser = async (event: FormEvent) => {
    event.preventDefault();
    if (form.password.length < 12) {
      toast.push("初始密码至少需要 12 个字符", "error");
      return;
    }
    setSaving(true);
    try {
      const user = await api.admin.createUser({
        username: form.username,
        password: form.password,
        systemRole: form.systemRole,
      });
      await api.workspaces.setMember(workspaceId, user.id, {
        role: form.role,
        grants: [],
        denies: [],
      });
      setCreateOpen(false);
      setForm({
        username: "",
        password: "",
        systemRole: "user",
        role: "Viewer",
      });
      toast.push("账号已创建，首次登录需修改密码");
      await load();
    } catch (error) {
      toast.push(
        error instanceof Error ? error.message : "创建账号失败",
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const saveMember = async (member: WorkspaceMember) => {
    setSaving(true);
    try {
      const saved = await api.workspaces.setMember(
        workspaceId,
        member.userId,
        member,
      );
      setMembers((current) =>
        current.map((item) => (item.userId === saved.userId ? saved : item)),
      );
      setPermissionMember(null);
      toast.push("成员权限已更新");
    } catch (error) {
      toast.push(error instanceof Error ? error.message : "更新失败", "error");
    } finally {
      setSaving(false);
    }
  };

  const toggle = (kind: "grants" | "denies", permission: string) => {
    if (!permissionMember) return;
    const next = new Set(permissionMember[kind]);
    if (next.has(permission)) next.delete(permission);
    else next.add(permission);
    const opposite = kind === "grants" ? "denies" : "grants";
    setPermissionMember({
      ...permissionMember,
      [kind]: [...next],
      [opposite]: permissionMember[opposite].filter(
        (item) => item !== permission,
      ),
    });
  };

  const createReadOnlyKey = async () => {
    if (!apiKeyName.trim()) return;
    setSaving(true);
    try {
      const created = await api.workspaces.createApiKey(workspaceId, apiKeyName.trim());
      setRevealedKey(created.key || "");
      setApiKeys((current) => [created, ...current]);
      toast.push("只读密钥已创建，请立即复制");
    } catch (error) {
      toast.push(error instanceof Error ? error.message : "创建密钥失败", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page team-page">
      <PageHeader
        eyebrow="ACCESS CONTROL"
        title="团队与权限"
        description="管理员创建账号；工作区角色提供默认权限，允许用授权和拒绝项精确覆盖。"
        actions={<div className="team-header-actions">
          {workspaces.length > 1 && <select value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value); void load(event.target.value); }}>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select>}
          {isSystemAdmin && <Button icon={<Plus size={16} />} onClick={() => setCreateOpen(true)}>创建账号</Button>}
        </div>}
      />
      {loading ? (
        <Skeleton lines={7} />
      ) : !workspaceId ? (
        <EmptyState title="没有可管理的工作区" description="请先创建工作区。" />
      ) : (
        <section className="panel team-panel">
          <header className="panel__header">
            <div>
              <h2>工作区成员</h2>
              <p>
                {members.length} 名成员 · {users.length} 个系统账号
              </p>
            </div>
            <Badge tone="purple">
              <ShieldCheck size={13} />
              细粒度 RBAC
            </Badge>
          </header>
          <div className="team-table">
            <div className="team-row team-row--head">
              <span>账号</span>
              <span>角色</span>
              <span>额外授权</span>
              <span>明确拒绝</span>
              <span>操作</span>
            </div>
            {members.map((member) => (
              <div className="team-row" key={member.userId}>
                <span className="team-user">
                  <i>{member.username.slice(0, 1).toUpperCase()}</i>
                  <span>
                    <strong>{member.username}</strong>
                    <small>
                      {users.find((user) => user.id === member.userId)
                        ?.mustChangePassword
                        ? "等待首次改密"
                        : "账号已启用"}
                    </small>
                  </span>
                </span>
                <span>
                  <select
                    value={member.role}
                    disabled={member.role === "Owner"}
                    onChange={(event) =>
                      void saveMember({
                        ...member,
                        role: event.target.value as WorkspaceMember["role"],
                      })
                    }
                  >
                    {roles.map((role) => (
                      <option key={role}>{role}</option>
                    ))}
                  </select>
                </span>
                <span>
                  <Badge>{member.grants.length} 项</Badge>
                </span>
                <span>
                  <Badge tone={member.denies.length ? "warning" : "neutral"}>
                    {member.denies.length} 项
                  </Badge>
                </span>
                <span className="team-actions">
                  <button
                    onClick={() => setPermissionMember(structuredClone(member))}
                  >
                    <UserCog size={15} />
                    细分
                  </button>
                  {member.role !== "Owner" && (
                    <button
                      className="danger"
                      onClick={async () => {
                        await api.workspaces.removeMember(
                          workspaceId,
                          member.userId,
                        );
                        await load();
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
      {!loading && audit.length > 0 && (
        <section className="panel audit-panel">
          <header className="panel__header">
            <div>
              <h2>最近审计记录</h2>
              <p>账号、权限、知识、公式与生成操作</p>
            </div>
            <Badge>{audit.length} 条</Badge>
          </header>
          <div className="audit-list">
            {audit.slice(0, 20).map((entry) => (
              <div key={entry.id}>
                <span>
                  <strong>{entry.action}</strong>
                  <small>
                    {entry.entityType}
                    {entry.entityId ? ` · ${entry.entityId.slice(0, 12)}` : ""}
                  </small>
                </span>
                <span>{entry.username || "system"}</span>
                <time>{new Date(entry.createdAt).toLocaleString("zh-CN")}</time>
              </div>
            ))}
          </div>
        </section>
      )}

      {!loading && workspaceId && (
        <section className="panel audit-panel">
          <header className="panel__header">
            <div><h2>只读集成密钥</h2><p>只能访问 /v1 读取接口，不能从外部发起生成</p></div>
            <Button variant="secondary" icon={<KeyRound size={15} />} onClick={() => { setRevealedKey(""); setApiKeyOpen(true); }}>创建密钥</Button>
          </header>
          <div className="api-key-list">
            {apiKeys.filter((item) => !item.revokedAt).map((item) => (
              <div key={item.id}>
                <span><strong>{item.name}</strong><code>{item.prefix}••••</code></span>
                <small>{item.lastUsedAt ? `最后使用 ${new Date(item.lastUsedAt).toLocaleString("zh-CN")}` : "尚未使用"}</small>
                <button onClick={async () => { await api.workspaces.revokeApiKey(workspaceId, item.id); await load(); }}><Trash2 size={14} />撤销</button>
              </div>
            ))}
            {apiKeys.every((item) => item.revokedAt) && <p className="api-key-empty">尚未创建有效密钥</p>}
          </div>
        </section>
      )}

      <Modal
        open={apiKeyOpen}
        onClose={() => { setApiKeyOpen(false); setRevealedKey(""); }}
        title="创建只读 API Key"
        description="密钥只显示一次，仅具备 api.read 权限。"
        footer={revealedKey ? <Button onClick={() => { setApiKeyOpen(false); setRevealedKey(""); }}>我已保存</Button> : <><Button variant="ghost" onClick={() => setApiKeyOpen(false)}>取消</Button><Button loading={saving} onClick={() => void createReadOnlyKey()}>创建密钥</Button></>}
      >
        {revealedKey ? <div className="revealed-key"><p>请立即复制并保存，关闭后无法再次查看。</p><code>{revealedKey}</code><Button variant="secondary" onClick={() => navigator.clipboard.writeText(revealedKey).then(() => toast.push("密钥已复制"))}>复制密钥</Button></div> : <Field label="密钥名称"><input value={apiKeyName} onChange={(event) => setApiKeyName(event.target.value)} maxLength={100} /></Field>}
      </Modal>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="创建团队账号"
        description="系统不开放注册，新账号由管理员创建。"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button form="create-team-user" type="submit" loading={saving}>
              创建并加入
            </Button>
          </>
        }
      >
        <form
          id="create-team-user"
          className="form-stack"
          onSubmit={createUser}
        >
          <Field label="用户名">
            <input
              value={form.username}
              onChange={(event) =>
                setForm({ ...form, username: event.target.value })
              }
              minLength={3}
              required
            />
          </Field>
          <Field label="初始密码" hint="至少 12 个字符，首次登录强制修改">
            <input
              type="password"
              value={form.password}
              onChange={(event) =>
                setForm({ ...form, password: event.target.value })
              }
              minLength={12}
              required
            />
          </Field>
          <div className="field-grid field-grid--two">
            <Field label="系统身份">
              <select
                value={form.systemRole}
                onChange={(event) =>
                  setForm({
                    ...form,
                    systemRole: event.target.value as "admin" | "user",
                  })
                }
              >
                <option value="user">普通账号</option>
                <option value="admin">系统管理员</option>
              </select>
            </Field>
            <Field label="工作区角色">
              <select
                value={form.role}
                onChange={(event) =>
                  setForm({
                    ...form,
                    role: event.target.value as WorkspaceMember["role"],
                  })
                }
              >
                {roles
                  .filter((role) => role !== "Owner")
                  .map((role) => (
                    <option key={role}>{role}</option>
                  ))}
              </select>
            </Field>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(permissionMember)}
        onClose={() => setPermissionMember(null)}
        title={`细分权限 · ${permissionMember?.username || ""}`}
        description="拒绝项优先于角色默认和额外授权；项目级 ACL 可继续覆盖。"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPermissionMember(null)}>
              取消
            </Button>
            <Button
              loading={saving}
              onClick={() =>
                permissionMember && void saveMember(permissionMember)
              }
              icon={<KeyRound size={15} />}
            >
              保存权限
            </Button>
          </>
        }
      >
        {permissionMember && (
          <div className="permission-grid">
            {permissions.map((permission) => (
              <div key={permission}>
                <code>{permission}</code>
                <label>
                  <input
                    type="checkbox"
                    checked={permissionMember.grants.includes(permission)}
                    onChange={() => toggle("grants", permission)}
                  />
                  授权
                </label>
                <label className="deny">
                  <input
                    type="checkbox"
                    checked={permissionMember.denies.includes(permission)}
                    onChange={() => toggle("denies", permission)}
                  />
                  拒绝
                </label>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
