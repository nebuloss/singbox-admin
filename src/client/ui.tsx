import { useState } from 'react'
import { useEscapeKey } from './hooks'
import { useI18n, useT } from './i18n'

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
  error,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  autoFocus?: boolean
  className?: string
  /** Shown under the field, in the error colour. Say what is wrong, not that
   *  something is: this is read while typing, not after a failed submit. */
  error?: string
}) {
  return (
    <label className={`block ${className}`}>
      <span className="relative block">
        <input
          type={type}
          value={value}
          autoFocus={autoFocus}
          placeholder=" "
          aria-invalid={Boolean(error)}
          onChange={(e) => onChange(e.target.value)}
          className={`peer h-14 w-full rounded-[var(--radius-md3-xs)] border bg-transparent px-4 pt-4 text-base text-on-surface outline-none transition-colors focus:border-2 focus:px-[15px] ${
            error ? 'border-error focus:border-error' : 'border-outline focus:border-primary'
          }`}
        />
        <span
          className={`pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-base transition-all peer-focus:top-2.5 peer-focus:text-xs peer-[:not(:placeholder-shown)]:top-2.5 peer-[:not(:placeholder-shown)]:text-xs ${
            error ? 'text-error' : 'text-on-surface-variant peer-focus:text-primary'
          }`}
        >
          {label}
        </span>
      </span>
      {error && <span className="mt-1.5 block px-4 text-xs text-error">{error}</span>}
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
  disabled,
  tone,
}: {
  children: React.ReactNode
  label: string
  onClick?: () => void
  disabled?: boolean
  tone?: 'error'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`state-layer grid size-10 shrink-0 place-items-center rounded-[var(--radius-md3-full)] disabled:pointer-events-none disabled:opacity-38 ${
        tone === 'error' ? 'text-error' : 'text-on-surface-variant'
      }`}
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

/**
 * Two languages, so a segmented pair rather than a dropdown: the alternative is
 * visible without opening anything, which is the point of putting it in the app
 * bar and on the sign-in screen instead of burying it in settings.
 */
export function LangToggle() {
  const { lang, setLang } = useI18n()
  return (
    <div
      className="inline-flex h-8 shrink-0 overflow-hidden rounded-[var(--radius-md3-full)] border border-outline-variant"
      role="group"
      aria-label="Language"
    >
      {(['fr', 'en'] as const).map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-pressed={lang === l}
          onClick={() => setLang(l)}
          className={`state-layer px-2.5 text-xs font-medium uppercase ${
            lang === l
              ? 'bg-secondary-container text-on-secondary-container'
              : 'text-on-surface-variant'
          }`}
        >
          {l}
        </button>
      ))}
    </div>
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
  const close = useT()('Fermer')
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
          <IconButton label={close} onClick={onClose}>
            <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
          </IconButton>
        </div>
        {children}
      </div>
    </div>
  )
}

/**
 * The shape every editing modal shares: hold a draft, submit it, show the
 * failure inline if it fails, close if it does not. Written once here so each
 * tab contributes only its fields — and so a fix to the submit behaviour, or
 * to how a failure is shown, reaches all of them.
 *
 * onSubmit is expected to throw on failure; the message is rendered as it
 * comes, translated, without closing the modal, so nothing typed is lost.
 */
export function FormModal({
  title,
  wide,
  submitLabel,
  disabled,
  onSubmit,
  onClose,
  children,
}: {
  title: string
  wide?: boolean
  submitLabel?: string
  disabled?: boolean
  onSubmit: () => Promise<unknown>
  onClose: () => void
  children: React.ReactNode
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await onSubmit()
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal title={title} wide={wide} onClose={onClose}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        {children}
        {error && <Banner tone="error">{t(error)}</Banner>}
        <div className="mt-2 flex justify-end gap-2">
          <TextButton onClick={onClose}>{t('Annuler')}</TextButton>
          <FilledButton disabled={busy || disabled}>{submitLabel ?? t('Enregistrer')}</FilledButton>
        </div>
      </form>
    </Modal>
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
  confirmLabel,
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
  const t = useT()
  return (
    <Modal title={title} onClose={onClose}>
      <div className="text-sm text-on-surface-variant">{body}</div>
      <div className="mt-6 flex justify-end gap-2">
        <TextButton onClick={onClose}>{t('Annuler')}</TextButton>
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className="state-layer inline-flex h-10 items-center gap-2 rounded-[var(--radius-md3-full)] bg-error px-6 text-sm font-medium text-on-error disabled:pointer-events-none disabled:opacity-38"
        >
          {confirmLabel ?? t('Supprimer')}
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
  title,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
  label: string
  /** Why the switch is greyed out, when that is not obvious from context. */
  title?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
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

/**
 * Errors from an action the user just took. A banner at the top of a scrolled
 * page is easy to miss; a modal cannot be ignored and states what failed.
 * Errors *inside* a form stay inline next to the field, as in evs-app.
 */
export function ErrorModal({ message, onClose }: { message: string; onClose: () => void }) {
  const t = useT()
  return (
    <Modal title={t('Échec de l’opération')} onClose={onClose}>
      <div className="flex gap-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-error-container text-on-error-container">
          <svg viewBox="0 0 24 24" className="size-6 fill-current" aria-hidden>
            <path d="M11 15h2v2h-2v-2zm0-8h2v6h-2V7zm1-5C6.47 2 2 6.5 2 12a10 10 0 1 0 10-10zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16z" />
          </svg>
        </span>
        <p className="min-w-0 flex-1 text-sm break-words text-on-surface-variant">{t(message)}</p>
      </div>
      <div className="mt-6 flex justify-end">
        <FilledButton type="button" onClick={onClose}>
          {t('Fermer')}
        </FilledButton>
      </div>
    </Modal>
  )
}
