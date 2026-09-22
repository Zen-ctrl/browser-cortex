import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from 'react';

export type IconName =
  | 'activity'
  | 'arrow'
  | 'brain'
  | 'check'
  | 'chevron'
  | 'close'
  | 'database'
  | 'document'
  | 'download'
  | 'eye'
  | 'key'
  | 'lock'
  | 'menu'
  | 'model'
  | 'pause'
  | 'play'
  | 'privacy'
  | 'search'
  | 'settings'
  | 'spark'
  | 'upload'
  | 'warning'
  | 'workflow';

const iconPaths: Record<IconName, ReactNode> = {
  activity: <path d="M3 12h4l2.2-6 4.1 12 2.2-6H21" />,
  arrow: <path d="m9 18 6-6-6-6" />,
  brain: <><path d="M9.5 4.5A3 3 0 0 0 4 6.2a3.2 3.2 0 0 0 .4 5.8A3.2 3.2 0 0 0 9.5 15" /><path d="M14.5 4.5A3 3 0 0 1 20 6.2a3.2 3.2 0 0 1-.4 5.8 3.2 3.2 0 0 1-5.1 3" /><path d="M9.5 4.5V20m5-15.5V20M7 9h2.5m5 3H18m-8.5 4H7m7.5 1H17" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  chevron: <path d="m8 10 4 4 4-4" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>,
  document: <><path d="M6 2h8l4 4v16H6z" /><path d="M14 2v5h5M9 12h6M9 16h6" /></>,
  download: <><path d="M12 3v12m0 0 5-5m-5 5-5-5" /><path d="M5 21h14" /></>,
  eye: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="m11 12 8-8m-3 3 3 3m-6 0 3 3" /></>,
  lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  model: <><path d="M12 2 4 6v12l8 4 8-4V6Z" /><path d="m4 6 8 4 8-4m-8 4v12" /></>,
  pause: <path d="M9 5v14m6-14v14" />,
  play: <path d="m8 5 11 7-11 7Z" />,
  privacy: <><path d="M12 2 5 5v6c0 5 3 8.5 7 11 4-2.5 7-6 7-11V5Z" /><path d="m9 12 2 2 4-5" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>,
  spark: <><path d="m12 2 1.4 4.6L18 8l-4.6 1.4L12 14l-1.4-4.6L6 8l4.6-1.4Z" /><path d="m18.5 14 .8 2.7 2.7.8-2.7.8-.8 2.7-.8-2.7-2.7-.8 2.7-.8Z" /></>,
  upload: <><path d="M12 16V4m0 0L7 9m5-5 5 5" /><path d="M5 20h14" /></>,
  warning: <><path d="M12 3 2.8 20h18.4Z" /><path d="M12 9v5m0 3h.01" /></>,
  workflow: <><rect x="3" y="3" width="6" height="6" rx="1" /><rect x="15" y="15" width="6" height="6" rx="1" /><path d="M9 6h3a3 3 0 0 1 3 3v6m-6 3H6a3 3 0 0 1-3-3v-3" /></>,
};

export function Icon({ name, size = 18, label }: { name: IconName; size?: number; label?: string }) {
  return (
    <svg
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className="bc-icon"
      fill="none"
      height={size}
      role={label ? 'img' : undefined}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 24 24"
      width={size}
    >
      {iconPaths[name]}
    </svg>
  );
}

export type BadgeTone = 'neutral' | 'positive' | 'warning' | 'danger' | 'info' | 'violet';

export function Badge({ children, tone = 'neutral', dot = false }: { children: ReactNode; tone?: BadgeTone; dot?: boolean }) {
  return <span className={`bc-badge bc-badge--${tone}`}>{dot && <span aria-hidden="true" className="bc-badge__dot" />}{children}</span>;
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: IconName;
  tone?: 'primary' | 'secondary' | 'quiet' | 'danger';
  compact?: boolean;
}

export function Button({ children, className = '', compact = false, icon, tone = 'secondary', type = 'button', ...props }: ButtonProps) {
  return (
    <button className={`bc-button bc-button--${tone}${compact ? ' bc-button--compact' : ''} ${className}`.trim()} type={type} {...props}>
      {icon && <Icon name={icon} size={compact ? 15 : 17} />}
      <span>{children}</span>
    </button>
  );
}

export function Panel({ children, className = '', title, eyebrow, action, ...props }: HTMLAttributes<HTMLElement> & { title?: string; eyebrow?: string; action?: ReactNode }) {
  return (
    <section className={`bc-panel ${className}`.trim()} {...props}>
      {(title || eyebrow || action) && (
        <header className="bc-panel__header">
          <div>
            {eyebrow && <p className="bc-eyebrow">{eyebrow}</p>}
            {title && <h2>{title}</h2>}
          </div>
          {action && <div className="bc-panel__action">{action}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, description, eyebrow, actions }: { title: string; description: string; eyebrow?: string; actions?: ReactNode }) {
  return (
    <header className="bc-page-header">
      <div>
        {eyebrow && <p className="bc-eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div className="bc-page-header__actions">{actions}</div>}
    </header>
  );
}

export function Stat({ label, value, detail, icon }: { label: string; value: ReactNode; detail: string; icon: IconName }) {
  return (
    <article className="bc-stat">
      <span className="bc-stat__icon"><Icon name={icon} size={19} /></span>
      <div><p>{label}</p><strong>{value}</strong><small>{detail}</small></div>
    </article>
  );
}

export type NoticeTone = 'info' | 'positive' | 'warning' | 'danger';

export function Notice({ children, title, tone = 'info', action }: { children: ReactNode; title: string; tone?: NoticeTone; action?: ReactNode }) {
  const icon: IconName = tone === 'positive' ? 'check' : tone === 'warning' || tone === 'danger' ? 'warning' : 'privacy';
  return (
    <div className={`bc-notice bc-notice--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <span className="bc-notice__icon"><Icon name={icon} size={18} /></span>
      <div className="bc-notice__copy"><strong>{title}</strong><div>{children}</div></div>
      {action && <div className="bc-notice__action">{action}</div>}
    </div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className={`bc-field${error ? ' bc-field--error' : ''}`}>
      <span className="bc-field__label">{label}</span>
      {children}
      {(error || hint) && <small>{error ?? hint}</small>}
    </label>
  );
}

export function Switch({ label, description, checked, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: string; description?: string; checked: boolean }) {
  return (
    <label className="bc-switch-row">
      <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
      <span className="bc-switch"><input checked={checked} type="checkbox" {...props} /><span aria-hidden="true" /></span>
    </label>
  );
}

export interface SegmentedOption<T extends string> { value: T; label: string; }

export function SegmentedControl<T extends string>({ label, options, value, onChange }: { label: string; options: readonly SegmentedOption<T>[]; value: T; onChange: (value: T) => void }) {
  return (
    <fieldset className="bc-segmented">
      <legend className="bc-sr-only">{label}</legend>
      {options.map((option) => (
        <button aria-pressed={option.value === value} key={option.value} onClick={() => onChange(option.value)} type="button">{option.label}</button>
      ))}
    </fieldset>
  );
}

export function Meter({ value, label, detail }: { value: number; label: string; detail: string }) {
  const bounded = Math.max(0, Math.min(100, value));
  return (
    <div className="bc-meter">
      <div><span>{label}</span><small>{detail}</small></div>
      <div aria-label={`${label}: ${bounded}%`} aria-valuemax={100} aria-valuemin={0} aria-valuenow={bounded} className="bc-meter__track" role="progressbar"><span style={{ width: `${bounded}%` }} /></div>
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: IconName; title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="bc-empty"><span><Icon name={icon} size={22} /></span><h3>{title}</h3><p>{children}</p>{action}</div>;
}

export function InlineCode({ children }: { children: ReactNode }) { return <code className="bc-inline-code">{children}</code>; }
export function Toolbar({ children }: { children: ReactNode }) { return <div className="bc-toolbar">{children}</div>; }
export function Skeleton({ width = '100%' }: { width?: string }) { return <span aria-hidden="true" className="bc-skeleton" style={{ width }} />; }

export interface AppFrameItem { id: string; label: string; icon: IconName; badge?: string; }

export function AppFrame({ brand, items, activeId, onNavigate, sidebarFooter, headerEnd, mobileOpen, onMobileOpenChange, children }: { brand: ReactNode; items: readonly AppFrameItem[]; activeId: string; onNavigate: (id: string) => void; sidebarFooter?: ReactNode; headerEnd?: ReactNode; mobileOpen: boolean; onMobileOpenChange: (open: boolean) => void; children: ReactNode }) {
  return (
    <div className="bc-frame">
      <button aria-label="Close navigation" className={`bc-frame__scrim${mobileOpen ? ' is-open' : ''}`} onClick={() => onMobileOpenChange(false)} type="button" />
      <aside className={`bc-sidebar${mobileOpen ? ' is-open' : ''}`}>
        <div className="bc-sidebar__brand">{brand}</div>
        <nav aria-label="Main navigation">
          {items.map((item) => (
            <button aria-current={item.id === activeId ? 'page' : undefined} key={item.id} onClick={() => { onNavigate(item.id); onMobileOpenChange(false); }} type="button">
              <Icon name={item.icon} size={18} /><span>{item.label}</span>{item.badge && <em>{item.badge}</em>}
            </button>
          ))}
        </nav>
        {sidebarFooter && <div className="bc-sidebar__footer">{sidebarFooter}</div>}
      </aside>
      <div className="bc-frame__body">
        <div className="bc-mobile-bar"><button aria-label="Open navigation" onClick={() => onMobileOpenChange(true)} type="button"><Icon name="menu" /></button>{brand}<div>{headerEnd}</div></div>
        {headerEnd && <div className="bc-frame__topline">{headerEnd}</div>}
        <main className="bc-content" id="main-content">{children}</main>
      </div>
    </div>
  );
}
