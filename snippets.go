package main

// Bóveda de comandos (panel "snippets" del cuarto 1).
//
// Los datos viven en $XDG_DATA_HOME/pixel-desk/snippets.json (por defecto
// ~/.local/share/pixel-desk/snippets.json). Si no existe se crea con ejemplos.
// El usuario lo edita a mano; se relee en cada GET, sin reiniciar.
//
// Formato:
//
//	{
//	  "version": 1,
//	  "snippets": [
//	    {
//	      "id":    "ssh",                         // único; es lo que usa /api/snippets/copy
//	      "title": "Conectar por SSH",
//	      "cmd":   "ssh {{usuario}}@{{host}}",    // {{variable}} = hueco que se rellena al copiar
//	      "tags":  ["red", "acceso"],
//	      "desc":  "Texto opcional de ayuda."
//	    }
//	  ]
//	}
//
// Rutas (todas con token):
//
//	GET  /api/snippets                  lista de snippets
//	POST /api/snippets/copy?id=ID       cuerpo opcional {"vars":{"host":"…"}};
//	                                    copia el comando (con variables sustituidas)
//	                                    al portapapeles. NUNCA ejecuta nada y el
//	                                    navegador nunca envía el comando, solo id y valores.
//
// Si el archivo está corrupto se aparta como snippets.json.corrupto-<epoch>
// y se crea uno nuevo con los ejemplos.

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

type snippet struct {
	ID    string   `json:"id"`
	Title string   `json:"title"`
	Cmd   string   `json:"cmd"`
	Tags  []string `json:"tags"`
	Desc  string   `json:"desc"`
}

type snippetsData struct {
	Version  int       `json:"version"`
	Snippets []snippet `json:"snippets"`
}

const snippetMaxValue = 512

var (
	snippetsMu  sync.Mutex
	snippetVarR = regexp.MustCompile(`\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}`)
)

func snippetsPath() string { return filepath.Join(dataDir(), "snippets.json") }

func snippetsDefault() snippetsData {
	s := func(id, title, cmd, desc string, tags ...string) snippet {
		return snippet{ID: id, Title: title, Cmd: cmd, Tags: tags, Desc: desc}
	}
	return snippetsData{Version: 1, Snippets: []snippet{
		s("puertos", "Puertos en escucha", "ss -tulpn", "Sockets TCP/UDP a la escucha y el proceso que los tiene (usa sudo para ver todos).", "red", "diagnóstico"),
		s("logs-servicio", "Últimos logs de un servicio", "journalctl -u {{servicio}} -n 100 --no-pager", "Las 100 últimas líneas del journal de una unidad systemd.", "logs", "systemd", "diagnóstico"),
		s("disco-carpetas", "Uso de disco por carpeta", "du -xh --max-depth=1 {{ruta}} | sort -h", "Qué carpetas ocupan más dentro de una ruta, sin cruzar sistemas de archivos.", "disco", "diagnóstico"),
		s("disco-libre", "Espacio libre en discos", "df -hT -x tmpfs -x devtmpfs", "Particiones montadas con tipo y espacio libre.", "disco", "diagnóstico"),
		s("certificado", "Comprobar certificado TLS", "openssl s_client -connect {{host}}:443 -servername {{host}} </dev/null 2>/dev/null | openssl x509 -noout -dates", "Muestra las fechas de validez del certificado que sirve el host.", "tls", "red", "consulta"),
		s("curl-cabeceras", "Cabeceras HTTP", "curl -sI {{url}}", "Solo las cabeceras de respuesta (código, servidor, redirecciones).", "http", "red", "consulta"),
		s("dig", "Consulta DNS", "dig +short {{dominio}} {{tipo}}", "Resuelve un registro DNS (A, AAAA, MX, TXT…).", "dns", "red", "consulta"),
		s("ssh", "Conectar por SSH", "ssh {{usuario}}@{{host}}", "", "ssh", "acceso", "red"),
		s("rsync", "Sincronizar con rsync", "rsync -avzh --progress {{origen}} {{usuario}}@{{host}}:{{destino}}", "Copia incremental por SSH conservando permisos. Añade --dry-run para ensayar.", "rsync", "despliegue", "archivos"),
		s("docker-ps", "Contenedores en marcha", "docker ps", "Contenedores activos con imagen, estado y puertos.", "docker", "diagnóstico"),
		s("systemctl-status", "Estado de un servicio", "systemctl status {{servicio}} --no-pager", "", "systemd", "diagnóstico"),
		s("systemctl-fallos", "Unidades fallidas", "systemctl --failed --no-pager", "Lista las unidades systemd en estado failed.", "systemd", "diagnóstico"),
	}}
}

// snippetsLoad lee el archivo; si falta lo crea con ejemplos; si está corrupto
// lo aparta (no se pierde) y crea uno nuevo. Llamar con snippetsMu tomado.
func snippetsLoad() (snippetsData, error) {
	raw, err := os.ReadFile(snippetsPath())
	switch {
	case err == nil:
		var d snippetsData
		if json.Unmarshal(raw, &d) == nil {
			if d.Version == 0 {
				d.Version = 1
			}
			clean := []snippet{}
			for _, sn := range d.Snippets {
				if sn.ID == "" || sn.Cmd == "" {
					continue
				}
				if sn.Title == "" {
					sn.Title = sn.ID
				}
				if sn.Tags == nil {
					sn.Tags = []string{}
				}
				clean = append(clean, sn)
			}
			d.Snippets = clean
			return d, nil
		}
		bad := fmt.Sprintf("%s.corrupto-%d", snippetsPath(), time.Now().Unix())
		if rerr := os.Rename(snippetsPath(), bad); rerr != nil {
			return snippetsData{}, rerr
		}
		log.Printf("snippets.json ilegible, apartado en %s", bad)
	case !errors.Is(err, fs.ErrNotExist):
		return snippetsData{}, err
	}
	d := snippetsDefault()
	out, _ := json.MarshalIndent(d, "", "  ")
	if err := writeFileAtomic(snippetsPath(), out); err != nil {
		log.Printf("no se pudo crear snippets.json: %v", err)
	}
	return d, nil
}

// snippetFill sustituye solo las variables presentes en vars; las demás quedan.
func snippetFill(cmd string, vars map[string]string) (string, error) {
	for k, v := range vars {
		if len(v) > snippetMaxValue {
			return "", fmt.Errorf("valor de %q demasiado largo", k)
		}
		if strings.ContainsAny(v, "\r\n") {
			return "", fmt.Errorf("valor de %q con salto de línea", k)
		}
	}
	return snippetVarR.ReplaceAllStringFunc(cmd, func(m string) string {
		name := snippetVarR.FindStringSubmatch(m)[1]
		if v, ok := vars[name]; ok {
			return v
		}
		return m
	}), nil
}

func init() {
	extraRoutes = append(extraRoutes, func(mux *http.ServeMux, authed func(http.HandlerFunc) http.HandlerFunc) {
		mux.HandleFunc("/api/snippets", authed(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet {
				http.Error(w, "metodo no permitido", http.StatusMethodNotAllowed)
				return
			}
			snippetsMu.Lock()
			defer snippetsMu.Unlock()
			d, err := snippetsLoad()
			if err != nil {
				http.Error(w, "no se pudo leer snippets.json", http.StatusInternalServerError)
				return
			}
			sendJSON(w, d)
		}))
		mux.HandleFunc("/api/snippets/copy", authed(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				http.Error(w, "metodo no permitido", http.StatusMethodNotAllowed)
				return
			}
			var body struct {
				Vars map[string]string `json:"vars"`
			}
			raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
			if err != nil {
				http.Error(w, "cuerpo demasiado grande", http.StatusRequestEntityTooLarge)
				return
			}
			if len(strings.TrimSpace(string(raw))) > 0 {
				if err := json.Unmarshal(raw, &body); err != nil {
					http.Error(w, "JSON invalido", http.StatusBadRequest)
					return
				}
			}
			id := r.URL.Query().Get("id")
			snippetsMu.Lock()
			defer snippetsMu.Unlock()
			d, err := snippetsLoad()
			if err != nil {
				http.Error(w, "no se pudo leer snippets.json", http.StatusInternalServerError)
				return
			}
			for _, sn := range d.Snippets {
				if sn.ID != id {
					continue
				}
				out, err := snippetFill(sn.Cmd, body.Vars)
				if err != nil {
					http.Error(w, err.Error(), http.StatusBadRequest)
					return
				}
				copyToClipboard(out)
				sendJSON(w, map[string]any{"ok": true, "copied": out})
				return
			}
			http.Error(w, "snippet no encontrado", http.StatusNotFound)
		}))
	})
}
