package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestValidHost(t *testing.T) {
	good := []string{"localhost", "127.0.0.1", "example.com", "::1", "fe80::1", "a-b.c"}
	bad := []string{"", "-c", "--help", "a b", "a;b", "a$(x)", "a|b", "a\nb", "ho st", "a/b", "a`b`", strings.Repeat("a", 300)}
	for _, h := range good {
		if !validHost(h) {
			t.Errorf("debería ser válido: %q", h)
		}
	}
	for _, h := range bad {
		if validHost(h) {
			t.Errorf("debería ser inválido: %q", h)
		}
	}
	if validSSH("usuario@host\nrm -rf /") || validSSH("-oProxyCommand=x") || validSSH("a;b") || validSSH("$(x)") {
		t.Error("ssh peligroso aceptado")
	}
	if !validSSH("usuario@host -p 22") {
		t.Error("ssh normal rechazado")
	}
}

func TestParseConfig(t *testing.T) {
	var f rackFile
	if err := json.Unmarshal(defaultRack, &f); err != nil {
		t.Fatal(err)
	}
	racks := normalizeRack(f)
	if len(racks) != 1 || len(racks[0].Nodes) < 4 {
		t.Fatalf("config embebida inesperada: %+v", racks)
	}
	raw := `{"racks":[{"id":"a b","nodes":[
	  {"id":"n","host":"h","interval_s":1,"ssh":"-x","checks":[{"type":"http","url":"https://u:secreto@host.example:8443/ruta?token=zzz"},{"type":"raro"},{"type":"tcp","port":22}]},
	  {"id":"n","checks":[]}]}]}`
	if err := json.Unmarshal([]byte(raw), &f); err != nil {
		t.Fatal(err)
	}
	f.Racks = f.Racks[len(f.Racks)-1:]
	racks = normalizeRack(f)
	n := racks[0].Nodes[0]
	if racks[0].ID != "ab" || n.IntervalS != rackMinSec || n.SSH != "" || len(n.Checks) != 2 {
		t.Fatalf("normalización: %+v", racks[0])
	}
	if racks[0].Nodes[1].ID != "n-2" {
		t.Fatalf("id duplicado sin resolver: %s", racks[0].Nodes[1].ID)
	}
	tg := rackTarget(n, n.Checks[0])
	if tg != "host.example:8443" || strings.Contains(tg, "secreto") || strings.Contains(tg, "token") {
		t.Fatalf("target inseguro: %q", tg)
	}
	if rackTarget(n, n.Checks[1]) != "h:22" {
		t.Fatalf("target tcp: %q", rackTarget(n, n.Checks[1]))
	}
}

func TestCleanErr(t *testing.T) {
	_, err := net.DialTimeout("tcp", "127.0.0.1:1", time.Second)
	if err == nil {
		t.Skip("el puerto 1 está abierto")
	}
	if got := cleanErr(err); got != "conexión rechazada" {
		t.Fatalf("cleanErr = %q (%v)", got, err)
	}
	r := checkHTTP("http://127.0.0.1:1/x?token=secreto", 200, "")
	if r.Level != "bad" || strings.Contains(r.Err, "secreto") || strings.Contains(r.Err, "127.0.0.1") {
		t.Fatalf("error con datos sensibles: %+v", r)
	}
}

func TestTLSDays(t *testing.T) {
	now := time.Now()
	cases := []struct {
		after time.Time
		days  int
		level string
	}{
		{now.Add(30*24*time.Hour + time.Hour), 30, "ok"},
		{now.Add(20*24*time.Hour + time.Hour), 20, "warn"},
		{now.Add(6*24*time.Hour + time.Hour), 6, "bad"},
		{now.Add(-3 * time.Hour), -1, "bad"},
	}
	for _, c := range cases {
		d := tlsDays(c.after, now)
		if d != c.days || tlsLevel(d) != c.level {
			t.Errorf("tlsDays(%v) = %d/%s, quería %d/%s", c.after.Sub(now), d, tlsLevel(d), c.days, c.level)
		}
	}
}

// certServer levanta un servidor TLS local con un certificado autofirmado
// generado aquí que caduca en `valid`.
func certServer(t *testing.T, valid time.Duration) (port int, cert *x509.Certificate) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "127.0.0.1"},
		NotBefore:    time.Now().Add(-48 * time.Hour),
		NotAfter:     time.Now().Add(valid),
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ = x509.ParseCertificate(der)
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) }))
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv.Listener.Addr().(*net.TCPAddr).Port, cert
}

func TestCheckTLS(t *testing.T) {
	port, cert := certServer(t, 15*24*time.Hour+time.Hour)

	// Sin confiar en el certificado: inválido, pero con los días leídos.
	r := checkTLS("127.0.0.1", port)
	if r.Level != "bad" || r.Days == nil || *r.Days != 15 || r.Err == "" {
		t.Fatalf("autofirmado: %+v", r)
	}

	// Confiando en él: válido, naranja por quedar < 21 días.
	pool := x509.NewCertPool()
	pool.AddCert(cert)
	rackRootCAs = pool
	t.Cleanup(func() { rackRootCAs = nil })
	r = checkTLS("127.0.0.1", port)
	if r.Level != "warn" || r.Days == nil || *r.Days != 15 || r.Err != "" {
		t.Fatalf("confiable: %+v", r)
	}

	// El HTTP con ese certificado también funciona.
	h := checkHTTP("https://127.0.0.1:"+strconv.Itoa(port)+"/", 200, "")
	if h.Level != "ok" {
		t.Fatalf("http tls: %+v", h)
	}
}

func TestCheckHTTPAndTCP(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/404" {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte("ok"))
	}))
	defer srv.Close()
	if r := checkHTTP(srv.URL, 200, ""); r.Level != "ok" {
		t.Fatalf("http ok: %+v", r)
	}
	if r := checkHTTP(srv.URL+"/404", 200, ""); r.Level != "bad" || r.Err != "estado HTTP 404" {
		t.Fatalf("http 404: %+v", r)
	}
	if r := checkHTTP(srv.URL+"/404", 404, ""); r.Level != "ok" {
		t.Fatalf("expect 404: %+v", r)
	}
	if r := checkHTTP(srv.URL, 200, "ok"); r.Level != "ok" {
		t.Fatalf("keyword presente: %+v", r)
	}
	if r := checkHTTP(srv.URL, 200, "secreto"); r.Level != "bad" || strings.Contains(r.Err, "secreto") {
		t.Fatalf("keyword ausente: %+v", r)
	}
	host, port, _ := net.SplitHostPort(srv.Listener.Addr().String())
	p, _ := net.LookupPort("tcp", port)
	if r := checkTCP(host, p); r.Level != "ok" {
		t.Fatalf("tcp: %+v", r)
	}
	if r := checkTCP("-x", 22); r.Level != "bad" {
		t.Fatalf("host inválido aceptado: %+v", r)
	}
}

func TestCheckDockerSinSocket(t *testing.T) {
	old := dockerSock
	dockerSock = "/ruta/que/no/existe.sock"
	defer func() { dockerSock = old }()
	r := checkDocker("x")
	if r.Level != "bad" || r.Err != "docker.sock no existe" {
		t.Fatalf("docker sin socket: %+v", r)
	}
}

func TestRecargaPorMtime(t *testing.T) {
	dir := t.TempDir()
	p := dir + "/rack.json"
	one := `{"racks":[{"id":"r","nodes":[{"id":"a","checks":[{"type":"tcp","host":"127.0.0.1","port":9}]}]}]}`
	two := `{"racks":[{"id":"r","nodes":[{"id":"a","checks":[{"type":"tcp","host":"127.0.0.1","port":9}]},{"id":"b","checks":[]}]}]}`
	if err := os.WriteFile(p, []byte(one), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIXEL_DESK_RACK", p)
	s := &rackState{chk: map[string]*rackChk{}, forced: map[string]time.Time{}, sem: make(chan struct{}, 2)}
	s.reload()
	if len(s.cfg[0].Nodes) != 1 {
		t.Fatal("primera carga")
	}
	os.WriteFile(p, []byte(two), 0o644)
	future := time.Now().Add(2 * time.Second)
	os.Chtimes(p, future, future)
	s.reload()
	if len(s.cfg[0].Nodes) != 2 {
		t.Fatal("no recargó tras cambiar el mtime")
	}
	os.WriteFile(p, []byte("{roto"), 0o644)
	os.Chtimes(p, future.Add(time.Second), future.Add(time.Second))
	s.reload()
	if len(s.cfg[0].Nodes) != 2 {
		t.Fatal("una config inválida debe conservar la anterior")
	}
}

func TestPingRechazaHostPeligroso(t *testing.T) {
	if r := checkPing("--help"); r.Level != "bad" || r.Err != "host inválido" {
		t.Fatalf("%+v", r)
	}
}
