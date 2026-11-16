package main

import (
	"testing"
	"time"
)

func TestSample(t *testing.T) {
	s := &sampler{
		prevCPU:   map[string]cpuTimes{},
		prevNet:   map[string][2]uint64{},
		prevProcs: map[int]uint64{},
		hNet:      map[string][2][]float64{},
	}
	s.sample()
	time.Sleep(300 * time.Millisecond)
	s.sample()
	l := s.last
	if l.MemTotal == 0 || l.Cores == 0 || l.Host == "" || l.NProcs == 0 {
		t.Fatalf("instantánea incompleta: %+v", l)
	}
	if l.CPU < 0 || l.CPU > 100 || len(l.CPUCores) != l.Cores {
		t.Fatalf("cpu fuera de rango: %v %v", l.CPU, l.CPUCores)
	}
	if len(l.ProcsCPU) == 0 || len(l.ProcsMem) == 0 {
		t.Fatal("sin procesos")
	}
}

func TestJSONPath(t *testing.T) {
	doc := map[string]any{"data": map[string]any{"price": 4.5, "list": []any{"a", "b"}}}
	if v, ok := jsonPath(doc, "data.price"); !ok || v != 4.5 {
		t.Fatal("data.price", v, ok)
	}
	if v, ok := jsonPath(doc, "data.list.1"); !ok || v != "b" {
		t.Fatal("data.list.1", v, ok)
	}
	if _, ok := jsonPath(doc, "data.nada"); ok {
		t.Fatal("debería faltar")
	}
}

func BenchmarkSample(b *testing.B) {
	s := &sampler{
		prevCPU:   map[string]cpuTimes{},
		prevNet:   map[string][2]uint64{},
		prevProcs: map[int]uint64{},
		hNet:      map[string][2][]float64{},
	}
	for i := 0; i < b.N; i++ {
		s.sample()
	}
}
