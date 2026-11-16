package main

// Tocadiscos ↔ reproductor del sistema por MPRIS (D-Bus), usando dbus-send:
// sin dependencias nuevas ni playerctl. Solo se consulta cuando la página lo
// pide (cuarto 1 visible y tocadiscos seleccionado); no hay nada en segundo plano.
//
//   GET  /api/music            → {"player","status","title","artist"} (player "" si no hay)
//   POST /api/music?cmd=playpause|next|previous

import (
	"bufio"
	"context"
	"net/http"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

const mprisPrefix = "org.mpris.MediaPlayer2."

var (
	dbusString = regexp.MustCompile(`^\s*string "(.*)"\s*$`)
	dbusStatus = regexp.MustCompile(`string "([A-Za-z]+)"\s*$`)
	// Valor de un campo: puede venir solo ("string …") o tras "variant".
	dbusValue = regexp.MustCompile(`^\s*(?:variant\s+)?string "(.*)"\s*$`)
)

func dbusCall(args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "dbus-send", append([]string{"--session", "--print-reply"}, args...)...).Output()
	return string(out), err
}

// mprisPlayer elige el reproductor: Spotify si está, si no el primero que haya.
func mprisPlayer() string {
	out, err := dbusCall("--dest=org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.ListNames")
	if err != nil {
		return ""
	}
	var first string
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		m := dbusString.FindStringSubmatch(sc.Text())
		if m == nil || !strings.HasPrefix(m[1], mprisPrefix) {
			continue
		}
		if m[1] == mprisPrefix+"spotify" {
			return m[1]
		}
		if first == "" {
			first = m[1]
		}
	}
	return first
}

func mprisGet(player, prop string) (string, error) {
	return dbusCall("--dest="+player, "/org/mpris/MediaPlayer2",
		"org.freedesktop.DBus.Properties.Get", "string:org.mpris.MediaPlayer2.Player", "string:"+prop)
}

// mprisField devuelve la primera cadena que sigue a la clave en la salida de dbus-send.
func mprisField(out, key string) string {
	lines := strings.Split(out, "\n")
	for i, l := range lines {
		if !strings.Contains(l, `"`+key+`"`) {
			continue
		}
		for _, next := range lines[i+1 : min(i+5, len(lines))] {
			if m := dbusValue.FindStringSubmatch(next); m != nil {
				return m[1]
			}
		}
	}
	return ""
}

func init() {
	extraRoutes = append(extraRoutes, func(mux *http.ServeMux, authed func(http.HandlerFunc) http.HandlerFunc) {
		mux.HandleFunc("/api/music", authed(func(w http.ResponseWriter, r *http.Request) {
			player := mprisPlayer()
			switch r.Method {
			case http.MethodGet:
				res := map[string]string{"player": "", "status": "", "title": "", "artist": ""}
				if player != "" {
					res["player"] = strings.TrimPrefix(player, mprisPrefix)
					if st, err := mprisGet(player, "PlaybackStatus"); err == nil {
						if m := dbusStatus.FindStringSubmatch(strings.TrimSpace(st)); m != nil {
							res["status"] = m[1] // Playing | Paused | Stopped
						}
					}
					if md, err := mprisGet(player, "Metadata"); err == nil {
						res["title"] = mprisField(md, "xesam:title")
						res["artist"] = mprisField(md, "xesam:artist")
					}
				}
				sendJSON(w, res)
			case http.MethodPost:
				method := map[string]string{"playpause": "PlayPause", "next": "Next", "previous": "Previous"}[r.URL.Query().Get("cmd")]
				if method == "" {
					http.Error(w, "cmd desconocido", http.StatusBadRequest)
					return
				}
				if player == "" {
					http.Error(w, "sin reproductor", http.StatusNotFound)
					return
				}
				if _, err := dbusCall("--dest="+player, "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player."+method); err != nil {
					http.Error(w, "dbus: "+err.Error(), http.StatusBadGateway)
					return
				}
				w.WriteHeader(http.StatusNoContent)
			default:
				http.Error(w, "metodo no permitido", http.StatusMethodNotAllowed)
			}
		}))
	})
}
