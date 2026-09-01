package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	qrcode "github.com/skip2/go-qrcode"
)

type publicBaseAddr struct {
	Origin string
	Host   string
	Port   int
}

/*
The one public address, and everything derived from it.

A device needs to know two things: where the tunnel answers, and where to fetch
its profile. Both are the same host in every sane deployment, so they are one
setting rather than two — an origin like `https://tunnel.example.com`.

Unset, it falls back to however the interface was reached. That is right on a
first visit and wrong as soon as the interface lives on an internal name the
phone cannot resolve, which is why it is worth setting.
*/
func publicBase(r *http.Request) publicBaseAddr {
	raw := readAdminConfig(adminConfigPath).PublicURL
	if raw == "" {
		raw = requestScheme(r) + "://" + hostOf(r)
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" {
		return publicBaseAddr{Origin: "https://example.com", Host: "example.com", Port: 443}
	}
	port := 443
	if u.Scheme == "http" {
		port = 80
	}
	if p, err := strconv.Atoi(u.Port()); err == nil && p > 0 {
		port = p
	}
	return publicBaseAddr{Origin: u.Scheme + "://" + u.Host, Host: u.Hostname(), Port: port}
}

func requestScheme(r *http.Request) string {
	if f := r.Header.Get("X-Forwarded-Proto"); f != "" {
		return strings.TrimSpace(strings.Split(f, ",")[0])
	}
	if r.TLS != nil {
		return "https"
	}
	return "http"
}

func hostOf(r *http.Request) string {
	if r.Host != "" {
		return r.Host
	}
	return "example.com"
}

func linkFor(uuid, name, wsPath string, base publicBaseAddr) string {
	label := name
	if label == "" {
		label = uuid[:min(8, len(uuid))]
	}
	q := url.Values{}
	q.Set("encryption", "none")
	q.Set("security", "tls")
	q.Set("sni", base.Host)
	q.Set("type", "ws")
	q.Set("path", wsPath)
	return fmt.Sprintf("vless://%s@%s:%d?%s#%s", uuid, base.Host, base.Port, q.Encode(), url.PathEscape(label))
}

/*
The tunnel's address as a number, resolved here rather than on the device.

A device on a captive network can usually reach anything but is often unable to
ask a resolver of its own choosing: the network hands you one and drops UDP/53
to everywhere else. A client that insists on its own resolver simply times out —
which is exactly the difference between this tunnel and plain WireGuard, which
dials a number and never asks anyone anything.

The hostname stays as the TLS name, so the certificate still matches.
*/
var (
	addrMu    sync.Mutex
	addrCache struct {
		host string
		ip   string
		at   time.Time
	}
)

func publicAddress(host string) string {
	addrMu.Lock()
	if addrCache.host == host && time.Since(addrCache.at) < time.Minute {
		ip := addrCache.ip
		addrMu.Unlock()
		return ip
	}
	addrMu.Unlock()

	ips, err := net.LookupIP(host)
	if err == nil {
		for _, ip := range ips {
			if v4 := ip.To4(); v4 != nil {
				addrMu.Lock()
				addrCache.host, addrCache.ip, addrCache.at = host, v4.String(), time.Now()
				addrMu.Unlock()
				return v4.String()
			}
		}
	}
	// Unresolvable from here is no reason to serve nothing: the device may well
	// manage where this host could not.
	return host
}

/*
A full client profile, served at a URL the device can subscribe to.

What a vless:// link cannot say: which networks belong behind the tunnel, and
that everything should go through it. Both are here.
*/
func clientProfile(uuid string, cfg M, wsPath string, base publicBaseAddr, server string) M {
	internal := []any{}
	for _, e := range wgEndpoints(cfg) {
		if !isEnabled(asS(e["tag"])) {
			continue
		}
		if peer := firstPeer(e); peer != nil {
			internal = asA(peer["allowed_ips"])
		}
		break
	}

	rules := []any{}
	if len(internal) > 0 {
		// The tunnel's own networks, named explicitly so they hold even if the
		// profile is later edited to stop routing everything.
		rules = append(rules, M{"ip_cidr": internal, "outbound": "proxy"})
	}

	return M{
		"log": M{"level": "warn"},
		// No DNS section, deliberately.
		//
		// Clients ship their own sing-box and it is rarely the version this host
		// runs: the DNS format changed between 1.11, 1.12 and 1.13, and a profile
		// written for one is refused outright by another. Resolution is also the
		// one thing every client already has settings for, so it is left to them.
		"inbounds": []any{
			M{
				"type":         "tun",
				"tag":          "tun-in",
				"address":      []any{"172.19.0.1/30"},
				"auto_route":   true,
				"strict_route": true,
			},
		},
		"outbounds": []any{
			M{
				"type":        "vless",
				"tag":         "proxy",
				"server":      server,
				"server_port": base.Port,
				"uuid":        uuid,
				"tls":         M{"enabled": true, "server_name": base.Host},
				"transport":   M{"type": "ws", "path": wsPath},
			},
			M{"type": "direct", "tag": "direct"},
		},
		"route":        M{"rules": rules, "final": "proxy"},
		"experimental": M{"cache_file": M{"enabled": true}},
	}
}

/*
The reverse-proxy configuration for the public name.

It names no path and no shape: an upgrade is the tunnel, anything else is the
public listener. That is the whole rule, so regenerating the tunnel path — or
adding a device — never touches the proxy.
*/
func proxySnippet(cfg M, appPort int) string {
	singbox := 8081
	if live, err := liveInbound(cfg); err == nil {
		if p, ok := asI(live["listen_port"]); ok {
			singbox = p
		}
	}
	// The address the proxy has to dial. This process runs on the sing-box host,
	// so its own LAN address is the right answer whether the proxy sits here or
	// on another machine — which loopback would not be.
	host := "127.0.0.1"
	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok || ipnet.IP.IsLoopback() {
				continue
			}
			if v4 := ipnet.IP.To4(); v4 != nil {
				host = v4.String()
				break
			}
		}
	}
	return strings.Join([]string{
		"# Un upgrade WebSocket est le tunnel ; tout le reste est la vitrine",
		"# publique de l'interface, qui ne sert que les profils et une page",
		"# quelconque. Aucun chemin, aucune forme : rien a tenir a jour ici.",
		"location / {",
		fmt.Sprintf("  set $backend %s:%d;", host, appPort),
		fmt.Sprintf("  if ($http_upgrade ~* websocket) { set $backend %s:%d; }", host, singbox),
		"  proxy_pass http://$backend;",
		"  proxy_set_header Host $host;",
		"  proxy_set_header X-Real-IP $remote_addr;",
		"  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
		"  proxy_set_header X-Forwarded-Proto $scheme;",
		"  proxy_set_header Upgrade $http_upgrade;",
		"  proxy_set_header Connection $http_connection;",
		"  proxy_http_version 1.1;",
		"  proxy_read_timeout 86400s;",
		"  proxy_send_timeout 86400s;",
		"  # Un refus de sing-box ressort en 404 comme le reste : meme corps, meme",
		"  # statut, quelle que soit la raison.",
		"  proxy_intercept_errors on;",
		"  error_page 400 401 403 404 500 502 503 504 =404 @vitrine;",
		"}",
		"",
		"location @vitrine {",
		fmt.Sprintf("  proxy_pass http://%s:%d;", host, appPort),
		"  proxy_set_header Host $host;",
		"}",
	}, "\n")
}

/*
A QR code as SVG, drawn here rather than pulled in as a rendering dependency.

The interface drops it straight into the page and sizes it with CSS, so what it
needs is a viewBox and squares — nothing that carries its own dimensions.
*/
func qrSVG(text string) (string, error) {
	code, err := qrcode.New(text, qrcode.Medium)
	if err != nil {
		return "", err
	}
	code.DisableBorder = true
	grid := code.Bitmap()
	size := len(grid)
	const margin = 1
	side := size + margin*2

	var b bytes.Buffer
	fmt.Fprintf(&b, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" shape-rendering="crispEdges">`, side, side)
	fmt.Fprintf(&b, `<rect width="%d" height="%d" fill="#fff"/><path fill="#000" d="`, side, side)
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			if grid[y][x] {
				fmt.Fprintf(&b, "M%d %dh1v1h-1z", x+margin, y+margin)
			}
		}
	}
	b.WriteString(`"/></svg>`)
	return b.String(), nil
}

func base64UTF8(s string) string {
	return base64.StdEncoding.EncodeToString([]byte(s))
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
