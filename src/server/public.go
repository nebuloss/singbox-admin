/*
The public face: a device's profile, and an unremarkable page for everything
else.

Deliberately a separate listener on its own socket — the interface and its API
are simply not mounted here, so no request arriving from outside can reach them
however it is shaped.
*/
package main

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

const landingPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Static Asset Delivery</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font:15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         background:#fafafa; color:#333 }
  main { max-width:30rem; padding:2rem }
  h1 { font-size:1.15rem; font-weight:600; margin:0 0 .75rem }
  p { margin:0 0 .6rem; color:#666 }
  @media (prefers-color-scheme: dark) { body{background:#16181a;color:#d6d6d6} p{color:#9a9a9a} }
</style>
</head>
<body><main>
  <h1>Static asset delivery</h1>
  <p>This host serves cached static resources. There is no browsable index.</p>
</main></body>
</html>
`

/*
What a host like this owes a request for something it does not have: a 404, like
any other origin. Answering everything with the front page would be the tell —
it is the one behaviour no real asset host has.

Uniform all the same: every address that is not a profile gets this exact body
and status, the tunnel's own included when asked without an upgrade.
*/
const notFoundPage = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>404 Not Found</title></head>
<body><h1>404 Not Found</h1><p>No such asset.</p></body>
</html>
`

func html(w http.ResponseWriter, status int, page string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(page))
}

func public() {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			html(w, http.StatusOK, landingPage)
			return
		}
		token := strings.TrimPrefix(r.URL.Path, "/")
		// A token nobody holds is answered exactly like any other address: there
		// is no reply that says "not this one".
		if !tokenShape.MatchString(token) {
			html(w, http.StatusNotFound, notFoundPage)
			return
		}
		device, exists := readAdminConfig(adminConfigPath).Devices[token]
		if !exists || len(device.Uuids) == 0 {
			html(w, http.StatusNotFound, notFoundPage)
			return
		}

		// Fetching a profile is the one moment a device is listening, so it is
		// when a credential is replaced: it leaves with the new one in hand.
		uuid, err := rotate(token, device)
		if err != nil {
			html(w, http.StatusNotFound, notFoundPage)
			return
		}
		cfg, err := readConfig()
		if err != nil {
			html(w, http.StatusNotFound, notFoundPage)
			return
		}
		inbound, err := liveInbound(cfg)
		if err != nil {
			html(w, http.StatusNotFound, notFoundPage)
			return
		}
		wsPath := "/"
		if p := asS(asM(inbound["transport"])["path"]); p != "" {
			wsPath = p
		}
		name := device.Name
		if name == "" {
			name = token[:min(8, len(token))]
		}
		base := publicBase(r)
		profile := clientProfile(uuid, cfg, wsPath, base, publicAddress(base.Host))
		out, err := marshalConfig(profile)
		if err != nil {
			html(w, http.StatusNotFound, notFoundPage)
			return
		}
		w.Header().Set("profile-title", "base64:"+base64UTF8(name))
		w.Header().Set("profile-update-interval", strconv.Itoa(refreshHours))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(out)
	})

	logf("vitrine publique on :%d — profils et page de couverture", publicPort)
	if err := http.ListenAndServe(fmt.Sprintf(":%d", publicPort), mux); err != nil {
		logf("vitrine: %v", err)
	}
}
