package main

// Monitor remoto: un panel del cuarto 3 puede mostrar otra máquina en vez de
// esta, leyendo la API de Netdata de esa máquina (nada que instalar en ella).
//
//   monitor.json:
//     "servers": { "ibm": { "name": "IBMSERVER", "netdata": "https://servidor:19999" } }
//     "panels":  [ { "type": "cpu", "title": "IBM CPU", "server": "ibm" }, … ]
//
// /api/sys?server=ibm devuelve la misma forma que /api/sys, con los
// contenedores (cgroups) en lugar de procesos. La URL nunca sale al navegador.
// No hay goroutines: se consulta a Netdata como mucho cada 2 s y solo cuando
// la página lo pide (cuarto 3 visible y sin pausa).

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	ndEvery    = 2 * time.Second
	ndInfoTTL  = 10 * time.Minute
	ndTimeout  = 4 * time.Second
	ndMaxBody  = 4 << 20
	ndFilter   = "system.cpu system.ram system.load system.uptime system.active_processes mem.swap disk_space.* net.* cgroup_*.cpu cgroup_*.mem_usage sensors.*temp*input cpu.cpu*"
	ndMaxProcs = 40
)

type MonServer struct {
	Name    string `json:"name,omitempty"`
	Netdata string `json:"netdata"`
}

type ndChart struct {
	Units      string `json:"units"`
	Dimensions map[string]struct {
		Value *float64 `json:"value"`
	} `json:"dimensions"`
}

type ndInfo struct {
	Mirrored []string `json:"mirrored_hosts"`
	Kernel   string   `json:"kernel_version"`
	OS       string   `json:"os_name"`
	Cores    string   `json:"cores_total"`
	RAM      string   `json:"ram_total"`
	Freq     string   `json:"cpu_freq"`
}

type ndHost struct {
	mu      sync.Mutex
	cfg     MonServer
	info    *ndInfo
	infoAt  time.Time
	last    *Snapshot
	lastErr error
	at      time.Time
	hCPU    []float64
	hMem    []float64
	hNet    map[string][2][]float64
	netMain string
}

var (
	ndMu     sync.Mutex
	ndHosts  = map[string]*ndHost{}
	ndClient = &http.Client{Timeout: ndTimeout}
)

func validNetdataURL(s string) bool {
	u, err := url.Parse(s)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" && u.User == nil
}

func ndHostFor(id string, cfg MonServer) *ndHost {
	ndMu.Lock()
	defer ndMu.Unlock()
	h := ndHosts[id]
	if h == nil {
		h = &ndHost{cfg: cfg, hNet: map[string][2][]float64{}}
		ndHosts[id] = h
	}
	return h
}

func ndGet(base, path string, q url.Values, v any) error {
	u := strings.TrimRight(base, "/") + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "pixel-desk-monitor")
	resp, err := ndClient.Do(req)
	if err != nil {
		return errors.New("sin respuesta de netdata")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("netdata respondió %d", resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, ndMaxBody)).Decode(v); err != nil {
		return errors.New("respuesta de netdata ilegible")
	}
	return nil
}

func (c ndChart) val(dim string) float64 {
	if d, ok := c.Dimensions[dim]; ok && d.Value != nil && !math.IsNaN(*d.Value) {
		return *d.Value
	}
	return 0
}

func (c ndChart) sum(skip ...string) float64 {
	t := 0.0
outer:
	for name, d := range c.Dimensions {
		for _, s := range skip {
			if name == s {
				continue outer
			}
		}
		if d.Value != nil && !math.IsNaN(*d.Value) {
			t += *d.Value
		}
	}
	return t
}

// virtualIface: interfaces que no son la salida real de la máquina.
func virtualIface(n string) bool {
	for _, p := range []string{"lo", "br-", "docker", "veth", "virbr", "tailscale", "tun", "wg"} {
		if strings.HasPrefix(n, p) {
			return true
		}
	}
	return false
}

// ndSnapshot convierte la última lectura de Netdata en un Snapshot.
func ndSnapshot(name string, info *ndInfo, m map[string]ndChart) *Snapshot {
	const mib = 1 << 20
	snap := &Snapshot{T: time.Now().UnixMilli(), Host: name, Kernel: info.Kernel, ProcsKind: "CONTENEDORES"}
	if snap.Host == "" && len(info.Mirrored) > 0 {
		snap.Host = info.Mirrored[0]
	}
	snap.Cores, _ = strconv.Atoi(info.Cores)
	ram, _ := strconv.ParseUint(info.RAM, 10, 64)
	if f, _ := strconv.ParseFloat(info.Freq, 64); f > 0 {
		snap.Model = fmt.Sprintf("%s %.1f GHz", info.OS, f/1e9)
	} else {
		snap.Model = info.OS
	}

	if c, ok := m["system.cpu"]; ok {
		snap.CPU = round1(clamp(c.sum("idle"), 0, 100))
	}
	for i := 0; ; i++ {
		c, ok := m["cpu.cpu"+strconv.Itoa(i)]
		if !ok {
			break
		}
		snap.CPUCores = append(snap.CPUCores, round1(clamp(c.sum("idle"), 0, 100)))
	}
	if snap.CPUCores == nil {
		snap.CPUCores = []float64{}
	}
	if c, ok := m["system.ram"]; ok {
		used, cache := c.val("used"), c.val("cached")+c.val("buffers")
		snap.MemUsed = uint64(used * mib)
		snap.MemCache = uint64(cache * mib)
		if ram == 0 {
			ram = uint64(c.sum() * mib)
		}
	}
	snap.MemTotal = ram
	if c, ok := m["mem.swap"]; ok {
		snap.SwapUsed = uint64(c.val("used") * mib)
		snap.SwapTot = uint64(c.sum() * mib)
	}
	if c, ok := m["system.load"]; ok {
		snap.Load = [3]float64{c.val("load1"), c.val("load5"), c.val("load15")}
	}
	if c, ok := m["system.uptime"]; ok {
		snap.Uptime = c.val("uptime")
	}
	if c, ok := m["system.active_processes"]; ok {
		snap.NProcs = int(c.val("active"))
	}

	var temp float64
	snap.Net, snap.Disks = []NetIf{}, []DiskInfo{}
	for k, c := range m {
		switch {
		case strings.HasPrefix(k, "net."):
			// kilobits/s; "sent" llega en negativo
			snap.Net = append(snap.Net, NetIf{
				Name:  strings.TrimPrefix(k, "net."),
				RxBps: math.Abs(c.val("received")) * 1000 / 8,
				TxBps: math.Abs(c.val("sent")) * 1000 / 8,
			})
		case strings.HasPrefix(k, "disk_space."):
			const gib = 1 << 30
			used := (c.val("used") + c.val("reserved_for_root")) * gib
			snap.Disks = append(snap.Disks, DiskInfo{
				Mount: strings.TrimPrefix(k, "disk_space."),
				Total: uint64(used + c.val("avail")*gib),
				Used:  uint64(used),
			})
		case strings.HasPrefix(k, "sensors.") && strings.Contains(c.Units, "Celsius"):
			temp = math.Max(temp, c.sum())
		case strings.HasPrefix(k, "cgroup_") && strings.HasSuffix(k, ".cpu"):
			name := strings.TrimSuffix(strings.TrimPrefix(k, "cgroup_"), ".cpu")
			p := ProcInfo{Name: name, CPU: round1(c.sum())}
			if mem, ok := m["cgroup_"+name+".mem_usage"]; ok && ram > 0 {
				p.Mem = round1(100 * mem.val("ram") * mib / float64(ram))
			}
			snap.ProcsCPU = append(snap.ProcsCPU, p)
		}
	}
	if temp > 0 {
		snap.Temp = &temp
	}
	sort.Slice(snap.Net, func(i, j int) bool { return snap.Net[i].Name < snap.Net[j].Name })
	sort.Slice(snap.Disks, func(i, j int) bool { return snap.Disks[i].Mount < snap.Disks[j].Mount })

	snap.ProcsMem = append([]ProcInfo(nil), snap.ProcsCPU...)
	sort.Slice(snap.ProcsCPU, func(i, j int) bool {
		a, b := snap.ProcsCPU[i], snap.ProcsCPU[j]
		return a.CPU > b.CPU || (a.CPU == b.CPU && a.Name < b.Name)
	})
	sort.Slice(snap.ProcsMem, func(i, j int) bool {
		a, b := snap.ProcsMem[i], snap.ProcsMem[j]
		return a.Mem > b.Mem || (a.Mem == b.Mem && a.Name < b.Name)
	})
	if len(snap.ProcsCPU) > ndMaxProcs {
		snap.ProcsCPU, snap.ProcsMem = snap.ProcsCPU[:ndMaxProcs], snap.ProcsMem[:ndMaxProcs]
	}
	if snap.ProcsCPU == nil {
		snap.ProcsCPU, snap.ProcsMem = []ProcInfo{}, []ProcInfo{}
	}
	return snap
}

// snapshot devuelve la última lectura; si tiene más de ndEvery, pide otra.
func (h *ndHost) snapshot() (*Snapshot, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.last != nil && time.Since(h.at) < ndEvery || h.lastErr != nil && time.Since(h.at) < ndEvery {
		return h.last, h.lastErr
	}
	h.at = time.Now()
	h.last, h.lastErr = h.fetch()
	return h.last, h.lastErr
}

func (h *ndHost) fetch() (*Snapshot, error) {
	if h.info == nil || time.Since(h.infoAt) > ndInfoTTL {
		var info ndInfo
		if err := ndGet(h.cfg.Netdata, "/api/v1/info", nil, &info); err != nil {
			return nil, err
		}
		h.info, h.infoAt = &info, time.Now()
	}
	var m map[string]ndChart
	q := url.Values{"format": {"json"}, "filter": {ndFilter}}
	if err := ndGet(h.cfg.Netdata, "/api/v1/allmetrics", q, &m); err != nil {
		return nil, err
	}
	snap := ndSnapshot(h.cfg.Name, h.info, m)

	// Interfaz principal: la física con más tráfico, y se queda fija.
	if h.netMain == "" || !hasIface(snap.Net, h.netMain) {
		best, bestV := "", -1.0
		for _, n := range snap.Net {
			if !virtualIface(n.Name) && n.RxBps+n.TxBps > bestV {
				best, bestV = n.Name, n.RxBps+n.TxBps
			}
		}
		h.netMain = best
	}
	snap.NetMain = h.netMain

	h.hCPU = push(h.hCPU, snap.CPU)
	mp := 0.0
	if snap.MemTotal > 0 {
		mp = round1(100 * float64(snap.MemUsed) / float64(snap.MemTotal))
	}
	h.hMem = push(h.hMem, mp)
	nh := map[string]any{}
	for _, n := range snap.Net {
		if virtualIface(n.Name) && n.Name != h.netMain {
			continue // los puentes de docker no se dibujan: no hace falta su historial
		}
		hn := h.hNet[n.Name]
		hn[0] = push(hn[0], float64(int64(n.RxBps)))
		hn[1] = push(hn[1], float64(int64(n.TxBps)))
		h.hNet[n.Name] = hn
		nh[n.Name] = map[string][]float64{"rx": append([]float64(nil), hn[0]...), "tx": append([]float64(nil), hn[1]...)}
	}
	snap.Hist = map[string]any{
		"cpu": append([]float64(nil), h.hCPU...),
		"mem": append([]float64(nil), h.hMem...),
		"net": nh,
	}
	return snap, nil
}

func hasIface(ns []NetIf, name string) bool {
	for _, n := range ns {
		if n.Name == name {
			return true
		}
	}
	return false
}
