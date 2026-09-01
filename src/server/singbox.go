/*
sing-box's configuration, handled as the document it is.

This file belongs to sing-box, not to us. It carries keys this app has never
heard of — inbounds we do not manage, rules someone wrote by hand, options a
later version added — and every one of them has to survive being edited here.
So it is navigated as a decoded document rather than decoded into types: types
would silently drop everything they do not name, which on a configuration file
is not a bug you notice until the tunnel is down.

Numbers are decoded as literals for the same reason. A port read as a float and
written back as 8081 is luck, not correctness, and the first large integer that
came out in scientific notation would be refused by sing-box with no clue why.
*/
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// M is a decoded JSON object: the only shape this file trusts.
type M = map[string]any

func asM(v any) M {
	m, _ := v.(M)
	return m
}

func asA(v any) []any {
	a, _ := v.([]any)
	return a
}

func asS(v any) string {
	s, _ := v.(string)
	return s
}

func asI(v any) (int, bool) {
	switch n := v.(type) {
	case json.Number:
		i, err := n.Int64()
		return int(i), err == nil
	case float64:
		return int(n), true
	case int:
		return n, true
	}
	return 0, false
}

func strList(v any) []string {
	out := []string{}
	for _, item := range asA(v) {
		if s := asS(item); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func anyList(items []string) []any {
	out := make([]any, 0, len(items))
	for _, s := range items {
		out = append(out, s)
	}
	return out
}

func readConfig() (M, error) {
	raw, err := os.ReadFile(configPath)
	if err != nil {
		return nil, err
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	var cfg M
	if err := dec.Decode(&cfg); err != nil {
		return nil, fmt.Errorf("configuration illisible : %w", err)
	}
	return cfg, nil
}

func marshalConfig(cfg M) ([]byte, error) {
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(cfg); err != nil {
		return nil, err
	}
	return []byte(b.String()), nil
}

/*
Suspension is a place, not a flag.

sing-box offers no field for "this device is off", and a routing rule can only
match a user by name — which would make the name the identity and turn every
rename into a delicate operation. So a suspended device is moved to a second
VLESS inbound bound to localhost: nothing proxies it, nothing outside the host
can reach it. The identifier stays the identity and the name goes back to being
nothing but a label.
*/
const parkedTag = "vless-suspended"

/*
Every address reachable from outside has the same shape: `/<identifier>`. A
device fetching its profile and a client opening the tunnel are told apart by
the WebSocket upgrade, not by the path — so from the outside there is nothing
to sort them by.

The proxy is told that rule and nothing else: a shape and a header, never a
secret. Which identifier is the tunnel stays this app's business, which is what
lets it be rewritten without anyone else hearing about it.
*/
var tokenShape = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)

func vlessInbounds(cfg M) []M {
	out := []M{}
	for _, item := range asA(cfg["inbounds"]) {
		if in := asM(item); asS(in["type"]) == "vless" {
			out = append(out, in)
		}
	}
	return out
}

/** The inbound clients actually reach. */
func liveInbound(cfg M) (M, error) {
	for _, in := range vlessInbounds(cfg) {
		if asS(in["tag"]) != parkedTag {
			if _, ok := in["users"].([]any); !ok {
				in["users"] = []any{}
			}
			return in, nil
		}
	}
	return nil, errors.New("aucun inbound VLESS dans la configuration")
}

func parkedInbound(cfg M) M {
	for _, in := range vlessInbounds(cfg) {
		if asS(in["tag"]) == parkedTag {
			return in
		}
	}
	return nil
}

/*
The shelf, created on demand. `listen` is explicit rather than relying on
sing-box defaulting to localhost — that default is what makes it safe.
*/
func shelf(cfg M) M {
	parked := parkedInbound(cfg)
	if parked == nil {
		parked = M{"type": "vless", "tag": parkedTag, "listen": "127.0.0.1", "users": []any{}}
		cfg["inbounds"] = append(asA(cfg["inbounds"]), parked)
	}
	if _, ok := parked["users"].([]any); !ok {
		parked["users"] = []any{}
	}
	return parked
}

/** An empty shelf is noise in the config, so it does not outlive its contents. */
func tidyShelf(cfg M) {
	parked := parkedInbound(cfg)
	if parked == nil || len(asA(parked["users"])) > 0 {
		return
	}
	kept := []any{}
	for _, item := range asA(cfg["inbounds"]) {
		if in := asM(item); in != nil && asS(in["tag"]) == parkedTag {
			continue
		}
		kept = append(kept, item)
	}
	cfg["inbounds"] = kept
}

func inboundUuids(in M) []string {
	out := []string{}
	for _, item := range asA(in["users"]) {
		if u := asM(item); u != nil {
			out = append(out, asS(u["uuid"]))
		}
	}
	return out
}

func allUuids(cfg M) []string {
	out := []string{}
	if live, err := liveInbound(cfg); err == nil {
		out = append(out, inboundUuids(live)...)
	}
	if parked := parkedInbound(cfg); parked != nil {
		out = append(out, inboundUuids(parked)...)
	}
	return out
}

func contains(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

/*
Which inbound holds a device — the shelf if it is suspended, the public one
otherwise. A device's credentials always travel together: they are the same
device, and half of one on each shelf would mean half suspended.
*/
func homeOf(cfg M, uuids []string) M {
	if parked := parkedInbound(cfg); parked != nil {
		for _, u := range inboundUuids(parked) {
			if contains(uuids, u) {
				return parked
			}
		}
	}
	live, err := liveInbound(cfg)
	if err != nil {
		return nil
	}
	for _, u := range inboundUuids(live) {
		if contains(uuids, u) {
			return live
		}
	}
	return nil
}

func dropUuids(in M, uuids []string) {
	if in == nil {
		return
	}
	kept := []any{}
	for _, item := range asA(in["users"]) {
		if u := asM(item); u != nil && contains(uuids, asS(u["uuid"])) {
			continue
		}
		kept = append(kept, item)
	}
	in["users"] = kept
}

func addUser(in M, uuid string) {
	// Named after itself: sing-box logs the name, and with none it prints the
	// array index, which shifts as soon as the list does. That name is what
	// makes the log say which credential was used.
	in["users"] = append(asA(in["users"]), M{"uuid": uuid, "name": uuid})
}

func run(name string, args ...string) (bool, string) {
	cmd := exec.Command(name, args...)
	done := make(chan struct{})
	var out []byte
	var err error
	go func() {
		out, err = cmd.CombinedOutput()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		_ = cmd.Process.Kill()
		<-done
		return false, "delai depasse"
	}
	return err == nil, strings.TrimSpace(string(out))
}

/*
One writer at a time.

Every mutation reads the configuration, changes it, and writes it back with a
call out to sing-box in between — so two of them overlapping would have the
second write erase the first's change. That is not hypothetical here: several
devices can fetch their profile at once, each replacing its own credential, and
the sweep runs on a timer regardless of what else is happening.
*/
var writeMu sync.Mutex

func serialise(work func() error) error {
	writeMu.Lock()
	defer writeMu.Unlock()
	return work()
}

/*
Write the config, verify it with `sing-box check`, reload the service. On any
failure the previous file is restored, so a bad edit can never leave the tunnel
down.
*/
func commit(cfg M) error {
	// Whatever the caller was changing, the file comes out tidy.
	tidyShelf(cfg)

	backup, err := os.ReadFile(configPath)
	if err != nil {
		return err
	}
	next, err := marshalConfig(cfg)
	if err != nil {
		return err
	}
	if err := os.WriteFile(configPath, next, 0o600); err != nil {
		return err
	}

	if ok, out := run("sing-box", "check", "-c", configPath); !ok {
		_ = os.WriteFile(configPath, backup, 0o600)
		return fmt.Errorf("configuration refusee par sing-box : %s", out)
	}

	// Reload, not restart. sing-box rebuilds its instance in place on SIGHUP:
	// the process survives, established transfers keep running, and a change to
	// the user list takes effect at once — measured, and the reason a credential
	// can be replaced often enough to be worth replacing at all. Restarting is
	// kept as the fallback for a service manager that cannot reload.
	if ok, _ := run("rc-service", service, "reload"); ok {
		return nil
	}
	if ok, _ := run("systemctl", "reload", service); ok {
		return nil
	}
	ok, out := run("rc-service", service, "restart")
	if ok {
		return nil
	}
	okSd, outSd := run("systemctl", "restart", service)
	if okSd {
		return nil
	}
	return fmt.Errorf("redemarrage impossible : %s %s", out, outSd)
}

// ── Tunnels ─────────────────────────────────────────────────────────────────

/*
A tunnel tag is `wg-<id>` when enabled and `wgx-<id>` when not. The id is
random and permanent: it is what the display name is filed under, so renaming
never touches the sing-box configuration.

The prefix is the one thing that does move, when a tunnel is switched on or
off. Nothing stores the old tag: anything referencing a tunnel is re-pointed
from the id it already names.
*/
const (
	wgOn  = "wg"
	wgOff = "wgx"
)

func isWgTag(tag string) bool {
	return strings.HasPrefix(tag, wgOn+"-") || strings.HasPrefix(tag, wgOff+"-")
}

func isEnabled(tag string) bool { return strings.HasPrefix(tag, wgOn+"-") }

func wgID(tag string) string {
	if i := strings.Index(tag, "-"); i >= 0 {
		return tag[i+1:]
	}
	return tag
}

func withState(tag string, on bool) string {
	if on {
		return wgOn + "-" + wgID(tag)
	}
	return wgOff + "-" + wgID(tag)
}

func newWgID() string { return newToken()[:8] }

func wgEndpoints(cfg M) []M {
	out := []M{}
	for _, item := range asA(cfg["endpoints"]) {
		if e := asM(item); e != nil && isWgTag(asS(e["tag"])) {
			out = append(out, e)
		}
	}
	return out
}

func firstPeer(ep M) M {
	peers := asA(ep["peers"])
	if len(peers) == 0 {
		return nil
	}
	return asM(peers[0])
}

/*
DNS follows the tunnel.

A WireGuard configuration names the resolver to use — that DNS line is what
makes internal names resolve at all — so each tunnel carries its own server
entry, reached through that tunnel. Whichever tunnel is serving lends its
resolver to `default_domain_resolver`, and with the outbound off we fall back to
the public one rather than pointing at something unreachable.

That last knob is the one that matters: sing-box resolves a domain arriving
through the tunnel with it and does NOT consult `dns.rules` on the way — a rule
there looks right and decides nothing.
*/
const dnsPrefix = "dns-wg-"

func dnsTag(id string) string    { return dnsPrefix + id }
func isOurDns(tag string) bool   { return strings.HasPrefix(tag, dnsPrefix) }
func dnsIDOf(tag string) string  { return strings.TrimPrefix(tag, dnsPrefix) }

func dnsServers(cfg M) []any {
	dns := asM(cfg["dns"])
	if dns == nil {
		return nil
	}
	return asA(dns["servers"])
}

func dnsFor(cfg M, ep M) M {
	want := dnsTag(wgID(asS(ep["tag"])))
	for _, item := range dnsServers(cfg) {
		if d := asM(item); d != nil && asS(d["tag"]) == want {
			return d
		}
	}
	return nil
}

func ensureM(cfg M, key string) M {
	m := asM(cfg[key])
	if m == nil {
		m = M{}
		cfg[key] = m
	}
	return m
}

/** Point a tunnel at a resolver, or drop the entry when the address is cleared. */
func setTunnelDns(cfg M, ep M, server string) {
	dns := ensureM(cfg, "dns")
	want := dnsTag(wgID(asS(ep["tag"])))
	kept := []any{}
	for _, item := range asA(dns["servers"]) {
		if d := asM(item); d != nil && asS(d["tag"]) == want {
			continue
		}
		kept = append(kept, item)
	}
	if server != "" {
		kept = append(kept, M{"type": "udp", "tag": want, "server": server, "detour": asS(ep["tag"])})
	}
	dns["servers"] = kept
}

/*
The tunnel currently carrying traffic, if any — counting only a rule that points
at a tunnel still present.

A rule naming a tag nobody defines is stale, from a hand-edited config, and
taking it at face value would report the outbound as on while sing-box refuses
to start on exactly that dangling reference.
*/
func activeTarget(cfg M) string {
	tags := map[string]bool{}
	for _, e := range wgEndpoints(cfg) {
		tags[asS(e["tag"])] = true
	}
	route := asM(cfg["route"])
	if route == nil {
		return ""
	}
	for _, item := range asA(route["rules"]) {
		r := asM(item)
		if r == nil {
			continue
		}
		if out := asS(r["outbound"]); out != "" && tags[out] {
			return out
		}
	}
	return ""
}

/*
Everything derived from the tunnel list, rebuilt in one pass.

Routing and DNS are one decision, not two: the rule that sends traffic into a
tunnel and the resolver that tells it where to go have to name the same tunnel,
or names resolve one way and connect another.

`on` is the outbound switch. It has to come from the caller: it is encoded in
the very rules this rebuilds, so it must be read before anything changes —
which is what withTunnels below is for.
*/
func applyTunnelState(cfg M, on bool) {
	dns := ensureM(cfg, "dns")
	route := ensureM(cfg, "route")
	live := wgEndpoints(cfg)
	byID := map[string]M{}
	for _, e := range live {
		byID[wgID(asS(e["tag"]))] = e
	}

	// Our DNS entries live as long as their tunnel does. Any detour naming a
	// tunnel — ours or hand-written — is re-pointed at that tunnel's current
	// tag, which is how switching one on or off carries its references along.
	kept := []any{}
	for _, item := range asA(dns["servers"]) {
		d := asM(item)
		if d == nil {
			continue
		}
		tag := asS(d["tag"])
		if isOurDns(tag) && byID[dnsIDOf(tag)] == nil {
			continue
		}
		if detour := asS(d["detour"]); isWgTag(detour) {
			if ep := byID[wgID(detour)]; ep != nil {
				d["detour"] = asS(ep["tag"])
			}
		}
		kept = append(kept, d)
	}
	dns["servers"] = kept

	rules := []any{}
	for _, item := range asA(route["rules"]) {
		r := asM(item)
		if r == nil {
			continue
		}
		if out := asS(r["outbound"]); out != "" && isWgTag(out) {
			continue
		}
		if asS(r["action"]) == "resolve" {
			continue
		}
		rules = append(rules, r)
	}

	var serving M
	if on {
		for _, e := range live {
			if isEnabled(asS(e["tag"])) {
				serving = e
				break
			}
		}
	}
	var resolver M
	if serving != nil {
		resolver = dnsFor(cfg, serving)
	}

	if serving != nil {
		// Routing matches on the destination address, and a client sends a name.
		// Without resolving first, an ip_cidr rule cannot match and the connection
		// leaves by `direct`. The resolver has to be named here too: left
		// implicit, this action does not use default_domain_resolver.
		if resolver != nil && asS(resolver["tag"]) != "" {
			rules = append(rules, M{"action": "resolve", "server": asS(resolver["tag"])})
		}
		// Route exactly what the peer accepts, so a split tunnel stays split.
		allowed := []any{}
		if peer := firstPeer(serving); peer != nil {
			allowed = asA(peer["allowed_ips"])
		}
		rules = append(rules, M{"ip_cidr": allowed, "outbound": asS(serving["tag"])})
	}
	route["rules"] = rules

	// With no tunnel serving, fall back to a resolver that answers rather than
	// pointing at one only reachable through a tunnel that is off.
	chosen := ""
	if resolver != nil {
		chosen = asS(resolver["tag"])
	}
	if chosen == "" {
		for _, item := range asA(dns["servers"]) {
			if d := asM(item); d != nil && !isOurDns(asS(d["tag"])) {
				chosen = asS(d["tag"])
				break
			}
		}
	}
	if chosen != "" {
		route["default_domain_resolver"] = M{"server": chosen}
	}
}

/*
The only way tunnels are ever written: read the outbound state, apply the
change, rebuild what follows from it. The order is the whole point — the state
is encoded in the rules being rebuilt, so reading it afterwards reads the
rebuild, not the intent.
*/
func withTunnels(cfg M, change func(), force *bool) error {
	return serialise(func() error {
		on := activeTarget(cfg) != ""
		if force != nil {
			on = *force
		}
		change()
		applyTunnelState(cfg, on)
		return commit(cfg)
	})
}

type tunnelView struct {
	Tag          string   `json:"tag"`
	Name         string   `json:"name"`
	Enabled      bool     `json:"enabled"`
	Address      []string `json:"address"`
	Peer         *string  `json:"peer"`
	PublicKey    *string  `json:"publicKey"`
	AllowedIps   []string `json:"allowedIps"`
	Keepalive    *int     `json:"keepalive"`
	Dns          *string  `json:"dns"`
	PresharedKey bool     `json:"presharedKey"`
}

func wireguardSummary(cfg M, names map[string]string) M {
	profiles := []tunnelView{}
	for _, e := range wgEndpoints(cfg) {
		tag := asS(e["tag"])
		name := names[wgID(tag)]
		if name == "" {
			name = wgID(tag)
		}
		v := tunnelView{
			Tag:        tag,
			Name:       name,
			Enabled:    isEnabled(tag),
			Address:    strList(e["address"]),
			AllowedIps: []string{},
		}
		// The private key is never returned.
		if peer := firstPeer(e); peer != nil {
			port, _ := asI(peer["port"])
			addr := fmt.Sprintf("%s:%d", asS(peer["address"]), port)
			v.Peer = &addr
			pk := asS(peer["public_key"])
			v.PublicKey = &pk
			v.AllowedIps = strList(peer["allowed_ips"])
			if k, ok := asI(peer["persistent_keepalive_interval"]); ok {
				v.Keepalive = &k
			}
			v.PresharedKey = asS(peer["pre_shared_key"]) != ""
		}
		if d := dnsFor(cfg, e); d != nil {
			s := asS(d["server"])
			v.Dns = &s
		}
		profiles = append(profiles, v)
	}
	active := activeTarget(cfg)
	var activeOut any
	if active != "" {
		activeOut = active
	}
	return M{"profiles": profiles, "active": activeOut, "enabled": active != ""}
}

/*
Parse a standard WireGuard client configuration — the .conf a router or provider
hands you — into a sing-box endpoint. Accepting that format directly avoids
retyping five fields and getting one wrong.
*/
func parseWireguard(text string) (endpoint M, allowedIps []string, dns string, err error) {
	get := func(section, key string) string {
		secRe := regexp.MustCompile(`(?is)\[` + section + `\](.*?)(?:\n\s*\[|$)`)
		body := ""
		if m := secRe.FindStringSubmatch(text); m != nil {
			body = m[1]
		}
		lineRe := regexp.MustCompile(`(?im)^\s*` + key + `\s*=\s*(.+?)\s*$`)
		if m := lineRe.FindStringSubmatch(body); m != nil {
			return strings.TrimSpace(m[1])
		}
		return ""
	}

	privateKey := get("Interface", "PrivateKey")
	address := get("Interface", "Address")
	publicKey := get("Peer", "PublicKey")
	endpointLine := get("Peer", "Endpoint")
	allowed := get("Peer", "AllowedIPs")
	if allowed == "" {
		allowed = "0.0.0.0/0"
	}
	psk := get("Peer", "PresharedKey")
	// The router names its own resolver; that is what makes internal names work.
	dnsLine := get("Interface", "DNS")
	keepalive := get("Peer", "PersistentKeepalive")

	switch {
	case privateKey == "":
		return nil, nil, "", errors.New("PrivateKey manquant dans [Interface]")
	case address == "":
		return nil, nil, "", errors.New("Address manquant dans [Interface]")
	case publicKey == "":
		return nil, nil, "", errors.New("PublicKey manquant dans [Peer]")
	case endpointLine == "":
		return nil, nil, "", errors.New("Endpoint manquant dans [Peer]")
	}

	// Endpoint is host:port; the host may be an IPv6 literal in brackets.
	m := regexp.MustCompile(`^\s*(\[[^\]]+\]|[^:]+):(\d+)\s*$`).FindStringSubmatch(endpointLine)
	if m == nil {
		return nil, nil, "", fmt.Errorf("Endpoint illisible : %s", endpointLine)
	}
	host := strings.Trim(m[1], "[]")
	port, _ := strconv.Atoi(m[2])

	allowedIps = splitList(allowed)
	keep := 25
	if k, err := strconv.Atoi(keepalive); err == nil && k > 0 {
		keep = k
	}
	peer := M{
		"address":     host,
		"port":        port,
		"public_key":  publicKey,
		"allowed_ips": anyList(allowedIps),
		// Without a keepalive the UDP session behind NAT dies after a few idle
		// minutes, which is exactly when a fallback tunnel is needed.
		"persistent_keepalive_interval": keep,
	}
	if psk != "" {
		peer["pre_shared_key"] = psk
	}

	if dnsLine != "" {
		dns = strings.TrimSpace(strings.Split(dnsLine, ",")[0])
	}
	return M{
		"type":        "wireguard",
		"tag":         "",
		"address":     anyList(splitList(address)),
		"private_key": privateKey,
		"peers":       []any{peer},
	}, allowedIps, dns, nil
}

/** Accepts either a list or the comma-separated string a form field yields. */
func splitList(s string) []string {
	out := []string{}
	for _, part := range regexp.MustCompile(`[,\s]+`).Split(s, -1) {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}
