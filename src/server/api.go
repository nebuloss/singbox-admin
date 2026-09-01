package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// ── Auth: one shared password, sessions held in memory. Restarting the service
//    logs everyone out, which is the desired behaviour for an admin tool.
var (
	sessionMu sync.Mutex
	sessions  = map[string]bool{}
)

func newSession() string {
	token := newToken() + newToken()
	sessionMu.Lock()
	sessions[token] = true
	sessionMu.Unlock()
	return token
}

func grant(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name: "sbsession", Value: token, Path: "/",
		HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode,
		MaxAge: 12 * 3600,
	})
}

func credential() *Password { return readAdminConfig(adminConfigPath).Password }

func authed(r *http.Request) bool {
	if credential() == nil {
		return false
	}
	c, err := r.Cookie("sbsession")
	if err != nil {
		return false
	}
	sessionMu.Lock()
	defer sessionMu.Unlock()
	return sessions[c.Value]
}

func requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !authed(r) {
			fail(w, http.StatusUnauthorized, "authentification requise")
			return
		}
		next(w, r)
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(body)
}

func fail(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, M{"error": message})
}

func ok(w http.ResponseWriter, extra M) {
	body := M{"ok": true}
	for k, v := range extra {
		body[k] = v
	}
	writeJSON(w, http.StatusOK, body)
}

func body(r *http.Request) M {
	var m M
	dec := json.NewDecoder(r.Body)
	dec.UseNumber()
	_ = dec.Decode(&m)
	if m == nil {
		m = M{}
	}
	return m
}

func field(b M, key string) string { return strings.TrimSpace(asS(b[key])) }

// Letters of any script, so an accented or non-Latin name is not "invalid".
var nameRe = regexp.MustCompile(`^[\p{L}\p{N} ._@()'’-]{1,40}$`)

func validName(s string) bool {
	return len([]rune(s)) >= 1 && len([]rune(s)) <= 40 && nameRe.MatchString(s)
}

func taken(names map[string]string, name, except string) bool {
	for k, v := range names {
		if k != except && strings.EqualFold(v, name) {
			return true
		}
	}
	return false
}

func deviceNames(admin AdminConfig) map[string]string {
	out := map[string]string{}
	for token, d := range admin.Devices {
		out[token] = d.Name
	}
	return out
}

/*
First run: with no password set the app is not locked but unclaimed, and the UI
asks for one. Anyone who can reach it can claim it, which is why it is meant to
sit on an internal network — and why resetting requires root on the host rather
than being exposed here.
*/
func handleSetup(w http.ResponseWriter, r *http.Request) {
	if credential() != nil {
		fail(w, http.StatusConflict, "un mot de passe est deja defini")
		return
	}
	chosen := asS(body(r)["password"])
	if len([]rune(chosen)) < 10 {
		fail(w, http.StatusBadRequest, "10 caracteres minimum")
		return
	}
	hashed, err := hashPassword(chosen)
	if err == nil {
		_, err = updateAdminConfig(adminConfigPath, func(c *AdminConfig) { c.Password = hashed })
	}
	if err != nil {
		fail(w, http.StatusInternalServerError, "ecriture impossible : "+err.Error())
		return
	}
	grant(w, newSession())
	ok(w, nil)
}

func handleLogin(w http.ResponseWriter, r *http.Request) {
	current := credential()
	if current == nil {
		fail(w, http.StatusConflict, "aucun mot de passe defini")
		return
	}
	if !verifyPassword(asS(body(r)["password"]), current.Hash) {
		fail(w, http.StatusUnauthorized, "mot de passe incorrect")
		return
	}
	grant(w, newSession())
	ok(w, nil)
}

func handlePassword(w http.ResponseWriter, r *http.Request) {
	b := body(r)
	current, next := asS(b["current"]), asS(b["next"])
	stored := credential()
	if stored == nil || !verifyPassword(current, stored.Hash) {
		fail(w, http.StatusUnauthorized, "mot de passe actuel incorrect")
		return
	}
	if len([]rune(next)) < 10 {
		fail(w, http.StatusBadRequest, "10 caracteres minimum")
		return
	}
	if next == current {
		fail(w, http.StatusBadRequest, "identique a l actuel")
		return
	}
	hashed, err := hashPassword(next)
	if err == nil {
		_, err = updateAdminConfig(adminConfigPath, func(c *AdminConfig) { c.Password = hashed })
	}
	if err != nil {
		fail(w, http.StatusInternalServerError, "ecriture impossible : "+err.Error())
		return
	}
	// Every other session is dropped: a password change should evict anyone who
	// authenticated with the old one. The caller keeps its own cookie.
	keep := ""
	if c, err := r.Cookie("sbsession"); err == nil {
		keep = c.Value
	}
	sessionMu.Lock()
	for t := range sessions {
		if t != keep {
			delete(sessions, t)
		}
	}
	sessionMu.Unlock()
	ok(w, nil)
}

/*
The one setting: where this tunnel answers from outside.

Empty clears it, and the interface falls back to however it was reached. A
value that is not an address is refused here rather than written and discovered
later in a profile that will not import.
*/
func handleSettings(w http.ResponseWriter, r *http.Request) {
	raw := field(body(r), "publicUrl")
	if raw != "" {
		u, err := url.Parse(raw)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
			fail(w, http.StatusBadRequest, "adresse invalide : attendu https://nom-de-domaine")
			return
		}
		raw = strings.TrimSuffix(u.Scheme+"://"+u.Host, "/")
	}
	if _, err := updateAdminConfig(adminConfigPath, func(c *AdminConfig) { c.PublicURL = raw }); err != nil {
		fail(w, http.StatusInternalServerError, "ecriture impossible : "+err.Error())
		return
	}
	ok(w, M{"publicUrl": raw})
}

/*
A sign-in link, made from a session and spent once.

Meant to be created where you are already signed in and scanned where you are
not — a phone, mostly, which is where typing a long password is worst.

The token rides in the URL fragment, which browsers never send to a server: it
cannot turn up in an access log, a proxy's history or a Referer header the way a
query string would. It is worth as much as the password while it lives, so it
lives briefly and dies on first use, whether that use succeeds or not.
*/
func handleSessionLink(w http.ResponseWriter, r *http.Request) {
	token, err := mintLink(adminConfigPath, linkTTL)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Built from the address this interface was reached on, not the tunnel's:
	// the administration lives on the internal name and stays there.
	//
	// Section and token share the fragment, which a browser never sends to a
	// server: the link can point at a page without the token ever reaching an
	// access log, which a query string could not promise. The default page is
	// the one an absent section already lands on, so naming it would only make
	// the link longer to read off a screen.
	section := regexp.MustCompile(`[^a-z]`).ReplaceAllString(asS(body(r)["section"]), "")
	prefix := ""
	if section != "" && section != landingTab {
		prefix = section + "&"
	}
	link := fmt.Sprintf("%s://%s/#%slogin=%s", requestScheme(r), hostOf(r), prefix, token)
	svg, err := qrSVG(link)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, M{"url": link, "minutes": int(linkTTL / time.Minute), "qr": svg})
}

func handleSessionClaim(w http.ResponseWriter, r *http.Request) {
	// Spent on sight: a link that failed is a link that is gone.
	if !spendLink(adminConfigPath, asS(body(r)["token"])) {
		fail(w, http.StatusUnauthorized, "lien expire ou deja utilise")
		return
	}
	grant(w, newSession())
	ok(w, nil)
}

func handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie("sbsession"); err == nil {
		sessionMu.Lock()
		delete(sessions, c.Value)
		sessionMu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{Name: "sbsession", Value: "", Path: "/", MaxAge: -1})
	ok(w, nil)
}

func handleState(w http.ResponseWriter, r *http.Request) {
	if !authed(r) {
		writeJSON(w, http.StatusOK, M{"authed": false, "setup": credential() == nil})
		return
	}
	cfg, err := readConfig()
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	inbound, err := liveInbound(cfg)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	wsPath := "/"
	if p := asS(asM(inbound["transport"])["path"]); p != "" {
		wsPath = p
	}
	_, versionOut := run("sing-box", "version")
	version := strings.SplitN(versionOut, "\n", 2)[0]
	_, status := run("rc-service", service, "status")

	admin := readAdminConfig(adminConfigPath)
	base := publicBase(r)
	current := map[string]bool{}
	for _, u := range inboundUuids(inbound) {
		current[u] = true
	}

	users := []M{}
	for token, d := range admin.Devices {
		if len(d.Uuids) == 0 {
			continue
		}
		sub := base.Origin + "/" + token
		label := d.Name
		if label == "" {
			label = token[:min(8, len(token))]
		}
		// What the QR carries. Both Hiddify and the official sing-box client
		// register this scheme and read url and name out of it, so a scan
		// installs the profile instead of dropping the operator into a form.
		imp := "sing-box://import-remote-profile?url=" + url.QueryEscape(sub) + "#" + url.QueryEscape(label)
		svg, err := qrSVG(imp)
		if err != nil {
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
		users = append(users, M{
			"token": token,
			"name":  d.Name,
			// Suspended devices keep their address and their link: it is what
			// makes them work again the moment they are put back.
			"enabled": current[d.Uuids[0]],
			"sub":     sub,
			"link":    linkFor(d.Uuids[0], d.Name, wsPath, base),
			"qr":      svg,
		})
	}

	running := regexp.MustCompile(`(?i)started|running|active`).MatchString(status)
	writeJSON(w, http.StatusOK, M{
		"authed":       true,
		"users":        users,
		"service":      M{"running": running, "version": version},
		"tunnel":       M{"host": base.Host, "port": base.Port, "path": wsPath},
		"publicUrl":    nilIfEmpty(admin.PublicURL),
		"proxySnippet": proxySnippet(cfg, publicPort),
		"wireguard":    wireguardSummary(cfg, admin.Tunnels),
	})
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func handleAddUser(w http.ResponseWriter, r *http.Request) {
	name := field(body(r), "name")
	if !validName(name) {
		fail(w, http.StatusBadRequest, "nom invalide")
		return
	}
	admin := readAdminConfig(adminConfigPath)
	if taken(deviceNames(admin), name, "") {
		fail(w, http.StatusConflict, "ce nom existe deja")
		return
	}
	token, uuid := newToken(), newToken()
	err := serialise(func() error {
		cfg, err := readConfig()
		if err != nil {
			return err
		}
		live, err := liveInbound(cfg)
		if err != nil {
			return err
		}
		addUser(live, uuid)
		return commit(cfg)
	})
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if _, err := updateAdminConfig(adminConfigPath, func(c *AdminConfig) {
		c.Devices[token] = Device{Name: name, Uuids: []string{uuid}}
	}); err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok(w, M{"token": token})
}

func handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	admin := readAdminConfig(adminConfigPath)
	device, exists := admin.Devices[token]
	if !exists {
		fail(w, http.StatusNotFound, "inconnu")
		return
	}
	if len(admin.Devices) == 1 {
		fail(w, http.StatusBadRequest, "refus : cela supprimerait le dernier acces")
		return
	}
	err := serialise(func() error {
		cfg, err := readConfig()
		if err != nil {
			return err
		}
		live, err := liveInbound(cfg)
		if err != nil {
			return err
		}
		dropUuids(live, device.Uuids)
		dropUuids(parkedInbound(cfg), device.Uuids)
		return commit(cfg)
	})
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if _, err := updateAdminConfig(adminConfigPath, func(c *AdminConfig) {
		delete(c.Devices, token)
		for _, uuid := range device.Uuids {
			delete(c.Seen, uuid)
		}
	}); err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok(w, nil)
}

/** Renaming writes our own file and stops there — see the note on names. */
func handleRenameUser(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	name := field(body(r), "name")
	if !validName(name) {
		fail(w, http.StatusBadRequest, "nom invalide")
		return
	}
	admin := readAdminConfig(adminConfigPath)
	if _, exists := admin.Devices[token]; !exists {
		fail(w, http.StatusNotFound, "inconnu")
		return
	}
	if taken(deviceNames(admin), name, token) {
		fail(w, http.StatusConflict, "ce nom existe deja")
		return
	}
	if _, err := updateAdminConfig(adminConfigPath, func(c *AdminConfig) {
		d := c.Devices[token]
		d.Name = name
		c.Devices[token] = d
	}); err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok(w, nil)
}

func handleUserEnabled(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	device, exists := readAdminConfig(adminConfigPath).Devices[token]
	if !exists {
		fail(w, http.StatusNotFound, "inconnu")
		return
	}
	wanted, _ := body(r)["enabled"].(bool)
	err := serialise(func() error {
		cfg, err := readConfig()
		if err != nil {
			return err
		}
		live, err := liveInbound(cfg)
		if err != nil {
			return err
		}
		from := live
		if wanted {
			from = parkedInbound(cfg)
		}
		if from == nil {
			return nil
		}
		moving := []any{}
		for _, item := range asA(from["users"]) {
			if u := asM(item); u != nil && contains(device.Uuids, asS(u["uuid"])) {
				moving = append(moving, u)
			}
		}
		if len(moving) == 0 {
			return nil
		}
		dropUuids(from, device.Uuids)
		to := live
		if !wanted {
			to = shelf(cfg)
		}
		to["users"] = append(asA(to["users"]), moving...)
		return commit(cfg)
	})
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	ok(w, nil)
}

func handleTunnelPath(w http.ResponseWriter, r *http.Request) {
	var path string
	err := serialise(func() error {
		cfg, err := readConfig()
		if err != nil {
			return err
		}
		inbound, err := liveInbound(cfg)
		if err != nil {
			return err
		}
		transport := asM(inbound["transport"])
		if transport == nil || asS(transport["type"]) != "ws" {
			return errClient("l inbound n utilise pas un transport ws")
		}
		// Shaped like every other reachable address: from outside, a profile and
		// the tunnel are both /<identifier>, and only the WebSocket upgrade tells
		// them apart.
		path = "/" + newToken()
		transport["path"] = path
		return commit(cfg)
	})
	if err != nil {
		fail(w, statusFor(err), err.Error())
		return
	}
	ok(w, M{"path": path})
}

type clientError struct{ message string }

func (e clientError) Error() string { return e.message }
func errClient(m string) error      { return clientError{m} }

func statusFor(err error) int {
	if _, isClient := err.(clientError); isClient {
		return http.StatusBadRequest
	}
	return http.StatusInternalServerError
}

func handleAddTunnel(w http.ResponseWriter, r *http.Request) {
	b := body(r)
	name := field(b, "name")
	if !regexp.MustCompile(`^[\w .@-]{1,40}$`).MatchString(name) {
		fail(w, http.StatusBadRequest, "nom invalide")
		return
	}
	endpoint, _, dns, err := parseWireguard(asS(b["config"]))
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	tag := wgOn + "-" + newWgID()
	endpoint["tag"] = tag

	admin := readAdminConfig(adminConfigPath)
	cfg, err := readConfig()
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Two ways to end up with the same tunnel twice, both worth refusing: the
	// same name, and the same peer pasted under a different name. The second is
	// the one that actually bites — a duplicate would sit in the list doing
	// nothing, since only the first enabled one ever serves.
	if taken(admin.Tunnels, name, "") {
		fail(w, http.StatusConflict, "un tunnel porte deja ce nom")
		return
	}
	peer := firstPeer(endpoint)
	peerPort, _ := asI(peer["port"])
	for _, e := range wgEndpoints(cfg) {
		p := firstPeer(e)
		if p == nil {
			continue
		}
		port, _ := asI(p["port"])
		if asS(p["public_key"]) == asS(peer["public_key"]) && asS(p["address"]) == asS(peer["address"]) && port == peerPort {
			// Shaped as "<message> : <detail>" like the other messages carrying
			// a variable part, so the interface can translate the fixed half.
			existing := admin.Tunnels[wgID(asS(e["tag"]))]
			if existing == "" {
				existing = wgID(asS(e["tag"]))
			}
			fail(w, http.StatusConflict, "ce tunnel est deja configure sous le nom : "+existing)
			return
		}
	}

	err = withTunnels(cfg, func() {
		cfg["endpoints"] = append(asA(cfg["endpoints"]), endpoint)
		// The DNS line of the pasted configuration, if it had one.
		setTunnelDns(cfg, endpoint, dns)
	}, nil)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := updateAdminConfig(adminConfigPath, func(c *AdminConfig) {
		c.Tunnels[wgID(tag)] = name
	}); err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok(w, M{"tag": tag})
}

/*
Edit a tunnel in place: its name and every peer field, but never its private
key. That key is write-once by design — it is not returned by the API, so it
cannot be shown in the form, and leaving it alone keeps that promise. A tunnel
that needs a new key is a new tunnel.
*/
func handleEditTunnel(w http.ResponseWriter, r *http.Request) {
	tag := r.PathValue("tag")
	b := body(r)
	name := field(b, "name")
	if !validName(name) {
		fail(w, http.StatusBadRequest, "nom invalide")
		return
	}
	host := field(b, "host")
	port, portOK := asI(b["port"])
	publicKey := field(b, "publicKey")
	address := splitList(joinAny(b["address"]))
	allowedIps := splitList(joinAny(b["allowedIps"]))
	switch {
	case host == "":
		fail(w, http.StatusBadRequest, "adresse du pair manquante")
		return
	case !portOK || port < 1 || port > 65535:
		fail(w, http.StatusBadRequest, "port du pair invalide")
		return
	case publicKey == "":
		fail(w, http.StatusBadRequest, "cle publique du pair manquante")
		return
	case len(address) == 0:
		fail(w, http.StatusBadRequest, "adresse dans le tunnel manquante")
		return
	case len(allowedIps) == 0:
		fail(w, http.StatusBadRequest, "reseaux routes manquants")
		return
	}

	cfg, err := readConfig()
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	var ep M
	for _, e := range wgEndpoints(cfg) {
		if asS(e["tag"]) == tag {
			ep = e
			break
		}
	}
	if ep == nil {
		fail(w, http.StatusNotFound, "tunnel introuvable")
		return
	}
	admin := readAdminConfig(adminConfigPath)
	if taken(admin.Tunnels, name, wgID(tag)) {
		fail(w, http.StatusConflict, "un tunnel porte deja ce nom")
		return
	}
	for _, e := range wgEndpoints(cfg) {
		if asS(e["tag"]) == tag {
			continue
		}
		p := firstPeer(e)
		if p == nil {
			continue
		}
		otherPort, _ := asI(p["port"])
		if asS(p["public_key"]) == publicKey && asS(p["address"]) == host && otherPort == port {
			existing := admin.Tunnels[wgID(asS(e["tag"]))]
			if existing == "" {
				existing = wgID(asS(e["tag"]))
			}
			fail(w, http.StatusConflict, "ce tunnel est deja configure sous le nom : "+existing)
			return
		}
	}

	peer := firstPeer(ep)
	if peer == nil {
		fail(w, http.StatusBadRequest, "tunnel sans pair")
		return
	}
	// Absent means "leave it alone"; empty means "clear it". Treating the two
	// alike let a request that never mentioned DNS wipe the tunnel's resolver,
	// and with it the rule that routes internal names.
	currentDns := ""
	if d := dnsFor(cfg, ep); d != nil {
		currentDns = asS(d["server"])
	}
	nextDns := currentDns
	if _, given := b["dns"]; given {
		nextDns = field(b, "dns")
	}
	keepalive := 25
	if k, okNum := asI(b["keepalive"]); okNum && k > 0 {
		keepalive = k
	}

	before := fingerprint(ep, peer, currentDns)
	ep["address"] = anyList(address)
	peer["address"] = host
	peer["port"] = port
	peer["public_key"] = publicKey
	peer["allowed_ips"] = anyList(allowedIps)
	peer["persistent_keepalive_interval"] = keepalive

	// AllowedIPs and the resolver both feed what gets rebuilt, so a change to
	// either is worth a write — and nothing else is.
	if fingerprint(ep, peer, nextDns) != before {
		if err := withTunnels(cfg, func() { setTunnelDns(cfg, ep, nextDns) }, nil); err != nil {
			fail(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	if _, err := updateAdminConfig(adminConfigPath, func(c *AdminConfig) {
		c.Tunnels[wgID(tag)] = name
	}); err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok(w, M{"tag": tag})
}

func fingerprint(ep, peer M, dns string) string {
	out, _ := json.Marshal([]any{ep["address"], peer, dns})
	return string(out)
}

/** Accepts either a list or the comma-separated string a form field yields. */
func joinAny(v any) string {
	if items, isList := v.([]any); isList {
		parts := []string{}
		for _, item := range items {
			parts = append(parts, asS(item))
		}
		return strings.Join(parts, ",")
	}
	return asS(v)
}

func handleTunnelOrder(w http.ResponseWriter, r *http.Request) {
	wanted := []string{}
	for _, item := range asA(body(r)["tags"]) {
		wanted = append(wanted, asS(item))
	}
	cfg, err := readConfig()
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	wgs := wgEndpoints(cfg)
	byTag := map[string]M{}
	for _, e := range wgs {
		byTag[asS(e["tag"])] = e
	}
	if len(wanted) != len(wgs) {
		fail(w, http.StatusBadRequest, "liste de profils incoherente")
		return
	}
	for _, t := range wanted {
		if byTag[t] == nil {
			fail(w, http.StatusBadRequest, "liste de profils incoherente")
			return
		}
	}
	err = withTunnels(cfg, func() {
		others := []any{}
		for _, item := range asA(cfg["endpoints"]) {
			if e := asM(item); e != nil && isWgTag(asS(e["tag"])) {
				continue
			}
			others = append(others, item)
		}
		for _, t := range wanted {
			others = append(others, byTag[t])
		}
		cfg["endpoints"] = others
	}, nil)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	ok(w, nil)
}

func handleEgressEnabled(w http.ResponseWriter, r *http.Request) {
	on, _ := body(r)["enabled"].(bool)
	cfg, err := readConfig()
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if on {
		any := false
		for _, e := range wgEndpoints(cfg) {
			if isEnabled(asS(e["tag"])) {
				any = true
				break
			}
		}
		if !any {
			fail(w, http.StatusBadRequest, "aucun tunnel actif a utiliser")
			return
		}
	}
	if err := withTunnels(cfg, func() {}, &on); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	ok(w, nil)
}

func handleTunnelEnabled(w http.ResponseWriter, r *http.Request) {
	tag := r.PathValue("tag")
	on, _ := body(r)["enabled"].(bool)
	cfg, err := readConfig()
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	var ep M
	for _, item := range asA(cfg["endpoints"]) {
		if e := asM(item); e != nil && asS(e["tag"]) == tag {
			ep = e
			break
		}
	}
	if ep == nil {
		fail(w, http.StatusNotFound, "tunnel introuvable")
		return
	}
	next := withState(tag, on)
	if err := withTunnels(cfg, func() { ep["tag"] = next }, nil); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	ok(w, M{"tag": next})
}

func handleDeleteTunnel(w http.ResponseWriter, r *http.Request) {
	tag := r.PathValue("tag")
	cfg, err := readConfig()
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	found := false
	for _, item := range asA(cfg["endpoints"]) {
		if e := asM(item); e != nil && asS(e["tag"]) == tag {
			found = true
			break
		}
	}
	if !found {
		fail(w, http.StatusNotFound, "profil introuvable")
		return
	}
	// Routing is rebuilt from what remains: a rule pointing at a deleted
	// endpoint is rejected by sing-box outright.
	err = withTunnels(cfg, func() {
		kept := []any{}
		for _, item := range asA(cfg["endpoints"]) {
			if e := asM(item); e != nil && asS(e["tag"]) == tag {
				continue
			}
			kept = append(kept, item)
		}
		cfg["endpoints"] = kept
	}, nil)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if _, err := updateAdminConfig(adminConfigPath, func(c *AdminConfig) {
		delete(c.Tunnels, wgID(tag))
	}); err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok(w, nil)
}
