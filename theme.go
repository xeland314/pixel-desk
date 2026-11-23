package main

// Claro/oscuro: la tecla T de la escena avisa aquí (POST /api/theme?mode=…).
// Se recuerda la elección en $XDG_DATA_HOME/pixel-desk/theme para el próximo
// arranque y, si el tema del sistema se aplicó con theme/theme.py, se cambia
// también (LXQt, pcmanfm-qt, panel, rofi y marcos de xfwm4) con
// `theme.py switch light|dark`. Solo se aceptan esos dos valores.

import (
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func validTheme(t string) bool { return t == "light" || t == "dark" }

func themeFile() string { return filepath.Join(dataDir(), "theme") }

// savedTheme devuelve el último tema elegido con T, o "" si no hay.
func savedTheme() string {
	b, err := os.ReadFile(themeFile())
	if err != nil {
		return ""
	}
	t := strings.TrimSpace(string(b))
	if !validTheme(t) {
		return ""
	}
	return t
}

// themeScript localiza theme/theme.py junto al ejecutable (o en el
// directorio actual) y solo lo devuelve si el tema del sistema está aplicado
// (existe la copia de seguridad que deja `theme.py apply`).
func themeScript() string {
	var dirs []string
	if exe, err := os.Executable(); err == nil {
		dirs = append(dirs, filepath.Dir(exe))
	}
	if wd, err := os.Getwd(); err == nil {
		dirs = append(dirs, wd)
	}
	for _, d := range dirs {
		script := filepath.Join(d, "theme", "theme.py")
		if _, err := os.Stat(filepath.Join(d, "theme", "backup", "lxqt.conf")); err == nil {
			if _, err := os.Stat(script); err == nil {
				return script
			}
		}
	}
	return ""
}

func switchSystemTheme(mode string) {
	script := themeScript()
	if script == "" {
		return
	}
	cmd := exec.Command("python3", script, "switch", mode)
	cmd.Dir = filepath.Dir(filepath.Dir(script))
	if out, err := cmd.CombinedOutput(); err != nil {
		log.Printf("theme.py switch %s: %v: %s", mode, err, strings.TrimSpace(string(out)))
		return
	}
	log.Printf("tema del sistema: %s", mode)
}

func init() {
	extraRoutes = append(extraRoutes, func(mux *http.ServeMux, authed func(http.HandlerFunc) http.HandlerFunc) {
		mux.HandleFunc("/api/theme", authed(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				http.Error(w, "POST", http.StatusMethodNotAllowed)
				return
			}
			mode := r.URL.Query().Get("mode")
			if !validTheme(mode) {
				http.Error(w, "mode", http.StatusBadRequest)
				return
			}
			if err := writeFileAtomic(themeFile(), []byte(mode+"\n")); err != nil {
				log.Printf("no se pudo guardar el tema: %v", err)
			}
			go switchSystemTheme(mode)
			w.WriteHeader(http.StatusNoContent)
		}))
	})
}
