import { useEscapeKey } from './hooks'

/* Material 3 primitives, shared by every tab. */

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-[var(--radius-md3-xl)] bg-surface-container p-6 ${className}`}>
      {children}
    </section>
  )
}

export function Field({
  label,
  value,
  onChange,
  type = 'text',
  autoFocus,
  className = '',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  autoFocus?: boolean
  className?: string
}) {
  return (
    <label className={`relative block ${className}`}>
      <input
        type={type}
        value={value}
        autoFocus={autoFocus}
        placeholder=" "
        onChange={(e) => onChange(e.target.value)}
        className="peer h-14 w-full rounded-[var(--radius-md3-xs)] border border-outline bg-transparent px-4 pt-4 text-base text-on-surface outline-none transition-colors focus:border-2 focus:border-primary focus:px-[15px]"
      />
      <span className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-base text-on-surface-variant transition-all peer-focus:top-2.5 peer-focus:text-xs peer-focus:text-primary peer-[:not(:placeholder-shown)]:top-2.5 peer-[:not(:placeholder-shown)]:text-xs">
        {label}
      </span>
    </label>
  )
}

export function FilledButton({
  children,
  disabled,
  onClick,
  type = 'submit',
  className = '',
}: {
  children: React.ReactNode
  disabled?: boolean
  onClick?: () => void
  type?: 'submit' | 'button'
  className?: string
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`state-layer inline-flex h-10 items-center gap-2 rounded-[var(--radius-md3-full)] bg-primary px-6 text-sm font-medium text-on-primary disabled:pointer-events-none disabled:opacity-38 ${className}`}
    >
      {children}
    </button>
  )
}

export function TonalButton({
  children,
  onClick,
  disabled,
  className = '',
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`state-layer inline-flex h-10 items-center gap-2 rounded-[var(--radius-md3-full)] bg-secondary-container px-5 text-sm font-medium text-on-secondary-container disabled:pointer-events-none disabled:opacity-38 ${className}`}
    >
      {children}
    </button>
  )
}

export function TextButton({
  children,
  onClick,
  disabled,
  tone,
  type = 'button',
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  tone?: 'error'
  type?: 'submit' | 'button'
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`state-layer inline-flex h-10 items-center rounded-[var(--radius-md3-full)] px-3 text-sm font-medium disabled:pointer-events-none disabled:opacity-38 ${
        tone === 'error' ? 'text-error' : 'text-primary'
      }`}
    >
      {children}
    </button>
  )
}

export function IconButton({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode
  label: string
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="state-layer grid size-10 shrink-0 place-items-center rounded-[var(--radius-md3-full)] text-on-surface-variant"
    >
      <svg viewBox="0 0 24 24" className="size-6 fill-current" aria-hidden>
        {children}
      </svg>
    </button>
  )
}

export function Chip({
  children,
  tone,
  onClick,
  selected,
}: {
  children: React.ReactNode
  tone?: 'ok' | 'error'
  onClick?: () => void
  selected?: boolean
}) {
  const tones = {
    ok: 'bg-secondary-container text-on-secondary-container',
    error: 'bg-error-container text-on-error-container',
  }
  const base = tone
    ? tones[tone]
    : selected
      ? 'bg-secondary-container text-on-secondary-container'
      : 'border border-outline-variant text-on-surface-variant'
  const Tag = onClick ? 'button' : 'span'
  return (
    <Tag
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={`inline-flex h-8 items-center gap-2 rounded-[var(--radius-md3-s)] px-3 text-xs font-medium ${base} ${onClick ? 'state-layer' : ''}`}
    >
      {children}
    </Tag>
  )
}

export function Banner({
  children,
  tone,
  className = '',
}: {
  children: React.ReactNode
  tone?: 'error'
  className?: string
}) {
  return (
    <div
      className={`rounded-[var(--radius-md3-m)] px-4 py-3 text-sm ${
        tone === 'error' ? 'bg-error-container text-on-error-container' : 'bg-surface-high'
      } ${className}`}
    >
      {children}
    </div>
  )
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <tr>
      <td className="py-1 pr-4 align-top whitespace-nowrap text-on-surface-variant">{label}</td>
      <td className="py-1 font-mono text-xs break-all">{children}</td>
    </tr>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-[var(--radius-md3-m)] border border-dashed border-outline-variant px-4 py-8 text-center text-sm text-on-surface-variant">
      {children}
    </p>
  )
}

/* ── Modals ──────────────────────────────────────────────────────────────── */

export function Modal({
  title,
  children,
  onClose,
  wide,
}: {
  title: string
  children: React.ReactNode
  onClose: () => void
  wide?: boolean
}) {
  useEscapeKey(onClose)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className={`relative w-full ${wide ? 'max-w-xl' : 'max-w-md'} rounded-[var(--radius-md3-xl)] bg-surface-high p-6 shadow-xl`}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-xl leading-7 font-normal text-on-surface">{title}</h2>
          <IconButton label="Fermer" onClick={onClose}>
            <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
          </IconButton>
        </div>
        {children}
      </div>
    </div>
  )
}

/**
 * Destructive actions go through here rather than an inline "are you sure".
 * The confirm button carries the error colour and names what disappears, so
 * the consequence is visible at the moment of clicking.
 */
export function ConfirmModal({
  title,
  body,
  confirmLabel = 'Supprimer',
  busy,
  onConfirm,
  onClose,
}: {
  title: string
  body: React.ReactNode
  confirmLabel?: string
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="text-sm text-on-surface-variant">{body}</div>
      <div className="mt-6 flex justify-end gap-2">
        <TextButton onClick={onClose}>Annuler</TextButton>
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className="state-layer inline-flex h-10 items-center gap-2 rounded-[var(--radius-md3-full)] bg-error px-6 text-sm font-medium text-on-error disabled:pointer-events-none disabled:opacity-38"
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  )
}

/** Material 3 switch: the thumb grows when on, which reads at a glance. */
export function Switch({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-8 w-13 shrink-0 items-center rounded-full border-2 transition-colors disabled:opacity-38 ${
        checked ? 'border-primary bg-primary' : 'border-outline bg-surface-highest'
      }`}
    >
      <span
        className={`grid place-items-center rounded-full transition-all ${
          checked
            ? 'ml-[26px] size-6 bg-on-primary text-primary'
            : 'ml-1 size-4 bg-outline text-transparent'
        }`}
      >
        <svg viewBox="0 0 24 24" className="size-4 fill-current" aria-hidden>
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
        </svg>
      </span>
    </button>
  )
}
