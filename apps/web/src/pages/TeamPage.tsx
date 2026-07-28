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
  Skeleton,
  useToast,
} from "../components/Ui";
import { V2Hero } from "../components/V2";
import { api } from "../lib/api";
import { PERMISSION_ORDER, groupPermissions, permissionCopy } from "../lib/permission-copy";
import type {
  AuditEntry,
  RegistrationRequest,
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
/*
  原来这里手抄了一份权限清单,抄漏了 research.read / research.write /
  research.approve / release.manage 四条——它们在后端真实生效,但管理员在这个
  弹窗里既看不到也调不了。改为用 PERMISSION_ORDER,并由测试守住与后端同集合。
*/
const permissions = PERMISSION_ORDER;

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
  const [registrations, setRegistrations] = useState<RegistrationRequest[]>([]);
  const [rejecting, setRejecting] = useState<RegistrationRequest | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [form, setForm] = useState({
    username: "",
    password: "",
    systemRole: "user" as "admin" | "user",
    role: "Viewer" as WorkspaceMember["role"],
    userKind: "research" as "research" | "saas",
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
      const [userList, memberList, auditList, keyList, registrationList] =
        await Promise.all([
          isSystemAdmin ? api.admin.users() : Promise.resolve([]),
          api.workspaces.members(selected),
          api.audit.list(selected),
          api.workspaces.apiKeys(selected),
          isSystemAdmin
            ? api.admin.registrations("pending")
            : Promise.resolve([]),
        ]);
      setUsers(userList);
      setMembers(memberList);
      setAudit(auditList);
      setApiKeys(keyList);
      setRegistrations(registrationList);
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
        userKind: form.userKind,
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
        userKind: "research",
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

  const approve = async (item: RegistrationRequest) => {
    try {
      await api.admin.approveRegistration(item.id);
      setRegistrations((cur) => cur.filter((r) => r.id !== item.id));
      toast.push(`已通过 ${item.organizationName} 的申请，账号与工作区已创建`);
      await load();
    } catch (error) {
      toast.push(error instanceof Error ? error.message : "操作失败", "error");
    }
  };

  const confirmReject = async () => {
    if (!rejecting || !rejectReason.trim()) return;
    try {
      await api.admin.rejectRegistration(rejecting.id, rejectReason.trim());
      setRegistrations((cur) => cur.filter((r) => r.id !== rejecting.id));
      setRejecting(null);
      setRejectReason("");
      toast.push("已拒绝该申请");
    } catch (error) {
      toast.push(error instanceof Error ? error.message : "操作失败", "error");
    }
  };

  return (
    <div className="page team-page">
      <V2Hero
        index="09"
        status={<>工作区 · 角色与权限</>}
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
                    type="button"
                    onClick={() => setPermissionMember(structuredClone(member))}
                  >
                    <UserCog size={15} />
                    细分
                  </button>
                  {member.role !== "Owner" && (
                    <button
                      type="button"
                      className="danger"
                      aria-label="移除成员"
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
      {!loading && isSystemAdmin && registrations.length > 0 && (
        <section className="panel team-panel">
          <header className="panel__header">
            <div><h2>注册申请</h2><p>{registrations.length} 条待审核 · 通过后自动创建账号与专属工作区</p></div>
          </header>
          <div className="team-table">
            <div className="team-row team-row--head"><span>机构</span><span>用户名</span><span>手机号</span><span>申请时间</span><span>操作</span></div>
            {registrations.map((item) => (
              <div className="team-row" key={item.id}>
                <span><strong>{item.organizationName}</strong></span>
                <span>{item.username}</span>
                <span>{item.phone}</span>
                <span>{new Date(item.createdAt).toLocaleString("zh-CN")}</span>
                <span className="team-actions">
                  <button type="button" onClick={() => void approve(item)}>通过</button>
                  <button type="button" className="danger" onClick={() => { setRejecting(item); setRejectReason(""); }}>拒绝</button>
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
                <button type="button" onClick={async () => { await api.workspaces.revokeApiKey(workspaceId, item.id); await load(); }}><Trash2 size={14} />撤销</button>
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
          <Field label="用户类型" hint="SaaS 用户登录后只能使用极简创作">
            <select
              value={form.userKind}
              onChange={(event) =>
                setForm({
                  ...form,
                  userKind: event.target.value as "research" | "saas",
                })
              }
            >
              <option value="research">科研用户(默认)</option>
              <option value="saas">SaaS 用户</option>
            </select>
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
            <Field
              label="工作区角色"
              hint={form.userKind === "saas" ? "SaaS 用户建议选 Owner" : undefined}
            >
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
                  .filter((role) => role !== "Owner" || form.userKind === "saas")
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
          <div className="permission-sections">
            {groupPermissions(permissions).map((group) => (
              <section key={group.id}>
                <h4>{group.label}</h4>
                <div className="permission-grid">
                  {group.permissions.map((permission) => {
                    const copy = permissionCopy(permission);
                    return (
                      <div key={permission}>
                        <span className="permission-name">
                          <strong>{copy.label}</strong>
                          <small>{copy.hint}</small>
                          {/* 标识符仍是审计日志与 API 里的真名,排查问题要对得上 */}
                          <code>{permission}</code>
                        </span>
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
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(rejecting)}
        onClose={() => setRejecting(null)}
        title={`拒绝申请 · ${rejecting?.organizationName || ""}`}
        description="填写拒绝原因，用户下次登录时可见。"
        footer={<><Button variant="ghost" onClick={() => setRejecting(null)}>取消</Button><Button loading={saving} disabled={!rejectReason.trim()} onClick={() => void confirmReject()}>确认拒绝</Button></>}
      >
        <Field label="拒绝原因"><textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={3} maxLength={500} /></Field>
      </Modal>
    </div>
  );
}
