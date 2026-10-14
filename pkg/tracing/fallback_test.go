package tracing

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

// main.go sets engine.ContextWithFallback so handlers can pass c itself as a
// context.Context and still get the otelgin server span as parent.
func TestContextWithFallbackParentsSpansStartedFromGinContext(t *testing.T) {
	for _, fallback := range []bool{true, false} {
		rec, tracer := setupEnabled(t)
		gin.SetMode(gin.TestMode)
		r := gin.New()
		r.ContextWithFallback = fallback
		r.Use(Middleware()...)
		r.GET("/api/v1/things", func(c *gin.Context) {
			_, span := tracer.Start(c, "handler-work") // c, not c.Request.Context()
			span.End()
			c.Status(http.StatusOK)
		})

		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/things", nil))
		if w.Code != http.StatusOK {
			t.Fatalf("fallback=%v: status %d", fallback, w.Code)
		}

		var server, child sdktrace.ReadOnlySpan
		for _, s := range rec.Ended() {
			switch {
			case s.SpanKind() == trace.SpanKindServer:
				server = s
			case s.Name() == "handler-work":
				child = s
			}
		}
		if server == nil || child == nil {
			t.Fatalf("fallback=%v: server span %v, handler span %v", fallback, server != nil, child != nil)
		}
		isChild := child.Parent().SpanID() == server.SpanContext().SpanID() &&
			child.SpanContext().TraceID() == server.SpanContext().TraceID()
		if fallback && !isChild {
			t.Errorf("with ContextWithFallback the handler span is not a child of the server span")
		}
		if !fallback && isChild {
			t.Errorf("without ContextWithFallback the handler span unexpectedly found the server span (test no longer proves anything)")
		}
	}
}
