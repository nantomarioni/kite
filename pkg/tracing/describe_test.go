package tracing

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// describeFakeAPIServer serves a single Pod and records traceparent headers.
type describeFakeAPIServer struct {
	mu           sync.Mutex
	traceparents []string
}

func (f *describeFakeAPIServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.traceparents = append(f.traceparents, r.Header.Get("traceparent"))
	f.mu.Unlock()
	if r.URL.Path != "/api/v1/namespaces/default/pods/web" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"apiVersion":"v1","kind":"Pod","metadata":{"name":"web","namespace":"default"}}`))
}

// describeClusterConfig mirrors cluster_manager.go newClientSet: the base
// config carries the gated "kubernetes" transport.
func describeClusterConfig(host string) *rest.Config {
	cfg := &rest.Config{Host: host}
	cfg.Wrap(func(rt http.RoundTripper) http.RoundTripper {
		return WrapTransport("kubernetes", rt)
	})
	return cfg
}

func TestConfigWithParentDisabledOrNoParent(t *testing.T) {
	cfg := &rest.Config{Host: "https://apiserver.example"}

	prev := enabled.Load()
	enabled.Store(false)
	if got := ConfigWithParent(context.Background(), cfg); got != cfg {
		t.Errorf("disabled: ConfigWithParent returned a new config")
	}
	enabled.Store(prev)

	_, _ = setupEnabled(t)
	if got := ConfigWithParent(context.Background(), cfg); got != cfg {
		t.Errorf("no parent: ConfigWithParent returned a new config")
	}
}

func TestConfigWithParentReparentsTODORequests(t *testing.T) {
	rec, tracer := setupEnabled(t)
	fakeAPI := &describeFakeAPIServer{}
	srv := httptest.NewServer(fakeAPI)
	t.Cleanup(srv.Close)
	base := describeClusterConfig(srv.URL)

	ctx, parent := tracer.Start(context.Background(), "server")
	cfg := ConfigWithParent(ctx, base)
	if cfg == base {
		t.Fatal("ConfigWithParent returned the base config")
	}
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	// What kubectl's describers do: no request context.
	if _, err := cs.CoreV1().Pods("default").Get(context.TODO(), "web", metav1.GetOptions{}); err != nil {
		t.Fatalf("Get: %v", err)
	}
	parent.End()

	fakeAPI.mu.Lock()
	tps := append([]string(nil), fakeAPI.traceparents...)
	fakeAPI.mu.Unlock()
	if len(tps) != 1 {
		t.Fatalf("apiserver got %d requests, want 1", len(tps))
	}
	wantTrace := "00-" + parent.SpanContext().TraceID().String() + "-"
	if !strings.HasPrefix(tps[0], wantTrace) {
		t.Errorf("traceparent = %q, want prefix %q", tps[0], wantTrace)
	}

	var client sdktrace.ReadOnlySpan
	for _, s := range rec.Ended() {
		if s.SpanKind() == trace.SpanKindClient {
			client = s
		}
	}
	if client == nil {
		t.Fatal("no client span recorded")
	}
	if client.Name() != "kubernetes GET" {
		t.Errorf("client span = %q, want %q", client.Name(), "kubernetes GET")
	}
	if client.Parent().SpanID() != parent.SpanContext().SpanID() {
		t.Errorf("client span parent = %s, want %s", client.Parent().SpanID(), parent.SpanContext().SpanID())
	}

	// The base config is untouched: a TODO request through it stays untraced.
	before := len(rec.Ended())
	baseCS, err := kubernetes.NewForConfig(base)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := baseCS.CoreV1().Pods("default").Get(context.TODO(), "web", metav1.GetOptions{}); err != nil {
		t.Fatalf("Get: %v", err)
	}
	if after := len(rec.Ended()); after != before {
		t.Errorf("base config produced %d new spans, want 0", after-before)
	}
}

func TestStartDescribe(t *testing.T) {
	rec, tracer := setupEnabled(t)

	// No parent: no span, no-op end.
	ctx, end := StartDescribe(context.Background(), "Pod", "default", "web")
	end(nil)
	if trace.SpanContextFromContext(ctx).IsValid() || len(rec.Started()) != 0 {
		t.Fatal("StartDescribe created a span without a parent")
	}

	pctx, parent := tracer.Start(context.Background(), "server")
	_, end = StartDescribe(pctx, "Pod", "default", "web")
	end(errors.New("boom"))
	parent.End()

	s := onlySpan(t, rec, parent)
	if s.Name() != "kubectl describe Pod" {
		t.Errorf("span name = %q, want %q", s.Name(), "kubectl describe Pod")
	}
	if s.Status().Code != codes.Error {
		t.Errorf("status = %v, want error", s.Status())
	}
	wantAttrs(t, s, map[string]any{"kite.k8s.kind": "Pod", "k8s.namespace.name": "default", "kite.k8s.name": "web"})
}
