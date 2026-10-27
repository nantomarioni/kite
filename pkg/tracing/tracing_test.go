package tracing_test

import (
	"context"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/middleware"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/tracing"
	"go.opentelemetry.io/otel"
	collectortrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/proto"
)

const (
	otlpPath     = "/insert/opentelemetry/v1/traces"
	traceIDHex   = "4bf92f3577b34da6a3ce929d0e0e4736"
	parentIDHex  = "00f067aa0ba902b7"
	traceparent  = "00-" + traceIDHex + "-" + parentIDHex + "-01"
	testUserName = "alice"
)

type fakeReceiver struct {
	mu       sync.Mutex
	paths    []string
	requests []*collectortrace.ExportTraceServiceRequest
}

func (f *fakeReceiver) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	req := &collectortrace.ExportTraceServiceRequest{}
	if err := proto.Unmarshal(body, req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	f.mu.Lock()
	f.paths = append(f.paths, r.Method+" "+r.URL.Path)
	f.requests = append(f.requests, req)
	f.mu.Unlock()
	w.Header().Set("Content-Type", "application/x-protobuf")
	out, _ := proto.Marshal(&collectortrace.ExportTraceServiceResponse{})
	_, _ = w.Write(out)
}

func clearOTelEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_ENDPOINT",
		"OTEL_SDK_DISABLED", "OTEL_SERVICE_NAME", "OTEL_RESOURCE_ATTRIBUTES",
		"OTEL_TRACES_SAMPLER", "OTEL_TRACES_SAMPLER_ARG",
	} {
		t.Setenv(k, "") // registers restore of the original value
		_ = os.Unsetenv(k)
	}
}

func resetGlobals(t *testing.T) {
	t.Helper()
	prevTP := otel.GetTracerProvider()
	prevProp := otel.GetTextMapPropagator()
	t.Cleanup(func() {
		if otel.GetTracerProvider() != prevTP {
			otel.SetTracerProvider(prevTP)
		}
		if otel.GetTextMapPropagator() != prevProp {
			otel.SetTextMapPropagator(prevProp)
		}
	})
}

func TestInitDisabledWithoutEndpoint(t *testing.T) {
	clearOTelEnv(t)
	resetGlobals(t)
	prevProp := otel.GetTextMapPropagator()
	prevTP := otel.GetTracerProvider()

	shutdown, err := tracing.Init(context.Background())
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	if tracing.Enabled() {
		t.Fatal("Enabled() = true without an endpoint")
	}
	if otel.GetTextMapPropagator() != prevProp {
		t.Fatal("propagator was installed while disabled")
	}
	if otel.GetTracerProvider() != prevTP {
		t.Fatal("tracer provider was installed while disabled")
	}
	if err := shutdown(context.Background()); err != nil {
		t.Fatalf("no-op shutdown: %v", err)
	}
}

func TestInitDisabledBySDKDisabled(t *testing.T) {
	clearOTelEnv(t)
	resetGlobals(t)
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://127.0.0.1:1/v1/traces")
	t.Setenv("OTEL_SDK_DISABLED", "true")

	shutdown, err := tracing.Init(context.Background())
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	defer func() { _ = shutdown(context.Background()) }()
	if tracing.Enabled() {
		t.Fatal("Enabled() = true with OTEL_SDK_DISABLED=true")
	}
}

func TestEndToEndContinuesIncomingTrace(t *testing.T) {
	clearOTelEnv(t)
	resetGlobals(t)
	gin.SetMode(gin.TestMode)

	recv := &fakeReceiver{}
	srv := httptest.NewServer(recv)
	defer srv.Close()
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", srv.URL+otlpPath)

	shutdown, err := tracing.Init(context.Background())
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	if !tracing.Enabled() {
		t.Fatal("Enabled() = false with an endpoint")
	}
	fields := strings.Join(otel.GetTextMapPropagator().Fields(), ",")
	if !strings.Contains(fields, "traceparent") || !strings.Contains(fields, "baggage") {
		t.Fatalf("propagator fields = %q, want traceparent + baggage", fields)
	}

	r := gin.New()
	r.Use(tracing.Middleware()...)
	r.GET("/healthz", func(c *gin.Context) { c.String(http.StatusOK, "ok") })
	r.GET("/api/v1/pods/:namespace", func(c *gin.Context) {
		c.Set("user", model.User{Username: testUserName})
		c.Set(middleware.ClusterNameKey, "home")
		c.String(http.StatusOK, "pods")
	})

	for _, target := range []string{"/api/v1/pods/default", "/healthz"} {
		req := httptest.NewRequest(http.MethodGet, target, nil)
		req.Header.Set("traceparent", traceparent)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("%s: status %d", target, w.Code)
		}
	}

	if err := shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown: %v", err)
	}

	recv.mu.Lock()
	defer recv.mu.Unlock()
	if len(recv.paths) == 0 {
		t.Fatal("receiver got no export")
	}
	for _, p := range recv.paths {
		if p != http.MethodPost+" "+otlpPath {
			t.Fatalf("export went to %q, want POST %s", p, otlpPath)
		}
	}

	var spans []*tracepb.Span
	var serviceName string
	for _, req := range recv.requests {
		for _, rs := range req.GetResourceSpans() {
			for _, kv := range rs.GetResource().GetAttributes() {
				if kv.GetKey() == "service.name" {
					serviceName = kv.GetValue().GetStringValue()
				}
			}
			for _, ss := range rs.GetScopeSpans() {
				spans = append(spans, ss.GetSpans()...)
			}
		}
	}
	if serviceName != tracing.DefaultServiceName {
		t.Errorf("service.name = %q, want %q", serviceName, tracing.DefaultServiceName)
	}
	if len(spans) != 1 {
		names := make([]string, 0, len(spans))
		for _, s := range spans {
			names = append(names, s.GetName())
		}
		t.Fatalf("got %d spans %v, want exactly 1 (healthz must not be traced)", len(spans), names)
	}
	span := spans[0]
	if span.GetKind() != tracepb.Span_SPAN_KIND_SERVER {
		t.Errorf("span kind = %v, want SERVER", span.GetKind())
	}
	if span.GetName() != "GET /api/v1/pods/:namespace" {
		t.Errorf("span name = %q", span.GetName())
	}
	if got := hex.EncodeToString(span.GetTraceId()); got != traceIDHex {
		t.Errorf("trace id = %s, want %s", got, traceIDHex)
	}
	if got := hex.EncodeToString(span.GetParentSpanId()); got != parentIDHex {
		t.Errorf("parent span id = %s, want %s", got, parentIDHex)
	}
	attrs := map[string]string{}
	for _, kv := range span.GetAttributes() {
		attrs[kv.GetKey()] = kv.GetValue().GetStringValue()
	}
	if attrs["enduser.id"] != testUserName {
		t.Errorf("enduser.id = %q, want %q", attrs["enduser.id"], testUserName)
	}
	if attrs["kite.cluster"] != "home" {
		t.Errorf("kite.cluster = %q, want home (clusterNameKey out of sync with middleware.ClusterNameKey?)", attrs["kite.cluster"])
	}
}
