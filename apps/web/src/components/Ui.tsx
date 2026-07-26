import {
  CheckCircle2,
  CircleAlert,
  Info,
  LoaderCircle,
  X,
  XCircle,
} from 'lucide-react';
import {
  createContext,
  type ButtonHTMLAttributes,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

type ToastKind = 'success' | 'error' | 'info';
/**
 * 可选的行内动作。为「删除 · 撤销」而加:删一条产出弹一个确认弹窗太重
 * (整理列表要连删好几条),而删完无声无息又让人不敢下手。撤销放在提示里,
 * 代价最低。点击后提示自动收起。
 */
interface ToastAction { label: string; run: () => void }
interface ToastItem { id: number; message: string; kind: ToastKind; action?: ToastAction }
interface ToastContextValue { push: (message: string, kind?: ToastKind, action?: ToastAction) => void }

const ToastContext = createContext<ToastContextValue | null>(null);

/** 带动作的提示多给一点停留时间:3.6 秒不够读完再决定要不要撤销 */
const TOAST_MS = 3600;
const TOAST_WITH_ACTION_MS = 7000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = (message: string, kind: ToastKind = 'success', action?: ToastAction) => {
    const id = Date.now() + Math.random();
    setItems((current) => [...current, { id, message, kind, action }]);
    window.setTimeout(
      () => setItems((current) => current.filter((item) => item.id !== id)),
      action ? TOAST_WITH_ACTION_MS : TOAST_MS,
    );
  };

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {items.map((item) => (
          <div className={`toast toast--${item.kind}`} key={item.id}>
            {item.kind === 'success' ? <CheckCircle2 size={18} /> : item.kind === 'error' ? <XCircle size={18} /> : <Info size={18} />}
            <span>{item.message}</span>
            {item.action && (
              <button
                type="button"
                className="toast__action"
                onClick={() => {
                  item.action?.run();
                  setItems((current) => current.filter((currentItem) => currentItem.id !== item.id));
                }}
              >
                {item.action.label}
              </button>
            )}
            <button type="button" onClick={() => setItems((current) => current.filter((currentItem) => currentItem.id !== item.id))} aria-label="关闭提示"><X size={15} /></button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used within ToastProvider');
  return value;
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({ children, className = '', variant = 'primary', loading, icon, disabled, ...props }: ButtonProps) {
  return (
    <button className={`button button--${variant} ${className}`} disabled={disabled || loading} {...props}>
      {loading ? <LoaderCircle className="spin" size={17} /> : icon}
      <span>{children}</span>
    </button>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'positive' | 'warning' | 'danger' | 'purple' | 'blue' }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  );
}

export function Modal({ open, title, description, children, onClose, footer, size }: { open: boolean; title: string; description?: string; children: ReactNode; onClose: () => void; footer?: ReactNode; size?: "wide" }) {
  const dialogRef = useRef<HTMLElement>(null);
  // onClose 在所有调用处都是内联箭头函数，每次父组件渲染都是新引用。
  // 若直接进依赖数组，输入框每敲一个字都会重跑这个 effect，
  // dialogRef.focus() 会把焦点从输入框抢回弹窗容器，导致只能输入一个字符。
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', handleKey);
    dialogRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', handleKey);
      previous?.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} tabIndex={-1} className={size === "wide" ? "modal modal--wide" : "modal"} role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <header className="modal__header">
          <div><h2 id="modal-title">{title}</h2>{description && <p>{description}</p>}</div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={20} /></button>
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__footer">{footer}</footer>}
      </section>
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-state__icon">{icon || <CircleAlert size={24} />}</div><h3>{title}</h3><p>{description}</p>{action}</div>;
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return <div className="skeleton-block">{Array.from({ length: lines }, (_, index) => <span key={index} style={{ width: `${92 - index * 9}%` }} />)}</div>;
}

export function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: ReactNode }) {
  return <label className="field"><span className="field__label">{label}{required && <em>*</em>}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function ProgressRing({ value, size = 54 }: { value: number; size?: number }) {
  const radius = 20;
  const circumference = Math.PI * 2 * radius;
  const offset = circumference - (Math.max(0, Math.min(100, value)) / 100) * circumference;
  return (
    <div className="progress-ring" style={{ width: size, height: size }}>
      <svg viewBox="0 0 48 48"><circle className="progress-ring__track" cx="24" cy="24" r={radius} /><circle className="progress-ring__value" cx="24" cy="24" r={radius} strokeDasharray={circumference} strokeDashoffset={offset} /></svg>
      <strong>{value}</strong>
    </div>
  );
}
