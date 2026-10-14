package tracing

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"go.opentelemetry.io/contrib/instrumentation/github.com/gin-gonic/gin/otelgin"
	"go.opentelemetry.io/otel/attribute"
	semconv "go.opentelemetry.io/otel/semconv/v1.39.0"
	"go.opentelemetry.io/otel/trace"
)

// clusterNameKey mirrors middleware.ClusterNameKey. pkg/middleware imports
// pkg/cluster, which imports this package, so importing it here would cycle;
// the end-to-end test asserts the two stay in sync.
const clusterNameKey = "cluster-name"

// untracedPaths are skipped (matched after stripping common.Base), the same
// set the access logger ignores.
var untracedPaths = []string{"/healthz", "/metrics", "/favicon.ico"}

const untracedPrefix = "/assets/"

// Middleware returns the server-side tracing middleware chain: otelgin
// (continues an incoming W3C traceparent, e.g. from Traefik) followed by a
// small enricher adding the kite user and cluster to the server span.
// Register it first in the global chain, and only when Enabled().
func Middleware() []gin.HandlerFunc {
	return []gin.HandlerFunc{
		otelgin.Middleware(DefaultServiceName, otelgin.WithFilter(shouldTrace)),
		enrichSpan,
	}
}

func shouldTrace(r *http.Request) bool {
	if r.Method == http.MethodOptions {
		return false
	}
	path := r.URL.Path
	if base := common.Base; base != "" && base != "/" {
		path = strings.TrimPrefix(path, base)
	}
	for _, p := range untracedPaths {
		if path == p {
			return false
		}
	}
	return !strings.HasPrefix(path, untracedPrefix)
}

func enrichSpan(c *gin.Context) {
	span := trace.SpanFromContext(c.Request.Context())
	c.Next()
	if !span.IsRecording() {
		return
	}
	var attrs []attribute.KeyValue
	if v, ok := c.Get("user"); ok {
		if user, ok := v.(model.User); ok {
			attrs = append(attrs, semconv.EnduserID(user.Key()))
		}
	}
	if v, ok := c.Get(clusterNameKey); ok {
		if name, ok := v.(string); ok && name != "" {
			attrs = append(attrs, attribute.String("kite.cluster", name))
		}
	}
	if len(attrs) > 0 {
		span.SetAttributes(attrs...)
	}
}
