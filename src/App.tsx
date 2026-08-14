import { useCallback, useEffect, useState } from 'react'
import { useHashTab } from './hooks'
import { useI18n, useT } from './i18n'
import {
  Banner,
  Card,
  Chip,
  ConfirmModal,
  Empty,
  ErrorModal,
  Field,
  FilledButton,
  IconButton,
  Modal,
  Row,
  Switch,
  TextButton,
  TonalButton,
} from './ui'

export type User = { uuid: string; name?: string; link: string; qr: string }
export type Profile = {
  tag: string
  name: string
  enabled: boolean
  address: string[]
  peer: string | null
  publicKey: string | null
  allowedIps: string[]
  keepalive: number | null
  presharedKey: boolean
}
export type Wireguard = {
  profiles: Profile[]
  active: string | null
  enabled: boolean
}
export type State = {
  authed: boolean
  setup?: boolean
  users?: User[]
  service?: { running: boolean; version: string }
  tunnel?: { host: string; port: number; path: string }
  wireguard?: Wireguard
}

export const api = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json' } })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error ?? `erreur HTTP : ${r.status}`)
  return body
}

const TABS = ['appareils', 'wireguard', 'applications', 'parametres'] as const
type Tab = (typeof TABS)[number]

const TAB_LABELS: Record<Tab, string> = {
  appareils: 'Appareils',
  wireguard: 'WireGuard',
  applications: 'Applications',
  parametres: 'Paramètres',
}

export default function App() {
  const t = useT()
  const [state, setState] = useState<State | null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useHashTab<Tab>(TABS, 'appareils')

  const refresh = useCallback(async () => {
    try {
      setState(await api('/api/state'))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!state) {
    return (
      <div className="grid min-h-screen place-items-center bg-surface">
        <div className="size-10 animate-spin rounded-full border-4 border-outline-variant border-t-primary" />
      </div>
    )
  }

  if (!state.authed) {
    return (
      <div className="grid min-h-screen place-items-center bg-surface px-6 py-10 text-on-surface">
        <div className="w-full max-w-[26rem]">
          <div className="mb-10 flex flex-col items-center text-center">
            <span className="mb-6 grid size-16 place-items-center rounded-[var(--radius-md3-l)] bg-primary-container text-on-primary-container">
              <Shield className="size-8" />
            </span>
            <h1 className="text-[1.75rem] leading-9 font-normal">sing-box</h1>
            <p className="mt-2 text-base text-on-surface-variant">{t('Administration du tunnel')}</p>
          </div>

          {state.setup ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault()
                if (password !== confirm) return setError(t('les deux saisies diffèrent'))
                void act(() => api('/api/setup', { method: 'POST', body: JSON.stringify({ password }) }))
              }}
            >
              <Banner>{t('Première configuration : choisissez le mot de passe d’administration.')}</Banner>
              <Field label={t('Mot de passe')} type="password" value={password} autoFocus onChange={setPassword} />
              <Field label={t('Confirmer')} type="password" value={confirm} onChange={setConfirm} />
              <p className="text-xs text-on-surface-variant">{t('10 caractères minimum.')}</p>
              {error && <Banner tone="error">{t(error)}</Banner>}
              <FilledButton disabled={busy || password.length < 10 || !confirm} className="mt-2 h-12 w-full justify-center">
                {t('Définir le mot de passe')}
              </FilledButton>
            </form>
          ) : (
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault()
                void act(() => api('/api/login', { method: 'POST', body: JSON.stringify({ password }) }))
              }}
            >
              <Field label={t('Mot de passe')} type="password" value={password} autoFocus onChange={setPassword} />
              {error && <Banner tone="error">{t(error)}</Banner>}
              <FilledButton disabled={busy || !password} className="mt-2 h-12 w-full justify-center">
                {t('Se connecter')}
              </FilledButton>
            </form>
          )}
        </div>
      </div>
    )
  }

  const running = state.service?.running

  return (
    <div className="min-h-screen bg-surface text-on-surface">
      <header className="sticky top-0 z-10 bg-surface/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 pt-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-[var(--radius-md3-m)] bg-primary-container text-on-primary-container">
              <Shield className="size-5" />
            </span>
            <div>
              <h1 className="text-xl leading-6 font-normal">sing-box</h1>
              <p className="text-xs text-on-surface-variant">{t('administration du tunnel')}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`inline-block size-2 rounded-full ${running ? 'bg-primary' : 'bg-error'}`}
              title={running ? t('service actif') : t('service arrêté')}
            />
            <IconButton label={t('Déconnexion')} onClick={() => void act(() => api('/api/logout', { method: 'POST' }))}>
              <path d="M10 17l5-5-5-5v3H3v4h7v3zm9-14H5a2 2 0 00-2 2v4h2V5h14v14H5v-4H3v4a2 2 0 002 2h14a2 2 0 002-2V5a2 2 0 00-2-2z" />
            </IconButton>
          </div>
        </div>

        <nav className="mx-auto max-w-3xl overflow-x-auto px-4 sm:px-6">
          <div className="flex min-w-max border-b border-outline-variant">
            {TABS.map((id) => (
              <a
                key={id}
                href={`#${id}`}
                onClick={(e) => {
                  e.preventDefault()
                  setTab(id)
                }}
                className={`state-layer relative px-4 py-3.5 text-sm font-medium whitespace-nowrap ${
                  tab === id ? 'text-primary' : 'text-on-surface-variant'
                }`}
              >
                {t(TAB_LABELS[id])}
                {tab === id && (
                  <span className="absolute inset-x-2 bottom-0 h-[3px] rounded-t-full bg-primary" />
                )}
              </a>
            ))}
          </div>
        </nav>
      </header>

      <main className="mx-auto max-w-3xl px-4 pt-6 pb-16 sm:px-6">
        {tab === 'appareils' && <DevicesTab state={state} busy={busy} act={act} />}
        {tab === 'wireguard' && <WireguardTab wg={state.wireguard} busy={busy} act={act} />}
        {tab === 'applications' && <AppsTab />}
        {tab === 'parametres' && <SettingsTab state={state} />}
      </main>

      {error && <ErrorModal message={error} onClose={() => setError('')} />}
    </div>
  )
}

/* ── Appareils ───────────────────────────────────────────────────────────── */

function DevicesTab({
  state,
  busy,
  act,
}: {
  state: State
  busy: boolean
  act: (fn: () => Promise<unknown>) => Promise<void>
}) {
  const t = useT()
  const [newName, setNewName] = useState('')
  const [pending, setPending] = useState<User | null>(null)

  return (
    <>
      <Card className="mb-6">
        <h2 className="mb-1 text-xl leading-7 font-normal">{t('Ajouter un appareil')}</h2>
        <p className="mb-5 text-sm text-on-surface-variant">
          {t('Un identifiant unique est généré ; le retirer suffit à révoquer l’accès.')}
        </p>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (!newName.trim()) return
            void act(async () => {
              await api('/api/users', { method: 'POST', body: JSON.stringify({ name: newName.trim() }) })
              setNewName('')
            })
          }}
        >
          <Field label={t('Nom de l’appareil')} value={newName} onChange={setNewName} className="min-w-56 flex-1" />
          <FilledButton disabled={busy || !newName.trim()}>
            <Plus /> {t('Ajouter')}
          </FilledButton>
        </form>
      </Card>

      <h2 className="mb-3 px-1 text-sm font-medium tracking-wide text-on-surface-variant uppercase">
        {t('Appareils')} · {state.users?.length ?? 0}
      </h2>

      {state.users?.length ? (
        <ul className="flex flex-col gap-4">
          {state.users.map((u) => (
            <UserCard key={u.uuid} user={u} onRevoke={() => setPending(u)} />
          ))}
        </ul>
      ) : (
        <Empty>{t('Aucun appareil déclaré.')}</Empty>
      )}

      {pending && (
        <ConfirmModal
          title={t('Révoquer cet appareil ?')}
          busy={busy}
          confirmLabel={t('Révoquer')}
          body={
            <>
              <strong className="text-on-surface">{pending.name ?? pending.uuid.slice(0, 8)}</strong>{' '}
              {t('perdra immédiatement l’accès au tunnel. Son lien et son QR code cesseront de fonctionner. Cette action est irréversible : un nouvel identifiant sera généré si vous le rajoutez.')}
            </>
          }
          onClose={() => setPending(null)}
          onConfirm={() => {
            const uuid = pending.uuid
            setPending(null)
            void act(() => api(`/api/users/${uuid}`, { method: 'DELETE' }))
          }}
        />
      )}
    </>
  )
}

function UserCard({ user, onRevoke }: { user: User; onRevoke: () => void }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  return (
    <li className="overflow-hidden rounded-[var(--radius-md3-xl)] bg-surface-container">
      <div className="flex flex-col gap-5 p-5 sm:flex-row">
        <div className="mx-auto size-32 shrink-0 rounded-[var(--radius-md3-m)] bg-white p-2 sm:mx-0 [&>div>svg]:size-full">
          <div dangerouslySetInnerHTML={{ __html: user.qr }} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-lg leading-6 font-medium">{user.name ?? t('sans nom')}</p>
              <p className="mt-0.5 font-mono text-xs text-on-surface-variant">{user.uuid.slice(0, 13)}…</p>
            </div>
            <TextButton tone="error" onClick={onRevoke}>
              {t('Révoquer')}
            </TextButton>
          </div>
          <textarea
            readOnly
            rows={3}
            value={user.link}
            onClick={(e) => e.currentTarget.select()}
            className="w-full resize-none rounded-[var(--radius-md3-m)] bg-surface-low p-3 font-mono text-[11px] leading-relaxed break-all text-on-surface-variant outline-none focus:ring-2 focus:ring-primary"
          />
          <TonalButton
            className="self-start"
            onClick={() => {
              void navigator.clipboard.writeText(user.link)
              setCopied(true)
              setTimeout(() => setCopied(false), 1600)
            }}
          >
            {copied ? t('Copié') : t('Copier le lien')}
          </TonalButton>
        </div>
      </div>
    </li>
  )
}

/* ── WireGuard ───────────────────────────────────────────────────────────── */

function WireguardTab({
  wg,
  busy,
  act,
}: {
  wg: Wireguard | undefined
  busy: boolean
  act: (fn: () => Promise<unknown>) => Promise<void>
}) {
  const t = useT()
  const [adding, setAdding] = useState(false)
  const [pending, setPending] = useState<Profile | null>(null)
  const [name, setName] = useState('')
  const [conf, setConf] = useState('')
  const [formError, setFormError] = useState('')
  const [dragging, setDragging] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)

  const profiles = wg?.profiles ?? []
  const on = Boolean(wg?.enabled)
  const firstEnabled = profiles.find((p) => p.enabled)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError('')
    try {
      await api('/api/wireguard', { method: 'POST', body: JSON.stringify({ name, config: conf }) })
      setName('')
      setConf('')
      setAdding(false)
      await act(async () => {})
    } catch (err) {
      setFormError((err as Error).message)
    }
  }

  const move = (from: number, to: number) => {
    if (to < 0 || to >= profiles.length) return
    const tags = profiles.map((p) => p.tag)
    const [moved] = tags.splice(from, 1)
    tags.splice(to, 0, moved)
    void act(() => api('/api/wireguard/order', { method: 'POST', body: JSON.stringify({ tags }) }))
  }

  return (
    <>
      <Card className="mb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-56 flex-1">
            <h2 className="text-xl leading-7 font-normal">{t('Sortie par un tunnel')}</h2>
            <p className="mt-1 text-sm text-on-surface-variant">
              {on && firstEnabled ? (
                <>
                  {t('Le trafic ressort par')} <strong className="text-on-surface">{firstEnabled.name}</strong>
                  {t(', le premier tunnel actif de la liste.')}
                </>
              ) : (
                t('Le trafic ressort directement par cette machine.')
              )}
            </p>
          </div>
          <Switch
            label={t('Sortie par un tunnel')}
            checked={on}
            disabled={busy || (!on && !firstEnabled)}
            onChange={(v) =>
              void act(() =>
                api('/api/wireguard/enabled', { method: 'POST', body: JSON.stringify({ enabled: v }) }),
              )
            }
          />
        </div>
        {!on && !firstEnabled && profiles.length > 0 && (
          <p className="mt-4 text-xs text-on-surface-variant">
            {t('Activez au moins un tunnel ci-dessous pour pouvoir enclencher la sortie.')}
          </p>
        )}
      </Card>

      <div className="mb-3 flex items-center justify-between px-1">
        <h2 className="text-sm font-medium tracking-wide text-on-surface-variant uppercase">
          {t('Tunnels')} · {profiles.length}
          {profiles.length > 1 && (
            <span className="ml-2 hidden font-normal normal-case sm:inline">{t('— glissez pour réordonner')}</span>
          )}
        </h2>
        <TonalButton onClick={() => { setFormError(''); setAdding(true) }}>
          <Plus /> {t('Ajouter')}
        </TonalButton>
      </div>

      {profiles.length ? (
        <ul className="flex flex-col gap-4">
          {profiles.map((p, i) => {
            const serving = on && firstEnabled?.tag === p.tag
            return (
              <li
                key={p.tag}
                draggable
                onDragStart={() => setDragging(i)}
                onDragOver={(e) => {
                  e.preventDefault()
                  setOver(i)
                }}
                onDragEnd={() => {
                  if (dragging !== null && over !== null && dragging !== over) move(dragging, over)
                  setDragging(null)
                  setOver(null)
                }}
                className={`rounded-[var(--radius-md3-xl)] p-5 transition-[opacity,box-shadow] ${
                  serving ? 'bg-secondary-container text-on-secondary-container' : 'bg-surface-container'
                } ${p.enabled ? '' : 'opacity-60'} ${dragging === i ? 'opacity-40' : ''} ${
                  over === i && dragging !== null && dragging !== i ? 'ring-2 ring-primary' : ''
                }`}
              >
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span
                      className="hidden cursor-grab text-on-surface-variant active:cursor-grabbing sm:block"
                      title={t('Glisser pour réordonner')}
                      aria-hidden
                    >
                      <svg viewBox="0 0 24 24" className="size-5 fill-current">
                        <path d="M9 4h2v2H9V4zm4 0h2v2h-2V4zM9 9h2v2H9V9zm4 0h2v2h-2V9zm-4 5h2v2H9v-2zm4 0h2v2h-2v-2zm-4 5h2v2H9v-2zm4 0h2v2h-2v-2z" />
                      </svg>
                    </span>
                    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-low text-xs font-medium text-on-surface-variant">
                      {i + 1}
                    </span>
                    <p className="text-lg leading-6 font-medium">{p.name}</p>
                    {serving && <Chip tone="ok">{t('en service')}</Chip>}
                    {!p.enabled && <Chip>{t('désactivé')}</Chip>}
                  </div>
                  <div className="flex items-center gap-1">
                    <IconButton label={t('Monter')} onClick={() => move(i, i - 1)}>
                      <path d="M7.4 15.4 12 10.8l4.6 4.6L18 14l-6-6-6 6z" />
                    </IconButton>
                    <IconButton label={t('Descendre')} onClick={() => move(i, i + 1)}>
                      <path d="M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z" />
                    </IconButton>
                    <TextButton tone="error" onClick={() => setPending(p)}>
                      {t('Supprimer')}
                    </TextButton>
                    <Switch
                      label={`${t('Activer')} ${p.name}`}
                      checked={p.enabled}
                      disabled={busy}
                      onChange={(v) =>
                        void act(() =>
                          api(`/api/wireguard/${p.tag}/enabled`, {
                            method: 'POST',
                            body: JSON.stringify({ enabled: v }),
                          }),
                        )
                      }
                    />
                  </div>
                </div>
                <table className="w-full text-sm">
                  <tbody>
                    <Row label={t('Pair')}>{p.peer}</Row>
                    <Row label={t('Adresse dans le tunnel')}>{p.address.join(', ')}</Row>
                    <Row label={t('Réseaux routés')}>{p.allowedIps.join(', ')}</Row>
                    <Row label={t('Keepalive')}>{p.keepalive ? `${p.keepalive} s` : '—'}</Row>
                  </tbody>
                </table>
              </li>
            )
          })}
        </ul>
      ) : (
        <Empty>{t('Aucun tunnel WireGuard.')}</Empty>
      )}

      {adding && (
        <Modal title={t('Nouveau tunnel WireGuard')} wide onClose={() => setAdding(false)}>
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <Field label={t('Nom du tunnel')} value={name} onChange={setName} autoFocus />
            <textarea
              rows={11}
              value={conf}
              onChange={(e) => setConf(e.target.value)}
              spellCheck={false}
              placeholder={'[Interface]\nPrivateKey = …\nAddress = 10.0.0.2/32\n\n[Peer]\nPublicKey = …\nAllowedIPs = 10.0.0.0/8\nEndpoint = vpn.example.com:51820'}
              className="w-full resize-y rounded-[var(--radius-md3-m)] border border-outline bg-surface-low p-3 font-mono text-xs leading-relaxed text-on-surface outline-none focus:border-2 focus:border-primary"
            />
            <p className="text-xs text-on-surface-variant">
              {t('Collez la configuration fournie par votre routeur. Seuls les réseaux listés dans')}{' '}
              <code>AllowedIPs</code>{' '}
              {t('passeront par le tunnel ; la clé privée n’est jamais réaffichée.')}
            </p>
            {formError && <Banner tone="error">{t(formError)}</Banner>}
            <div className="flex justify-end gap-2">
              <TextButton onClick={() => setAdding(false)}>{t('Annuler')}</TextButton>
              <FilledButton disabled={!name.trim() || !conf.trim()}>{t('Ajouter')}</FilledButton>
            </div>
          </form>
        </Modal>
      )}

      {pending && (
        <ConfirmModal
          title={t('Supprimer ce tunnel ?')}
          busy={busy}
          body={
            <>
              {t('Le tunnel')} <strong className="text-on-surface">{pending.name}</strong>{' '}
              {t('et sa clé privée seront retirés de la configuration.')}
              {firstEnabled?.tag === pending.tag && on && (
                <span className="mt-2 block">
                  {t('C’est celui en service : le trafic passera au tunnel actif suivant, ou ressortira directement par cette machine s’il n’en reste aucun.')}
                </span>
              )}
            </>
          }
          onClose={() => setPending(null)}
          onConfirm={() => {
            const tag = pending.tag
            setPending(null)
            void act(() => api(`/api/wireguard/${tag}`, { method: 'DELETE' }))
          }}
        />
      )}
    </>
  )
}

/* ── Applications ────────────────────────────────────────────────────────── */

type Platform = 'android' | 'ios' | 'windows' | 'macos' | 'linux'

const PLATFORMS: { id: Platform; label: string }[] = [
  { id: 'android', label: 'Android' },
  { id: 'ios', label: 'iOS' },
  { id: 'windows', label: 'Windows' },
  { id: 'macos', label: 'macOS' },
  { id: 'linux', label: 'Linux' },
]

const CLIENTS: Record<Platform, { name: string; desc: string; url: string }[]> = {
  android: [
    { name: 'Hiddify', desc: 'Le plus simple : coller le lien ou scanner le QR', url: 'https://github.com/hiddify/hiddify-app' },
    { name: 'sing-box (SFA)', desc: 'Client officiel du projet sing-box', url: 'https://github.com/SagerNet/sing-box-for-android' },
    { name: 'NekoBox', desc: 'Plus de réglages, pour un usage avancé', url: 'https://github.com/MatsuriDayo/NekoBoxForAndroid' },
    { name: 'v2rayNG', desc: 'La référence historique, très éprouvée', url: 'https://github.com/2dust/v2rayNG' },
  ],
  ios: [
    { name: 'Hiddify', desc: 'Disponible sur l’App Store', url: 'https://github.com/hiddify/hiddify-app' },
    { name: 'sing-box (SFI)', desc: 'Client officiel, App Store', url: 'https://github.com/SagerNet/sing-box' },
  ],
  windows: [
    { name: 'Hiddify', desc: 'Installateur, import du lien en un clic', url: 'https://github.com/hiddify/hiddify-app' },
    { name: 'v2rayN', desc: 'Client de bureau complet', url: 'https://github.com/2dust/v2rayN' },
    { name: 'GUI.for.SingBox', desc: 'Interface riche, règles et mode TUN', url: 'https://github.com/GUI-for-Cores/GUI.for.SingBox' },
  ],
  macos: [
    { name: 'Hiddify', desc: 'Application de bureau', url: 'https://github.com/hiddify/hiddify-app' },
    { name: 'sing-box (SFM)', desc: 'Client officiel, App Store', url: 'https://github.com/SagerNet/sing-box' },
    { name: 'v2rayN', desc: 'Multiplateforme', url: 'https://github.com/2dust/v2rayN' },
  ],
  linux: [
    { name: 'Hiddify', desc: 'AppImage et paquets', url: 'https://github.com/hiddify/hiddify-app' },
    { name: 'GUI.for.SingBox', desc: 'Interface de bureau', url: 'https://github.com/GUI-for-Cores/GUI.for.SingBox' },
    { name: 'sing-box', desc: 'Le cœur en ligne de commande', url: 'https://github.com/SagerNet/sing-box' },
  ],
}

function detectPlatform(): Platform {
  const ua = navigator.userAgent
  if (/Android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos'
  if (/Windows/i.test(ua)) return 'windows'
  return 'linux'
}

function AppsTab() {
  const t = useT()
  const [platform, setPlatform] = useState<Platform>(detectPlatform)
  return (
    <Card>
      <h2 className="mb-1 text-xl leading-7 font-normal">{t('Applications clientes')}</h2>
      <p className="mb-5 text-sm text-on-surface-variant">
        {t('Scannez le QR code ou collez le lien dans l’une de ces applications.')}
      </p>

      <div className="mb-5 -mx-1 flex overflow-x-auto px-1 pb-1">
        <div className="inline-flex rounded-[var(--radius-md3-full)] border border-outline">
          {PLATFORMS.map((p, i) => {
            const on = p.id === platform
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setPlatform(p.id)}
                className={`state-layer h-10 shrink-0 px-4 text-sm font-medium whitespace-nowrap ${
                  on ? 'bg-secondary-container text-on-secondary-container' : 'text-on-surface-variant'
                } ${i === 0 ? 'rounded-l-[var(--radius-md3-full)]' : 'border-l border-outline'} ${
                  i === PLATFORMS.length - 1 ? 'rounded-r-[var(--radius-md3-full)]' : ''
                }`}
              >
                {on && <Check className="mr-1.5 inline" />}
                {p.label}
              </button>
            )
          })}
        </div>
      </div>

      <ul className="flex flex-col gap-2">
        {CLIENTS[platform].map((c) => (
          <li key={c.name}>
            <a
              href={c.url}
              target="_blank"
              rel="noreferrer noopener"
              className="state-layer flex items-center gap-4 rounded-[var(--radius-md3-m)] bg-surface-low px-4 py-3"
            >
              <svg viewBox="0 0 24 24" className="size-5 shrink-0 fill-current text-on-surface-variant" aria-hidden>
                <path d="M12 .3a12 12 0 00-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2 0-.4-.5-1.6.2-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 016 0C17.3 4.5 18.3 4.8 18.3 4.8c.7 1.6.2 2.8.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0012 .3z" />
              </svg>
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-on-surface">{c.name}</span>
                <span className="block text-sm text-on-surface-variant">{t(c.desc)}</span>
              </span>
              <svg viewBox="0 0 24 24" className="size-5 shrink-0 fill-current text-on-surface-variant" aria-hidden>
                <path d="M19 19H5V5h7V3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7h-2v7zM14 3v2h3.6l-9.8 9.8 1.4 1.4L19 6.4V10h2V3h-7z" />
              </svg>
            </a>
          </li>
        ))}
      </ul>
    </Card>
  )
}

/* ── Paramètres ──────────────────────────────────────────────────────────── */

function SettingsTab({ state }: { state: State }) {
  const { t, lang, setLang } = useI18n()
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (next !== confirm) return setError(t('les deux saisies diffèrent'))
    setBusy(true)
    try {
      await api('/api/password', { method: 'POST', body: JSON.stringify({ current, next }) })
      setCurrent(''); setNext(''); setConfirm('')
      setOpen(false)
      setDone(true)
      setTimeout(() => setDone(false), 4000)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Card className="mb-6">
        <h2 className="mb-4 text-xl leading-7 font-normal">{t('Service')}</h2>
        <table className="w-full text-sm">
          <tbody>
            <Row label={t('État')}>{state.service?.running ? t('actif') : t('arrêté')}</Row>
            <Row label={t('Version')}>{state.service?.version}</Row>
            <Row label={t('Nom public')}>
              {state.tunnel?.host}:{state.tunnel?.port}
            </Row>
            <Row label={t('Chemin WebSocket')}>{state.tunnel?.path}</Row>
          </tbody>
        </table>
      </Card>

      <Card className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl leading-7 font-normal">{t('Langue')}</h2>
            <p className="mt-1 text-sm text-on-surface-variant">{t('Langue de l’interface.')}</p>
          </div>
          <div className="inline-flex rounded-[var(--radius-md3-full)] border border-outline">
            {(['fr', 'en'] as const).map((l, i) => (
              <button
                key={l}
                type="button"
                onClick={() => setLang(l)}
                className={`state-layer h-10 px-5 text-sm font-medium ${
                  lang === l ? 'bg-secondary-container text-on-secondary-container' : 'text-on-surface-variant'
                } ${i === 0 ? 'rounded-l-[var(--radius-md3-full)]' : 'border-l border-outline rounded-r-[var(--radius-md3-full)]'}`}
              >
                {l === 'fr' ? t('Français') : t('Anglais')}
              </button>
            ))}
          </div>
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl leading-7 font-normal">{t('Mot de passe')}</h2>
            <p className="mt-1 text-sm text-on-surface-variant">
              {done ? t('Modifié — les autres sessions ont été fermées.') : t('Accès à cette interface.')}
            </p>
          </div>
          <TonalButton onClick={() => { setError(''); setOpen(true) }}>{t('Changer')}</TonalButton>
        </div>
      </Card>

      {open && (
        <Modal title={t('Changer le mot de passe')} onClose={() => setOpen(false)}>
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <Field label={t('Mot de passe actuel')} type="password" value={current} onChange={setCurrent} autoFocus />
            <Field label={t('Nouveau mot de passe')} type="password" value={next} onChange={setNext} />
            <Field label={t('Confirmer')} type="password" value={confirm} onChange={setConfirm} />
            <p className="text-xs text-on-surface-variant">
              {t('10 caractères minimum. Les autres sessions seront fermées.')}
            </p>
            {error && <Banner tone="error">{t(error)}</Banner>}
            <div className="flex justify-end gap-2">
              <TextButton onClick={() => setOpen(false)}>{t('Annuler')}</TextButton>
              <FilledButton disabled={busy || !current || !next || !confirm}>{t('Enregistrer')}</FilledButton>
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}

/* ── Icônes ──────────────────────────────────────────────────────────────── */

function Shield({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`fill-current ${className}`} aria-hidden>
      <path d="M12 2L4 6v6c0 5 3.4 9.4 8 10 4.6-.6 8-5 8-10V6l-8-4zm0 5a2.5 2.5 0 110 5 2.5 2.5 0 010-5zm0 11c-1.7 0-3.2-.9-4-2.2.1-1.3 2.7-2 4-2s3.9.7 4 2A4.7 4.7 0 0112 18z" />
    </svg>
  )
}

function Plus() {
  return (
    <svg viewBox="0 0 24 24" className="size-[18px] fill-current" aria-hidden>
      <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
    </svg>
  )
}

function Check({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`size-[18px] fill-current ${className}`} aria-hidden>
      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
    </svg>
  )
}
