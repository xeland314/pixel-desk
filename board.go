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
	"sync"
	"time"
)

// Tablero de corcho (cuarto 2): persistencia en $XDG_DATA_HOME/pixel-desk/board.json.

type boardCard struct {
	ID      string `json:"id"`
	Text    string `json:"text"`
	Color   string `json:"color"`
	Created int64  `json:"created"`
	Updated int64  `json:"updated"`
}

type boardData struct {
	Version int                    `json:"version"`
	Columns map[string][]boardCard `json:"columns"`
	Pinned  []boardCard            `json:"pinned"`
}

var boardMu sync.Mutex

func boardPath() string { return filepath.Join(dataDir(), "board.json") }

func boardDefault() boardData {
	now := time.Now().UnixMilli()
	return boardData{
		Version: 1,
		Columns: map[string][]boardCard{
			"todo": {
				{ID: "c1", Text: "Pulsa N para crear una nota", Color: "cream", Created: now, Updated: now},
				{ID: "c2", Text: "Arrastra las notas entre columnas", Color: "sand", Created: now, Updated: now},
			},
			"doing": {{ID: "c3", Text: "Probar el tablero", Color: "orange", Created: now, Updated: now}},
			"done":  {},
		},
		Pinned: []boardCard{{ID: "p1", Text: "Info fija: aqui van los datos que no se mueven", Color: "cream", Created: now, Updated: now}},
	}
}

// boardNormalize garantiza que las tres columnas y pinned existan (nunca null).
func boardNormalize(b *boardData) {
	if b.Columns == nil {
		b.Columns = map[string][]boardCard{}
	}
	for _, k := range []string{"todo", "doing", "done"} {
		if b.Columns[k] == nil {
			b.Columns[k] = []boardCard{}
		}
	}
	if b.Pinned == nil {
		b.Pinned = []boardCard{}
	}
	if b.Version == 0 {
		b.Version = 1
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
