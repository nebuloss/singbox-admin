/*
The app's own configuration file — everything it keeps for itself.

That is: the password hash, and the display names. Both are small, both are
ours, both belong next to the install — so they share one `config.json` rather
than taking a file each. One thing to back up, one thing to lose.

It is `$APP_DIR/config.json`, which sing-box's own `config.json` also is, one
directory away. Hence ADMIN_CONFIG and SINGBOX_CONFIG rather than two variables
both called config: the files are alike in name only.

What is NOT here is anything sing-box needs to run. Access and routing live in
the sing-box configuration, where they can be read and edited directly. Names
are here precisely so that renaming never touches that file: sing-box is only
ever told a device's identifier and a tunnel's tag, and neither has to be
readable. Losing this file costs the password and the labels; every device and
tunnel keeps working.

Unlike sing-box's configuration, this file is entirely ours — so it is decoded
into types rather than navigated as a document. Nothing in it belongs to
anyone else, so nothing can be dropped by not knowing about it.
*/
package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/scrypt"
)

const (
	scryptKeyLen = 64
	scryptCost   = 16384 // N; ~100ms on modest hardware
	scryptR      = 8
	scryptP      = 1
)

type Password struct {
	Hash    string `json:"hash"`
	Updated string `json:"updated"`
}

/*
A device, as this app sees it.

The key it is filed under is what the subscription URL carries and never
changes. `Uuids` are the credentials sing-box knows, newest first: the head is
what a profile is served with, the rest are predecessors kept alive only as
long as something is still using them. Splitting the two is what lets a
credential be replaced without changing the address a device fetches from.
*/
type Device struct {
	Name    string   `json:"name"`
	Uuids   []string `json:"uuids"`
	Rotated string   `json:"rotated,omitempty"`
}

type AdminConfig struct {
	Password  *Password         `json:"password"`
	PublicURL string            `json:"publicUrl"`
	Devices   map[string]Device `json:"devices"`
	// Tunnel display names, by tunnel id.
	Tunnels map[string]string `json:"tunnels"`
	// When each credential was last seen in sing-box's log, ISO 8601.
	Seen map[string]string `json:"seen"`
	// Sign-in links not yet spent, by token, with their expiry. On disk rather
	// than in memory so a link can be minted from a shell — which is the case
	// that matters, since a link made from a session is no help when you have
	// none. The file is the password's own, and no more readable for it.
	Links map[string]string `json:"links"`
}

func (c *AdminConfig) fill() {
	if c.Devices == nil {
		c.Devices = map[string]Device{}
	}
	if c.Tunnels == nil {
		c.Tunnels = map[string]string{}
	}
	if c.Seen == nil {
		c.Seen = map[string]string{}
	}
	if c.Links == nil {
		c.Links = map[string]string{}
	}
}

/*
An identifier: an address, a credential, a link that signs someone in.

Sixteen random bytes, written in the twenty-two characters a URL takes them in
rather than the thirty-six a UUID would spend on the same 128 bits.

A VLESS credential is one of these too. It does not have to be a UUID: handed a
shorter string, sing-box and Xray both hash it into a v5 over the nil namespace
— the same computation, so the two ends agree without ever discussing it. What
travels on the wire is sixteen bytes either way; the UUID was only ever how
they were written down. Xray takes at most thirty characters through that
branch, which twenty-two comfortably clears.
*/
func newToken() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err) // A machine that cannot produce randomness cannot serve.
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// Format: scrypt$<N>$<salt-hex>$<derived-hex> — the same as the Node version
// wrote, so an existing installation's password still verifies.
func hashPassword(password string) (*Password, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	derived, err := scrypt.Key([]byte(password), salt, scryptCost, scryptR, scryptP, scryptKeyLen)
	if err != nil {
		return nil, err
	}
	return &Password{
		Hash:    fmt.Sprintf("scrypt$%d$%s$%s", scryptCost, hex.EncodeToString(salt), hex.EncodeToString(derived)),
		Updated: time.Now().UTC().Format(time.RFC3339Nano),
	}, nil
}

func verifyPassword(password, stored string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 4 || parts[0] != "scrypt" {
		return false
	}
	cost, err := strconv.Atoi(parts[1])
	if err != nil {
		return false
	}
	salt, err := hex.DecodeString(parts[2])
	if err != nil {
		return false
	}
	expected, err := hex.DecodeString(parts[3])
	if err != nil {
		return false
	}
	derived, err := scrypt.Key([]byte(password), salt, cost, scryptR, scryptP, len(expected))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(derived, expected) == 1
}

// One writer at a time for this file too: several handlers update it, and the
// sweep does so on a timer regardless of what else is happening.
var adminMu sync.Mutex

func readAdminConfig(file string) AdminConfig {
	var c AdminConfig
	raw, err := os.ReadFile(file)
	if err == nil {
		// A file that cannot be parsed reads as empty: the interface then asks
		// for a password on first visit, which beats refusing to start.
		_ = json.Unmarshal(raw, &c)
	}
	c.fill()
	return c
}

/** Written through a temporary file, so a crash mid-write cannot truncate it. */
func writeAdminConfig(file string, c AdminConfig) error {
	c.fill()
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(c); err != nil {
		return err
	}
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, []byte(b.String()), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

/** Read, change one part, write back — the only way this file is ever updated. */
func updateAdminConfig(file string, change func(*AdminConfig)) (AdminConfig, error) {
	adminMu.Lock()
	defer adminMu.Unlock()
	c := readAdminConfig(file)
	change(&c)
	return c, writeAdminConfig(file, c)
}

/** Mint a sign-in link, dropping any that have expired on the way through. */
func mintLink(file string, ttl time.Duration) (string, error) {
	token := newToken()
	now := time.Now()
	_, err := updateAdminConfig(file, func(c *AdminConfig) {
		for t, expiry := range c.Links {
			if at, err := time.Parse(time.RFC3339, expiry); err != nil || !at.After(now) {
				delete(c.Links, t)
			}
		}
		c.Links[token] = now.Add(ttl).UTC().Format(time.RFC3339)
	})
	return token, err
}

/** Spend a link: true once, false ever after, and false for one made up. */
func spendLink(file, token string) bool {
	valid := false
	_, _ = updateAdminConfig(file, func(c *AdminConfig) {
		expiry, ok := c.Links[token]
		if ok {
			at, err := time.Parse(time.RFC3339, expiry)
			valid = err == nil && at.After(time.Now())
		}
		delete(c.Links, token)
	})
	return valid
}

func defaultAdminConfigPath() string {
	if p := os.Getenv("ADMIN_CONFIG"); p != "" {
		return p
	}
	exe, err := os.Executable()
	if err != nil {
		return "config.json"
	}
	return filepath.Join(filepath.Dir(exe), "config.json")
}
