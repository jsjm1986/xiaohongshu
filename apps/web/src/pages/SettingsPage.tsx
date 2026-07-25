import {
  Check,
  CircleDollarSign,
  Eye,
  EyeOff,
  KeyRound,
  LockKeyhole,
  Save,
  Server,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useAuth } from "../components/AuthContext";
import { useProjects } from "../components/ProjectContext";
import {
  Badge,
  Button,
  Field,
  Skeleton,
  useToast,
} from "../components/Ui";
import { V2Hero } from "../components/V2";
import { api } from "../lib/api";
import { demoSettings } from "../lib/fixtures";
import type { AppSettings } from "../types";

type SettingsTab = "model" | "quota" | "account";

const quotaPercent = (settings: AppSettings) =>
  settings.monthlyQuota > 0
    ? Math.min(100, Math.round((settings.quotaUsed / settings.monthlyQuota) * 100))
    : 0;

export function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>("model");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [password, setPassword] = useState({
    current: "",
    next: "",
    confirm: "",
  });
  const { user, setUser } = useAuth();
  const { currentProject } = useProjects();
  const toast = useToast();
  // 这个页面现在只服务专家用户:SaaS 用户的账户页是 /quick/account,渲染在极简
  // 创作壳里。原来这里有一堆 saas 分支(遮侧栏、只给 accountSections、跳过
  // /api/settings),既让页面难改,也留着"以后加东西忘了判 saas"的漏点。

  useEffect(() => {
    if (user?.mustChangePassword) setTab("account");
  }, [user?.mustChangePassword]);

  useEffect(() => {
    api.settings
      .get(currentProject?.workspaceId)
      .then(setSettings)
      .catch(() => setSettings(demoSettings))
      .finally(() => setLoading(false));
  }, [currentProject?.workspaceId]);

  const saveSettings = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      setSettings(
        await api.settings.update({
          ...settings,
          workspaceId: currentProject?.workspaceId,
          ...(apiKey ? { apiKey } : {}),
        }),
      );
      toast.push("设置已保存");
    } catch {
      toast.push("演示模式：设置已在本地保存", "info");
    } finally {
      setSaving(false);
      setApiKey("");
    }
  };

  const clearKey = async () => {
    if (!settings) return;
    if (!window.confirm("确定清除已保存的 API Key 吗？清除后 BYOK 模式需要重新填写。")) return;
    setSaving(true);
    try {
      setSettings(
        await api.settings.update({
          ...settings,
          workspaceId: currentProject?.workspaceId,
          clearApiKey: true,
        }),
      );
      toast.push("已清除保存的密钥");
    } catch {
      toast.push("清除失败", "error");
    } finally {
      setSaving(false);
      setApiKey("");
    }
  };

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (password.next.length < 12) {
      toast.push("新密码至少需要 12 个字符", "error");
      return;
    }
    if (password.next !== password.confirm) {
      toast.push("两次输入的新密码不一致", "error");
      return;
    }
    setSaving(true);
    try {
      await api.auth.changePassword(password.current, password.next);
      if (user) setUser({ ...user, mustChangePassword: false });
      setPassword({ current: "", next: "", confirm: "" });
      toast.push("密码已更新");
    } catch (error) {
      toast.push(
        error instanceof Error ? error.message : "密码更新失败",
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  // 「账户安全」区:改密码表单 + 账户信息卡,所需信息全部来自 useAuth,不调 API。
  // SaaS 用户直接渲染这一块;科研用户仍在 tab === "account" 时渲染同一份。
  const accountSections = (
    <>
      <section className="settings-section">
        <header>
          <div>
            <h2>账户信息</h2>
            <p>账号由管理员创建，用户名和归属权限不能在此修改。</p>
          </div>
        </header>
        <div className="account-card">
          <span className="account-avatar">
            {user?.displayName.slice(0, 1)}
          </span>
          <div>
            <strong>{user?.displayName}</strong>
            <span>@{user?.username}</span>
          </div>
          <Badge tone="purple">{user?.role}</Badge>
        </div>
      </section>
      <section className="settings-section">
        <header>
          <div>
            <h2>更改密码</h2>
            <p>修改后系统会保留当前会话，其他设备需重新登录。</p>
          </div>
          {user?.mustChangePassword && (
            <Badge tone="warning">首次登录需修改</Badge>
          )}
        </header>
        <form
          className="form-stack password-form"
          onSubmit={changePassword}
        >
          <Field label="当前密码">
            <input
              type="password"
              value={password.current}
              onChange={(event) =>
                setPassword({
                  ...password,
                  current: event.target.value,
                })
              }
              required
            />
          </Field>
          <div className="field-grid field-grid--two">
            <Field label="新密码" hint="至少 12 个字符">
              <input
                type="password"
                value={password.next}
                onChange={(event) =>
                  setPassword({ ...password, next: event.target.value })
                }
                minLength={12}
                required
              />
            </Field>
            <Field label="再次输入新密码">
              <input
                type="password"
                value={password.confirm}
                onChange={(event) =>
                  setPassword({
                    ...password,
                    confirm: event.target.value,
                  })
                }
                minLength={12}
                required
              />
            </Field>
          </div>
          <div className="security-note">
            <LockKeyhole size={17} />
            <p>
              密码会使用 Argon2id
              单向处理，服务器不保存可读取的明文密码。
            </p>
          </div>
          <div className="settings-save">
            <Button
              type="submit"
              loading={saving}
              icon={<Save size={16} />}
            >
              更新密码
            </Button>
          </div>
        </form>
      </section>
    </>
  );

  return (
    <div className="page settings-page">
      <V2Hero
        index="08"
        status={<>工作区 · 模型与账户</>}
        title="模型与设置"
        description="管理模型来源、平台额度与账户安全。"
      />
      <div className="settings-layout">
        <aside className="settings-nav">
          <button
            type="button"
            className={tab === "model" ? "active" : ""}
            onClick={() => setTab("model")}
          >
            <Server size={18} />
            <span>
              <strong>模型与密钥</strong>
              <small>平台额度或 BYOK</small>
            </span>
          </button>
          <button
            type="button"
            className={tab === "quota" ? "active" : ""}
            onClick={() => setTab("quota")}
          >
            <CircleDollarSign size={18} />
            <span>
              <strong>用量与额度</strong>
              <small>当前周期使用情况</small>
            </span>
          </button>
          <button
            type="button"
            className={tab === "account" ? "active" : ""}
            onClick={() => setTab("account")}
          >
            <UserRound size={18} />
            <span>
              <strong>账户安全</strong>
              <small>密码与登录信息</small>
            </span>
          </button>
        </aside>
        <main className="settings-content">
          {loading || !settings ? (
            <Skeleton lines={7} />
          ) : tab === "model" ? (
            <>
              <section className="settings-section">
                <header>
                  <div>
                    <h2>模型使用方式</h2>
                    <p>使用管理员发放的平台额度，或为工作区提供自己的密钥。</p>
                  </div>
                  <Badge tone="positive">
                    <ShieldCheck size={13} />
                    密钥加密保存
                  </Badge>
                </header>
                <div className="provider-options">
                  <button
                    type="button"
                    className={
                      settings.providerMode === "platform" ? "selected" : ""
                    }
                    onClick={() =>
                      setSettings({ ...settings, providerMode: "platform" })
                    }
                  >
                    <span>
                      <Server size={20} />
                    </span>
                    <div>
                      <strong>使用平台额度</strong>
                      <p>无需提供密钥，从管理员分配的测试额度中扣除。</p>
                    </div>
                    {settings.providerMode === "platform" && (
                      <i>
                        <Check size={14} />
                      </i>
                    )}
                  </button>
                  <button
                    type="button"
                    className={
                      settings.providerMode === "byok" ? "selected" : ""
                    }
                    onClick={() =>
                      setSettings({ ...settings, providerMode: "byok" })
                    }
                  >
                    <span>
                      <KeyRound size={20} />
                    </span>
                    <div>
                      <strong>使用自有密钥 BYOK</strong>
                      <p>请求直接走你配置的 OpenAI 兼容接口。</p>
                    </div>
                    {settings.providerMode === "byok" && (
                      <i>
                        <Check size={14} />
                      </i>
                    )}
                  </button>
                </div>
              </section>
              <section className="settings-section">
                <header>
                  <div>
                    <h2>提供商与默认模型</h2>
                    <p>项目或单次任务中设置的模型会覆盖此默认值。</p>
                  </div>
                </header>
                <div className="form-stack">
                  <div className="field-grid field-grid--two">
                    <Field label="提供商">
                      <select
                        value={settings.provider || "openai"}
                        onChange={(event) =>
                          setSettings({
                            ...settings,
                            provider: event.target.value,
                          })
                        }
                      >
                        <option value="openai">OpenAI</option>
                        <option value="openai-compatible">OpenAI Compatible</option>
                      </select>
                    </Field>
                    <Field label="默认模型">
                      <input
                        value={settings.model}
                        onChange={(event) =>
                          setSettings({
                            ...settings,
                            model: event.target.value,
                          })
                        }
                        placeholder="gpt-5"
                      />
                    </Field>
                  </div>
                  {settings.providerMode === "byok" && (
                    <>
                      <div className="field-grid field-grid--two">
                        <Field label="API Base URL" hint="请使用 HTTPS，不要在地址中包含密钥">
                          <input
                            value={settings.apiBaseUrl || ""}
                            onChange={(event) => setSettings({ ...settings, apiBaseUrl: event.target.value })}
                            placeholder="https://api.openai.com/v1"
                          />
                        </Field>
                        <Field label="接口模式" hint="官方 OpenAI 优先使用 Responses">
                          <select
                            value={settings.transport || "responses"}
                            onChange={(event) => setSettings({
                              ...settings,
                              transport: event.target.value as AppSettings["transport"],
                            })}
                          >
                            <option value="responses">Responses API</option>
                            <option value="chat_completions">Chat Completions 兼容接口</option>
                          </select>
                        </Field>
                      </div>
                      <Field
                        label="API Key"
                        hint={
                          settings.hasApiKey
                            ? "已保存密钥。留空表示不更改。"
                            : "保存后不会再显示明文。"
                        }
                      >
                        <span className="password-input">
                          <input
                            type={showKey ? "text" : "password"}
                            value={apiKey}
                            onChange={(event) => setApiKey(event.target.value)}
                            placeholder={
                              settings.hasApiKey ? "••••••••••••" : "sk-..."
                            }
                            autoComplete="off"
                          />
                          <button type="button" aria-label={showKey ? "隐藏密钥" : "显示密钥"} onClick={() => setShowKey((value) => !value)}>
                            {showKey ? <EyeOff size={17} /> : <Eye size={17} />}
                          </button>
                        </span>
                        {settings.hasApiKey && (
                          <Button variant="ghost" type="button" loading={saving} onClick={() => void clearKey()}>
                            清除已保存的密钥
                          </Button>
                        )}
                      </Field>
                    </>
                  )}
                  <div className="settings-save">
                    <Button
                      loading={saving}
                      icon={<Save size={16} />}
                      onClick={saveSettings}
                    >
                      保存模型设置
                    </Button>
                  </div>
                </div>
              </section>
            </>
          ) : tab === "quota" ? (
            <>
              <section className="settings-section quota-section">
                <header>
                  <div>
                    <h2>当前测试额度</h2>
                    <p>额度由管理员手动发放，首版不包含在线付款。</p>
                  </div>
                  <Badge tone="blue">管理员手动维护</Badge>
                </header>
                <div className="quota-hero">
                  <div>
                    <span>剩余可用</span>
                    <strong>
                      {Math.max(0, settings.monthlyQuota - settings.quotaUsed)}
                      <small> / {settings.monthlyQuota} 次</small>
                    </strong>
                    <p>累计已使用 {settings.quotaUsed} 次</p>
                  </div>
                  <div
                    className="quota-donut"
                    style={
                      {
                        "--quota": `${quotaPercent(settings)}%`,
                      } as React.CSSProperties
                    }
                  >
                    <span>
                      {quotaPercent(settings)}
                      %<small>已使用</small>
                    </span>
                  </div>
                </div>
                <div className="quota-progress">
                  <span
                    style={{
                      width: `${quotaPercent(settings)}%`,
                    }}
                  />
                </div>
                {["系统管理员", "Owner", "Admin"].includes(user?.role || "") && (
                  <div className="quota-admin">
                    <Field label="平台测试额度">
                      <input type="number" min={0} value={settings.monthlyQuota} onChange={(event) => setSettings({ ...settings, monthlyQuota: Math.max(0, Number(event.target.value)) })} />
                    </Field>
                    <Field label="默认温度" hint="0–2，控制生成发散度。留空用平台默认。">
                      <input type="number" min={0} max={2} step={0.1} value={settings.defaultTemperature ?? ""} onChange={(event) => setSettings({ ...settings, defaultTemperature: event.target.value === "" ? undefined : Math.max(0, Math.min(2, Number(event.target.value))) })} />
                    </Field>
                    <Button loading={saving} onClick={saveSettings}>更新额度</Button>
                  </div>
                )}
              </section>
              <section className="settings-section">
                <header>
                  <div>
                    <h2>额度计算说明</h2>
                    <p>
                      一次完整任务默认生成 3 个候选，并包含最多两轮自动修复。
                    </p>
                  </div>
                </header>
                <div className="quota-rules">
                  <div>
                    <strong>1 次</strong>
                    <span>新建一次完整生成任务</span>
                  </div>
                  <div>
                    <strong>不额外计费</strong>
                    <span>任务内的质量检查与自动修复</span>
                  </div>
                  <div>
                    <strong>按次计算</strong>
                    <span>对候选内容发起的会话修改</span>
                  </div>
                </div>
              </section>
            </>
          ) : (
            accountSections
          )}
        </main>
      </div>
    </div>
  );
}
