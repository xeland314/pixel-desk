package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Bitácora rápida (panel del caballete): registro append-only en
// $XDG_DATA_HOME/pixel-desk/bitacora.jsonl. Cada línea es una entrada
// {"id","ts","text","tag"} o una corrección {"op":"edit"|"del","ref","ts",…}
// que se aplica al leer. El archivo nunca se reescribe.

const (
	logMaxText   = 4000
	logFixWindow = 15 * time.Minute
	logMaxBody   = 64 << 10
)

type logEntry struct {
	ID     string `json:"id"`
	TS     string `json:"ts"`
	Text   string `json:"text"`
	Tag    string `json:"tag"`
	Edited bool   `json:"edited,omitempty"`
}

// logRecord es una línea cruda del archivo (entrada o corrección).
type logRecord struct {
	Op   string `json:"op,omitempty"`
	Ref  string `json:"ref,omitempty"`
	ID   string `json:"id,omitempty"`
	TS   string `json:"ts"`
	Text string `json:"text"`
	Tag  string `json:"tag"`
}

var (
	logMu     sync.Mutex
	logLastID string
	logTagRe  = regexp.MustCompile(`^[a-z0-9_-]{1,24}$`)
	// Sustituible en pruebas: copyToClipboard necesita el bucle GTK.
	logClipboard = copyToClipboard
)

func logPath() string { return filepath.Join(dataDir(), "bitacora.jsonl") }

// logNewID da un id base36 basado en el reloj, siempre creciente.
func logNewID(now time.Time) string {
	n := now.UnixNano()
	if last, err := strconv.ParseInt(logLastID, 36, 64); err == nil && n <= last {
		n = last + 1
	}
	logLastID = strconv.FormatInt(n, 36)
	return logLastID
}

// logAppend añade una línea completa de un solo Write y la sincroniza.
// Si el archivo terminó sin salto de línea (corte a mitad de escritura), lo
// añade antes para no pegar la nueva línea a una corrupta.
func logAppend(path string, rec logRecord) error {
	b, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	if st, err := f.Stat(); err == nil && st.Size() > 0 {
		if r, err := os.Open(path); err == nil {
			last := make([]byte, 1)
			if _, err := r.ReadAt(last, st.Size()-1); err == nil && last[0] != '\n' {
				b = append([]byte{'\n'}, b...)
			}
			r.Close()
		}
	}
	if _, err := f.Write(b); err != nil {
		return err
	}
	return f.Sync()
}

// logReadRecords lee todas las líneas válidas; las corruptas se ignoran.
func logReadRecords(path string) ([]logRecord, error) {
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []logRecord
	br := bufio.NewReader(f)
	for n := 1; ; n++ {
		line, err := br.ReadBytes('\n')
		if s := strings.TrimSpace(string(line)); s != "" {
			var rec logRecord
			if json.Unmarshal([]byte(s), &rec) != nil || rec.TS == "" || (rec.Op == "" && rec.ID == "") || (rec.Op != "" && rec.Ref == "") {
				log.Printf("bitacora.jsonl: línea %d corrupta, se ignora", n)
			} else {
				out = append(out, rec)
			}
		}
		if err != nil {
			if err != io.EOF {
				return out, err
			}
			break
		}
	}
	return out, nil
}

// logApply resuelve las correcciones y devuelve las entradas vivas en orden
// de escritura. Una corrección solo cuenta si su ref existe.
func logApply(recs []logRecord) []logEntry {
	var order []string
	byID := map[string]*logEntry{}
	for _, r := range recs {
		switch r.Op {
		case "":
			if _, dup := byID[r.ID]; dup {
				continue
			}
			byID[r.ID] = &logEntry{ID: r.ID, TS: r.TS, Text: r.Text, Tag: r.Tag}
			order = append(order, r.ID)
		case "edit":
			if e := byID[r.Ref]; e != nil {
				e.Text, e.Tag, e.Edited = r.Text, r.Tag, true
			}
		case "del":
			delete(byID, r.Ref)
		}
	}
	out := make([]logEntry, 0, len(byID))
	for _, id := range order {
		if e := byID[id]; e != nil {
			out = append(out, *e)
		}
	}
	return out
}

func logLoad(path string) ([]logEntry, error) {
	recs, err := logReadRecords(path)
	if err != nil {
		return nil, err
	}
	return logApply(recs), nil
}

func logCleanTag(t string) string {
	t = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(t), "#"))
	if logTagRe.MatchString(t) {
		return t
	}
	return ""
}

func logCleanText(t string) (string, bool) {
	t = strings.TrimSpace(strings.ReplaceAll(t, "\r\n", "\n"))
	if t == "" || utf8.RuneCountInString(t) > logMaxText {
		return "", false
	}
	return t, true
}

// ── Semana y Markdown ────────────────────────────────────────────────────────

// logWeekStart devuelve el lunes 00:00 de la semana (ISO) de now, retrocedido
// back semanas.
func logWeekStart(now time.Time, back int) time.Time {
	wd := int(now.Weekday()+6) % 7 // lunes = 0
	return time.Date(now.Year(), now.Month(), now.Day()-wd-7*back, 0, 0, 0, 0, now.Location())
}

var logDias = [...]string{"Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"}

// logMarkdown genera el informe de la semana que empieza en start (lunes).
func logMarkdown(entries []logEntry, start time.Time) string {
	loc := start.Location()
	end := start.AddDate(0, 0, 7)
	type item struct {
		t time.Time
		e logEntry
	}
	var items []item
	for _, e := range entries {
		t, err := time.Parse(time.RFC3339, e.TS)
		if err != nil {
			continue
		}
		t = t.In(loc)
		if !t.Before(start) && t.Before(end) {
			items = append(items, item{t, e})
		}
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].t.Before(items[j].t) })

	yr, wk := start.ISOWeek()
	last := end.AddDate(0, 0, -1)
	var b strings.Builder
	fmt.Fprintf(&b, "# Bitácora · Semana %02d de %d (%s – %s)\n\n", wk, yr, start.Format("02/01/2006"), last.Format("02/01/2006"))
	if len(items) == 0 {
		b.WriteString("_Sin entradas esta semana._\n")
		return b.String()
	}
	counts := map[string]int{}
	day := ""
	for _, it := range items {
		if d := it.t.Format("2006-01-02"); d != day {
			if day != "" {
				b.WriteString("\n")
			}
			day = d
			fmt.Fprintf(&b, "## %s %s\n\n", logDias[it.t.Weekday()], it.t.Format("02/01"))
		}
		lines := strings.Split(it.e.Text, "\n")
		prefix := fmt.Sprintf("- %s · ", it.t.Format("15:04"))
		if it.e.Tag != "" {
			prefix += "[" + it.e.Tag + "] "
		}
		counts[it.e.Tag]++
		b.WriteString(prefix + lines[0] + "\n")
		for _, l := range lines[1:] {
			if strings.TrimSpace(l) == "" {
				b.WriteString("\n")
			} else {
				b.WriteString("  " + l + "\n")
			}
		}
	}
	fmt.Fprintf(&b, "\n## Resumen\n\n- Total de entradas: %d\n- Por etiqueta:\n", len(items))
	tags := make([]string, 0, len(counts))
	for t := range counts {
		tags = append(tags, t)
	}
	sort.Slice(tags, func(i, j int) bool {
		if counts[tags[i]] != counts[tags[j]] {
			return counts[tags[i]] > counts[tags[j]]
		}
		return tags[i] < tags[j]
	})
	for _, t := range tags {
		name := t
		if t == "" {
			name = "sin etiqueta"
		}
		fmt.Fprintf(&b, "  - %s: %d\n", name, counts[t])
	}
	return b.String()
}

func logReportName(start time.Time) string {
	y, w := start.ISOWeek()
	return fmt.Sprintf("bitacora-%d-W%02d.md", y, w)
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

func init() {
	extraRoutes = append(extraRoutes, func(mux *http.ServeMux, authed func(http.HandlerFunc) http.HandlerFunc) {
		decode := func(w http.ResponseWriter, r *http.Request, v any) bool {
			if r.Method != http.MethodPost {
				http.Error(w, "metodo no permitido", http.StatusMethodNotAllowed)
				return false
			}
			raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, logMaxBody))
			if err != nil {
				http.Error(w, "cuerpo demasiado grande", http.StatusRequestEntityTooLarge)
				return false
			}
			if json.Unmarshal(raw, v) != nil {
				http.Error(w, "JSON invalido", http.StatusBadRequest)
				return false
			}
			return true
		}

		mux.HandleFunc("/api/log", authed(func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodGet:
				days := 14
				if v := r.URL.Query().Get("days"); v != "" {
					n, err := strconv.Atoi(v)
					if err != nil || n < 1 {
						http.Error(w, "days invalido", http.StatusBadRequest)
						return
					}
					days = min(n, 366)
				}
				logMu.Lock()
				all, err := logLoad(logPath())
				logMu.Unlock()
				if err != nil {
					http.Error(w, "no se pudo leer la bitacora", http.StatusInternalServerError)
					return
				}
				now := time.Now()
				from := time.Date(now.Year(), now.Month(), now.Day()-(days-1), 0, 0, 0, 0, now.Location())
				out := make([]logEntry, 0, len(all))
				for _, e := range all {
					if t, err := time.Parse(time.RFC3339, e.TS); err == nil && !t.Before(from) {
						out = append(out, e)
					}
				}
				sendJSON(w, map[string]any{"entries": out, "now": now.Format(time.RFC3339)})
			case http.MethodPost:
				var in struct{ Text, Tag string }
				if !decode(w, r, &in) {
					return
				}
				text, ok := logCleanText(in.Text)
				if !ok {
					http.Error(w, "texto vacio o demasiado largo", http.StatusBadRequest)
					return
				}
				logMu.Lock()
				defer logMu.Unlock()
				now := time.Now()
				rec := logRecord{ID: logNewID(now), TS: now.Format(time.RFC3339), Text: text, Tag: logCleanTag(in.Tag)}
				if err := logAppend(logPath(), rec); err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				sendJSON(w, logEntry{ID: rec.ID, TS: rec.TS, Text: rec.Text, Tag: rec.Tag})
			default:
				http.Error(w, "metodo no permitido", http.StatusMethodNotAllowed)
			}
		}))

		mux.HandleFunc("/api/log/fix", authed(func(w http.ResponseWriter, r *http.Request) {
			var in struct{ Op, Ref, Text, Tag string }
			if !decode(w, r, &in) {
				return
			}
			if (in.Op != "edit" && in.Op != "del") || in.Ref == "" {
				http.Error(w, "operacion invalida", http.StatusBadRequest)
				return
			}
			rec := logRecord{Op: in.Op, Ref: in.Ref}
			if in.Op == "edit" {
				text, ok := logCleanText(in.Text)
				if !ok {
					http.Error(w, "texto vacio o demasiado largo", http.StatusBadRequest)
					return
				}
				rec.Text, rec.Tag = text, logCleanTag(in.Tag)
			}
			logMu.Lock()
			defer logMu.Unlock()
			all, err := logLoad(logPath())
			if err != nil {
				http.Error(w, "no se pudo leer la bitacora", http.StatusInternalServerError)
				return
			}
			var target *logEntry
			for i := range all {
				if all[i].ID == in.Ref {
					target = &all[i]
				}
			}
			if target == nil {
				http.Error(w, "entrada inexistente", http.StatusNotFound)
				return
			}
			now := time.Now()
			if t, err := time.Parse(time.RFC3339, target.TS); err != nil || now.Sub(t) > logFixWindow {
				http.Error(w, "solo se corrigen entradas de menos de 15 minutos", http.StatusForbidden)
				return
			}
			rec.TS = now.Format(time.RFC3339)
			if err := logAppend(logPath(), rec); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			sendJSON(w, map[string]bool{"ok": true})
		}))

		mux.HandleFunc("/api/log/export", authed(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				http.Error(w, "metodo no permitido", http.StatusMethodNotAllowed)
				return
			}
			back := 0
			switch r.URL.Query().Get("week") {
			case "", "current":
			case "previous":
				back = 1
			default:
				http.Error(w, "week invalido", http.StatusBadRequest)
				return
			}
			logMu.Lock()
			all, err := logLoad(logPath())
			logMu.Unlock()
			if err != nil {
				http.Error(w, "no se pudo leer la bitacora", http.StatusInternalServerError)
				return
			}
			start := logWeekStart(time.Now(), back)
			md := logMarkdown(all, start)
			dir := filepath.Join(dataDir(), "reportes")
			if err := os.MkdirAll(dir, 0o755); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			path := filepath.Join(dir, logReportName(start))
			if err := writeFileAtomic(path, []byte(md)); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			logClipboard(md)
			sendJSON(w, map[string]string{"path": path, "markdown": md})
		}))
	})
}
