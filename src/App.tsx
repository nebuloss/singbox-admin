import { useCallback, useEffect, useState } from 'react'

type User = { uuid: string; name?: string; link: string; qr: string }
type Wireguard = {
  address: string[]
  peer: string | null
  publicKey: string | null
  allowedIps: string[]
  keepalive: number | null
  presharedKey: boolean
}
type State = {
  authed: boolean
  setup?: boolean
  users?: User[]
  service?: { running: boolean; version: string }
  tunnel?: { host: string; port: number; path: string }
  wireguard?: Wireguard | null
}

const api = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json' } })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error ?? `erreur ${r.status}`)
  return body
}

export default function App() {
  const [state, setState] = useState<State | null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

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
    // Dedicated full-screen layout: no app bar, nothing to navigate to yet.
    return (
      <div className="grid min-h-screen place-items-center bg-surface px-6 py-10 text-on-surface">
        <div className="w-full max-w-[26rem]">
          <div className="mb-10 flex flex-col items-center text-center">
            <span className="mb-6 grid size-16 place-items-center rounded-[var(--radius-md3-l)] bg-primary-container text-on-primary-container">
              <svg viewBox="0 0 24 24" className="size-8 fill-current" aria-hidden>
                <path d="M12 2L4 6v6c0 5 3.4 9.4 8 10 4.6-.6 8-5 8-10V6l-8-4zm0 5a2.5 2.5 0 110 5 2.5 2.5 0 010-5zm0 11c-1.7 0-3.2-.9-4-2.2.1-1.3 2.7-2 4-2s3.9.7 4 2A4.7 4.7 0 0112 18z" />
              </svg>
            </span>
            <h1 className="text-[1.75rem] leading-9 font-normal">sing-box</h1>
            <p className="mt-2 text-base text-on-surface-variant">Administration du tunnel</p>
          </div>

          {state.setup ? (
            // First run: no password is set yet, so we ask for one instead of
            // refusing access. Whoever reaches the app first claims it — hence
            // the warning, and hence resetting requires root on the host.
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault()
                if (password !== confirm) return setError('les deux saisies diffèrent')
                void act(() =>
                  api('/api/setup', { method: 'POST', body: JSON.stringify({ password }) }),
                )
              }}
            >
              <Banner>
                Première configuration : choisissez le mot de passe d’administration.
              </Banner>
              <Field
                label="Mot de passe"
                type="password"
                value={password}
                autoFocus
                onChange={setPassword}
              />
              <Field label="Confirmer" type="password" value={confirm} onChange={setConfirm} />
              <p className="text-xs text-on-surface-variant">10 caractères minimum.</p>
              {error && <Banner tone="error">{error}</Banner>}
              <FilledButton
                disabled={busy || password.length < 10 || !confirm}
                className="mt-2 h-12 w-full justify-center"
              >
                Définir le mot de passe
              </FilledButton>
            </form>
          ) : (
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault()
                void act(() =>
                  api('/api/login', { method: 'POST', body: JSON.stringify({ password }) }),
                )
              }}
            >
              <Field
                label="Mot de passe"
                type="password"
                value={password}
                autoFocus
                onChange={setPassword}
              />
              {error && <Banner tone="error">{error}</Banner>}
              <FilledButton disabled={busy || !password} className="mt-2 h-12 w-full justify-center">
                Se connecter
              </FilledButton>
            </form>
          )}
        </div>
      </div>
    )
  }

  const running = state.service?.running

  return (
    <Shell
      trailing={
        <IconButton
          label="Déconnexion"
          onClick={() => void act(() => api('/api/logout', { method: 'POST' }))}
        >
          <path d="M10 17l5-5-5-5v3H3v4h7v3zm9-14H5a2 2 0 00-2 2v4h2V5h14v14H5v-4H3v4a2 2 0 002 2h14a2 2 0 002-2V5a2 2 0 00-2-2z" />
        </IconButton>
      }
    >
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Chip tone={running ? 'ok' : 'error'}>
          <span
            className={`size-2 rounded-full ${running ? 'bg-on-secondary-container' : 'bg-on-error-container'}`}
          />
          {running ? 'Service actif' : 'Service arrêté'}
        </Chip>
        {state.service?.version && <Chip>{state.service.version}</Chip>}
        <Chip>
          {state.tunnel?.host}:{state.tunnel?.port}
        </Chip>
      </div>

      <Card className="mb-6">
        <h2 className="mb-1 text-xl leading-7 font-normal text-on-surface">Ajouter un appareil</h2>
        <p className="mb-5 text-sm text-on-surface-variant">
          Un identifiant unique est généré ; le retirer suffit à révoquer l'accès.
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
          <Field
            label="Nom de l'appareil"
            value={newName}
            onChange={setNewName}
            className="min-w-56 flex-1"
          />
          <FilledButton disabled={busy || !newName.trim()}>
            <svg viewBox="0 0 24 24" className="size-[18px] fill-current" aria-hidden>
              <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
            </svg>
            Ajouter
          </FilledButton>
        </form>
      </Card>

      {error && (
        <Banner tone="error" className="mb-6">
          {error}
        </Banner>
      )}

      <h2 className="mb-3 px-1 text-sm font-medium tracking-wide text-on-surface-variant uppercase">
        Appareils · {state.users?.length ?? 0}
      </h2>

      <ul className="flex flex-col gap-4">
        {state.users?.map((u) => (
          <UserCard
            key={u.uuid}
            user={u}
            busy={busy}
            onDelete={() => void act(() => api(`/api/users/${u.uuid}`, { method: 'DELETE' }))}
          />
        ))}
      </ul>

      <WireguardCard wg={state.wireguard} onChange={() => void refresh()} />
      <Clients />
      <PasswordCard />
    </Shell>
  )
}

function UserCard({ user, busy, onDelete }: { user: User; busy: boolean; onDelete: () => void }) {
  const [copied, setCopied] = useState(false)
  const [confirming, setConfirming] = useState(false)

  return (
    <li className="overflow-hidden rounded-[var(--radius-md3-xl)] bg-surface-container">
      <div className="flex flex-col gap-5 p-5 sm:flex-row">
        <div className="mx-auto size-32 shrink-0 rounded-[var(--radius-md3-m)] bg-white p-2 sm:mx-0 [&>svg]:size-full">
          <div dangerouslySetInnerHTML={{ __html: user.qr }} />
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-lg leading-6 font-medium text-on-surface">
                {user.name ?? 'sans nom'}
              </p>
              <p className="mt-0.5 font-mono text-xs text-on-surface-variant">
                {user.uuid.slice(0, 13)}…
              </p>
            </div>
            {confirming ? (
              <div className="flex shrink-0 gap-1">
                <TextButton tone="error" disabled={busy} onClick={onDelete}>
                  Confirmer
                </TextButton>
                <TextButton onClick={() => setConfirming(false)}>Annuler</TextButton>
              </div>
            ) : (
              <TextButton tone="error" onClick={() => setConfirming(true)}>
                Révoquer
              </TextButton>
            )}
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
            <svg viewBox="0 0 24 24" className="size-[18px] fill-current" aria-hidden>
              {copied ? (
                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
              ) : (
                <path d="M16 1H4a2 2 0 00-2 2v14h2V3h12V1zm3 4H8a2 2 0 00-2 2v14a2 2 0 002 2h11a2 2 0 002-2V7a2 2 0 00-2-2zm0 16H8V7h11v14z" />
              )}
            </svg>
            {copied ? 'Copié' : 'Copier le lien'}
          </TonalButton>
        </div>
      </div>
    </li>
  )
}

/* ── WireGuard ───────────────────────────────────────────────────────────── */

function WireguardCard({ wg, onChange }: { wg: Wireguard | null | undefined; onChange: () => void }) {
  const [open, setOpen] = useState(false)
  const [conf, setConf] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api('/api/wireguard', { method: 'POST', body: JSON.stringify({ config: conf }) })
      setConf('')
      setOpen(false)
      onChange()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    setError('')
    try {
      await api('/api/wireguard', { method: 'DELETE' })
      setConfirming(false)
      onChange()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mt-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl leading-7 font-normal text-on-surface">Sortie WireGuard</h2>
          <p className="mt-1 text-sm text-on-surface-variant">
            {wg
              ? 'Le trafic des appareils ressort par ce tunnel.'
              : 'Optionnel : faire ressortir le trafic par un tunnel WireGuard existant.'}
          </p>
        </div>
        {!open && (
          <TonalButton onClick={() => { setError(''); setOpen(true) }}>
            {wg ? 'Remplacer' : 'Configurer'}
          </TonalButton>
        )}
      </div>

      {wg && !open && (
        <div className="mt-5 flex flex-col gap-3">
          <table className="w-full text-sm">
            <tbody>
              <Row label="Pair">{wg.peer}</Row>
              <Row label="Adresse dans le tunnel">{wg.address.join(', ')}</Row>
              <Row label="Réseaux routés">{wg.allowedIps.join(', ')}</Row>
              <Row label="Keepalive">{wg.keepalive ? `${wg.keepalive} s` : '—'}</Row>
              <Row label="Clé partagée">{wg.presharedKey ? 'oui' : 'non'}</Row>
            </tbody>
          </table>
          <div className="flex justify-end">
            {confirming ? (
              <span className="flex gap-1">
                <TextButton tone="error" disabled={busy} onClick={remove}>
                  Confirmer la suppression
                </TextButton>
                <TextButton onClick={() => setConfirming(false)}>Annuler</TextButton>
              </span>
            ) : (
              <TextButton tone="error" onClick={() => setConfirming(true)}>
                Supprimer le tunnel
              </TextButton>
            )}
          </div>
        </div>
      )}

      {open && (
        <form className="mt-5 flex flex-col gap-3" onSubmit={submit}>
          <p className="text-sm text-on-surface-variant">
            Collez la configuration WireGuard fournie par votre routeur ou votre fournisseur.
          </p>
          <textarea
            autoFocus
            rows={11}
            value={conf}
            onChange={(e) => setConf(e.target.value)}
            spellCheck={false}
            placeholder={'[Interface]\nPrivateKey = …\nAddress = 10.0.0.2/32\n\n[Peer]\nPublicKey = …\nAllowedIPs = 10.0.0.0/8\nEndpoint = vpn.example.com:51820'}
            className="w-full resize-y rounded-[var(--radius-md3-m)] border border-outline bg-surface-low p-3 font-mono text-xs leading-relaxed text-on-surface outline-none focus:border-2 focus:border-primary"
          />
          <p className="text-xs text-on-surface-variant">
            Seuls les réseaux listés dans <code>AllowedIPs</code> passeront par le tunnel. La clé
            privée est stockée dans la configuration de sing-box et n’est jamais réaffichée.
          </p>
          {error && <Banner tone="error">{error}</Banner>}
          <div className="flex justify-end gap-2">
            <TextButton onClick={() => setOpen(false)}>Annuler</TextButton>
            <FilledButton disabled={busy || !conf.trim()}>Appliquer</FilledButton>
          </div>
        </form>
      )}

      {error && !open && <Banner tone="error" className="mt-4">{error}</Banner>}
    </Card>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <tr>
      <td className="py-1 pr-4 align-top whitespace-nowrap text-on-surface-variant">{label}</td>
      <td className="py-1 font-mono text-xs break-all">{children}</td>
    </tr>
  )
}

/* ── Password ────────────────────────────────────────────────────────────── */

function PasswordCard() {
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const reset = () => {
    setCurrent(''); setNext(''); setConfirm(''); setError('')
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (next !== confirm) return setError('les deux saisies diffèrent')
    setBusy(true)
    try {
      await api('/api/password', { method: 'POST', body: JSON.stringify({ current, next }) })
      reset()
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
    <Card className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl leading-7 font-normal text-on-surface">Mot de passe</h2>
          <p className="mt-1 text-sm text-on-surface-variant">
            {done ? 'Modifié — les autres sessions ont été fermées.' : 'Accès à cette interface d’administration.'}
          </p>
        </div>
        {!open && (
          <TonalButton
            onClick={() => {
              reset()
              setOpen(true)
            }}
          >
            Changer
          </TonalButton>
        )}
      </div>

      {open && (
        <form className="mt-6 flex flex-col gap-4" onSubmit={submit}>
          <Field label="Mot de passe actuel" type="password" value={current} onChange={setCurrent} autoFocus />
          <Field label="Nouveau mot de passe" type="password" value={next} onChange={setNext} />
          <Field label="Confirmer" type="password" value={confirm} onChange={setConfirm} />
          <p className="text-xs text-on-surface-variant">10 caractères minimum.</p>
          {error && <Banner tone="error">{error}</Banner>}
          <div className="flex justify-end gap-2">
            <TextButton onClick={() => setOpen(false)}>Annuler</TextButton>
            <FilledButton disabled={busy || !current || !next || !confirm}>Enregistrer</FilledButton>
          </div>
        </form>
      )}
    </Card>
  )
}

/* ── Client apps ─────────────────────────────────────────────────────────── */

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

function Clients() {
  const [platform, setPlatform] = useState<Platform>(detectPlatform)

  return (
    <Card className="mt-8">
      <h2 className="mb-1 text-xl leading-7 font-normal text-on-surface">Applications clientes</h2>
      <p className="mb-5 text-sm text-on-surface-variant">
        Scanne le QR code ou colle le lien dans l’une de ces applications.
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
                className={`state-layer h-10 shrink-0 px-4 text-sm font-medium whitespace-nowrap transition-colors ${
                  on ? 'bg-secondary-container text-on-secondary-container' : 'text-on-surface-variant'
                } ${i === 0 ? 'rounded-l-[var(--radius-md3-full)]' : 'border-l border-outline'} ${
                  i === PLATFORMS.length - 1 ? 'rounded-r-[var(--radius-md3-full)]' : ''
                }`}
              >
                {on && (
                  <svg viewBox="0 0 24 24" className="mr-1.5 inline size-[18px] fill-current" aria-hidden>
                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                  </svg>
                )}
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
                <span className="block text-sm text-on-surface-variant">{c.desc}</span>
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

/* ── MD3 building blocks ─────────────────────────────────────────────────── */

function Shell({ children, trailing }: { children: React.ReactNode; trailing?: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-surface text-on-surface">
      <header className="sticky top-0 z-10 bg-surface/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-[var(--radius-md3-m)] bg-primary-container text-on-primary-container">
              <svg viewBox="0 0 24 24" className="size-5 fill-current" aria-hidden>
                <path d="M12 2L4 6v6c0 5 3.4 9.4 8 10 4.6-.6 8-5 8-10V6l-8-4zm0 5a2.5 2.5 0 110 5 2.5 2.5 0 010-5zm0 11c-1.7 0-3.2-.9-4-2.2.1-1.3 2.7-2 4-2s3.9.7 4 2A4.7 4.7 0 0112 18z" />
              </svg>
            </span>
            <div>
              <h1 className="text-xl leading-6 font-normal">sing-box</h1>
              <p className="text-xs text-on-surface-variant">administration du tunnel</p>
            </div>
          </div>
          {trailing}
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 pb-16 sm:px-6">{children}</main>
    </div>
  )
}

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-[var(--radius-md3-xl)] bg-surface-container p-6 ${className}`}>
      {children}
    </section>
  )
}

function Field({
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
    <label className={`group relative block ${className}`}>
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

function FilledButton({
  children,
  disabled,
  className = '',
}: {
  children: React.ReactNode
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      disabled={disabled}
      className={`state-layer inline-flex h-10 items-center gap-2 rounded-[var(--radius-md3-full)] bg-primary px-6 text-sm font-medium text-on-primary transition-opacity disabled:pointer-events-none disabled:opacity-38 ${className}`}
    >
      {children}
    </button>
  )
}

function TonalButton({
  children,
  onClick,
  className = '',
}: {
  children: React.ReactNode
  onClick?: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`state-layer inline-flex h-10 items-center gap-2 rounded-[var(--radius-md3-full)] bg-secondary-container px-5 text-sm font-medium text-on-secondary-container ${className}`}
    >
      {children}
    </button>
  )
}

function TextButton({
  children,
  onClick,
  disabled,
  tone,
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  tone?: 'error'
}) {
  return (
    <button
      type="button"
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

function IconButton({
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

function Chip({ children, tone }: { children: React.ReactNode; tone?: 'ok' | 'error' }) {
  const tones = {
    ok: 'bg-secondary-container text-on-secondary-container',
    error: 'bg-error-container text-on-error-container',
  }
  return (
    <span
      className={`inline-flex h-8 items-center gap-2 rounded-[var(--radius-md3-s)] px-3 text-xs font-medium ${
        tone ? tones[tone] : 'border border-outline-variant text-on-surface-variant'
      }`}
    >
      {children}
    </span>
  )
}

function Banner({
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
