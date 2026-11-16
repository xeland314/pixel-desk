// Cuarto 5: rack de servidores. Comprueba la disponibilidad de servicios
// (tcp, http, tls, ping, dns, docker) y la expone al navegador por
// /api/rack/config, /api/rack/status, /api/rack/check y /api/rack/ssh.
//
// Configuración (la escribe el usuario a mano). Se busca, por orden, en:
// $PIXEL_DESK_RACK, $XDG_CONFIG_HOME/pixel-desk/rack.json (por defecto
// ~/.config/pixel-desk/rack.json), ./config/rack.json y, si no hay ninguno,
// el config/rack.json embebido. Se recarga sola si cambia el mtime.
//
//	{"racks":[{"id":"main","title":"RACK A","nodes":[
//	  {"id":"web1","name":"web-1","group":"produccion",
//	   "host":"192.0.2.10",                    // host por defecto de las comprobaciones
//	   "ssh":"usuario@192.0.2.10 -p 22",       // opcional: Enter copia "ssh <esto>"
//	   "interval_s":30,                        // mínimo 10, por defecto 30
//	   "checks":[
//	     {"type":"tcp","port":22},
//	     {"type":"http","url":"https://ejemplo.org/salud","expect_status":200},
//	     {"type":"http","url":"https://ejemplo.org/api/health","keyword":"\"status\":\"ok\""},
//	     {"type":"tls","host":"ejemplo.org","port":443},
//	     {"type":"ping"},
//	     {"type":"dns","name":"ejemplo.org"},
//	     {"type":"docker","container":"nombre"}   // vía /var/run/docker.sock
//	   ]}]}]}
//
// Niveles: ok (verde), warn (naranja: lento, TLS < 21 días, contenedor no
// sano), bad (rojo: caído, TLS < 7 días o caducado/no confiable). Lento =
// más de 500 ms (tcp, ping, dns) o 2 s (http, tls, docker).
//
// Seguridad: el navegador nunca envía hosts ni URLs, solo ids de nodo. Ni la
// config pública ni los errores ni el log contienen URLs completas: solo un
// "target" corto (host:puerto). ping usa exec sin shell y solo con hosts que
// pasan validHost. /api/rack/ssh copia texto de la config al portapapeles y
// no ejecuta nada.
//
// Trabajo en segundo plano: el planificador solo comprueba mientras haya
// habido una petición a /api/rack/status en los últimos 15 s.
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed config/rack.json
var defaultRack []byte

const (
	rackActiveFor  = 15 * time.Second
	rackMinSec     = 10
	rackDefaultSec = 30
	rackHist       = 30
	rackTimeout    = 3 * time.Second
	rackHTTPTime   = 5 * time.Second
	rackMaxBody    = 64 << 10
	rackConc       = 8
	rackForceGap   = 5 * time.Second
	rackSlowFast   = 500  // ms
	rackSlowSlow   = 2000 // ms
	rackWarnDays   = 21
	rackBadDays    = 7
)

// ── Configuración ──────────────────────────────────────────────────────────

type RackCheckCfg struct {
	Type         string `json:"type"`
	Port         int    `json:"port,omitempty"`
	URL          string `json:"url,omitempty"`
	ExpectStatus int    `json:"expect_status,omitempty"`
	Keyword      string `json:"keyword,omitempty"` // http: texto que debe aparecer en la respuesta
	Host         string `json:"host,omitempty"`
	Name         string `json:"name,omitempty"`
	Container    string `json:"container,omitempty"`
}

type RackNodeCfg struct {
	ID        string         `json:"id"`
	Name      string         `json:"name"`
	Group     string         `json:"group"`
	Host      string         `json:"host,omitempty"`
	SSH       string         `json:"ssh,omitempty"`
	Checks    []RackCheckCfg `json:"checks"`
	IntervalS int            `json:"interval_s,omitempty"`
}

type RackCfg struct {
	ID    string        `json:"id"`
	Title string        `json:"title"`
	Nodes []RackNodeCfg `json:"nodes"`
}

type rackFile struct {
	Racks []RackCfg `json:"racks"`
}

var (
	rackIDRe   = regexp.MustCompile(`[^A-Za-z0-9_.-]`)
	hostRe     = regexp.MustCompile(`^[A-Za-z0-9.:-]+$`)
	sshRe      = regexp.MustCompile(`^[A-Za-z0-9_.@:=,/~+\[\] -]+$`)
	dockerSock = "/var/run/docker.sock"
	// rackRootCAs permite a los tests confiar en un certificado local.
	rackRootCAs *x509.CertPool
)

// validHost: nombre o IP (letras, dígitos, punto, guion, dos puntos), sin
// empezar por "-" (no puede pasar por opción de ping).
func validHost(h string) bool {
	return h != "" && len(h) <= 253 && h[0] != '-' && hostRe.MatchString(h)
}

func validSSH(s string) bool {
	s = strings.TrimSpace(s)
	return s != "" && len(s) <= 200 && s[0] != '-' && sshRe.MatchString(s)
}

// target devuelve el destino corto y seguro de una comprobación (nunca una
// URL completa, ruta, query ni usuario).
func rackTarget(n RackNodeCfg, c RackCheckCfg) string {
	host := c.Host
	if host == "" {
		host = n.Host
	}
	switch c.Type {
	case "tcp":
		return net.JoinHostPort(host, strconv.Itoa(c.Port))
	case "tls":
		p := c.Port
		if p == 0 {
			p = 443
		}
		return net.JoinHostPort(host, strconv.Itoa(p))
	case "http":
		if u, err := url.Parse(c.URL); err == nil {
			return u.Host
		}
		return "?"
	case "ping":
		return host
	case "dns":
		return c.Name
	case "docker":
		return c.Container
	}
	return "?"
}

// normalizeRack limpia ids, intervalos y descarta comprobaciones inválidas.
func normalizeRack(f rackFile) []RackCfg {
	seen := map[string]bool{}
	uniq := func(id, fallback string) string {
		id = rackIDRe.ReplaceAllString(id, "")
		if id == "" {
			id = fallback
		}
		base, i := id, 2
		for seen[id] {
			id = fmt.Sprintf("%s-%d", base, i)
			i++
		}
		seen[id] = true
		return id
	}
	var out []RackCfg
	for ri, r := range f.Racks {
		r.ID = uniq(r.ID, fmt.Sprintf("rack%d", ri+1))
		if r.Title == "" {
			r.Title = strings.ToUpper(r.ID)
		}
		for ni := range r.Nodes {
			n := &r.Nodes[ni]
			n.ID = uniq(n.ID, fmt.Sprintf("%s-n%d", r.ID, ni+1))
			if n.Name == "" {
				n.Name = n.ID
			}
			if n.IntervalS == 0 {
				n.IntervalS = rackDefaultSec
			}
			if n.IntervalS < rackMinSec {
				n.IntervalS = rackMinSec
			}
			if !validSSH(n.SSH) {
				if n.SSH != "" {
					log.Printf("rack: ssh inválido en el nodo %s; se ignora", n.ID)
				}
				n.SSH = ""
			} else {
				n.SSH = strings.TrimSpace(n.SSH)
			}
			var cs []RackCheckCfg
			for _, c := range n.Checks {
				switch c.Type {
				case "tcp", "tls", "http", "ping", "dns", "docker":
					cs = append(cs, c)
				default:
					log.Printf("rack: tipo de comprobación desconocido en el nodo %s; se ignora", n.ID)
				}
			}
			n.Checks = cs
		}
		out = append(out, r)
	}
	return out
}

func rackConfigPaths() []string {
	var paths []string
	if p := os.Getenv("PIXEL_DESK_RACK"); p != "" {
		paths = append(paths, p)
	}
	if cfg := os.Getenv("XDG_CONFIG_HOME"); cfg != "" {
		paths = append(paths, filepath.Join(cfg, "pixel-desk", "rack.json"))
	} else if home, err := os.UserHomeDir(); err == nil {
		paths = append(paths, filepath.Join(home, ".config", "pixel-desk", "rack.json"))
	}
	return append(paths, filepath.Join("config", "rack.json"))
}

// ── Estado ─────────────────────────────────────────────────────────────────

type rackHistEntry struct {
	L  string `json:"l"`  // ok | warn | bad
	MS int64  `json:"ms"` // latencia (0 si no aplica)
}

type rackResult struct {
	Level string `json:"level"`
	MS    int64  `json:"ms"`
	Err   string `json:"err,omitempty"`
	Days  *int   `json:"days,omitempty"` // tls: días restantes (puede ser negativo)
	At    int64  `json:"at"`             // ms epoch
}

type rackChk struct {
	res     rackResult
	has     bool
	hist    []rackHistEntry
	next    time.Time
	running bool
}

type rackState struct {
	mu      sync.Mutex
	cfg     []RackCfg
	ver     string
	loaded  bool
	chk     map[string]*rackChk
	lastReq time.Time
	forced  map[string]time.Time
	sem     chan struct{}
}

var rk = &rackState{
	chk:    map[string]*rackChk{},
	forced: map[string]time.Time{},
	sem:    make(chan struct{}, rackConc),
}

func chkKey(n RackNodeCfg, i int, c RackCheckCfg) string {
	return fmt.Sprintf("%s/%d/%s/%s", n.ID, i, c.Type, rackTarget(n, c))
}

// reload relee la config si cambió (mtime/tamaño/ruta). Llamar sin el mutex.
func (s *rackState) reload() {
	var data []byte
	ver := "embebida"
	for _, p := range rackConfigPaths() {
		st, err := os.Stat(p)
		if err != nil || st.IsDir() {
			continue
		}
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		data, ver = b, fmt.Sprintf("%s:%d:%d", p, st.ModTime().UnixNano(), st.Size())
		break
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.loaded && ver == s.ver {
		return
	}
	if data == nil {
		data = defaultRack
	}
	var f rackFile
	if err := json.Unmarshal(data, &f); err != nil {
		log.Printf("rack: config inválida: %v", err)
		s.ver, s.loaded = ver, true
		if s.cfg == nil && ver != "embebida" {
			json.Unmarshal(defaultRack, &f)
			s.cfg = normalizeRack(f)
		}
		return
	}
	s.cfg = normalizeRack(f)
	s.ver, s.loaded = ver, true
	nc := map[string]*rackChk{}
	for _, r := range s.cfg {
		for _, n := range r.Nodes {
			for i, c := range n.Checks {
				k := chkKey(n, i, c)
				if old := s.chk[k]; old != nil {
					nc[k] = old
				} else {
					nc[k] = &rackChk{}
				}
			}
		}
	}
	s.chk = nc
}

func (s *rackState) findNode(id string) (RackNodeCfg, bool) {
	for _, r := range s.cfg {
		for _, n := range r.Nodes {
			if n.ID == id {
				return n, true
			}
		}
	}
	return RackNodeCfg{}, false
}

// spawn lanza una comprobación en segundo plano (con s.mu tomado).
func (s *rackState) spawn(n RackNodeCfg, i int, c RackCheckCfg) {
	k := chkKey(n, i, c)
	st := s.chk[k]
	if st == nil || st.running {
		return
	}
	st.running = true
	go func() {
		s.sem <- struct{}{}
		res := runRackCheck(n, c)
		<-s.sem
		res.At = time.Now().UnixMilli()
		s.mu.Lock()
		defer s.mu.Unlock()
		st.res, st.has, st.running = res, true, false
		st.hist = append(st.hist, rackHistEntry{res.Level, res.MS})
		if len(st.hist) > rackHist {
			st.hist = st.hist[len(st.hist)-rackHist:]
		}
		st.next = time.Now().Add(time.Duration(n.IntervalS) * time.Second)
	}()
}

// tick lanza las comprobaciones vencidas, solo si alguien mira.
func (s *rackState) tick() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if time.Since(s.lastReq) > rackActiveFor {
		return
	}
	now := time.Now()
	for _, r := range s.cfg {
		for _, n := range r.Nodes {
			for i, c := range n.Checks {
				if st := s.chk[chkKey(n, i, c)]; st != nil && !st.running && !now.Before(st.next) {
					s.spawn(n, i, c)
				}
			}
		}
	}
}

func (s *rackState) loop() {
	for range time.Tick(time.Second) {
		s.tick()
	}
}

var levelRank = map[string]int{"": 0, "ok": 1, "warn": 2, "bad": 3}

func (s *rackState) status() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	nodes := map[string]any{}
	for _, r := range s.cfg {
		for _, n := range r.Nodes {
			level := ""
			checks := make([]map[string]any, 0, len(n.Checks))
			for i, c := range n.Checks {
				st := s.chk[chkKey(n, i, c)]
				m := map[string]any{"type": c.Type, "target": rackTarget(n, c), "level": "none", "running": false, "hist": []rackHistEntry{}}
				if st != nil {
					m["running"] = st.running
					m["hist"] = append([]rackHistEntry{}, st.hist...)
					if st.has {
						m["level"], m["ms"], m["at"] = st.res.Level, st.res.MS, st.res.At
						if st.res.Err != "" {
							m["err"] = st.res.Err
						}
						if st.res.Days != nil {
							m["days"] = *st.res.Days
						}
						if levelRank[st.res.Level] > levelRank[level] {
							level = st.res.Level
						}
					}
				}
				checks = append(checks, m)
			}
			if level == "" {
				level = "none"
			}
			nodes[n.ID] = map[string]any{"level": level, "checks": checks}
		}
	}
	return map[string]any{"ver": s.ver, "now": time.Now().UnixMilli(), "nodes": nodes}
}

func (s *rackState) publicConfig() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	racks := make([]map[string]any, 0, len(s.cfg))
	for _, r := range s.cfg {
		nodes := make([]map[string]any, 0, len(r.Nodes))
		for _, n := range r.Nodes {
			cs := make([]map[string]string, 0, len(n.Checks))
			for _, c := range n.Checks {
				cs = append(cs, map[string]string{"type": c.Type, "target": rackTarget(n, c)})
			}
			nodes = append(nodes, map[string]any{
				"id": n.ID, "name": n.Name, "group": n.Group,
				"ssh": n.SSH != "", "interval_s": n.IntervalS, "checks": cs,
			})
		}
		racks = append(racks, map[string]any{"id": r.ID, "title": r.Title, "nodes": nodes})
	}
	return map[string]any{"ver": s.ver, "racks": racks}
}

// ── Comprobaciones ─────────────────────────────────────────────────────────

// cleanErr traduce un error de red a un texto corto sin direcciones ni URLs.
func cleanErr(err error) string {
	var ne net.Error
	var dns *net.DNSError
	var uk x509.UnknownAuthorityError
	var hn x509.HostnameError
	var ci x509.CertificateInvalidError
	switch {
	case err == nil:
		return ""
	case errors.Is(err, context.DeadlineExceeded):
		return "tiempo agotado"
	case errors.As(err, &dns):
		if dns.IsTimeout {
			return "tiempo agotado"
		}
		return "no resuelve"
	case errors.As(err, &ne) && ne.Timeout():
		return "tiempo agotado"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "conexión rechazada"
	case errors.Is(err, syscall.ENETUNREACH), errors.Is(err, syscall.EHOSTUNREACH):
		return "sin ruta al host"
	case errors.Is(err, syscall.ECONNRESET), errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		return "conexión cerrada"
	case errors.As(err, &ci):
		if ci.Reason == x509.Expired {
			return "certificado caducado"
		}
		return "certificado inválido"
	case errors.As(err, &hn):
		return "certificado de otro nombre"
	case errors.As(err, &uk):
		return "certificado no confiable"
	case errors.Is(err, os.ErrPermission):
		return "sin permiso"
	}
	var cv *tls.CertificateVerificationError
	if errors.As(err, &cv) {
		return "certificado inválido"
	}
	return "error de conexión"
}

func isCertErr(err error) bool {
	var cv *tls.CertificateVerificationError
	var uk x509.UnknownAuthorityError
	var hn x509.HostnameError
	var ci x509.CertificateInvalidError
	return errors.As(err, &cv) || errors.As(err, &uk) || errors.As(err, &hn) || errors.As(err, &ci)
}

func slowLevel(ms int64, limit int64) string {
	if ms > limit {
		return "warn"
	}
	return "ok"
}

func runRackCheck(n RackNodeCfg, c RackCheckCfg) rackResult {
	host := c.Host
	if host == "" {
		host = n.Host
	}
	switch c.Type {
	case "tcp":
		return checkTCP(host, c.Port)
	case "tls":
		p := c.Port
		if p == 0 {
			p = 443
		}
		return checkTLS(host, p)
	case "http":
		return checkHTTP(c.URL, c.ExpectStatus, c.Keyword)
	case "ping":
		return checkPing(host)
	case "dns":
		return checkDNS(c.Name)
	case "docker":
		return checkDocker(c.Container)
	}
	return rackResult{Level: "bad", Err: "tipo desconocido"}
}

func bad(msg string) rackResult { return rackResult{Level: "bad", Err: msg} }

func checkTCP(host string, port int) rackResult {
	if !validHost(host) || port < 1 || port > 65535 {
		return bad("destino inválido")
	}
	start := time.Now()
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), rackTimeout)
	ms := time.Since(start).Milliseconds()
	if err != nil {
		return rackResult{Level: "bad", MS: ms, Err: cleanErr(err)}
	}
	conn.Close()
	return rackResult{Level: slowLevel(ms, rackSlowFast), MS: ms}
}

func checkHTTP(raw string, expect int, keyword string) rackResult {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return bad("url inválida")
	}
	client := &http.Client{
		Timeout: rackHTTPTime,
		// Los redirects no se siguen: el estado 3xx es el resultado.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport:     &http.Transport{TLSClientConfig: &tls.Config{RootCAs: rackRootCAs}, DisableKeepAlives: true},
	}
	req, _ := http.NewRequest(http.MethodGet, raw, nil)
	req.Header.Set("User-Agent", "pixel-desk-rack")
	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return rackResult{Level: "bad", MS: time.Since(start).Milliseconds(), Err: cleanErr(err)}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, rackMaxBody))
	ms := time.Since(start).Milliseconds()
	okStatus := resp.StatusCode == expect
	if expect == 0 {
		okStatus = resp.StatusCode >= 200 && resp.StatusCode < 400
	}
	if !okStatus {
		return rackResult{Level: "bad", MS: ms, Err: "estado HTTP " + strconv.Itoa(resp.StatusCode)}
	}
	// El error no repite la palabra clave ni el cuerpo: solo que falta.
	if keyword != "" && !strings.Contains(string(body), keyword) {
		return rackResult{Level: "bad", MS: ms, Err: "falta la palabra clave"}
	}
	return rackResult{Level: slowLevel(ms, rackSlowSlow), MS: ms}
}

// tlsDays: días enteros hasta NotAfter (negativo si ya caducó).
func tlsDays(notAfter, now time.Time) int {
	d := notAfter.Sub(now).Hours() / 24
	if d < 0 {
		return int(d) - 1 // -0,2 días → -1: ya caducado
	}
	return int(d)
}

func tlsLevel(days int) string {
	switch {
	case days < rackBadDays:
		return "bad"
	case days < rackWarnDays:
		return "warn"
	}
	return "ok"
}

func checkTLS(host string, port int) rackResult {
	if !validHost(host) || port < 1 || port > 65535 {
		return bad("destino inválido")
	}
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	d := &net.Dialer{Timeout: rackTimeout}
	start := time.Now()
	conn, err := tls.DialWithDialer(d, "tcp", addr, &tls.Config{ServerName: host, RootCAs: rackRootCAs})
	ms := time.Since(start).Milliseconds()
	if err == nil {
		defer conn.Close()
		certs := conn.ConnectionState().PeerCertificates
		if len(certs) == 0 {
			return rackResult{Level: "bad", MS: ms, Err: "sin certificado"}
		}
		days := tlsDays(certs[0].NotAfter, time.Now())
		lv := tlsLevel(days)
		if lv == "ok" {
			lv = slowLevel(ms, rackSlowSlow)
		}
		return rackResult{Level: lv, MS: ms, Days: &days}
	}
	res := rackResult{Level: "bad", MS: ms, Err: cleanErr(err)}
	if isCertErr(err) {
		// Segunda conexión SOLO para leer la fecha del certificado inválido.
		c2, err2 := tls.DialWithDialer(d, "tcp", addr, &tls.Config{ServerName: host, InsecureSkipVerify: true})
		if err2 == nil {
			if certs := c2.ConnectionState().PeerCertificates; len(certs) > 0 {
				days := tlsDays(certs[0].NotAfter, time.Now())
				res.Days = &days
			}
			c2.Close()
		}
	}
	return res
}

var pingTimeRe = regexp.MustCompile(`time[=<]([0-9.]+) ?ms`)

func checkPing(host string) rackResult {
	if !validHost(host) {
		return bad("host inválido")
	}
	ctx, cancel := context.WithTimeout(context.Background(), rackTimeout+time.Second)
	defer cancel()
	start := time.Now()
	out, err := exec.CommandContext(ctx, "ping", "-c", "1", "-W", "2", "--", host).CombinedOutput()
	ms := time.Since(start).Milliseconds()
	if err != nil {
		var ee *exec.ExitError
		switch {
		case errors.Is(err, exec.ErrNotFound):
			return bad("ping no instalado")
		case ctx.Err() != nil:
			return bad("tiempo agotado")
		case errors.As(err, &ee) && ee.ExitCode() == 1:
			return rackResult{Level: "bad", MS: ms, Err: "sin respuesta"}
		case strings.Contains(strings.ToLower(string(out)), "permitted"), strings.Contains(strings.ToLower(string(out)), "permission"):
			return bad("sin permiso para ping")
		}
		return bad("error de ping")
	}
	if m := pingTimeRe.FindSubmatch(out); m != nil {
		if f, err := strconv.ParseFloat(string(m[1]), 64); err == nil {
			ms = int64(f + 0.5)
		}
	}
	return rackResult{Level: slowLevel(ms, rackSlowFast), MS: ms}
}

func checkDNS(name string) rackResult {
	if !validHost(name) {
		return bad("nombre inválido")
	}
	ctx, cancel := context.WithTimeout(context.Background(), rackTimeout)
	defer cancel()
	start := time.Now()
	addrs, err := net.DefaultResolver.LookupHost(ctx, name)
	ms := time.Since(start).Milliseconds()
	if err != nil {
		return rackResult{Level: "bad", MS: ms, Err: cleanErr(err)}
	}
	if len(addrs) == 0 {
		return rackResult{Level: "bad", MS: ms, Err: "sin respuesta"}
	}
	return rackResult{Level: slowLevel(ms, rackSlowFast), MS: ms}
}

var stateWordRe = regexp.MustCompile(`[^a-z]`)

func checkDocker(name string) rackResult {
	if name == "" || len(name) > 128 {
		return bad("contenedor inválido")
	}
	client := &http.Client{
		Timeout: rackTimeout,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "unix", dockerSock)
			},
			DisableKeepAlives: true,
		},
	}
	start := time.Now()
	resp, err := client.Get("http://docker/containers/json?all=1")
	ms := time.Since(start).Milliseconds()
	if err != nil {
		switch {
		case errors.Is(err, syscall.ENOENT):
			return bad("docker.sock no existe")
		case errors.Is(err, syscall.EACCES), errors.Is(err, syscall.EPERM):
			return bad("sin permiso en docker.sock")
		case errors.Is(err, syscall.ECONNREFUSED):
			return bad("docker no responde")
		}
		return bad(cleanErr(err))
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return bad("docker: estado " + strconv.Itoa(resp.StatusCode))
	}
	var list []struct {
		Names  []string `json:"Names"`
		State  string   `json:"State"`
		Status string   `json:"Status"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&list); err != nil {
		return bad("respuesta de docker inválida")
	}
	for _, c := range list {
		for _, nm := range c.Names {
			if strings.TrimPrefix(nm, "/") != name {
				continue
			}
			state := stateWordRe.ReplaceAllString(strings.ToLower(c.State), "")
			switch {
			case state == "running" && strings.Contains(strings.ToLower(c.Status), "unhealthy"):
				return rackResult{Level: "warn", MS: ms, Err: "no sano"}
			case state == "running":
				return rackResult{Level: slowLevel(ms, rackSlowSlow), MS: ms}
			case state == "restarting" || state == "paused":
				return rackResult{Level: "warn", MS: ms, Err: "estado: " + state}
			}
			return rackResult{Level: "bad", MS: ms, Err: "estado: " + state}
		}
	}
	return rackResult{Level: "bad", MS: ms, Err: "contenedor no existe"}
}

// ── Rutas ──────────────────────────────────────────────────────────────────

func init() {
	go rk.loop()
	extraRoutes = append(extraRoutes, func(mux *http.ServeMux, authed func(http.HandlerFunc) http.HandlerFunc) {
		mux.HandleFunc("/api/rack/config", authed(func(w http.ResponseWriter, r *http.Request) {
			rk.reload()
			w.Header().Set("Cache-Control", "no-store")
			sendJSON(w, rk.publicConfig())
		}))
		mux.HandleFunc("/api/rack/status", authed(func(w http.ResponseWriter, r *http.Request) {
			rk.reload()
			rk.mu.Lock()
			rk.lastReq = time.Now()
			rk.mu.Unlock()
			rk.tick() // lo vencido arranca ya, sin esperar al siguiente segundo
			w.Header().Set("Cache-Control", "no-store")
			sendJSON(w, rk.status())
		}))
		mux.HandleFunc("/api/rack/check", authed(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				http.Error(w, "POST", http.StatusMethodNotAllowed)
				return
			}
			rk.reload()
			rk.mu.Lock()
			defer rk.mu.Unlock()
			n, ok := rk.findNode(r.URL.Query().Get("node"))
			if !ok {
				http.Error(w, "nodo desconocido", http.StatusNotFound)
				return
			}
			if time.Since(rk.forced[n.ID]) < rackForceGap {
				http.Error(w, "espera 5 s", http.StatusTooManyRequests)
				return
			}
			rk.forced[n.ID] = time.Now()
			rk.lastReq = time.Now()
			for i, c := range n.Checks {
				rk.spawn(n, i, c)
			}
			w.WriteHeader(http.StatusAccepted)
		}))
		mux.HandleFunc("/api/rack/ssh", authed(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				http.Error(w, "POST", http.StatusMethodNotAllowed)
				return
			}
			rk.reload()
			rk.mu.Lock()
			n, ok := rk.findNode(r.URL.Query().Get("node"))
			rk.mu.Unlock()
			if !ok || n.SSH == "" {
				http.Error(w, "sin ssh", http.StatusNotFound)
				return
			}
			copyToClipboard("ssh " + n.SSH)
			w.WriteHeader(http.StatusNoContent)
		}))
	})
}
