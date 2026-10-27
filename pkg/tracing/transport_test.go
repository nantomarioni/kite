package tracing

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

type recordingRT struct {
	calls int
	last  *http.Request
}

func (r *recordingRT) RoundTrip(req *http.Request) (*http.Response, error) {
	r.calls++
	r.last = req
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader("ok")),
		Header:     http.Header{},
		Request:    req,
	}, nil
}

// setupEnabled installs a recording tracer provider + W3C propagator and marks
// tracing as enabled, restoring everything on cleanup.
func setupEnabled(t *testing.T) (*tracetest.SpanRecorder, trace.Tracer) {
	t.Helper()
	prevTP := otel.GetTracerProvider()
	prevProp := otel.GetTextMapPropagator()
	prevEnabled := enabled.Load()

	rec := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(rec))
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))
	enabled.Store(true)

	t.Cleanup(func() {
		_ = tp.Shutdown(context.Background())
		otel.SetTracerProvider(prevTP)
		otel.SetTextMapPropagator(prevProp)
		enabled.Store(prevEnabled)
	})
	return rec, tp.Tracer("test")
}

func doRequest(t *testing.T, rt http.RoundTripper, ctx context.Context, hdr http.Header) {
	t.Helper()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://apiserver.example/api/v1/pods", nil)
	if err != nil {
		t.Fatal(err)
	}
	for k, vs := range hdr {
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	resp, err := rt.RoundTrip(req)
	if err != nil {
		t.Fatalf("RoundTrip: %v", err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
}

func TestWrapTransportDisabledReturnsSameRoundTripper(t *testing.T) {
	prev := enabled.Load()
	enabled.Store(false)
	t.Cleanup(func() { enabled.Store(prev) })

	base := &recordingRT{}
	if got := WrapTransport("kubernetes", base); got != base {
		t.Fatalf("WrapTransport returned %T, want the base round tripper unchanged", got)
	}
}

func TestWrapTransportNoParentSpan(t *testing.T) {
	rec, _ := setupEnabled(t)
	base := &recordingRT{}
	rt := WrapTransport("kubernetes", base)

	doRequest(t, rt, context.Background(), nil)

	if base.calls != 1 {
		t.Fatalf("base calls = %d, want 1", base.calls)
	}
	if n := len(rec.Ended()) + len(rec.Started()); n != 0 {
		t.Fatalf("got spans without a parent: %d", n)
	}
	if v := base.last.Header.Get("traceparent"); v != "" {
		t.Fatalf("traceparent injected without a parent: %q", v)
	}
}

func TestWrapTransportWithParentSpan(t *testing.T) {
	rec, tracer := setupEnabled(t)
	base := &recordingRT{}
	rt := WrapTransport("prometheus", base)

	ctx, parent := tracer.Start(context.Background(), "server")
	doRequest(t, rt, ctx, nil)
	parent.End()

	if base.calls != 1 {
		t.Fatalf("base calls = %d, want 1", base.calls)
	}
	var client []sdktrace.ReadOnlySpan
	for _, s := range rec.Ended() {
		if s.SpanKind() == trace.SpanKindClient {
			client = append(client, s)
		}
	}
	if len(client) != 1 {
		t.Fatalf("client spans = %d, want 1", len(client))
	}
	s := client[0]
	if s.Name() != "prometheus GET" {
		t.Errorf("span name = %q, want %q", s.Name(), "prometheus GET")
	}
	if s.Parent().SpanID() != parent.SpanContext().SpanID() {
		t.Errorf("client span parent = %s, want %s", s.Parent().SpanID(), parent.SpanContext().SpanID())
	}
	var peer string
	for _, kv := range s.Attributes() {
		if kv.Key == "peer.service" {
			peer = kv.Value.AsString()
		}
	}
	if peer != "prometheus" {
		t.Errorf("peer.service = %q, want prometheus", peer)
	}

	tp := base.last.Header.Get("traceparent")
	wantPrefix := "00-" + parent.SpanContext().TraceID().String() + "-" + s.SpanContext().SpanID().String()
	if !strings.HasPrefix(tp, wantPrefix) {
		t.Errorf("traceparent = %q, want prefix %q", tp, wantPrefix)
	}
}

func TestWrapTransportSkipsUpgradeRequests(t *testing.T) {
	cases := map[string]http.Header{
		"upgrade":    {"Upgrade": {"websocket"}, "Connection": {"Upgrade"}},
		"connection": {"Connection": {"keep-alive, Upgrade"}},
		"spdy":       {headerStreamProtocolVersion: {"v4.channel.k8s.io"}},
		"websocket":  {headerWebSocketProtocol: {"v5.channel.k8s.io"}},
	}
	for name, hdr := range cases {
		t.Run(name, func(t *testing.T) {
			rec, tracer := setupEnabled(t)
			base := &recordingRT{}
			rt := WrapTransport("kubernetes", base)

			ctx, parent := tracer.Start(context.Background(), "server")
			doRequest(t, rt, ctx, hdr)
			parent.End()

			if base.calls != 1 {
				t.Fatalf("base calls = %d, want 1", base.calls)
			}
			for _, s := range rec.Ended() {
				if s.SpanKind() == trace.SpanKindClient {
					t.Fatalf("upgrade request produced client span %q", s.Name())
				}
			}
			if v := base.last.Header.Get("traceparent"); v != "" {
				t.Fatalf("traceparent injected into upgrade request: %q", v)
			}
		})
	}
}
