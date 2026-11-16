package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLogWeekStartISO(t *testing.T) {
	loc := time.FixedZone("x", -5*3600)
	// domingo 15/11/2026 pertenece a la semana que empieza el lunes 09/11
	s := logWeekStart(time.Date(2026, 11, 15, 23, 0, 0, 0, loc), 0)
	if s.Format("2006-01-02") != "2026-11-09" {
		t.Fatalf("semana actual: %v", s)
	}
	if p := logWeekStart(time.Date(2026, 11, 16, 0, 0, 0, 0, loc), 1); p.Format("2006-01-02") != "2026-11-09" {
		t.Fatalf("semana previa de un lunes: %v", p)
	}
	// 1 de enero de 2027 (viernes) es ISO 2026-W53
	s = logWeekStart(time.Date(2027, 1, 1, 10, 0, 0, 0, loc), 0)
	if n := logReportName(s); n != "bitacora-2026-W53.md" {
		t.Fatalf("nombre: %s", n)
	}
}

func TestLogApplyCorrections(t *testing.T) {
	recs := []logRecord{
		{ID: "a", TS: "2026-11-16T09:00:00-05:00", Text: "uno"},
		{ID: "b", TS: "2026-11-16T09:05:00-05:00", Text: "dos", Tag: "red"},
		{Op: "edit", Ref: "b", TS: "2026-11-16T09:06:00-05:00", Text: "dos bis", Tag: "cambio"},
		{Op: "del", Ref: "a", TS: "2026-11-16T09:07:00-05:00"},
		{Op: "del", Ref: "zz", TS: "2026-11-16T09:07:00-05:00"},
	}
	got := logApply(recs)
	if len(got) != 1 || got[0].ID != "b" || got[0].Text != "dos bis" || got[0].Tag != "cambio" {
		t.Fatalf("%+v", got)
	}
}

func TestLogMarkdown(t *testing.T) {
	loc := time.FixedZone("x", -5*3600)
	start := time.Date(2026, 11, 9, 0, 0, 0, 0, loc)
	es := []logEntry{
		{ID: "1", TS: "2026-11-09T09:42:00-05:00", Text: "reinicié el switch", Tag: "red"},
		{ID: "2", TS: "2026-11-09T10:00:00-05:00", Text: "línea 1\nlínea 2"},
		{ID: "3", TS: "2026-11-11T08:00:00-05:00", Text: "otro", Tag: "red"},
		{ID: "4", TS: "2026-11-16T08:00:00-05:00", Text: "fuera de semana"},
	}
	md := logMarkdown(es, start)
	for _, want := range []string{
		"# Bitácora · Semana 46 de 2026 (09/11/2026 – 15/11/2026)",
		"## Lunes 09/11",
		"- 09:42 · [red] reinicié el switch",
		"  línea 2",
		"## Miércoles 11/11",
		"- Total de entradas: 3",
		"  - red: 2",
		"  - sin etiqueta: 1",
	} {
		if !strings.Contains(md, want) {
			t.Errorf("falta %q en:\n%s", want, md)
		}
	}
	if strings.Contains(md, "fuera de semana") {
		t.Error("entrada fuera de la semana")
	}
}

func TestLogCorruptLineAndAppend(t *testing.T) {
	p := filepath.Join(t.TempDir(), "bitacora.jsonl")
	os.WriteFile(p, []byte(`{"id":"a","ts":"2026-11-16T09:00:00-05:00","text":"ok","tag":""}`+"\nbasura\n{\"id\":\"b\",\"ts\":\"2026"), 0o644)
	if err := logAppend(p, logRecord{ID: "c", TS: "2026-11-16T10:00:00-05:00", Text: "nuevo"}); err != nil {
		t.Fatal(err)
	}
	got, err := logLoad(p)
	if err != nil || len(got) != 2 || got[0].ID != "a" || got[1].ID != "c" {
		t.Fatalf("%v %+v", err, got)
	}
}
