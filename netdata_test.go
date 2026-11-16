package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const ndFake = `{
 "system.cpu": {"units":"percentage","dimensions":{"user":{"value":20},"system":{"value":5},"idle":{"value":75}}},
 "system.ram": {"units":"MiB","dimensions":{"used":{"value":1024},"cached":{"value":512},"buffers":{"value":0},"free":{"value":512}}},
 "mem.swap": {"units":"MiB","dimensions":{"used":{"value":256},"free":{"value":768}}},
 "system.load": {"units":"load","dimensions":{"load1":{"value":1.5},"load5":{"value":1},"load15":{"value":0.5}}},
 "system.uptime": {"units":"seconds","dimensions":{"uptime":{"value":3600}}},
 "system.active_processes": {"units":"processes","dimensions":{"active":{"value":321}}},
 "disk_space./": {"units":"GiB","dimensions":{"avail":{"value":6},"used":{"value":3},"reserved_for_root":{"value":1}}},
 "net.eth0": {"units":"kilobits/s","dimensions":{"received":{"value":800},"sent":{"value":-80}}},
 "net.docker0": {"units":"kilobits/s","dimensions":{"received":{"value":9000},"sent":{"value":-9000}}},
 "sensors.temperature_core0_input": {"units":"degrees Celsius","dimensions":{"input":{"value":47}}},
 "cgroup_web.cpu": {"units":"percentage","dimensions":{"user":{"value":10},"system":{"value":2}}},
 "cgroup_web.mem_usage": {"units":"MiB","dimensions":{"ram":{"value":205.2},"swap":{"value":0}}},
 "cgroup_db.cpu": {"units":"percentage","dimensions":{"user":{"value":1},"system":{"value":0}}},
 "cgroup_db.mem_usage": {"units":"MiB","dimensions":{"ram":{"value":410.4},"swap":{"value":0}}}
}`

func TestNetdataSnapshot(t *testing.T) {
	var m map[string]ndChart
	if err := json.Unmarshal([]byte(ndFake), &m); err != nil {
		t.Fatal(err)
	}
	info := &ndInfo{Mirrored: []string{"srv"}, Kernel: "6.1", OS: "Debian", Cores: "4", RAM: "2147483648", Freq: "2000000000"}
	s := ndSnapshot("", info, m)
	if s.Host != "srv" || s.Cores != 4 || s.CPU != 25 || s.Model != "Debian 2.0 GHz" {
		t.Fatalf("básicos: %+v", s)
	}
	if s.MemUsed != 1<<30 || s.MemTotal != 2<<30 || s.MemCache != 512<<20 || s.SwapTot != 1<<30 {
		t.Fatalf("memoria: used=%d total=%d cache=%d swap=%d", s.MemUsed, s.MemTotal, s.MemCache, s.SwapTot)
	}
	if len(s.Disks) != 1 || s.Disks[0].Total != 10<<30 || s.Disks[0].Used != 4<<30 {
		t.Fatalf("disco: %+v", s.Disks)
	}
	if s.Temp == nil || *s.Temp != 47 || s.NProcs != 321 || s.Load[0] != 1.5 {
		t.Fatalf("temp/procs/load: %+v", s)
	}
	if s.ProcsKind != "CONTENEDORES" || s.ProcsCPU[0].Name != "web" || s.ProcsMem[0].Name != "db" || s.ProcsMem[0].Mem != 20 {
		t.Fatalf("contenedores: %+v / %+v", s.ProcsCPU, s.ProcsMem)
	}
	for _, n := range s.Net {
		if n.Name == "eth0" && (n.RxBps != 100000 || n.TxBps != 10000) {
			t.Fatalf("red: %+v", n)
		}
	}
}

func TestNetdataHostSinFiltrarURL(t *testing.T) {
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		switch r.URL.Path {
		case "/api/v1/info":
			w.Write([]byte(`{"mirrored_hosts":["srv"],"cores_total":"2","ram_total":"1073741824"}`))
		case "/api/v1/allmetrics":
			if r.URL.Query().Get("format") != "json" || !strings.Contains(r.URL.Query().Get("filter"), "system.cpu") {
				http.Error(w, "filtro", 400)
				return
			}
			w.Write([]byte(ndFake))
		}
	}))
	defer srv.Close()
	h := &ndHost{cfg: MonServer{Name: "MIO", Netdata: srv.URL}, hNet: map[string][2][]float64{}}
	s, err := h.snapshot()
	if err != nil || s.Host != "MIO" || s.NetMain != "eth0" {
		t.Fatalf("snapshot: %v %+v", err, s)
	}
	if _, err := h.snapshot(); err != nil || calls != 2 {
		t.Fatalf("debe reutilizar la lectura reciente: calls=%d err=%v", calls, err)
	}
	srv.Close()
	bad := &ndHost{cfg: MonServer{Netdata: srv.URL + "/?token=secreto"}, hNet: map[string][2][]float64{}}
	if _, err := bad.snapshot(); err == nil || strings.Contains(err.Error(), "secreto") || strings.Contains(err.Error(), "127.0.0.1") {
		t.Fatalf("el error no debe filtrar la URL: %v", err)
	}
	if validNetdataURL("ftp://x") || validNetdataURL("https://user:pw@x") || !validNetdataURL("https://x:19999") {
		t.Fatal("validNetdataURL")
	}
}
