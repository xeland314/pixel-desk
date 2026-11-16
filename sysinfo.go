// Cuarto 3: monitor del sistema. Lee /proc y /sys directamente (sin comandos
// externos) y expone tres rutas: /api/monitor/config, /api/sys y
// /api/monitor/http. El navegador nunca envía URLs: solo pide por id.
package main

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

//go:embed config/monitor.json
var defaultMonitor []byte

const (
	sampleEvery = time.Second
	histLen     = 60
	activeFor   = 10 * time.Second // solo se muestrea si hubo petición reciente
	clkTck      = 100.0            // USER_HZ en Linux
	topProcs    = 25
	httpMinSec  = 10
	httpTimeout = 5 * time.Second
	httpMaxBody = 256 << 10
)

// ── Configuración ──────────────────────────────────────────────────────────

type MonPanel struct {
	ID       string            `json:"id"`
	Type     string            `json:"type"`
	Title    string            `json:"title"`
	Span     [2]int            `json:"span"`
	N        int               `json:"n,omitempty"`      // procs: filas
	Iface    string            `json:"iface,omitempty"`  // net
	Mounts   []string          `json:"mounts,omitempty"` // disk
	URL      string            `json:"url,omitempty"`    // http
	Method   string            `json:"method,omitempty"`
	Interval int               `json:"interval_s,omitempty"`
	Headers  map[string]string `json:"headers,omitempty"`
	Field    string            `json:"field,omitempty"`
	Expect   int               `json:"expect_status,omitempty"`
	Nota     string            `json:"_nota,omitempty"`
}

type MonConfig struct {
	Columns int        `json:"columns"`
	Rows    int        `json:"rows"`
	Panels  []MonPanel `json:"panels"`
}

var (
	monCfgOnce sync.Once
	monCfg     MonConfig
)

func monConfig() *MonConfig {
	monCfgOnce.Do(func() {
		data, src := defaultMonitor, "embebida"
		if b, err := os.ReadFile("config/monitor.json"); err == nil {
			data, src = b, "config/monitor.json"
		}
		if err := json.Unmarshal(data, &monCfg); err != nil {
			log.Printf("monitor: config inválida (%s): %v; uso la embebida", src, err)
			monCfg = MonConfig{}
			json.Unmarshal(defaultMonitor, &monCfg)
		}
		if monCfg.Columns < 1 {
			monCfg.Columns = 4
		}
		if monCfg.Rows < 1 {
			monCfg.Rows = 3
		}
		for i := range monCfg.Panels {
			p := &monCfg.Panels[i]
			if p.Span[0] < 1 {
				p.Span[0] = 1
			}
			if p.Span[1] < 1 {
				p.Span[1] = 1
			}
			if p.ID == "" {
				p.ID = fmt.Sprintf("%s%d", p.Type, i)
			}
			if p.Title == "" {
				p.Title = strings.ToUpper(p.Type)
			}
		}
	})
	return &monCfg
}

// publicPanel quita lo que no debe llegar al navegador (url, cabeceras).
func publicPanel(p MonPanel) map[string]any {
	m := map[string]any{"id": p.ID, "type": p.Type, "title": p.Title, "span": p.Span}
	if p.N > 0 {
		m["n"] = p.N
	}
	if p.Iface != "" {
		m["iface"] = p.Iface
	}
	if len(p.Mounts) > 0 {
		m["mounts"] = p.Mounts
	}
	if p.Type == "http" {
		iv := p.Interval
		if iv < httpMinSec {
			iv = httpMinSec
		}
		m["interval_s"] = iv
		if u, err := url.Parse(p.URL); err == nil {
			m["host"] = u.Host
		}
	}
	return m
}

// ── Muestreo de /proc y /sys ───────────────────────────────────────────────

type cpuTimes struct{ total, idle uint64 }

type NetIf struct {
	Name  string  `json:"name"`
	RxBps float64 `json:"rx"`
	TxBps float64 `json:"tx"`
	RxTot uint64  `json:"rx_total"`
	TxTot uint64  `json:"tx_total"`
}

type ProcInfo struct {
	PID  int     `json:"pid"`
	Name string  `json:"name"`
	CPU  float64 `json:"cpu"` // % de un núcleo (como htop): puede pasar de 100
	Mem  float64 `json:"mem"` // % de la RAM total (RSS)
}

type DiskInfo struct {
	Mount string `json:"mount"`
	Total uint64 `json:"total"`
	Used  uint64 `json:"used"`
	Error string `json:"error,omitempty"`
}

type Battery struct {
	Pct    int    `json:"pct"`
	Status string `json:"status"`
}

type Snapshot struct {
	T        int64          `json:"t"`
	Host     string         `json:"host"`
	Kernel   string         `json:"kernel"`
	Model    string         `json:"model"`
	Cores    int            `json:"cores"`
	Uptime   float64        `json:"uptime"`
	Load     [3]float64     `json:"load"`
	CPU      float64        `json:"cpu"` // 0..100
	CPUCores []float64      `json:"cpu_cores"`
	MemTotal uint64         `json:"mem_total"`
	MemUsed  uint64         `json:"mem_used"`
	MemCache uint64         `json:"mem_cache"`
	SwapTot  uint64         `json:"swap_total"`
	SwapUsed uint64         `json:"swap_used"`
	Net      []NetIf        `json:"net"`
	NetMain  string         `json:"net_main"`
	Disks    []DiskInfo     `json:"disks"`
	Temp     *float64       `json:"temp,omitempty"`
	Battery  *Battery       `json:"battery,omitempty"`
	NProcs   int            `json:"nprocs"`
	ProcsCPU []ProcInfo     `json:"procs_cpu"`
	ProcsMem []ProcInfo     `json:"procs_mem"`
	Hist     map[string]any `json:"hist"`
	Stale    bool           `json:"stale,omitempty"`
}

type sampler struct {
	mu         sync.Mutex // protege last y el historial
	last       *Snapshot
	hCPU, hMem []float64
	hNet       map[string][2][]float64

	// estado del muestreo (solo lo toca sample(), bajo smu)
	smu       sync.Mutex
	prevCPU   map[string]cpuTimes
	prevNet   map[string][2]uint64
	prevProcs map[int]uint64
	prevAt    time.Time
	static    struct{ host, kernel, model string }

	lastReq atomic.Int64 // unix nano de la última petición
}

var mon = &sampler{
	prevCPU:   map[string]cpuTimes{},
	prevNet:   map[string][2]uint64{},
	prevProcs: map[int]uint64{},
	hNet:      map[string][2][]float64{},
}

func readFile(p string) string {
	b, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	return string(b)
}

func push(h []float64, v float64) []float64 {
	h = append(h, v)
	if len(h) > histLen {
		h = h[len(h)-histLen:]
	}
	return h
}

func round1(v float64) float64 { return float64(int(v*10+0.5)) / 10 }

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func (s *sampler) sample() {
	s.smu.Lock()
	defer s.smu.Unlock()
	now := time.Now()
	dt := now.Sub(s.prevAt).Seconds()
	first := s.prevAt.IsZero()
	if first {
		s.static.host, _ = os.Hostname()
		s.static.kernel = strings.TrimSpace(readFile("/proc/sys/kernel/osrelease"))
		for _, ln := range strings.Split(readFile("/proc/cpuinfo"), "\n") {
			if strings.HasPrefix(ln, "model name") {
				if i := strings.Index(ln, ":"); i >= 0 {
					s.static.model = strings.TrimSpace(ln[i+1:])
				}
				break
			}
		}
	}
	snap := &Snapshot{T: now.UnixMilli(), Host: s.static.host, Kernel: s.static.kernel, Model: s.static.model}

	// CPU: delta de /proc/stat entre muestras
	cores := []float64{}
	for _, ln := range strings.Split(readFile("/proc/stat"), "\n") {
		if !strings.HasPrefix(ln, "cpu") {
			continue
		}
		f := strings.Fields(ln)
		if len(f) < 9 {
			continue
		}
		var v [8]uint64
		var tot uint64
		for i := 0; i < 8; i++ {
			v[i], _ = strconv.ParseUint(f[i+1], 10, 64)
			tot += v[i]
		}
		cur := cpuTimes{tot, v[3] + v[4]} // idle + iowait
		pct := 0.0
		if p, ok := s.prevCPU[f[0]]; ok && cur.total > p.total {
			pct = 100 * (1 - float64(cur.idle-p.idle)/float64(cur.total-p.total))
		}
		s.prevCPU[f[0]] = cur
		pct = round1(clamp(pct, 0, 100))
		if f[0] == "cpu" {
			snap.CPU = pct
		} else {
			cores = append(cores, pct)
		}
	}
	snap.CPUCores = cores
	snap.Cores = len(cores)

	// Carga y uptime
	if f := strings.Fields(readFile("/proc/loadavg")); len(f) >= 3 {
		for i := 0; i < 3; i++ {
			snap.Load[i], _ = strconv.ParseFloat(f[i], 64)
		}
	}
	if f := strings.Fields(readFile("/proc/uptime")); len(f) >= 1 {
		snap.Uptime, _ = strconv.ParseFloat(f[0], 64)
	}

	// Memoria
	mi := map[string]uint64{}
	for _, ln := range strings.Split(readFile("/proc/meminfo"), "\n") {
		f := strings.Fields(ln)
		if len(f) >= 2 {
			n, _ := strconv.ParseUint(f[1], 10, 64)
			mi[strings.TrimSuffix(f[0], ":")] = n * 1024
		}
	}
	snap.MemTotal = mi["MemTotal"]
	if mi["MemAvailable"] <= snap.MemTotal {
		snap.MemUsed = snap.MemTotal - mi["MemAvailable"]
	}
	snap.MemCache = mi["Cached"] + mi["Buffers"]
	snap.SwapTot = mi["SwapTotal"]
	if mi["SwapFree"] <= snap.SwapTot {
		snap.SwapUsed = snap.SwapTot - mi["SwapFree"]
	}

	// Red
	var best string
	var bestTot uint64
	snap.Net = []NetIf{}
	for _, ln := range strings.Split(readFile("/proc/net/dev"), "\n") {
		i := strings.Index(ln, ":")
		if i < 0 {
			continue
		}
		name := strings.TrimSpace(ln[:i])
		f := strings.Fields(ln[i+1:])
		if len(f) < 9 {
			continue
		}
		rx, _ := strconv.ParseUint(f[0], 10, 64)
		tx, _ := strconv.ParseUint(f[8], 10, 64)
		ni := NetIf{Name: name, RxTot: rx, TxTot: tx}
		if p, ok := s.prevNet[name]; ok && dt > 0 && rx >= p[0] && tx >= p[1] {
			ni.RxBps = float64(rx-p[0]) / dt
			ni.TxBps = float64(tx-p[1]) / dt
		}
		s.prevNet[name] = [2]uint64{rx, tx}
		snap.Net = append(snap.Net, ni)
		if name != "lo" && rx+tx >= bestTot {
			best, bestTot = name, rx+tx
		}
	}
	snap.NetMain = defaultIface(best)

	// Discos (los puntos de montaje salen de la config)
	seen := map[string]bool{}
	snap.Disks = []DiskInfo{}
	for _, p := range monConfig().Panels {
		if p.Type != "disk" {
			continue
		}
		ms := p.Mounts
		if len(ms) == 0 {
			ms = []string{"/"}
		}
		for _, m := range ms {
			if seen[m] {
				continue
			}
			seen[m] = true
			var st syscall.Statfs_t
			d := DiskInfo{Mount: m}
			if err := syscall.Statfs(m, &st); err != nil {
				d.Error = err.Error()
			} else {
				d.Total = st.Blocks * uint64(st.Bsize)
				// "usado" como df: total - libre
				d.Used = (st.Blocks - st.Bfree) * uint64(st.Bsize)
			}
			snap.Disks = append(snap.Disks, d)
		}
	}

	// Temperatura (la mayor de las zonas) y batería
	var tmax float64
	zones, _ := filepath.Glob("/sys/class/thermal/thermal_zone*/temp")
	for _, z := range zones {
		if v, err := strconv.ParseFloat(strings.TrimSpace(readFile(z)), 64); err == nil && v/1000 > tmax {
			tmax = v / 1000
		}
	}
	if tmax > 0 {
		tmax = round1(tmax)
		snap.Temp = &tmax
	}
	bats, _ := filepath.Glob("/sys/class/power_supply/BAT*")
	if len(bats) > 0 {
		if pct, err := strconv.Atoi(strings.TrimSpace(readFile(bats[0] + "/capacity"))); err == nil {
			snap.Battery = &Battery{Pct: pct, Status: strings.TrimSpace(readFile(bats[0] + "/status"))}
		}
	}

	snap.ProcsCPU, snap.ProcsMem, snap.NProcs = s.procs(snap.MemTotal, dt, first)
	s.prevAt = now

	// Historial y publicación
	s.mu.Lock()
	s.hCPU = push(s.hCPU, snap.CPU)
	mp := 0.0
	if snap.MemTotal > 0 {
		mp = round1(100 * float64(snap.MemUsed) / float64(snap.MemTotal))
	}
	s.hMem = push(s.hMem, mp)
	nh := map[string]any{}
	for _, n := range snap.Net {
		h := s.hNet[n.Name]
		h[0] = push(h[0], float64(int64(n.RxBps)))
		h[1] = push(h[1], float64(int64(n.TxBps)))
		s.hNet[n.Name] = h
		nh[n.Name] = map[string][]float64{"rx": append([]float64(nil), h[0]...), "tx": append([]float64(nil), h[1]...)}
	}
	snap.Hist = map[string]any{
		"cpu": append([]float64(nil), s.hCPU...),
		"mem": append([]float64(nil), s.hMem...),
		"net": nh,
	}
	s.last = snap
	s.mu.Unlock()
}

// defaultIface: la de la ruta por defecto; si no hay, la de más tráfico.
func defaultIface(fallback string) string {
	for i, ln := range strings.Split(readFile("/proc/net/route"), "\n") {
		f := strings.Fields(ln)
		if i > 0 && len(f) > 7 && f[1] == "00000000" {
			return f[0]
		}
	}
	return fallback
}

// procs recorre /proc/[pid]/stat: CPU% = delta(utime+stime)/delta(reloj).
// El RSS (campo 24) sale del mismo archivo: una lectura por proceso.
func (s *sampler) procs(memTotal uint64, dt float64, first bool) (byCPU, byMem []ProcInfo, n int) {
	byCPU, byMem = []ProcInfo{}, []ProcInfo{}
	ents, err := os.ReadDir("/proc")
	if err != nil {
		return
	}
	page := uint64(os.Getpagesize())
	cur := make(map[int]uint64, len(ents))
	var all []ProcInfo
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		b, err := os.ReadFile("/proc/" + e.Name() + "/stat")
		if err != nil {
			continue
		}
		str := string(b)
		lp, rp := strings.IndexByte(str, '('), strings.LastIndexByte(str, ')')
		if lp < 0 || rp < lp {
			continue
		}
		f := strings.Fields(str[rp+1:])
		if len(f) < 22 {
			continue
		}
		ut, _ := strconv.ParseUint(f[11], 10, 64)
		st, _ := strconv.ParseUint(f[12], 10, 64)
		rss, _ := strconv.ParseUint(f[21], 10, 64)
		ticks := ut + st
		cur[pid] = ticks
		p := ProcInfo{PID: pid, Name: str[lp+1 : rp]}
		if prev, ok := s.prevProcs[pid]; ok && dt > 0 && ticks >= prev && !first {
			p.CPU = round1(float64(ticks-prev) / clkTck / dt * 100)
		}
		if memTotal > 0 {
			p.Mem = round1(float64(rss*page) / float64(memTotal) * 100)
		}
		all = append(all, p)
	}
	s.prevProcs = cur
	n = len(all)
	top := func(less func(a, b ProcInfo) bool) []ProcInfo {
		c := append([]ProcInfo(nil), all...)
		sort.Slice(c, func(i, j int) bool { return less(c[i], c[j]) })
		if len(c) > topProcs {
			c = c[:topProcs]
		}
		return c
	}
	byCPU = top(func(a, b ProcInfo) bool {
		if a.CPU != b.CPU {
			return a.CPU > b.CPU
		}
		return a.Mem > b.Mem
	})
	byMem = top(func(a, b ProcInfo) bool { return a.Mem > b.Mem })
	return
}

// run muestrea cada segundo, pero solo si alguien consultó hace poco.
func (s *sampler) run() {
	t := time.NewTicker(sampleEvery)
	for range t.C {
		if time.Since(time.Unix(0, s.lastReq.Load())) < activeFor {
			s.sample()
		}
	}
}

// snapshot devuelve lo último sin bloquear (salvo la primera vez).
func (s *sampler) snapshot() *Snapshot {
	s.lastReq.Store(time.Now().UnixNano())
	s.mu.Lock()
	l := s.last
	s.mu.Unlock()
	if l == nil {
		s.sample()
		s.mu.Lock()
		l = s.last
		s.mu.Unlock()
	}
	if time.Since(time.UnixMilli(l.T)) > 3*time.Second {
		c := *l
		c.Stale = true // la goroutine dormía: llegará una muestra nueva en ~1 s
		return &c
	}
	return l
}

// ── Panel http ─────────────────────────────────────────────────────────────

type HTTPResult struct {
	ID      string  `json:"id"`
	OK      bool    `json:"ok"`
	Status  int     `json:"status"`
	Latency int64   `json:"latency_ms"`
	Value   string  `json:"value,omitempty"`
	Error   string  `json:"error,omitempty"`
	At      int64   `json:"at"`
	Hist    []int64 `json:"hist"` // latencias (ms); -1 = fallo
}

type httpEntry struct {
	mu   sync.Mutex
	res  HTTPResult
	done bool
	hist []int64
}

var (
	httpMu      sync.Mutex
	httpEntries = map[string]*httpEntry{}
	httpClient  = &http.Client{Timeout: httpTimeout}
)

func jsonPath(v any, path string) (any, bool) {
	for _, part := range strings.Split(path, ".") {
		switch t := v.(type) {
		case map[string]any:
			x, ok := t[part]
			if !ok {
				return nil, false
			}
			v = x
		case []any:
			i, err := strconv.Atoi(part)
			if err != nil || i < 0 || i >= len(t) {
				return nil, false
			}
			v = t[i]
		default:
			return nil, false
		}
	}
	return v, true
}

func fetchHTTP(p MonPanel) (res HTTPResult) {
	res = HTTPResult{ID: p.ID, At: time.Now().UnixMilli()}
	u, err := url.Parse(p.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		res.Error = "url inválida"
		return
	}
	method := strings.ToUpper(p.Method)
	if method != "POST" && method != "HEAD" {
		method = "GET"
	}
	req, err := http.NewRequest(method, p.URL, nil)
	if err != nil {
		res.Error = "petición inválida"
		return
	}
	req.Header.Set("User-Agent", "pixel-desk-monitor")
	for k, v := range p.Headers {
		req.Header.Set(k, v)
	}
	t0 := time.Now()
	resp, err := httpClient.Do(req)
	res.Latency = time.Since(t0).Milliseconds()
	if err != nil {
		if ue, ok := err.(*url.Error); ok {
			err = ue.Err // sin la URL (puede llevar claves en la query)
		}
		res.Error = err.Error()
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, httpMaxBody))
	res.Status = resp.StatusCode
	if p.Expect == 0 {
		res.OK = resp.StatusCode >= 200 && resp.StatusCode < 300
	} else {
		res.OK = resp.StatusCode == p.Expect
	}
	if !res.OK {
		res.Error = fmt.Sprintf("estado %d", resp.StatusCode)
	}
	val := ""
	if p.Field != "" {
		var doc any
		if err := json.Unmarshal(body, &doc); err != nil {
			res.OK, res.Error = false, "respuesta no es JSON"
		} else if x, ok := jsonPath(doc, p.Field); !ok {
			res.OK, res.Error = false, "campo no encontrado: "+p.Field
		} else if s, ok := x.(string); ok {
			val = s
		} else {
			b, _ := json.Marshal(x)
			val = string(b)
		}
	} else {
		val = string(bytes.TrimSpace(body))
	}
	val = strings.Join(strings.Fields(val), " ")
	if r := []rune(val); len(r) > 200 {
		val = string(r[:200]) + "…"
	}
	res.Value = val
	return
}

// httpResult devuelve el resultado cacheado o consulta si caducó.
func httpResult(p MonPanel, force bool) HTTPResult {
	httpMu.Lock()
	e := httpEntries[p.ID]
	if e == nil {
		e = &httpEntry{}
		httpEntries[p.ID] = e
	}
	httpMu.Unlock()

	iv := p.Interval
	if iv < httpMinSec {
		iv = httpMinSec
	}
	e.mu.Lock() // una sola consulta a la vez por id
	defer e.mu.Unlock()
	age := time.Since(time.UnixMilli(e.res.At))
	// refresco manual: permitido, pero no más de una vez cada 5 s
	if e.done && age < time.Duration(iv)*time.Second && !(force && age > 5*time.Second) {
		return e.res
	}
	r := fetchHTTP(p)
	h := r.Latency
	if !r.OK {
		h = -1
	}
	e.hist = append(e.hist, h)
	if len(e.hist) > 30 {
		e.hist = e.hist[len(e.hist)-30:]
	}
	r.Hist = append([]int64(nil), e.hist...)
	e.res, e.done = r, true
	return r
}

func init() {
	go mon.run()
	extraRoutes = append(extraRoutes, func(mux *http.ServeMux, authed func(http.HandlerFunc) http.HandlerFunc) {
		mux.HandleFunc("/api/monitor/config", authed(func(w http.ResponseWriter, r *http.Request) {
			c := monConfig()
			ps := make([]map[string]any, 0, len(c.Panels))
			for _, p := range c.Panels {
				ps = append(ps, publicPanel(p))
			}
			sendJSON(w, map[string]any{"columns": c.Columns, "rows": c.Rows, "panels": ps})
		}))
		mux.HandleFunc("/api/sys", authed(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			sendJSON(w, mon.snapshot())
		}))
		mux.HandleFunc("/api/monitor/http", authed(func(w http.ResponseWriter, r *http.Request) {
			id := r.URL.Query().Get("id")
			for _, p := range monConfig().Panels {
				if p.Type == "http" && p.ID == id {
					w.Header().Set("Cache-Control", "no-store")
					sendJSON(w, httpResult(p, r.URL.Query().Get("refresh") == "1"))
					return
				}
			}
			http.Error(w, "id desconocido", http.StatusNotFound)
		}))
	})
}
