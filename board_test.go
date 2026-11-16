package main

import (
	"encoding/json"
	"testing"
)

func TestBoardMigraV1(t *testing.T) {
	raw := `{"version":1,"columns":{"todo":[{"id":"a","text":"x"}],"doing":[]},"pinned":[{"id":"p","text":"fija"}]}`
	var b boardData
	if err := json.Unmarshal([]byte(raw), &b); err != nil {
		t.Fatal(err)
	}
	boardNormalize(&b)
	if b.Version != 2 || len(b.Spaces) != 2 || b.Current != "trabajo" {
		t.Fatalf("migración: %+v", b)
	}
	s := b.Spaces[0]
	if len(s.Columns["todo"]) != 1 || s.Columns["todo"][0].Text != "x" || len(s.Pinned) != 1 {
		t.Fatalf("se perdieron notas: %+v", s)
	}
	if b.Spaces[1].Columns["done"] == nil || b.Spaces[1].Pinned == nil {
		t.Fatal("el espacio nuevo debe tener columnas vacías, no null")
	}
	out, _ := json.Marshal(b)
	var back map[string]any
	json.Unmarshal(out, &back)
	if _, ok := back["columns"]; ok {
		t.Fatal("la v2 no debe escribir columns de primer nivel")
	}
}

func TestBoardNormalizaEspacios(t *testing.T) {
	b := boardData{Version: 2, Current: "nada", Spaces: []boardSpace{
		{ID: "Casa!", Name: " casa "}, {ID: "casa", Name: ""}, {ID: "", Name: "x"},
	}}
	boardNormalize(&b)
	ids := []string{b.Spaces[0].ID, b.Spaces[1].ID, b.Spaces[2].ID}
	if ids[0] != "casa" || ids[1] != "casa-2" || ids[2] != "e3" {
		t.Fatalf("ids: %v", ids)
	}
	if b.Spaces[0].Name != "CASA" || b.Spaces[1].Name != "CASA-2" {
		t.Fatalf("nombres: %q %q", b.Spaces[0].Name, b.Spaces[1].Name)
	}
	if b.Current != "casa" {
		t.Fatalf("current inválido no corregido: %q", b.Current)
	}
	vacio := boardData{Version: 2}
	boardNormalize(&vacio)
	if len(vacio.Spaces) != 1 {
		t.Fatal("debe quedar al menos un espacio")
	}
}
