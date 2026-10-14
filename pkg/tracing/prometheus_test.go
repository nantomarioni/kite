package tracing

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/prometheus/client_golang/api"
	v1 "github.com/prometheus/client_golang/api/prometheus/v1"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

const promMatrixResponse = `{"status":"success","warnings":["partial data"],"data":{"resultType":"matrix","result":[` +
	`{"metric":{"__name__":"up","job":"a"},"values":[[1700000000,"1"],[1700000060,"1"]]},` +
	`{"metric":{"__name__":"up","job":"b"},"values":[[1700000000,"0"]]}]}}`

const promVectorResponse = `{"status":"success","data":{"resultType":"vector","result":[` +
	`{"metric":{"job":"a"},"value":[1700000000,"1"]}]}}`

func promTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/query_range":
			_, _ = w.Write([]byte(promMatrixResponse))
		case "/api/v1/query":
			_, _ = w.Write([]byte(promVectorResponse))
		default:
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"status":"error","errorType":"bad_data","error":"unknown path"}`))
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func promTestAPI(t *testing.T, srv *httptest.Server) v1.API {
	t.Helper()
	c, err := api.NewClient(api.Config{
		Address:      srv.URL,
		RoundTripper: WrapTransport("prometheus", http.DefaultTransport),
	})
	if err != nil {
		t.Fatal(err)
	}
	return WrapPrometheusAPI(v1.NewAPI(c))
}

func TestWrapPrometheusAPIDisabledReturnsSameAPI(t *testing.T) {
	prev := enabled.Load()
	enabled.Store(false)
	t.Cleanup(func() { enabled.Store(prev) })

	c, err := api.NewClient(api.Config{Address: "http://prometheus.example"})
	if err != nil {
		t.Fatal(err)
	}
	a := v1.NewAPI(c)
	if got := WrapPrometheusAPI(a); got != a {
		t.Fatalf("WrapPrometheusAPI returned %T, want the API unchanged", got)
	}
}

func TestWrapPrometheusAPIQueryRange(t *testing.T) {
	rec, tracer := setupEnabled(t)
	a := promTestAPI(t, promTestServer(t))

	ctx, parent := tracer.Start(context.Background(), "server")
	end := time.Unix(1700000060, 0)
	query := `sum(rate(container_cpu_usage_seconds_total[1m]))`
	if _, warnings, err := a.QueryRange(ctx, query, v1.Range{Start: end.Add(-time.Minute), End: end, Step: time.Minute}); err != nil {
		t.Fatalf("QueryRange: %v", err)
	} else if len(warnings) != 1 {
		t.Fatalf("warnings = %v, want 1", warnings)
	}
	parent.End()

	var logical, httpSpan sdktrace.ReadOnlySpan
	for _, s := range rec.Ended() {
		switch {
		case s.Name() == "prometheus query_range":
			logical = s
		case s.SpanKind() == trace.SpanKindClient:
			httpSpan = s
		}
	}
	if logical == nil {
		t.Fatal("no prometheus query_range span")
	}
	if logical.Parent().SpanID() != parent.SpanContext().SpanID() {
		t.Errorf("query_range parent = %s, want %s", logical.Parent().SpanID(), parent.SpanContext().SpanID())
	}
	wantAttrs(t, logical, map[string]any{
		"db.system.name":              "prometheus",
		"db.operation.name":           "query_range",
		"db.query.text":               query,
		"kite.prometheus.result_type": "matrix",
		"kite.prometheus.series":      int64(2),
		"kite.prometheus.samples":     int64(3),
		"kite.prometheus.warnings":    int64(1),
		"kite.prometheus.range.step":  "1m0s",
		"kite.prometheus.range.end":   end.UTC().Format(time.RFC3339),
	})
	if httpSpan == nil {
		t.Fatal("no HTTP client span")
	}
	if httpSpan.Parent().SpanID() != logical.SpanContext().SpanID() {
		t.Errorf("HTTP span %q parent = %s, want query_range span %s", httpSpan.Name(), httpSpan.Parent().SpanID(), logical.SpanContext().SpanID())
	}
}

func TestWrapPrometheusAPIQuery(t *testing.T) {
	rec, tracer := setupEnabled(t)
	a := promTestAPI(t, promTestServer(t))

	ctx, parent := tracer.Start(context.Background(), "server")
	if _, _, err := a.Query(ctx, "up", time.Unix(1700000000, 0)); err != nil {
		t.Fatalf("Query: %v", err)
	}
	parent.End()

	var logical sdktrace.ReadOnlySpan
	for _, s := range rec.Ended() {
		if s.Name() == "prometheus query" {
			logical = s
		}
	}
	if logical == nil {
		t.Fatal("no prometheus query span")
	}
	wantAttrs(t, logical, map[string]any{
		"db.operation.name":           "query",
		"db.query.text":               "up",
		"kite.prometheus.result_type": "vector",
		"kite.prometheus.series":      int64(1),
		"kite.prometheus.samples":     int64(1),
		"kite.prometheus.warnings":    int64(0),
	})
}

func TestWrapPrometheusAPIErrorAndNoParent(t *testing.T) {
	rec, tracer := setupEnabled(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"status":"error","errorType":"bad_data","error":"parse error"}`))
	}))
	t.Cleanup(srv.Close)
	a := promTestAPI(t, srv)

	// No parent: no spans at all.
	if _, _, err := a.Query(context.Background(), "up{", time.Time{}); err == nil {
		t.Fatal("Query: want error")
	}
	if n := len(rec.Started()); n != 0 {
		t.Fatalf("got %d spans without a parent, want 0", n)
	}

	ctx, parent := tracer.Start(context.Background(), "server")
	if _, _, err := a.Query(ctx, "up{", time.Time{}); err == nil {
		t.Fatal("Query: want error")
	}
	parent.End()
	for _, s := range rec.Ended() {
		if s.Name() == "prometheus query" {
			if s.Status().Code != codes.Error {
				t.Errorf("status = %v, want error", s.Status())
			}
			return
		}
	}
	t.Fatal("no prometheus query span")
}
