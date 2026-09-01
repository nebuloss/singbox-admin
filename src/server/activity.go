/*
Who is using the tunnel, and for what.

Two sources, because neither answers alone. sing-box's log names the credential
behind a connection and the port it arrived on; the Clash API counts the bytes
and names the outbound the traffic left by, but never says whose connection it
is. The source port is in both, and it is unique for as long as the connection
is open — that is the join.

A predecessor is retired once nothing has used it for a while. The current
credential is never retired, however quiet: a device may simply be asleep, and
it is the one thing that would lock it out for good.
*/
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

type bearer struct {
	credential string
	at         time.Time
	host       string
}

var (
	activityMu sync.Mutex
	// Source port -> the credential that opened it. Pruned as it ages.
	bearers = map[string]bearer{}
	// Credential -> last time it was seen at all, in memory between sweeps.
	lastSeen = map[string]time.Time{}
	// Log id -> source port, waiting for the line that names the credential.
	pendingPorts = map[string]string{}
	// Start at the end of the log, not the beginning. Reading what is already
	// there would stamp connections from days ago as happening now, and nothing
	// would ever look idle enough to retire.
	logOffset int64 = -1
)

// Anchored on the whole message rather than on the shape of what sits between
// brackets: an identifier is no longer distinctive enough to recognise on
// sight, and these two lines say exactly where the interesting part is.
var (
	fromLine = regexp.MustCompile(`\[(\d+) [^\]]*\] inbound/\w+\[[^\]]*\]: inbound connection from \S+:(\d+)`)
	whoLine  = regexp.MustCompile(`\[(\d+) [^\]]*\] inbound/\w+\[[^\]]*\]: \[([^\]]+)\] inbound connection to (\S+)`)
)

func readLog() {
	cfg, err := readConfig()
	if err != nil {
		return
	}
	file := asS(asM(cfg["log"])["output"])
	if file == "" {
		return
	}
	info, err := os.Stat(file)
	if err != nil {
		// A missing or unreadable log only means no news, never a reason to retire.
		return
	}
	size := info.Size()

	activityMu.Lock()
	defer activityMu.Unlock()

	if logOffset < 0 {
		logOffset = size
		return
	}
	// Truncated or rotated: start over rather than read from beyond the end.
	if size < logOffset {
		logOffset = 0
	}
	if size == logOffset {
		return
	}

	f, err := os.Open(file)
	if err != nil {
		return
	}
	defer f.Close()
	buf := make([]byte, size-logOffset)
	n, err := f.ReadAt(buf, logOffset)
	if err != nil && err != io.EOF {
		return
	}
	logOffset = size

	now := time.Now()
	for _, line := range strings.Split(string(buf[:n]), "\n") {
		if m := fromLine.FindStringSubmatch(line); m != nil {
			pendingPorts[m[1]] = m[2]
			continue
		}
		m := whoLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		id, credential, host := m[1], m[2], m[3]
		lastSeen[credential] = now
		port, ok := pendingPorts[id]
		if !ok {
			continue
		}
		delete(pendingPorts, id)
		bearers[port] = bearer{credential: credential, at: now, host: host}
	}

	// The pair of lines is written together, so anything still unmatched never
	// will be. A bearer outlives that by long enough to cover a connection the
	// Clash API is still reporting.
	if len(pendingPorts) > 4096 {
		pendingPorts = map[string]string{}
	}
	for port, b := range bearers {
		if now.Sub(b.at) > 30*time.Minute {
			delete(bearers, port)
		}
	}
}

type clashConnection struct {
	Metadata struct {
		SourcePort      string `json:"sourcePort"`
		DestinationPort string `json:"destinationPort"`
		Host            string `json:"host"`
		DestinationIP   string `json:"destinationIP"`
	} `json:"metadata"`
	Upload   int64    `json:"upload"`
	Download int64    `json:"download"`
	Chains   []string `json:"chains"`
	Start    string   `json:"start"`
}

type clashSnapshot struct {
	Connections   []clashConnection `json:"connections"`
	UploadTotal   int64             `json:"uploadTotal"`
	DownloadTotal int64             `json:"downloadTotal"`
	Memory        int64             `json:"memory"`
}

/*
The live picture, straight from sing-box.

Read-only and local: the controller listens on loopback and its secret never
leaves this process. Unreachable, it returns nothing at all, so the interface
can say the counters are missing rather than show a busy tunnel as an idle one.
*/
func fetchSnapshot(cfg M) *clashSnapshot {
	api := asM(asM(cfg["experimental"])["clash_api"])
	controller := asS(api["external_controller"])
	if controller == "" {
		return nil
	}
	req, err := http.NewRequest("GET", "http://"+controller+"/connections", nil)
	if err != nil {
		return nil
	}
	if secret := asS(api["secret"]); secret != "" {
		req.Header.Set("Authorization", "Bearer "+secret)
	}
	client := &http.Client{Timeout: 2 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return nil
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil
	}
	var snap clashSnapshot
	if err := json.NewDecoder(res.Body).Decode(&snap); err != nil {
		return nil
	}
	return &snap
}

/*
Give sing-box a Clash controller if it has none.

On loopback, with a secret of its own. Without it there is no byte count to be
had: the log says who and where, never how much.
*/
func ensureClashApi() error {
	cfg, err := readConfig()
	if err != nil {
		return err
	}
	if asS(asM(asM(cfg["experimental"])["clash_api"])["external_controller"]) != "" {
		return nil
	}
	exp := ensureM(cfg, "experimental")
	exp["clash_api"] = M{"external_controller": "127.0.0.1:9090", "secret": newToken()}
	if err := serialise(func() error { return commit(cfg) }); err != nil {
		return err
	}
	logf("clash_api actif sur 127.0.0.1:9090 — compteurs disponibles")
	return nil
}

/*
Replace a device's credential, keeping the old one alive.

The device is not here to be told: it will learn the new credential when it next
fetches its profile, and until then the old one has to keep working. Retirement
is left to the sweep, which drops a predecessor once nothing has used it for a
while — so a credential's life is bounded by its use, not by a guess at how long
a device might be asleep.

Rate-limited: a device that fetches its profile in a loop must not grow the
credential list without bound.
*/
func rotate(token string, device Device) (string, error) {
	var fresh string
	err := serialise(func() error {
		now := time.Now()
		if device.Rotated != "" {
			if last, err := time.Parse(time.RFC3339Nano, device.Rotated); err == nil && now.Sub(last) < rotateEvery {
				fresh = device.Uuids[0]
				return nil
			}
		}
		fresh = newToken()
		cfg, err := readConfig()
		if err != nil {
			return err
		}
		home := homeOf(cfg, device.Uuids)
		if home == nil {
			if home, err = liveInbound(cfg); err != nil {
				return err
			}
		}
		addUser(home, fresh)
		if err := commit(cfg); err != nil {
			return err
		}
		_, err = updateAdminConfig(adminConfigPath, func(c *AdminConfig) {
			d, ok := c.Devices[token]
			if !ok {
				return
			}
			d.Uuids = append([]string{fresh}, d.Uuids...)
			d.Rotated = now.UTC().Format(time.RFC3339Nano)
			c.Devices[token] = d
		})
		return err
	})
	if err != nil {
		return "", err
	}
	return fresh, nil
}

func sweep() {
	activityMu.Lock()
	fresh := map[string]string{}
	for credential, at := range lastSeen {
		fresh[credential] = at.UTC().Format(time.RFC3339Nano)
	}
	activityMu.Unlock()

	now := time.Now()
	stale := []string{}
	_, err := updateAdminConfig(adminConfigPath, func(c *AdminConfig) {
		seen := map[string]string{}
		for k, v := range c.Seen {
			seen[k] = v
		}
		for k, v := range fresh {
			seen[k] = v
		}
		at := func(uuid string) time.Time {
			if v, ok := seen[uuid]; ok {
				if t, err := time.Parse(time.RFC3339Nano, v); err == nil {
					return t
				}
			}
			return time.Time{}
		}
		for _, device := range c.Devices {
			if len(device.Uuids) < 2 {
				continue
			}
			// Only retire once the current credential has been seen more
			// recently than the one being retired. That proves two things at
			// once: the device has moved on, and connections are being logged
			// at all. Without it, a log turned down to warnings would look like
			// silence, and a device still on its old credential would be cut off.
			current := at(device.Uuids[0])
			for _, uuid := range device.Uuids[1:] {
				if current.After(at(uuid)) && now.Sub(at(uuid)) > idleRetire {
					stale = append(stale, uuid)
				}
			}
		}
		for _, uuid := range stale {
			delete(seen, uuid)
		}
		c.Seen = seen
		if len(stale) == 0 {
			return
		}
		for token, device := range c.Devices {
			kept := []string{}
			for _, uuid := range device.Uuids {
				if !contains(stale, uuid) {
					kept = append(kept, uuid)
				}
			}
			device.Uuids = kept
			c.Devices[token] = device
		}
	})
	if err != nil {
		logf("balayage: %v", err)
		return
	}
	if len(stale) == 0 {
		return
	}
	err = serialise(func() error {
		cfg, err := readConfig()
		if err != nil {
			return err
		}
		live, err := liveInbound(cfg)
		if err != nil {
			return err
		}
		dropUuids(live, stale)
		dropUuids(parkedInbound(cfg), stale)
		return commit(cfg)
	})
	if err != nil {
		logf("balayage: %v", err)
		return
	}
	logf("identifiants retires faute d usage : %d", len(stale))
}

type liveConnection struct {
	Token *string `json:"token"`
	Host  string  `json:"host"`
	Port  string  `json:"port"`
	Up    int64   `json:"up"`
	Down  int64   `json:"down"`
	Route *string `json:"route"`
	Start *string `json:"start"`
}

type deviceActivity struct {
	Token       string    `json:"token"`
	Name        string    `json:"name"`
	LastSeen    *string   `json:"lastSeen"`
	Connections int       `json:"connections"`
	Up          int64     `json:"up"`
	Down        int64     `json:"down"`
	Routes      []*string `json:"routes"`
}

/*
What is happening right now.

Every device is listed, busy or not — a view that only showed the connected ones
would leave you unable to tell a quiet device from a broken one. A connection
whose bearer is unknown is counted apart rather than blamed on someone: the log
is followed from the moment this process started, so anything older than that
has no owner here.
*/
func handleActivity(w http.ResponseWriter, r *http.Request) {
	cfg, err := readConfig()
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	snap := fetchSnapshot(cfg)
	admin := readAdminConfig(adminConfigPath)

	owner := map[string]string{}
	for token, d := range admin.Devices {
		for _, u := range d.Uuids {
			owner[u] = token
		}
	}
	wgTags := map[string]bool{}
	for _, e := range wgEndpoints(cfg) {
		wgTags[asS(e["tag"])] = true
	}
	named := func(tag string) *string {
		if tag == "direct" {
			return nil
		}
		name := admin.Tunnels[wgID(tag)]
		if name == "" {
			name = wgID(tag)
		}
		return &name
	}

	type counts struct {
		connections int
		up, down    int64
		routes      []*string
	}
	perDevice := map[string]*counts{}
	live := []liveConnection{}
	unattributed := 0

	activityMu.Lock()
	known := map[string]bearer{}
	for k, v := range bearers {
		known[k] = v
	}
	activityMu.Unlock()

	var connections []clashConnection
	if snap != nil {
		connections = snap.Connections
	}
	for _, c := range connections {
		// The chain names every outbound the traffic crossed; the one that is a
		// tunnel is the answer, and its absence means it went out directly.
		tag := "direct"
		for _, t := range c.Chains {
			if wgTags[t] {
				tag = t
				break
			}
		}
		route := named(tag)

		var token *string
		if b, ok := known[c.Metadata.SourcePort]; ok {
			if t, ok := owner[b.credential]; ok {
				token = &t
			}
		}
		if token == nil {
			unattributed++
		} else {
			d := perDevice[*token]
			if d == nil {
				d = &counts{}
				perDevice[*token] = d
			}
			d.connections++
			d.up += c.Upload
			d.down += c.Download
			// Which way out is something a device does, not a category of its
			// own: it belongs against the device using it.
			seen := false
			for _, existing := range d.routes {
				if (existing == nil) == (route == nil) && (route == nil || *existing == *route) {
					seen = true
					break
				}
			}
			if !seen {
				d.routes = append(d.routes, route)
			}
		}

		// Enough of each connection to answer "what is it doing", and no more:
		// this list is read every few seconds and grows with the traffic.
		if len(live) < liveMax {
			host := c.Metadata.Host
			if host == "" {
				host = c.Metadata.DestinationIP
			}
			var start *string
			if c.Start != "" {
				s := c.Start
				start = &s
			}
			live = append(live, liveConnection{
				Token: token, Host: host, Port: c.Metadata.DestinationPort,
				Up: c.Upload, Down: c.Download, Route: route, Start: start,
			})
		}
	}

	activityMu.Lock()
	memory := lastSeen
	activityMu.Unlock()
	seenAt := func(uuids []string) *string {
		var best time.Time
		for _, u := range uuids {
			if t, ok := memory[u]; ok && t.After(best) {
				best = t
			}
			if v, ok := admin.Seen[u]; ok {
				if t, err := time.Parse(time.RFC3339Nano, v); err == nil && t.After(best) {
					best = t
				}
			}
		}
		if best.IsZero() {
			return nil
		}
		s := best.UTC().Format(time.RFC3339Nano)
		return &s
	}

	devices := []deviceActivity{}
	for token, d := range admin.Devices {
		entry := deviceActivity{Token: token, Name: d.Name, LastSeen: seenAt(d.Uuids), Routes: []*string{}}
		if c := perDevice[token]; c != nil {
			entry.Connections, entry.Up, entry.Down = c.connections, c.up, c.down
			entry.Routes = c.routes
		}
		devices = append(devices, entry)
	}

	total := clashSnapshot{}
	if snap != nil {
		total = *snap
	}
	writeJSON(w, http.StatusOK, M{
		// Without the controller there are no byte counts, and saying so beats
		// drawing zeroes that look like silence.
		"counters": snap != nil,
		"totals": M{
			"up":           total.UploadTotal,
			"down":         total.DownloadTotal,
			"connections":  len(connections),
			"unattributed": unattributed,
			"memory":       total.Memory,
		},
		"devices":   devices,
		"live":      live,
		"truncated": len(connections) > liveMax,
	})
}

func logf(format string, args ...any) {
	fmt.Printf(format+"\n", args...)
}
