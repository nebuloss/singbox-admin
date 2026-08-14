import { createContext, useContext, useEffect, useState } from 'react'

/**
 * Translation, gettext style: the French string is its own key.
 *
 * That keeps the call sites readable, needs no key catalogue to maintain, and
 * degrades to French when a translation is missing rather than showing a bare
 * identifier. The trade is that editing a source string orphans its
 * translation — acceptable for two languages and a few dozen strings.
 */

export type Lang = 'fr' | 'en'

const EN: Record<string, string> = {
  // Layout and tabs
  'administration du tunnel': 'tunnel administration',
  'Administration du tunnel': 'Tunnel administration',
  Appareils: 'Devices',
  Applications: 'Applications',
  Paramètres: 'Settings',
  Déconnexion: 'Sign out',
  'service actif': 'service running',
  'service arrêté': 'service stopped',

  // Sign in / first run
  'Mot de passe': 'Password',
  Confirmer: 'Confirm',
  'Se connecter': 'Sign in',
  'Première configuration : choisissez le mot de passe d’administration.':
    'First run: choose the administration password.',
  'Définir le mot de passe': 'Set the password',
  '10 caractères minimum.': 'At least 10 characters.',
  'les deux saisies diffèrent': 'the two entries differ',

  // Devices
  'Ajouter un appareil': 'Add a device',
  'Un identifiant unique est généré ; le retirer suffit à révoquer l’accès.':
    'A unique identifier is generated; removing it is enough to revoke access.',
  'Nom de l’appareil': 'Device name',
  Ajouter: 'Add',
  'Un appareil porte déjà ce nom.': 'A device already has this name.',
  'Aucun appareil déclaré.': 'No device yet.',
  'sans nom': 'unnamed',
  Révoquer: 'Revoke',
  Renommer: 'Rename',
  'Renommer l’appareil': 'Rename the device',
  'L’identifiant ne change pas : un appareil déjà connecté n’est pas coupé, seule l’étiquette portée par le lien change.':
    'The identifier does not change: a connected device is not cut off, only the label carried by the link.',
  'Révoquer cet appareil ?': 'Revoke this device?',
  'Le lien reste valide : réactiver l’appareil suffit à le remettre en service.':
    'The link stays valid: switching the device back on is all it takes.',
  'Copier le lien': 'Copy the link',
  'Copier l’abonnement': 'Copy the subscription',
  'Abonnement — importez ceci, le DNS est compris':
    'Subscription — import this one, DNS included',
  'Lien simple — sans réglage DNS': 'Plain link — carries no DNS setting',
  Copié: 'Copied',

  // WireGuard
  'Sortie par un tunnel': 'Route through a tunnel',
  'Le trafic ressort directement par cette machine.':
    'Traffic leaves directly from this machine.',
  'Activez au moins un tunnel ci-dessous pour pouvoir enclencher la sortie.':
    'Enable at least one tunnel below to turn this on.',
  '— glissez pour réordonner': '— drag to reorder',
  'Glisser pour réordonner': 'Drag to reorder',
  'en service': 'in use',
  désactivé: 'disabled',
  Monter: 'Move up',
  Descendre: 'Move down',
  Activer: 'Enable',
  Supprimer: 'Delete',
  'Supprimer ce tunnel ?': 'Delete this tunnel?',
  'Aucun tunnel WireGuard.': 'No WireGuard tunnel.',
  'Nouveau tunnel WireGuard': 'New WireGuard tunnel',
  Modifier: 'Edit',
  'Modifier le tunnel': 'Edit the tunnel',
  'Clé publique du pair': 'Peer public key',
  'Format attendu : hôte:port': 'Expected format: host:port',
  'Un tunnel porte déjà ce nom.': 'A tunnel already has this name.',
  'La clé privée n’est pas modifiée. Pour en changer, supprimez le tunnel et recréez-le.':
    'The private key is left unchanged. To replace it, delete the tunnel and create it again.',
  'Nom du tunnel': 'Tunnel name',
  Pair: 'Peer',
  'Adresse dans le tunnel': 'Address inside the tunnel',
  'Réseaux routés': 'Routed networks',
  Keepalive: 'Keepalive',
  DNS: 'DNS',
  'Le DNS est celui de la ligne « DNS » de la configuration WireGuard : c’est lui qui résout les noms internes, et il est interrogé à travers ce tunnel.':
    'The DNS is the one from the WireGuard configuration’s DNS line: it is what resolves internal names, and it is queried through this tunnel.',

  // Applications
  'Applications clientes': 'Client applications',
  'Scannez le QR code ou collez le lien dans l’une de ces applications.':
    'Scan the QR code or paste the link into one of these applications.',
  'Le plus simple : coller le lien ou scanner le QR':
    'The simplest: paste the link or scan the QR code',
  'Client officiel du projet sing-box': 'Official sing-box client',
  'Plus de réglages, pour un usage avancé': 'More settings, for advanced use',
  'La référence historique, très éprouvée': 'The long-standing, battle-tested one',
  'Disponible sur l’App Store': 'Available on the App Store',
  'Client officiel, App Store': 'Official client, App Store',
  'Installateur, import du lien en un clic': 'Installer, one-click link import',
  'Client de bureau complet': 'Full desktop client',
  'Interface riche, règles et mode TUN': 'Rich interface, rules and TUN mode',
  'Application de bureau': 'Desktop application',
  Multiplateforme: 'Cross-platform',
  'AppImage et paquets': 'AppImage and packages',
  'Interface de bureau': 'Desktop interface',
  'Le cœur en ligne de commande': 'The command-line core',

  // Settings
  Service: 'Service',
  État: 'State',
  actif: 'running',
  arrêté: 'stopped',
  Version: 'Version',
  'Nom public': 'Public hostname',
  'Chemin WebSocket': 'WebSocket path',
  Régénérer: 'Regenerate',
  'Régénérer le chemin ?': 'Regenerate the path?',
  'Le chemin ne sert qu’à ce qu’un scan du nom d’hôte ne trouve rien : c’est l’identifiant de l’appareil qui authentifie.':
    'The path only exists so a scan of the hostname finds nothing: it is the device identifier that authenticates.',
  'Tous les appareils perdront la connexion jusqu’à ce qu’ils réimportent leur lien : le chemin voyage dans le lien. À faire si vous pensez qu’il a fuité, pas par habitude.':
    'Every device loses its connection until it imports its link again, because the path travels in the link. Do this if you believe it leaked, not as a routine.',
  'Le reverse proxy n’a rien à changer : il transmet tout et laisse sing-box décider.':
    'The reverse proxy needs no change: it forwards everything and lets sing-box decide.',
  'Accès à cette interface.': 'Access to this interface.',
  'Modifié — les autres sessions ont été fermées.':
    'Changed — every other session was signed out.',
  Changer: 'Change',
  'Changer le mot de passe': 'Change the password',
  'Mot de passe actuel': 'Current password',
  'Nouveau mot de passe': 'New password',
  '10 caractères minimum. Les autres sessions seront fermées.':
    'At least 10 characters. Every other session will be signed out.',
  Enregistrer: 'Save',

  'perdra immédiatement l’accès au tunnel. Son lien et son QR code cesseront de fonctionner. Cette action est irréversible : un nouvel identifiant sera généré si vous le rajoutez.':
    'will immediately lose access to the tunnel. Its link and QR code will stop working. This cannot be undone: a new identifier is generated if you add it back.',
  'Le tunnel': 'Tunnel',
  'et sa clé privée seront retirés de la configuration.':
    'and its private key will be removed from the configuration.',
  'C’est celui en service : le trafic passera au tunnel actif suivant, ou ressortira directement par cette machine s’il n’en reste aucun.':
    'It is the one in use: traffic will move to the next enabled tunnel, or leave directly from this machine if none remain.',
  'Collez la configuration fournie par votre routeur. Seuls les réseaux listés dans':
    'Paste the configuration your router gives you. Only the networks listed in',
  'passeront par le tunnel ; la clé privée n’est jamais réaffichée.':
    'go through the tunnel; the private key is never shown again.',
  'Le trafic ressort par': 'Traffic leaves through',
  ', le premier tunnel actif de la liste.': ', the first enabled tunnel in the list.',
  Tunnels: 'Tunnels',
  'L’interface a rencontré une erreur inattendue. Le tunnel, lui, continue de fonctionner : recharger suffit généralement.':
    'The interface hit an unexpected error. The tunnel itself keeps running: reloading usually fixes it.',

  // Shared
  Annuler: 'Cancel',
  Fermer: 'Close',
  'Échec de l’opération': 'Operation failed',
  'Quelque chose s’est mal passé': 'Something went wrong',
  Recharger: 'Reload',

  // Server messages. Written unaccented on the server side, so the keys are
  // too — they must match the wire text byte for byte.
  'authentification requise': 'authentication required',
  'un mot de passe est deja defini': 'a password is already set',
  '10 caracteres minimum': 'at least 10 characters',
  'aucun mot de passe defini': 'no password set',
  'mot de passe incorrect': 'wrong password',
  'mot de passe actuel incorrect': 'wrong current password',
  'identique a l actuel': 'same as the current one',
  'nom invalide': 'invalid name',
  'ce nom existe deja': 'that name already exists',
  inconnu: 'unknown',
  'refus : cela supprimerait le dernier acces': 'refused: that would remove the last way in',
  'un tunnel porte deja ce nom': 'a tunnel already has that name',
  'liste de profils incoherente': 'inconsistent tunnel list',
  'aucun tunnel actif a utiliser': 'no enabled tunnel to route through',
  'tunnel introuvable': 'no such tunnel',
  'profil introuvable': 'no such tunnel',
  'tunnel sans pair': 'that tunnel has no peer',
  'l inbound n utilise pas un transport ws': 'that inbound does not use a ws transport',
  'adresse du pair manquante': 'peer address missing',
  'port du pair invalide': 'invalid peer port',
  'cle publique du pair manquante': 'peer public key missing',
  'adresse dans le tunnel manquante': 'address inside the tunnel missing',
  'reseaux routes manquants': 'routed networks missing',
  'aucun inbound VLESS dans la configuration': 'no VLESS inbound in the configuration',
  'PrivateKey manquant dans [Interface]': 'PrivateKey missing from [Interface]',
  'Address manquant dans [Interface]': 'Address missing from [Interface]',
  'PublicKey manquant dans [Peer]': 'PublicKey missing from [Peer]',
  'Endpoint manquant dans [Peer]': 'Endpoint missing from [Peer]',

  // Prefixes of "<message> : <detail>" server errors — see t() below.
  'ecriture impossible': 'cannot write',
  'configuration refusee par sing-box': 'configuration rejected by sing-box',
  'redemarrage impossible': 'restart failed',
  'Endpoint illisible': 'unreadable Endpoint',
  'ce tunnel est deja configure sous le nom': 'this tunnel is already configured under the name',
  'erreur HTTP': 'HTTP error',
}

/**
 * The choice is kept in a cookie rather than localStorage: it is small, it is
 * not secret, and the server can read it if it ever needs to render anything
 * in the right language. Deliberately not `secure` — the interface is also
 * reached over plain HTTP on a local network, and a display preference is not
 * worth losing there.
 */
const COOKIE = 'lang'

const saved = (): Lang | null => {
  const m = document.cookie.match(/(?:^|;\s*)lang=(fr|en)(?:;|$)/)
  return m ? (m[1] as Lang) : null
}

const remember = (l: Lang) => {
  document.cookie = `${COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`
}

/** Falls back to the browser's own language, which follows the system. */
const detect = (): Lang => saved() ?? (navigator.language.toLowerCase().startsWith('fr') ? 'fr' : 'en')

export type Ctx = { lang: Lang; setLang: (l: Lang) => void; t: (s: string) => string }

/** Exported so ErrorBoundary — a class, so no hooks — can read it. */
export const I18nContext = createContext<Ctx>({ lang: 'fr', setLang: () => {}, t: (s) => s })

/**
 * Server errors come as free text, some of it "<message> : <detail>" where the
 * detail is sing-box output or a config line and must survive verbatim.
 * Translating just the part before the separator covers those without an
 * error-code protocol between the server and this interface.
 */
const translate = (s: string): string => {
  const hit = EN[s]
  if (hit) return hit
  const cut = s.indexOf(' : ')
  if (cut > 0) {
    const head = EN[s.slice(0, cut)]
    if (head) return head + s.slice(cut)
  }
  return s
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detect)

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  const setLang = (l: Lang) => {
    remember(l)
    setLangState(l)
  }

  const t = (s: string) => (lang === 'en' ? translate(s) : s)

  return <I18nContext.Provider value={{ lang, setLang, t }}>{children}</I18nContext.Provider>
}

export const useI18n = () => useContext(I18nContext)
export const useT = () => useI18n().t
