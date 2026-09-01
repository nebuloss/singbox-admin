/*
Production server — serves the built SPA and exposes a small API to manage the
sing-box client list.

The source of truth is sing-box's own configuration file: this reads it, edits
what it owns, validates the result with `sing-box check` and only then reloads
the service. Nothing is duplicated in a database.

One binary, three jobs: the server, and two things you run on the host when you
cannot get in — `reset-password` and `sign-in-link`. They share this process's
knowledge of where the files are, which is the only reason they were ever
separate programs.
*/
package main

import (
	"embed"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

//go:embed all:dist
var assets embed.FS

var (
	port       = envInt("PORT", 3000)
	publicPort = envInt("PUBLIC_LISTEN", 3001)
	configPath = env("SINGBOX_CONFIG", "/etc/sing-box/config.json")
	service    = env("SINGBOX_SERVICE", "sing-box")

	adminConfigPath = defaultAdminConfigPath()

	// How often a device is asked to come back for its profile, and therefore
	// how often its credential is replaced. The sweep retires a predecessor
	// once it has gone quiet, so these bound a credential's life without
	// needing to guess how long a device might be asleep.
	refreshHours = envInt("REFRESH_HOURS", 1)
	rotateEvery  = time.Duration(envInt("ROTATE_MINUTES", 10)) * time.Minute
	idleRetire   = time.Duration(envInt("RETIRE_IDLE_MINUTES", 15)) * time.Minute
	sweepEvery   = time.Duration(envInt("SWEEP_SECONDS", 60)) * time.Second
	logEvery     = time.Duration(envInt("LOG_SECONDS", 3)) * time.Second
	linkTTL      = time.Duration(envInt("LINK_MINUTES", 10)) * time.Minute
)

const (
	/** Where a link with no section named lands, which the interface decides. */
	landingTab = "activite"
	/** How many live connections are described one by one before the list is cut. */
	liveMax = 300
)

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func envInt(name string, fallback int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil {
		return v
	}
	return fallback
}

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "reset-password":
			resetPassword(os.Args[2:])
			return
		case "sign-in-link":
			signInLink(os.Args[2:])
			return
		case "version":
			fmt.Println("singbox-admin")
			return
		}
	}
	serve()
}

func serve() {
	bootstrap()

	go func() {
		if err := ensureClashApi(); err != nil {
			logf("clash_api: %v", err)
		}
	}()
	// Take in credentials this app did not create, before anything reads the
	// device list.
	adopt()

	go public()

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/setup", handleSetup)
	mux.HandleFunc("POST /api/login", handleLogin)
	mux.HandleFunc("POST /api/logout", handleLogout)
	mux.HandleFunc("POST /api/session/claim", handleSessionClaim)
	mux.HandleFunc("GET /api/state", handleState)

	mux.HandleFunc("POST /api/password", requireAuth(handlePassword))
	mux.HandleFunc("POST /api/settings", requireAuth(handleSettings))
	mux.HandleFunc("POST /api/session/link", requireAuth(handleSessionLink))
	mux.HandleFunc("GET /api/activity", requireAuth(handleActivity))

	mux.HandleFunc("POST /api/users", requireAuth(handleAddUser))
	mux.HandleFunc("DELETE /api/users/{token}", requireAuth(handleDeleteUser))
	mux.HandleFunc("PATCH /api/users/{token}", requireAuth(handleRenameUser))
	mux.HandleFunc("POST /api/users/{token}/enabled", requireAuth(handleUserEnabled))

	mux.HandleFunc("POST /api/tunnel/path", requireAuth(handleTunnelPath))
	mux.HandleFunc("POST /api/wireguard", requireAuth(handleAddTunnel))
	mux.HandleFunc("POST /api/wireguard/order", requireAuth(handleTunnelOrder))
	mux.HandleFunc("POST /api/wireguard/enabled", requireAuth(handleEgressEnabled))
	mux.HandleFunc("PATCH /api/wireguard/{tag}", requireAuth(handleEditTunnel))
	mux.HandleFunc("POST /api/wireguard/{tag}/enabled", requireAuth(handleTunnelEnabled))
	mux.HandleFunc("DELETE /api/wireguard/{tag}", requireAuth(handleDeleteTunnel))

	mux.HandleFunc("/", spa)

	// Read often, write rarely: the log is followed every few seconds so the
	// activity view is current, while the file on disk is only touched by the
	// sweep.
	go every(logEvery, readLog)
	go every(sweepEvery, sweep)

	note := ""
	if credential() == nil {
		note = " (aucun mot de passe : lecture seule)"
	}
	logf("singbox-admin on :%d — config %s%s", port, configPath, note)
	if err := http.ListenAndServe(fmt.Sprintf(":%d", port), mux); err != nil {
		logf("interface: %v", err)
		os.Exit(1)
	}
}

func every(d time.Duration, work func()) {
	for range time.Tick(d) {
		work()
	}
}

/*
ADMIN_PASSWORD and PUBLIC_HOST are bootstrap values only: on first start they
are written into the app's own file and never read again. From then on both are
settings, editable in the interface.
*/
func bootstrap() {
	admin := readAdminConfig(adminConfigPath)
	if admin.Password == nil {
		if given := os.Getenv("ADMIN_PASSWORD"); given != "" {
			hashed, err := hashPassword(given)
			if err == nil {
				_, err = updateAdminConfig(adminConfigPath, func(c *AdminConfig) { c.Password = hashed })
			}
			if err != nil {
				logf("mot de passe initial: %v", err)
			} else {
				logf("mot de passe initial hache dans %s", adminConfigPath)
			}
		}
	}
	if admin.PublicURL == "" {
		host := os.Getenv("PUBLIC_HOST")
		if host != "" && host != "example.com" {
			suffix := ""
			if p := envInt("PUBLIC_PORT", 443); p != 443 {
				suffix = fmt.Sprintf(":%d", p)
			}
			seeded := "https://" + host + suffix
			if _, err := updateAdminConfig(adminConfigPath, func(c *AdminConfig) { c.PublicURL = seeded }); err == nil {
				logf("adresse publique initialisee a %s", seeded)
			}
		}
	}
}

/*
Take in credentials this app did not create.

The install script writes the first one, and a configuration may be edited by
hand. Without this they would exist for sing-box and be invisible here — no
name, no link, no way to revoke them from the interface, which is the worst of
both worlds.
*/
func adopt() {
	cfg, err := readConfig()
	if err != nil {
		logf("adoption: %v", err)
		return
	}
	known := map[string]bool{}
	for _, d := range readAdminConfig(adminConfigPath).Devices {
		for _, u := range d.Uuids {
			known[u] = true
		}
	}
	orphans := []string{}
	for _, uuid := range allUuids(cfg) {
		if !known[uuid] {
			orphans = append(orphans, uuid)
		}
	}
	if len(orphans) == 0 {
		return
	}
	if _, err := updateAdminConfig(adminConfigPath, func(c *AdminConfig) {
		for _, uuid := range orphans {
			c.Devices[newToken()] = Device{
				Name:  "appareil " + uuid[:min(8, len(uuid))],
				Uuids: []string{uuid},
			}
		}
	}); err != nil {
		logf("adoption: %v", err)
		return
	}
	logf("identifiants adoptes : %d", len(orphans))
}

/*
The interface itself: the built SPA, with every unknown path answered by its
index so the tab in the address bar survives a reload.
*/
func spa(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		fail(w, http.StatusNotFound, "inconnu")
		return
	}
	built, err := fs.Sub(assets, "dist")
	if err != nil {
		http.Error(w, "interface absente", http.StatusInternalServerError)
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/")
	if name != "" {
		if f, err := built.Open(name); err == nil {
			f.Close()
			http.FileServer(http.FS(built)).ServeHTTP(w, r)
			return
		}
	}
	index, err := fs.ReadFile(built, "index.html")
	if err != nil {
		http.Error(w, "interface absente", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(index)
}

func resetPassword(args []string) {
	given := ""
	set := false
	if len(args) > 0 {
		given, set = args[0], true
		if len([]rune(given)) < 10 {
			fmt.Fprintln(os.Stderr, "Le mot de passe doit faire au moins 10 caracteres.")
			os.Exit(1)
		}
	}
	// Only the password is touched — device and tunnel names share this file and
	// have nothing to do with losing a password.
	_, err := updateAdminConfig(adminConfigPath, func(c *AdminConfig) {
		if !set {
			c.Password = nil
			return
		}
		if hashed, err := hashPassword(given); err == nil {
			c.Password = hashed
		}
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Operation impossible sur %s : %v\n", adminConfigPath, err)
		os.Exit(1)
	}
	if set {
		fmt.Printf("Mot de passe redefini dans %s\n", adminConfigPath)
	} else {
		fmt.Printf("Mot de passe efface (%s).\n", adminConfigPath)
		// Printing a generated password to a terminal only invites copy-paste
		// through chat logs; let the operator choose one in the interface.
		fmt.Println("Ouvrez l'interface : elle demandera de definir un nouveau mot de passe.")
	}
	fmt.Println("Les noms des appareils et des tunnels sont conserves.")
	fmt.Println("Les sessions ouvertes seront fermees au prochain redemarrage du service.")
}

/*
A sign-in link, made on the host.

The one made from the interface needs a session, which is exactly what someone
locked out does not have. This one needs root on this machine instead, which is
the same thing the password is worth.
*/
func signInLink(args []string) {
	token, err := mintLink(adminConfigPath, linkTTL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Operation impossible sur %s : %v\n", adminConfigPath, err)
		os.Exit(1)
	}
	base := ""
	if len(args) > 0 {
		base = strings.TrimRight(args[0], "/")
	}
	// An absent section already lands on the first page, so naming it would only
	// lengthen a link meant to be read off a screen.
	section := ""
	if len(args) > 1 {
		section = strings.Map(func(r rune) rune {
			if r >= 'a' && r <= 'z' {
				return r
			}
			return -1
		}, args[1])
	}
	prefix := ""
	if section != "" && section != landingTab {
		prefix = section + "&"
	}
	fragment := "#" + prefix + "login=" + token
	if base != "" {
		fmt.Println(base + "/" + fragment)
	} else {
		fmt.Println(fragment)
	}
	fmt.Printf("Valable %d minutes, une seule fois.\n", int(linkTTL/time.Minute))
}
