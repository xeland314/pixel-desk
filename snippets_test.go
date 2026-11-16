package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSnippetFill(t *testing.T) {
	got, err := snippetFill("ssh {{usuario}}@{{ host }} {{otro}}", map[string]string{"usuario": "u", "host": "h", "sobra": "x"})
	if err != nil || got != "ssh u@h {{otro}}" {
		t.Fatalf("got %q, %v", got, err)
	}
	if _, err := snippetFill("a", map[string]string{"x": "a\nb"}); err == nil {
		t.Fatal("debía rechazar salto de línea")
	}
	if _, err := snippetFill("a", map[string]string{"x": strings.Repeat("a", 513)}); err == nil {
		t.Fatal("debía rechazar valor largo")
	}
}

func TestSnippetsCorrupto(t *testing.T) {
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	os.WriteFile(snippetsPath(), []byte("{roto"), 0o644)
	d, err := snippetsLoad()
	if err != nil || len(d.Snippets) < 5 {
		t.Fatalf("defecto no servido: %v", err)
	}
	m, _ := filepath.Glob(snippetsPath() + ".corrupto-*")
	if len(m) != 1 {
		t.Fatalf("archivo corrupto no apartado: %v", m)
	}
}
