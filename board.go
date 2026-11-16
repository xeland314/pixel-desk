package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Tablero de corcho (cuarto 2): persistencia en $XDG_DATA_HOME/pixel-desk/board.json.
//
// Versión 2: varios espacios (p. ej. TRABAJO y PERSONAL), cada uno con sus
// tres columnas y sus notas fijas. Un board.json de la versión 1 se migra al
// leerlo: sus notas pasan al primer espacio y el original se guarda una sola
// vez como board.v1.json.

type boardCard struct {
	ID      string `json:"id"`
	Text    string `json:"text"`
	Color   string `json:"color"`
	Created int64  `json:"created"`
	Updated int64  `json:"updated"`
}

type boardSpace struct {
	ID      string                 `json:"id"`
	Name    string                 `json:"name"`
	Columns map[string][]boardCard `json:"columns"`
	Pinned  []boardCard            `json:"pinned"`
}

type boardData struct {
	Version int          `json:"version"`
	Current string       `json:"current"`
	Spaces  []boardSpace `json:"spaces"`

	// Solo versión 1 (se leen para migrar; nunca se escriben).
	Columns map[string][]boardCard `json:"columns,omitempty"`
	Pinned  []boardCard            `json:"pinned,omitempty"`
}

const boardMaxSpaces = 9 // uno por tecla 1-9

var (
	boardMu     sync.Mutex
	boardIDRe   = regexp.MustCompile(`[^a-z0-9_-]`)
	boardSpace1 = "trabajo"
)

func boardPath() string { return filepath.Join(dataDir(), "board.json") }

func boardDefault() boardData {
	now := time.Now().UnixMilli()
	return boardData{
		Version: 2,
		Current: boardSpace1,
		Spaces: []boardSpace{
			{
				ID: boardSpace1, Name: "TRABAJO",
				Columns: map[string][]boardCard{
					"todo": {
						{ID: "c1", Text: "Pulsa N para crear una nota", Color: "cream", Created: now, Updated: now},
						{ID: "c2", Text: "W cambia de espacio; M lleva la nota al siguiente", Color: "sand", Created: now, Updated: now},
					},
					"doing": {{ID: "c3", Text: "Probar el tablero", Color: "orange", Created: now, Updated: now}},
					"done":  {},
				},
				Pinned: []boardCard{{ID: "p1", Text: "Info fija: aqui van los datos que no se mueven", Color: "cream", Created: now, Updated: now}},
			},
			{ID: "personal", Name: "PERSONAL"},
		},
	}
}

// boardMigrate convierte la versión 1 (un solo tablero) en la 2. Devuelve
// true si hubo que migrar.
func boardMigrate(b *boardData) bool {
	if b.Version >= 2 || len(b.Spaces) > 0 {
		b.Columns, b.Pinned = nil, nil
		return false
	}
	b.Spaces = []boardSpace{
		{ID: boardSpace1, Name: "TRABAJO", Columns: b.Columns, Pinned: b.Pinned},
		{ID: "personal", Name: "PERSONAL"},
	}
	b.Current = boardSpace1
	b.Columns, b.Pinned = nil, nil
	return true
}

// boardNormalize garantiza al menos un espacio, ids únicos, nombres, las tres
// columnas y pinned en cada uno (nunca null) y un espacio actual válido.
func boardNormalize(b *boardData) {
	boardMigrate(b)
	b.Version = 2
	if len(b.Spaces) > boardMaxSpaces {
		b.Spaces = b.Spaces[:boardMaxSpaces]
	}
	if len(b.Spaces) == 0 {
		b.Spaces = []boardSpace{{ID: boardSpace1, Name: "TRABAJO"}}
	}
	seen := map[string]bool{}
	for i := range b.Spaces {
		s := &b.Spaces[i]
		s.Name = strings.ToUpper(strings.TrimSpace(s.Name))
		if r := []rune(s.Name); len(r) > 24 {
			s.Name = string(r[:24])
		}
		id := boardIDRe.ReplaceAllString(strings.ToLower(s.ID), "")
		if id == "" {
			id = fmt.Sprintf("e%d", i+1)
		}
		base, n := id, 2
		for seen[id] {
			id = fmt.Sprintf("%s-%d", base, n)
			n++
		}
		seen[id] = true
		s.ID = id
		if s.Name == "" {
			s.Name = strings.ToUpper(id)
		}
		if s.Columns == nil {
			s.Columns = map[string][]boardCard{}
		}
		for _, k := range []string{"todo", "doing", "done"} {
			if s.Columns[k] == nil {
				s.Columns[k] = []boardCard{}
			}
		}
		if s.Pinned == nil {
			s.Pinned = []boardCard{}
		}
	}
	if !seen[b.Current] {
		b.Current = b.Spaces[0].ID
	}
}

func init() {
	extraRoutes = append(extraRoutes, func(mux *http.ServeMux, authed func(http.HandlerFunc) http.HandlerFunc) {
		mux.HandleFunc("/api/board", authed(func(w http.ResponseWriter, r *http.Request) {
			boardMu.Lock()
			defer boardMu.Unlock()
			switch r.Method {
			case http.MethodGet:
				b := boardDefault()
				raw, err := os.ReadFile(boardPath())
				switch {
				case err == nil:
					var saved boardData
					if json.Unmarshal(raw, &saved) == nil {
						b = saved
						if b.Version < 2 && len(b.Spaces) == 0 {
							// Copia del original antes de que el siguiente PUT lo reescriba.
							v1 := filepath.Join(dataDir(), "board.v1.json")
							if _, err := os.Stat(v1); errors.Is(err, fs.ErrNotExist) {
								if err := writeFileAtomic(v1, raw); err != nil {
									log.Printf("board: no se pudo guardar la copia v1: %v", err)
								}
							}
						}
					} else {
						// Corrupto: se aparta antes de servir el ejemplo, porque el
						// siguiente PUT lo sobrescribiría y se perderían las notas.
						bad := fmt.Sprintf("%s.corrupto-%d", boardPath(), time.Now().Unix())
						os.Rename(boardPath(), bad)
						log.Printf("board.json ilegible, apartado en %s", bad)
					}
				case !errors.Is(err, fs.ErrNotExist):
					// Existe pero no se puede leer: mejor error que pisarlo.
					http.Error(w, "no se pudo leer el tablero", http.StatusInternalServerError)
					return
				}
				boardNormalize(&b)
				sendJSON(w, b)
			case http.MethodPut:
				raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
				if err != nil {
					http.Error(w, "cuerpo demasiado grande", http.StatusRequestEntityTooLarge)
					return
				}
				var b boardData
				if err := json.Unmarshal(raw, &b); err != nil {
					http.Error(w, "JSON invalido", http.StatusBadRequest)
					return
				}
				boardNormalize(&b)
				out, _ := json.MarshalIndent(b, "", " ")
				if err := writeFileAtomic(boardPath(), out); err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				sendJSON(w, map[string]bool{"ok": true})
			default:
				http.Error(w, "metodo no permitido", http.StatusMethodNotAllowed)
			}
		}))
	})
}
